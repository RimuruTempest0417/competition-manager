/* v2.25.0：用手機尺寸的真實 Chrome 驗證「推播設定（時間與事件可設定）」
 *
 * 驗的是管理員真的操作得到的東西：
 *   ① 導覽選單有「⏰ 推播設定」（管理員以上），一般使用者看不到
 *   ② 彈窗打開顯示目前設定（預設：每日摘要開啟、09:00、四種事件都開）
 *   ③ 改時間與事件 → 儲存 → 畫面顯示變更、資料庫真的寫入、稽核日誌有紀錄（含前後值）
 *   ④ 關掉再打開：畫面顯示的就是剛存的值（回讀一致）
 *   ⑤ 壞時間（25:99）會被擋下並提示，而且不會污染資料庫
 *   ⑥ 關掉「報名審核結果通知」後，審核一筆報名完全不會去查推播訂閱
 *   ⑦ 關掉每日摘要後，排程呼叫會明確回報「每日摘要已關閉」
 *   ⑧ 過程中沒有前端例外、也不會下載任何檔案到使用者的電腦
 *
 * 用法：node tests/browser/push-settings-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3318);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-push-settings-check');
const ADMIN = 'owner-pushsettings';
const PASS = 'checkpass123';
const CRON_SECRET = 'push-settings-cron-secret';

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

const STUB_DIALOGS = `
    window.__ALERTS__ = [];
    window.alert = (m) => { window.__ALERTS__.push(String(m)); };
    window.confirm = () => true;
    return true;
`;

const login = async (browser, username, password) => {
    await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 10000 });
    const fillAndClick = () => browser.evaluate(`
        document.getElementById('loginModal').classList.remove('hidden');
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        setValue('loginUsername', ${JSON.stringify(username)});
        setValue('loginPassword', ${JSON.stringify(password)});
        document.getElementById('submitLoginBtn').click();
        return true;
    `);
    await fillAndClick();
    try {
        await browser.waitFor(`String(localStorage.getItem('auth_token') || '').length > 0`, { timeout: 4000 });
    } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        await fillAndClick();
        await browser.waitFor(`String(localStorage.getItem('auth_token') || '').length > 0`, { timeout: 10000 });
    }
};

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true },
                { id: 2, username: 'player-pushsettings', password: PASS, role: 'user', is_active: true }
            ],
            competitions: [
                {
                    id: 831, name: '推播設定測試賽', location: '澳門運動場', date: '2026-12-01', time: '09:00',
                    end_date: null, end_time: null, description: '給審核通知測試用',
                    is_registration_open: true, category: 'road', tags: [], is_team_event: false,
                    max_registrations: 20, requires_approval: true, waitlist_enabled: false,
                    registration_deadline: '2026-11-30', is_deleted: false, created_at: '2026-01-01T00:00:00.000Z'
                }
            ],
            registrations: [
                {
                    id: 7101, competition_id: 831, user_id: 91, username: 'runnerA',
                    status: 'pending', is_deleted: false, created_at: '2026-09-20T00:00:00.000Z'
                }
            ],
            teams: [],
            push_subscriptions: [
                {
                    id: 9001, user_id: 91, endpoint: 'http://127.0.0.1:9/push-stub',
                    p256dh: 'stub-p256dh', auth: 'stub-auth', is_active: true, created_at: '2026-01-01T00:00:00.000Z'
                }
            ],
            push_log: [],
            audit_logs: [],
            error_logs: [],
            app_settings: []
        },
        nextId: { registrations: 8000, audit_logs: 1000, push_log: 500, bot_detections: 100 },
        log: []
    };
}

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
    process.env.CRON_SECRET = CRON_SECRET;

    const app = require(path.join(__dirname, '..', '..', 'server.js'));
    const server = app.listen(PORT, '127.0.0.1');
    await once(server, 'listening');
    console.log(`\n🧪 推播設定介面檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        // 這個檢查不該下載任何檔案（防護裝上後，真的觸發下載會被抓到並記錄）
        await browser.guardDownloads();
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 1`, { timeout: 15000 });

        // ---------- ⓪ 頁面上方的版本號（使用者通報：一直停在 v2.18.0） ----------
        await browser.waitFor(`/v\\d+\\.\\d+\\.\\d+/.test(document.getElementById('appSubtitle').textContent)`, { timeout: 10000 });
        const versionInfo = JSON.parse(await browser.evaluate(`
            return fetch('/api/version').then((r) => r.json()).then((d) => JSON.stringify({
                subtitle: document.getElementById('appSubtitle').textContent,
                api: d.version,
                title: document.title
            }));
        `));
        check(/發佈與管理各類賽事資訊/.test(versionInfo.subtitle), `頁面上方副標正常（${versionInfo.subtitle}）`);
        check(versionInfo.subtitle.includes(`v${versionInfo.api}`),
            `副標的版本來自後端（副標 v?、後端 ${versionInfo.api}）`);
        check(!/v2\.18\.0/.test(versionInfo.subtitle), '副標不再是舊的 v2.18.0');
        check(versionInfo.title.includes(`v${versionInfo.api}`), `<title> 與後端版本一致（${versionInfo.title}）`);

        const alerts = async () => JSON.parse(await browser.evaluate(`return JSON.stringify(window.__ALERTS__ || []);`));
        const settingIn = (key) => (state.tables.app_settings.find((s) => s.key === key) || {}).value;
        const openModal = () => browser.evaluate(`
            const btn = document.getElementById('pushSettingsBtn');
            if (!btn) return false;
            btn.click();
            return true;
        `);
        const modalValues = async () => JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                visible: !document.getElementById('pushSettingsModal').classList.contains('hidden'),
                title: (document.querySelector('#pushSettingsModal h3') || {}).textContent || '',
                enabled: document.getElementById('pushDigestEnabled').checked,
                time: document.getElementById('pushDigestTime').value,
                kindNew: document.getElementById('pushDigestKindNew').checked,
                kindReminder: document.getElementById('pushDigestKindReminder').checked,
                eventReview: document.getElementById('pushEventReview').checked,
                eventPromote: document.getElementById('pushEventPromote').checked,
                hintHidden: document.getElementById('pushSettingsHint').classList.contains('hidden')
            });
        `));
        const setField = (id, checked) => browser.evaluate(`
            const el = document.getElementById('${id}');
            el.checked = ${checked ? 'true' : 'false'};
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return el.checked;
        `);
        const save = () => browser.evaluate(`document.getElementById('savePushSettingsBtn').click(); return true;`);

        // ---------- ① 選單權限 ----------
        const menu = async () => JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                adminVisible: !document.getElementById('pushSettingsBtn').classList.contains('hidden'),
                label: document.getElementById('pushSettingsBtn').textContent.trim(),
                userAllowed: !!(CM_MENU_PERMISSIONS.user && CM_MENU_PERMISSIONS.user.pushSettings),
                guestAllowed: !!(CM_MENU_PERMISSIONS.guest && CM_MENU_PERMISSIONS.guest.pushSettings),
                adminAllowed: !!(CM_MENU_PERMISSIONS.admin && CM_MENU_PERMISSIONS.admin.pushSettings)
            });
        `));
        const m = await menu();
        check(m.adminVisible, `管理員看得到推播設定按鈕（${m.label}）`);
        check(/推播設定/.test(m.label), '按鈕文字是「⏰ 推播設定」');
        check(m.adminAllowed && !m.userAllowed && !m.guestAllowed,
            `只有管理員以上看得到（admin=${m.adminAllowed}／user=${m.userAllowed}／guest=${m.guestAllowed}）`);

        // ---------- ② 開啟彈窗：預設值 ----------
        await openModal();
        await browser.waitFor(`!document.getElementById('pushSettingsModal').classList.contains('hidden')`, { timeout: 8000 });
        await browser.waitFor(`document.getElementById('pushDigestTime').value.length >= 4`, { timeout: 8000 });
        const first = await modalValues();
        check(first.visible, '彈窗打開了');
        check(/推播設定/.test(first.title), `彈窗標題是「${first.title}」`);
        check(first.enabled, '每日摘要預設是開啟的');
        check(first.time === '09:00', `摘要時間預設 09:00（${first.time}）`);
        check(first.kindNew && first.kindReminder, '摘要事件預設都開（新賽事＋開賽提醒）');
        check(first.eventReview && first.eventPromote, '即時通知預設都開（審核結果＋候補遞補）');
        check(first.hintHidden, '沒有資料庫降級提示（設定表正常）');
        await browser.screenshot(path.join(SHOTS, '01-推播設定彈窗.png'));

        // ---------- ③ 改設定並儲存 ----------
        await browser.evaluate(`
            const t = document.getElementById('pushDigestTime');
            t.value = '21:30';
            t.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await setField('pushDigestKindNew', false);
        await setField('pushEventReview', false);
        await save();
        await browser.waitFor(`!document.getElementById('pushSettingsStatus').classList.contains('hidden')`, { timeout: 10000 });

        const status = await browser.evaluate(`return document.getElementById('pushSettingsStatus').textContent;`);
        check(/已儲存/.test(status), `畫面回報已儲存（${status}）`);
        check(/21:30/.test(status), '變更清單裡有新的發送時間');
        check(/關閉/.test(status), '變更清單裡有「關閉」的字樣');

        check(settingIn('push_digest_time') === '21:30', `資料庫的摘要時間已寫入（${settingIn('push_digest_time')}）`);
        check(String(settingIn('push_digest_kind_new')) === 'false', `資料庫的「新賽事」已關閉（${settingIn('push_digest_kind_new')}）`);
        check(String(settingIn('push_event_review')) === 'false', `資料庫的「審核結果」已關閉（${settingIn('push_event_review')}）`);
        check(String(settingIn('push_event_promote')) === 'true', '沒動到的設定維持開啟（候補遞補）');

        const audit = (state.tables.audit_logs || []).filter((l) => l.action === 'UPDATE_PUSH_SETTINGS');
        check(audit.length === 1, `稽核日誌留了一筆 UPDATE_PUSH_SETTINGS（${audit.length} 筆）`);
        const auditDetails = String((audit[0] || {}).details || '');
        check(/09:00/.test(auditDetails) && /21:30/.test(auditDetails), `稽核有記下前後值（${auditDetails.slice(0, 120)}）`);

        // ---------- ④ 關掉再打開：畫面與資料庫一致 ----------
        await browser.evaluate(`document.getElementById('closePushSettingsBtn2').click(); return true;`);
        check(!(await modalValues()).visible, '彈窗關得起來');
        await openModal();
        await browser.waitFor(`document.getElementById('pushDigestTime').value === '21:30'`, { timeout: 8000 });
        const again = await modalValues();
        check(again.time === '21:30', `重開後顯示剛存的時間（${again.time}）`);
        check(!again.kindNew && again.kindReminder, '重開後勾選狀態與剛存的一致（新賽事關、開賽提醒開）');
        check(!again.eventReview && again.eventPromote, '重開後即時通知狀態一致（審核關、遞補開）');

        // ---------- ⑤ 壞時間要被擋下 ----------
        const beforeBad = settingIn('push_digest_time');

        // 先確認後端真的會拒絕（跟畫面無關，訊息也要說清楚格式）
        const apiBad = JSON.parse(await browser.evaluate(`
            const token = localStorage.getItem('auth_token');
            return fetch('/api/push/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                body: JSON.stringify({ digest_time: '25:99' })
            }).then(async (r) => JSON.stringify({ status: r.status, error: (await r.json()).error }));
        `));
        check(apiBad.status === 400, `後端會拒絕壞時間（HTTP ${apiBad.status}）`);
        check(/格式/.test(String(apiBad.error)), `拒絕訊息說明格式（${apiBad.error}）`);

        // 再從畫面走一次：輸入壞時間 → 儲存 → 畫面要有提示，而且資料庫不能被污染
        await browser.evaluate(`
            const t = document.getElementById('pushDigestTime');
            t.type = 'text';           // 繞過瀏覽器原生的時間欄位限制，模擬壞輸入
            t.value = '25:99';
            return true;
        `);
        await save();
        let badAlerts = [];
        try {
            await browser.waitFor(`JSON.stringify(window.__ALERTS__).includes('時間')`, { timeout: 15000 });
            badAlerts = await alerts();
        } catch (err) {
            await save();   // 機器忙碌時偶爾慢半拍，再按一次並給出目前收到的提示
            badAlerts = await alerts();
        }
        check(badAlerts.some((msg) => /格式/.test(msg)),
            `壞時間在畫面上有明確提示（${badAlerts.slice(-1)[0] || '（沒有收到任何提示）'}）`);
        check(settingIn('push_digest_time') === beforeBad, '壞輸入不會污染資料庫');

        // 還原成正常時間，後面的檢查才不會被擋
        await browser.evaluate(`
            const t = document.getElementById('pushDigestTime');
            t.type = 'time';
            t.value = '21:30';
            return true;
        `);

        // ---------- ⑥ 關掉的即時通知真的不查訂閱 ----------
        const subQueriesBefore = state.log.filter((l) => /push_subscriptions/.test(l.url || '')).length;
        const reviewResult = JSON.parse(await browser.evaluate(`
            const token = localStorage.getItem('auth_token');
            return fetch('/api/registrations/7101/review', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                body: JSON.stringify({ action: 'approve' })
            }).then((r) => r.json().then((d) => JSON.stringify({ status: r.status, notified: d.notified })));
        `));
        const subQueriesAfter = state.log.filter((l) => /push_subscriptions/.test(l.url || '')).length;
        check(reviewResult.status === 200, `審核一筆報名成功（HTTP ${reviewResult.status}）`);
        check(settingIn('push_event_review') === 'false', '先前存的設定仍在（審核通知維持關閉）');
        check(reviewResult.notified === 0, `關掉審核通知後沒有送出任何推播（notified=${reviewResult.notified}）`);
        check(subQueriesAfter === subQueriesBefore,
            `而且連推播訂閱都沒有去查（${subQueriesBefore} → ${subQueriesAfter}）`);

        // ---------- ⑦ 關掉每日摘要 → 排程明確回報 ----------
        const cronResult = JSON.parse(await browser.evaluate(`
            const token = localStorage.getItem('auth_token');
            return fetch('/api/push/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                body: JSON.stringify({ digest_enabled: false, digest_time: '21:30' })
            }).then(() => fetch('/api/cron/reminders', { headers: { Authorization: 'Bearer ${CRON_SECRET}' } }))
              .then((r) => r.json().then((d) => JSON.stringify({ digest: d.digest })));
        `));
        check(cronResult.digest && cronResult.digest.ran === false && /每日摘要已關閉/.test(cronResult.digest.reason),
            `排程回報摘要已關閉（${cronResult.digest && cronResult.digest.reason}）`);
        check(cronResult.digest && cronResult.digest.scheduled === '21:30',
            `排程用的是設定裡的時間（${cronResult.digest && cronResult.digest.scheduled}）`);

        await browser.screenshot(path.join(SHOTS, '02-設定完成後.png'));

        // ---------- ⑧ 沒有例外、沒有下載 ----------
        const downloads = JSON.parse(await browser.evaluate(`return JSON.stringify(window.__downloads || []);`));
        check(downloads.length === 0, `過程中沒有下載任何檔案（攔到 ${downloads.length} 個）`);
        check(browser.pageErrors.length === 0, '過程中沒有前端例外', browser.pageErrors.join(' | ').slice(0, 200));

        exitCode = fail === 0 ? 0 : 1;
    } catch (err) {
        console.log(`   ❌ 檢查腳本執行失敗：${err.message}`);
        exitCode = 1;
    } finally {
        await browser.close();
        server.close();
        stub.close();
    }
    console.log(`\n══════ 推播設定介面檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
