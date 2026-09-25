/* v2.18.0：用手機尺寸的真實 Chrome 驗證「資料備份與還原」介面
 *
 * 涵蓋：開啟視窗 → 下載備份（實際攔下 Blob 檢查 JSON 內容與 checksum）→ 取消勾選海報 → 再下載一次
 *      → 貼上備份做「先檢查」（dry-run，不寫入）→ 檢查後才能「確認還原」→ 還原真的生效
 *      → 被改過的備份要拒絕 → 權限表：一般管理員看不到這個功能
 *
 * 伺服器：真的 server.js + 假 Supabase（不碰正式資料庫）。
 * 用法：node tests/browser/backup-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3302);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-backup-check');
const USER = 'owner-backup';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

function seedState() {
    return {
        tables: {
            admin_users: [{ id: 1, username: USER, password: PASS, role: 'web_owner', is_active: true }],
            competitions: [
                { id: 100, name: '春季盃', date: '2026-10-01', location: '澳門', is_deleted: false, created_at: '2026-01-01T00:00:00.000Z' },
                { id: 101, name: '夏季盃', date: '2026-11-01', location: '香港', is_deleted: false, created_at: '2026-01-02T00:00:00.000Z' }
            ],
            registrations: [{ id: 200, competition_id: 100, user_id: 1, is_active: true, created_at: '2026-01-03T00:00:00.000Z' }],
            app_settings: [{ key: 'site_title', value: '比賽管理系統' }],
            competition_posters: [{ competition_id: 100, image_data: 'data:image/png;base64,AAAA', updated_at: '2026-01-05T00:00:00.000Z' }],
            competition_teams: [],
            push_subscriptions: [],
            push_log: [],
            audit_logs: [],
            error_logs: []
        },
        nextId: { admin_users: 50, audit_logs: 900, error_logs: 900 },
        log: []
    };
}

const STUB_DIALOGS = `
    window.__ALERTS__ = [];
    window.__backupText = null;
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = () => true;
    URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__backupText = t; }); return 'blob:stub'; };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () {};
    return true;
`;

(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const state = seedState();
    const stub = await startFakeSupabase(state);
    process.env.NODE_ENV = 'production';
    process.env.PORT = String(PORT);
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'browser-check-secret';
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    process.env.SUPABASE_KEY = 'stub-service-key';
    process.env.SITE_URL = BASE;

    const app = require(path.join(__dirname, '..', '..', 'server.js'));
    const server = app.listen(PORT, '127.0.0.1');
    await once(server, 'listening');
    console.log(`\n🧪 備份與還原介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.evaluate(STUB_DIALOGS);

        await browser.evaluate(`
            document.getElementById('loginModal').classList.remove('hidden');
            const setValue = (id, value) => {
                const el = document.getElementById(id);
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            };
            setValue('loginUsername', ${JSON.stringify(USER)});
            setValue('loginPassword', ${JSON.stringify(PASS)});
            document.getElementById('submitLoginBtn').click();
            return true;
        `);
        await browser.waitFor(`localStorage.getItem('competition_user') !== null`, { timeout: 10000 });

        // ---------- 1. 開啟視窗 ----------
        await browser.evaluate(`document.getElementById('backupBtn').click(); return true;`);
        await browser.waitFor(`!document.getElementById('backupModal').classList.contains('hidden')`, { timeout: 8000 });
        check(true, '選單可開啟「💾 備份與還原」視窗');
        await browser.screenshot(path.join(SHOTS, '01-備份視窗.png'));

        // ---------- 2. 下載備份 ----------
        await browser.evaluate(`document.getElementById('backupDownloadBtn').click(); return true;`);
        await browser.waitFor(`window.__backupText !== null`, { timeout: 10000 });
        const backup = JSON.parse(await browser.evaluate(`return window.__backupText;`));
        check(backup.meta && backup.meta.app === 'competition-manager', '備份有 meta 與應用識別');
        check(backup.tables.competitions.length === 2 && backup.tables.registrations.length === 1, '備份含賽事與報名');
        check(/^[a-f0-9]{64}$/.test(String(backup.meta.checksum)), '備份帶 checksum（可事後驗證完整性）');
        check(!Object.keys(backup.tables).includes('audit_logs'), '預設不備份日誌（檔案不會無故膨脹）');
        const statusText = await browser.evaluate(`return document.getElementById('backupStatus').textContent;`);
        check(/已下載備份（共 \d+ 筆/.test(statusText), `畫面回報備份筆數（${statusText.split('\\n')[0]}）`);

        // 取消勾選海報 → 再下載一次
        await browser.evaluate(`
            window.__backupText = null;
            document.getElementById('backupIncludePosters').checked = false;
            document.getElementById('backupDownloadBtn').click();
            return true;
        `);
        await browser.waitFor(`window.__backupText !== null`, { timeout: 10000 });
        const noPoster = JSON.parse(await browser.evaluate(`return window.__backupText;`));
        check(!Object.keys(noPoster.tables).includes('competition_posters'), '取消勾選後備份不含海報圖片');
        check(String(noPoster.meta.skipped.join('')).includes('competition_posters'), 'meta 說明略過了什麼');

        // ---------- 3. 先檢查（dry-run） ----------
        await browser.evaluate(`
            window.__restoreCheck = null;
            runRestoreFromText(${JSON.stringify(JSON.stringify({ meta: {}, tables: { competitions: [{ id: 100, name: '春季盃（還原後的名字）', date: '2026-10-01', location: '澳門', is_deleted: false }] } }))}, true, 'check.json').then((d) => { window.__restoreCheck = d; });
            return true;
        `);
        await browser.waitFor(`window.__restoreCheck !== null`, { timeout: 10000 });
        const dry = await browser.evaluate(`return window.__restoreCheck;`);
        check(dry.dry_run === true && dry.would_restore === 1, `檢查回報將還原 1 筆（實際 ${dry.would_restore}）`);
        const checkStatus = await browser.evaluate(`return document.getElementById('backupStatus').textContent;`);
        check(/尚未寫入任何資料/.test(checkStatus), '明確告知檢查階段還沒寫入');
        check(state.tables.competitions.find((c) => c.id === 100).name === '春季盃', '檢查階段資料庫完全沒被改動');
        const btnEnabled = await browser.evaluate(`return document.getElementById('backupRestoreBtn').disabled === false;`);
        check(btnEnabled, '檢查通過後「確認還原」才可按');
        const resultHtml = await browser.evaluate(`return document.getElementById('backupResult').textContent;`);
        check(/competitions/.test(resultHtml) && /1/.test(resultHtml), '畫面列出將還原的表與筆數');
        await browser.screenshot(path.join(SHOTS, '02-檢查結果.png'));

        // ---------- 4. 確認還原 ----------
        await browser.evaluate(`
            window.__restoreResult = null;
            const good = { meta: {}, tables: { competitions: [
                { id: 100, name: '春季盃（還原後的名字）', date: '2026-10-01', location: '澳門', is_deleted: false },
                { id: 999, name: '備份裡才有的新賽事', date: '2026-12-01', location: '珠海', is_deleted: false } ] } };
            runRestoreFromText(JSON.stringify(good), false, 'good.json').then((d) => { window.__restoreResult = d; });
            return true;
        `);
        await browser.waitFor(`window.__restoreResult !== null`, { timeout: 10000 });
        const restored = await browser.evaluate(`return window.__restoreResult;`);
        check(restored.success === true && restored.restored === 2, `還原回報 2 筆（實際 ${restored.restored}）`);
        const byId = Object.fromEntries(state.tables.competitions.map((c) => [c.id, c]));
        check(byId[100].name === '春季盃（還原後的名字）', '既有賽事被備份內容更新（upsert）');
        check(!!byId[999], '備份中的新賽事被建立');
        check(!!byId[101], '備份中沒有的賽事沒有被刪除');
        const afterStatus = await browser.evaluate(`return document.getElementById('backupStatus').textContent;`);
        check(/已還原 2 筆/.test(afterStatus) && /未刪除/.test(afterStatus), `畫面說明還原語意（${afterStatus.slice(0, 40)}…）`);
        await browser.screenshot(path.join(SHOTS, '03-還原完成.png'));

        // ---------- 5. 被改過的備份要拒絕 ----------
        const tampered = await browser.evaluate(`
            const bad = { meta: { checksum: 'deadbeef' }, tables: { competitions: [{ id: 100, name: '偷改的' }] } };
            return runRestoreFromText(JSON.stringify(bad), true, 'bad.json')
                .then(() => 'NO_ERROR')
                .catch((e) => String(e.message || e));
        `);
        check(/checksum/.test(tampered), `checksum 不符會被拒絕（${tampered.slice(0, 60)}）`);
        check(state.tables.competitions.find((c) => c.id === 100).name === '春季盃（還原後的名字）', '被拒絕的還原沒有動到資料');

        // ---------- 6. 權限 ----------
        const perms = await browser.evaluate(`
            return { admin: CM_MENU_PERMISSIONS.admin.backup, super: CM_MENU_PERMISSIONS.super_admin.backup, guest: CM_MENU_PERMISSIONS.guest.backup };
        `);
        check(perms.super === true && perms.admin === false && perms.guest === false, '權限表：只有 super_admin／web_owner 看得到備份功能');

        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));
        exitCode = fail === 0 ? 0 : 1;
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }

    console.log(`\n══════ 備份與還原介面檢查：${pass} 通過 / ${fail} 失敗 ══════`);
    console.log(`截圖：${SHOTS}`);
    process.exit(exitCode);
})().catch((err) => {
    console.error('❌ 檢查腳本本身出錯：', err);
    process.exit(1);
});
