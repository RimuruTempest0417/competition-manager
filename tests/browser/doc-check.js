/* v3.3.0（P1-6）：賽事規程 PDF 附件介面檢查（真實 Chrome）
 *
 * 驗的是「管理員放得上去、所有人都打開得了、拿得下來」：
 *   ① 沒有附件的賽事：卡片沒有規程按鈕，編輯表單提示可以上傳
 *   ② 選檔 → 出現「上傳規程」→ 上傳 → 卡片長出「📘 規程」按鈕
 *   ③ 上傳後資料庫內容與原檔位元組完全相同（不是壞掉的字串）
 *   ④ 訪客（未登入）也看得到按鈕，而且能讀到同一份 PDF
 *   ⑤ 按鈕是「另開新視窗」的連結，指向規程端點（不是下載到電腦）
 *   ⑥ 移除後按鈕消失、端點回 404
 *   ⑦ 非 PDF 檔與過大檔案在畫面上就被擋住（不會送出請求）
 *   ⑧ 每個動作都留稽核（UPLOAD_DOC／DELETE_DOC）
 *   ⑨ 沒有前端例外
 *
 * 注意：全程不寫任何檔案到磁碟（檔案用頁面內建的 File 物件假造，
 * 下載在 CDP 與頁面層都被攔住）。
 *
 * 用法：node tests/browser/doc-check.js
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3331);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-doc-check');
const ADMIN = 'owner-doc';
const PASS = 'checkpass123';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const PDF_BYTES = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'latin1'
);
const PDF_B64 = PDF_BYTES.toString('base64');
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

const comp = (id, name, extra) => Object.assign({
    id, name, location: '澳門運動場', date: '2026-12-01', time: '09:00', description: '',
    is_registration_open: true, category: 'track', tags: [], is_team_event: false,
    max_registrations: 32, requires_approval: false, waitlist_enabled: false,
    is_deleted: false, created_at: daysAgo(3), created_by: ADMIN, poster_updated_at: null
}, extra || {});

function seedState() {
    return {
        tables: {
            admin_users: [{ id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true, created_at: daysAgo(90), last_login_at: daysAgo(1) }],
            competitions: [
                comp(701, '已有規程的賽事'),
                comp(702, '還沒有規程的賽事')
            ],
            competition_docs: [{
                competition_id: 701, label: '既有規程', mime: 'application/pdf',
                bytes: PDF_BYTES.length, data: PDF_B64, uploaded_by: ADMIN, uploaded_at: daysAgo(2)
            }],
            registrations: [], error_logs: [], audit_logs: [], app_settings: [],
            push_subscriptions: [], push_log: [], competition_posters: []
        },
        nextId: { audit_logs: 1, error_logs: 1 },
        missingTables: [],
        log: []
    };
}

/* 頁面上的原生對話框會「卡住整個頁面」，連 CDP 都會逾時（踩過兩次）。
   所以每次重新載入頁面後都要重新蓋掉 confirm 與 alert。 */
const stubDialogs = (browser) => browser.evaluate(`
    window.confirm = () => true;
    window.alert = () => {};
    return true;
`);

const login = async (browser) => {
    await browser.evaluate(`
        document.getElementById('loginModal').classList.remove('hidden');
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set('loginUsername', ${JSON.stringify(ADMIN)});
        set('loginPassword', ${JSON.stringify(PASS)});
        document.getElementById('submitLoginBtn').click();
        return true;
    `);
    await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 800));
    await stubDialogs(browser);
};

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
    console.log(`\n🧪 賽事規程 PDF 附件檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    let exitCode = 1;
    let browser = null;
    const auditsOf = (action) => state.tables.audit_logs.filter((a) => a.action === action);
    const cardButtonText = async (id) => JSON.parse(await browser.evaluate(`
        const card = document.querySelector('[data-comp-id="${id}"]');
        const link = card ? card.querySelector('a[href*="/doc"]') : null;
        return JSON.stringify({ has: !!link, text: link ? link.textContent.trim() : null, href: link ? link.getAttribute('href') : null, blank: link ? link.getAttribute('target') : null });
    `));

    try {
        browser = await Browser.launch({ width: 1440, height: 950 });
        await browser.guardDownloads();
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await login(browser);

        /* ── ① 卡片按鈕依有沒有附件出現 ── */
        const withDoc = await cardButtonText(701);
        const withoutDoc = await cardButtonText(702);
        check(withDoc.has, '已有規程的賽事，卡片上有規程按鈕');
        check(withDoc.text.includes('既有規程'), `按鈕文字帶出附件名稱（${withDoc.text}）`);
        check(withDoc.blank === '_blank', '規程是另開新視窗的連結（不會蓋掉目前的頁面）');
        check(!withoutDoc.has, '沒有規程的賽事，卡片上不會有空按鈕');

        /* ── ⑤ 讀得到既有規程，而且位元組相同 ── */
        const readExisting = JSON.parse(await browser.evaluate(`
            return fetch('/api/competitions/701/doc').then(async (r) => {
                const buf = new Uint8Array(await r.arrayBuffer());
                return JSON.stringify({ status: r.status, type: r.headers.get('content-type'), len: buf.length, head: String.fromCharCode.apply(null, Array.from(buf.slice(0, 5))) });
            });
        `));
        check(readExisting.status === 200 && readExisting.type === 'application/pdf', `已上傳的規程讀得到（${readExisting.status}／${readExisting.type}）`);
        check(readExisting.head === '%PDF-' && readExisting.len === PDF_BYTES.length, `內容是完整 PDF（${readExisting.len} 位元組）`);

        /* ── ② 編輯表單上傳新規程 ── */
        await browser.evaluate(`
            document.querySelector('[data-comp-id="702"] [data-action="edit-comp"]').click();
            return true;
        `);
        await browser.waitFor(`document.getElementById('docHint') !== null`);
        await new Promise((r) => setTimeout(r, 500));
        const emptyForm = JSON.parse(await browser.evaluate(`
            const label = document.getElementById('docLabel');
            const removeBtn = document.getElementById('docRemoveBtn');
            const uploadBtn = document.getElementById('docUploadBtn');
            return JSON.stringify({
                label: label ? label.value : null,
                hint: document.getElementById('docHint').textContent.trim(),
                removeHidden: removeBtn.classList.contains('hidden'),
                uploadHidden: uploadBtn.classList.contains('hidden'),
                visible: document.getElementById('docFile').offsetParent !== null
            });
        `));
        check(emptyForm.visible, '沒有規程的賽事，編輯表單看得到上傳欄位');
        check(emptyForm.removeHidden, '沒有規程時不會顯示「移除規程」');
        check(emptyForm.uploadHidden, '還沒選檔案時不會顯示「上傳規程」');

        /* 假造一個 PDF 檔（不落地）並觸發 change */
        const afterPick = JSON.parse(await browser.evaluate(`
            const bin = atob('${PDF_B64}');
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            const file = new File([bytes], '2026 規程.pdf', { type: 'application/pdf' });
            const dt = new DataTransfer();
            dt.items.add(file);
            const input = document.getElementById('docFile');
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return JSON.stringify({
                uploadHidden: document.getElementById('docUploadBtn').classList.contains('hidden'),
                hint: document.getElementById('docHint').textContent.trim()
            });
        `));
        check(!afterPick.uploadHidden, '選好檔案後出現「上傳規程」按鈕');
        check(/2026 規程\.pdf/.test(afterPick.hint), `畫面顯示選到的檔名（${afterPick.hint.slice(0, 40)}）`);

        await browser.evaluate(`document.getElementById('docUploadBtn').click(); return true;`);
        await browser.waitFor(`document.querySelector('[data-comp-id="702"] a[href*="/doc"]') !== null`, { timeout: 15000 });
        const uploaded = await cardButtonText(702);
        check(uploaded.has, '上傳後卡片長出規程按鈕');

        /* ── ③ 資料庫內容與原檔一致 ── */
        const rows = state.tables.competition_docs.filter((d) => String(d.competition_id) === '702');
        check(rows.length === 1, `資料庫只有一份（實際 ${rows.length}）`);
        check(!!rows[0] && Buffer.from(rows[0].data, 'base64').equals(PDF_BYTES), '存進資料庫的內容與原檔位元組完全相同');
        check(!!rows[0] && rows[0].uploaded_by === ADMIN, `記錄了上傳者（${rows[0] && rows[0].uploaded_by}）`);

        /* ── ⑧ 稽核 ── */
        const upAudits = auditsOf('UPLOAD_DOC');
        check(upAudits.length === 1, `上傳留了一筆稽核（實際 ${upAudits.length}）`);
        check(!!upAudits[0] && /702|還沒有規程/.test(String(upAudits[0].target_id || '') + String(upAudits[0].details || '')), '稽核指向正確的賽事');

        /* ── ⑦ 非 PDF／過大檔案在畫面就被擋 ── */
        const blockedTxt = JSON.parse(await browser.evaluate(`
            const file = new File([new Uint8Array([1, 2, 3, 4])], '報名表.txt', { type: 'text/plain' });
            const dt = new DataTransfer(); dt.items.add(file);
            const input = document.getElementById('docFile');
            input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
            return JSON.stringify({ uploadHidden: document.getElementById('docUploadBtn').classList.contains('hidden'), hint: document.getElementById('docHint').textContent.trim() });
        `));
        check(blockedTxt.uploadHidden && /PDF/.test(blockedTxt.hint), `不是 PDF 會在畫面上被擋下並說明原因（${blockedTxt.hint.slice(0, 30)}）`);

        /* 檔名假裝是 PDF、內容不是 → 前端放行（瀏覽器不一定給對的 MIME），
           但後端要用檔頭把關，而且不能改掉已存在的附件 */
        const fakePdf = JSON.parse(await browser.evaluate(`
            const file = new File([new TextEncoder().encode('這不是 PDF')], '假規程.pdf', { type: 'application/pdf' });
            const dt = new DataTransfer(); dt.items.add(file);
            const input = document.getElementById('docFile');
            input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
            const shown = !document.getElementById('docUploadBtn').classList.contains('hidden');
            document.getElementById('docUploadBtn').click();
            return JSON.stringify({ uploadShown: shown });
        `));
        await new Promise((r) => setTimeout(r, 1200));
        const fakePdfHint = JSON.parse(await browser.evaluate(`return JSON.stringify({ hint: document.getElementById('docHint').textContent.trim() });`));
        check(fakePdf.uploadShown && /PDF/.test(fakePdfHint.hint), `假 PDF 被後端擋下並在畫面說明（${fakePdfHint.hint.slice(0, 40)}）`);
        const stillOne = state.tables.competition_docs.filter((d) => String(d.competition_id) === '702');
        check(stillOne.length === 1 && Buffer.from(stillOne[0].data, 'base64').equals(PDF_BYTES), '假 PDF 沒有覆蓋掉原本的附件');

        const blockedBig = JSON.parse(await browser.evaluate(`
            const big = new Uint8Array(3 * 1024 * 1024 + 1024);
            big.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);   // %PDF-
            const file = new File([big], '太大的規程.pdf', { type: 'application/pdf' });
            const dt = new DataTransfer(); dt.items.add(file);
            const input = document.getElementById('docFile');
            input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
            return JSON.stringify({ uploadHidden: document.getElementById('docUploadBtn').classList.contains('hidden'), hint: document.getElementById('docHint').textContent.trim() });
        `));
        check(blockedBig.uploadHidden && /3MB/.test(blockedBig.hint), `超過 3MB 會被擋下（${blockedBig.hint.slice(0, 30)}）`);
        check(state.tables.competition_docs.filter((d) => String(d.competition_id) === '702').length === 1, '被擋下的檔案沒有送出任何請求');

        /* ── ⑤ 按鈕指向端點、且是另開視窗（不是下載到電腦） ── */
        const opened = JSON.parse(await browser.evaluate(`
            window.__opened = [];
            document.addEventListener('click', (e) => {
                const a = e.target.closest('a[href*="/doc"]');
                if (a) { e.preventDefault(); window.__opened.push(a.getAttribute('href')); }
            }, true);
            document.querySelector('[data-comp-id="702"] a[href*="/doc"]').click();
            return JSON.stringify(window.__opened);
        `));
        check(opened.length === 1 && opened[0].includes('/api/competitions/702/doc'), `點規程按鈕開啟規程網址（${opened[0] || '無'}）`);

        /* ── ④ 訪客也看得到、讀得到 ── */
        await browser.evaluate(`
            localStorage.removeItem('auth_token');
            localStorage.removeItem('competition_user');
            return true;
        `);
        await browser.goto(BASE);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 20000 });
        await new Promise((r) => setTimeout(r, 800));
        const visitorCard = await cardButtonText(702);
        check(visitorCard.has, '訪客（未登入）也看得到規程按鈕');
        const visitorRead = JSON.parse(await browser.evaluate(`
            return fetch('/api/competitions/702/doc').then(async (r) => {
                const buf = new Uint8Array(await r.arrayBuffer());
                return JSON.stringify({ status: r.status, len: buf.length, head: String.fromCharCode.apply(null, Array.from(buf.slice(0, 5))) });
            });
        `));
        check(visitorRead.status === 200 && visitorRead.head === '%PDF-' && visitorRead.len === PDF_BYTES.length,
            `訪客讀到的規程與管理員完全相同（${visitorRead.status}，${visitorRead.len} 位元組）`);
        const visitorNoEdit = JSON.parse(await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="702"]');
            return JSON.stringify({ edit: !!card.querySelector('[data-action="edit-comp"]') });
        `));
        check(!visitorNoEdit.edit, '訪客看不到「編輯」（上傳入口只有管理員有）');

        /* ── ⑥ 移除 ── */
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await login(browser);
        await stubDialogs(browser);
        await browser.evaluate(`
            document.querySelector('[data-comp-id="702"] [data-action="edit-comp"]').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('docRemoveBtn').classList.contains('hidden')`, { timeout: 10000 });
        await browser.evaluate(`document.getElementById('docRemoveBtn').click(); return true;`);
        await browser.waitFor(`document.querySelector('[data-comp-id="702"] a[href*="/doc"]') === null`, { timeout: 15000 });
        const afterRemove = await cardButtonText(702);
        check(!afterRemove.has, '移除後卡片上的規程按鈕消失');
        check(state.tables.competition_docs.filter((d) => String(d.competition_id) === '702').length === 0, '資料庫裡的附件真的被刪掉');
        check(auditsOf('DELETE_DOC').length === 1, `移除留了一筆稽核（實際 ${auditsOf('DELETE_DOC').length}）`);
        const gone = JSON.parse(await browser.evaluate(`
            return fetch('/api/competitions/702/doc').then((r) => r.status).then((s) => JSON.stringify({ status: s }));
        `));
        check(gone.status === 404, `移除後端點回 404（實際 ${gone.status}）`);
        check((await cardButtonText(701)).has, '另一場賽事的規程不受影響');

        /* ── ⑨ 前端例外 ── */
        check(browser.pageErrors.length === 0, '沒有未捕捉的前端例外', browser.pageErrors.join(' | ').slice(0, 200));

        await browser.screenshot(path.join(SHOTS, 'doc-check.png'));
        console.log(`\n══════ 賽事規程附件檢查：${pass} 通過 / ${fail} 失敗 ══════`);
        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.log(`\n❌ 檢查腳本執行失敗：${err.message}`);
        console.log(String(err.stack || '').split('\n').slice(1, 4).join('\n'));
        exitCode = 1;
    } finally {
        try { if (browser) await browser.close(); } catch (err) { /* 忽略 */ }
        server.close();
        stub.close();
    }
    process.exit(exitCode);
})();
