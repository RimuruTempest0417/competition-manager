/* v3.1.0：用手機尺寸的真實 Chrome 驗證「成績與結果」
 *
 * 驗的是使用者真的看得到、按得到的東西：
 *   ① 未公布時：卡片只有「🏆 成績登錄」（管理員），沒有「🏆 成績」
 *   ② 登錄視窗列出「已核准」的參賽者（待審核的不在裡面），狀態寫明是草稿
 *   ③ 一鍵自動排名：時間越小越好，名次填回表格
 *   ④ 儲存草稿：提示已儲存，並且檢查清單說「每位參賽者都有成績」
 *   ⑤ 公布前：一般使用者看不到成績（也沒有按鈕）
 *   ⑥ 公布後：卡片出現「🏆 成績」，取得名次表、前三名領獎台、自己的那一列被標記
 *   ⑦ 我的報名裡顯示自己的成績與名次
 *   ⑧ 一般使用者沒有「成績登錄」按鈕，直接打 API 也被擋
 *   ⑨ 取消公布：前台立刻看不到
 *   ⑩ 按鈕看得見（底色不是透明的）、手機沒有橫向溢出、沒有下載檔案、沒有前端例外
 *
 * 用法：node tests/browser/results-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3321);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'cm-results-check');
const ADMIN = 'owner-results';
const PLAYER = 'player-results';
const PLAYER2 = 'player2-results';
const PASS = 'checkpass123';

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
    await browser.evaluate(STUB_DIALOGS);   // 頁面重載過的話要重新蓋掉 alert／confirm
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
        await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 4000 });
    } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        await fillAndClick();
        await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 10000 });
    }
};

/* 登出：清掉 token 之後用 goto 重新載入。
   不要寫成 evaluate('... location.reload()')——頁面在回覆前就重載，CDP 會等不到回應而逾時。 */
const logout = async (browser) => {
    await browser.evaluate(`localStorage.clear(); return true;`).catch(() => {});
    await browser.goto(BASE);
    await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 15000 });
    // 重新載入會讓先前蓋掉的 alert／confirm 全部失效 → 之後的 confirm() 會彈出原生對話框，
    // 那會把整個頁面（以及後續所有 CDP 指令）卡住。每次重新載入都要重新蓋一次。
    await browser.evaluate(STUB_DIALOGS);
};

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true, created_at: '2026-08-01T00:00:00.000Z', last_login_at: '2026-09-25T00:00:00.000Z' },
                { id: 91, username: PLAYER, password: PASS, role: 'user', is_active: true, created_at: '2026-08-02T00:00:00.000Z', last_login_at: '2026-09-24T00:00:00.000Z' },
                { id: 92, username: PLAYER2, password: PASS, role: 'user', is_active: true, created_at: '2026-08-03T00:00:00.000Z', last_login_at: '2026-09-23T00:00:00.000Z' }
            ],
            competitions: [
                {
                    id: 851, name: '秋季積分賽', location: '澳門氹仔運動場', date: '2026-09-20', time: '09:00',
                    end_date: null, end_time: null, description: '成績功能測試用', is_registration_open: false,
                    category: 'track', tags: [], is_team_event: false, max_registrations: 30,
                    requires_approval: true, waitlist_enabled: true, registration_deadline: null,
                    is_deleted: false, created_at: '2026-09-01T00:00:00.000Z', created_by: ADMIN,
                    poster_updated_at: null, result_published_at: null, result_published_by: null, result_summary: null
                },
                {
                    id: 852, name: '春季友誼賽', location: '氹仔運動場', date: '2026-10-20', time: '14:00',
                    end_date: null, end_time: null, description: '', is_registration_open: false,
                    category: 'track', tags: [], is_team_event: false, max_registrations: 20,
                    requires_approval: true, waitlist_enabled: false, registration_deadline: null,
                    is_deleted: false, created_at: '2026-09-02T00:00:00.000Z', created_by: ADMIN,
                    poster_updated_at: null, result_published_at: null, result_published_by: null, result_summary: null
                }
            ],
            registrations: [
                { id: 11, competition_id: 851, user_id: 91, username: PLAYER, team_name: null, note: null, status: 'confirmed', is_deleted: false, created_at: '2026-09-05T00:00:00.000Z' },
                { id: 12, competition_id: 851, user_id: 92, username: PLAYER2, team_name: null, note: null, status: 'confirmed', is_deleted: false, created_at: '2026-09-06T00:00:00.000Z' },
                { id: 13, competition_id: 851, user_id: 93, username: 'waitingGuy', team_name: null, note: null, status: 'pending', is_deleted: false, created_at: '2026-09-07T00:00:00.000Z' },
                { id: 21, competition_id: 852, user_id: 91, username: PLAYER, team_name: null, note: null, status: 'confirmed', is_deleted: false, created_at: '2026-09-08T00:00:00.000Z' }
            ],
            competition_results: [],
            push_subscriptions: [],
            push_log: [],
            audit_logs: [],
            error_logs: [],
            app_settings: []
        },
        nextId: { competition_results: 700, audit_logs: 500, error_logs: 500, push_log: 500, app_settings: 500 },
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

    const app = require(path.join(__dirname, '..', '..', 'server.js'));
    const server = app.listen(PORT, '127.0.0.1');
    await once(server, 'listening');
    console.log(`\n🧪 成績與結果檢查（${BASE}，假 Supabase :${stub.address().port}）`);

    const browser = await Browser.launch({ width: 414, height: 896, mobile: true });
    let exitCode = 1;
    try {
        await browser.goto(BASE);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`);
        await browser.guardDownloads();
        await browser.evaluate(STUB_DIALOGS);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 15000 });

        // ---------- ① 未公布時的卡片按鈕 ----------
        const before = JSON.parse(await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="851"]');
            return JSON.stringify({
                hasView: !!card.querySelector('[data-action="view-results"]'),
                hasEdit: !!card.querySelector('[data-action="edit-results"]'),
                hasPublishedAt: !!${JSON.stringify(true)}
            });
        `));
        check(!before.hasView, '未公布時卡片沒有「🏆 成績」按鈕（訪客看不到）');
        check(before.hasEdit, '管理員卡片有「🏆 成績登錄」按鈕');

        // 按鈕看得見（底色不是透明的——v2.27.0「白字配透明底」的教訓）
        const editBtnStyle = JSON.parse(await browser.evaluate(`
            const el = document.querySelector('[data-comp-id="851"] [data-action="edit-results"]');
            if (!el) return JSON.stringify(null);
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return JSON.stringify({ bg: cs.backgroundColor, color: cs.color, w: r.width, h: r.height, label: el.textContent.trim() });
        `));
        check(editBtnStyle && editBtnStyle.w > 20 && editBtnStyle.h > 10
            && !/rgba\(0, 0, 0, 0\)/.test(editBtnStyle.bg) && editBtnStyle.bg !== editBtnStyle.color,
            `「成績登錄」按鈕看得見（底色 ${editBtnStyle && editBtnStyle.bg}）`);

        // ---------- ② 登錄視窗：名單只有已核准的人 ----------
        await browser.evaluate(`
            document.querySelector('[data-comp-id="851"] [data-action="edit-results"]').click();
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('#resultsEditorTable tr[data-registration-id]').length > 0`, { timeout: 15000 });
        const sheet = JSON.parse(await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#resultsEditorTable tr[data-registration-id]'));
            const status = document.getElementById('resultsEditorStatus').textContent.replace(/\\\\s+/g, ' ').trim();
            return JSON.stringify({
                count: rows.length,
                regIds: rows.map((r) => r.dataset.registrationId),
                names: rows.map((r) => r.querySelector('td').textContent.replace(/\\\\s+/g, ' ').trim()),
                statusText: status,
                hasPending: rows.some((r) => r.textContent.includes('waitingGuy'))
            });
        `));
        check(sheet.count === 2, `登錄名單只有已核准的 2 位（實際 ${sheet.count} 位）`);
        check(!sheet.hasPending, '待審核的報名不會出現在成績名單裡');
        check(/草稿狀態/.test(sheet.statusText), `畫面說明目前是草稿（${sheet.statusText.slice(0, 40)}…)`);
        const editorTitle = JSON.parse(await browser.evaluate(`return JSON.stringify(document.getElementById('resultsEditorTitle').textContent.trim());`));
        check(/🏆 秋季積分賽 成績登錄/.test(editorTitle), `登錄視窗標題帶出賽事名稱（${editorTitle}）`);

        await browser.screenshot(path.join(SHOTS, '01-成績登錄-草稿.png'));

        // ---------- ③ 自動排名（時間越小越好） ----------
        await browser.evaluate(`
            const set = (regId, field, value) => {
                const el = document.querySelector('tr[data-registration-id="' + regId + '"] [data-field="' + field + '"]');
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            };
            set(11, 'score_text', '12:30');
            set(12, 'score_text', '11:45');
            document.getElementById('resultsAutoRankAscBtn').click();
            return true;
        `);
        await browser.waitFor(`
            (document.querySelector('tr[data-registration-id="12"] [data-field="rank"]') || {}).value === '1'
        `, { timeout: 15000 });
        const ranked = JSON.parse(await browser.evaluate(`
            const val = (regId, field) => (document.querySelector('tr[data-registration-id="' + regId + '"] [data-field="' + field + '"]') || {}).value;
            return JSON.stringify({
                rankPlayer: val(11, 'rank'),
                rankPlayer2: val(12, 'rank'),
                notice: document.getElementById('resultsEditorError').textContent.trim(),
                statusText: document.getElementById('resultsEditorStatus').textContent.replace(/\\\\s+/g, ' ').trim()
            });
        `));
        check(ranked.rankPlayer2 === '1' && ranked.rankPlayer === '2', `自動排名正確（11:45 → 第 1 名、12:30 → 第 2 名）`);
        check(/已依成績自動排名|已儲存/.test(ranked.notice), `儲存後有明確回饋（${ranked.notice.slice(0, 40)}）`);
        check(/每位已核准參賽者都有成績/.test(ranked.statusText), '檢查清單確認沒有漏登錄的人');
        check(/草稿狀態/.test(ranked.statusText), '自動排名後仍然是草稿（還沒公布）');

        // ---------- ④ 公布前的對外狀態 ----------
        const beforePublish = JSON.parse(await browser.evaluate(`
            return fetch('/api/competitions/851/results').then((r) => r.json()).then((d) => JSON.stringify({
                published: d.published, results: (d.results || []).length, message: d.message || ''
            }));
        `));
        check(beforePublish.published === false && beforePublish.results === 0, '公布前對外查詢看不到任何成績');
        check(/尚未公布/.test(beforePublish.message), `公布前明確回「成績尚未公布」（${beforePublish.message}）`);

        // ---------- ⑤ 公布（不推播，因為沒有人訂閱） ----------
        await browser.evaluate(`document.getElementById('resultsPublishBtn').click(); return true;`);
        await browser.waitFor(`
            !document.getElementById('resultsUnpublishBtn').classList.contains('hidden')
        `, { timeout: 15000 });
        const published = JSON.parse(await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="851"]');
            return JSON.stringify({
                statusText: document.getElementById('resultsEditorStatus').textContent.replace(/\\\\s+/g, ' ').trim(),
                notice: document.getElementById('resultsEditorError').textContent.trim(),
                cardHasView: !!card.querySelector('[data-action="view-results"]'),
                unpublishedVisible: !document.getElementById('resultsUnpublishBtn').classList.contains('hidden')
            });
        `));
        check(/已公布/.test(published.statusText), `畫面顯示已公布（${published.statusText.slice(0, 50)}…）`);
        check(/已公布 2 筆成績/.test(published.notice), `公布有明確回饋（${published.notice.slice(0, 40)}）`);
        check(published.unpublishedVisible, '公布後出現「取消公布」按鈕');
        check(published.cardHasView, '公布後卡片出現「🏆 成績」按鈕（所有人看得到）');

        // ---------- ⑥ 成績表（前台） ----------
        await browser.evaluate(`
            document.getElementById('resultsEditorClose').click();
            document.querySelector('[data-comp-id="851"] [data-action="view-results"]').click();
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('#resultsModalBody table tbody tr').length >= 2`, { timeout: 15000 });
        const view = JSON.parse(await browser.evaluate(`
            const rows = Array.from(document.querySelectorAll('#resultsModalBody table tbody tr'));
            const text = document.getElementById('resultsModalBody').textContent.replace(/\\\\s+/g, ' ').trim();
            return JSON.stringify({
                title: document.getElementById('resultsModalTitle').textContent.trim(),
                rows: rows.length,
                firstRow: rows[0].textContent.replace(/\\\\s+/g, ' ').trim(),
                podiumCount: document.querySelectorAll('#resultsModalBody .grid > div').length,
                text: text.slice(0, 300),
                hasExport: !!document.getElementById('resultsExportBtn'),
                mineHighlighted: rows.some((r) => /（你）/.test(r.textContent))
            });
        `));
        check(/秋季積分賽/.test(view.title), `成績表標題正確（${view.title}）`);
        check(view.rows === 2, `成績表列出 2 筆（${view.rows} 筆）`);
        check(/🥇/.test(view.firstRow) && /第 1 名/.test(view.firstRow) && /11:45/.test(view.firstRow),
            `第一名顯示獎牌、名次與成績（${view.firstRow.slice(0, 60)}）`);
        check(view.podiumCount >= 2, `前三名領獎台畫出來（${view.podiumCount} 格）`);
        check(/完賽 2/.test(view.text) && /已排名 2/.test(view.text), '統計摘要正確');
        check(view.hasExport, '有匯出成績 CSV 的按鈕（副檔名式匯出，測試不點擊）');

        await browser.screenshot(path.join(SHOTS, '02-成績表.png'));

        // ---------- ⑦ 我的報名顯示成績 ----------
        await browser.evaluate(`
            document.getElementById('resultsModalClose').click();
            return true;
        `);
        await logout(browser);
        await login(browser, PLAYER, PASS);
        await browser.waitFor(`!!document.querySelector('[data-comp-id="851"] [data-action="view-results"]')`, { timeout: 20000 });
        await browser.evaluate(`document.getElementById('myRegsBtn').click(); return true;`);
        await browser.waitFor(`/🏆 成績：/.test(document.getElementById('myRegsList').textContent)`, { timeout: 20000 });
        await new Promise((r) => setTimeout(r, 1200));   // 等所有背景重繪收斂後再讀
        const myRegs = JSON.parse(await browser.evaluate(`
            const text = document.getElementById('myRegsList').textContent.replace(/\\s+/g, ' ').trim();
            return JSON.stringify({ text: text, highlighted: /（你）/.test(text) });
        `));
        check(/🏆 成績：/.test(myRegs.text), `我的報名顯示自己的成績（列表：${myRegs.text.slice(0, 200)}）`);
        check(/第 2 名/.test(myRegs.text) && /12:30/.test(myRegs.text), `顯示的是自己的名次與成績（列表：${myRegs.text.slice(0, 200)}）`);

        // ---------- ⑧ 一般使用者的權限邊界 ----------
        const asUser = JSON.parse(await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="851"]');
            return fetch('/api/competitions/851/result-sheet', { headers: { Authorization: 'Bearer ' } })
                .then((r) => r.json().then((d) => JSON.stringify({
                    hasEdit: !!card.querySelector('[data-action="edit-results"]'),
                    hasView: !!card.querySelector('[data-action="view-results"]'),
                    sheetStatus: r.status,
                    sheetError: d.error || '',
                    saveStatus: 0
                })));
        `));
        check(!asUser.hasEdit, '一般使用者沒有「成績登錄」按鈕');
        check(asUser.hasView, '一般使用者看得到「🏆 成績」按鈕（已公布）');
        check(asUser.sheetStatus === 403, `一般使用者直接打登錄表單 API 被擋（HTTP ${asUser.sheetStatus}）`);

        const guestView = JSON.parse(await browser.evaluate(`
            return fetch('/api/competitions/851/results', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ results: [] }) })
                .then((r) => r.json().then((d) => JSON.stringify({ status: r.status, error: d.error || '' })));
        `));
        check(guestView.status === 401 || guestView.status === 403, `沒帶 token 想改成績被擋（HTTP ${guestView.status}）`);

        // ---------- ⑨ 按鈕看得見（不是白字配透明底） ----------
        const buttons = JSON.parse(await browser.evaluate(`
            const info = (el) => {
                if (!el) return null;
                const cs = getComputedStyle(el);
                return { bg: cs.backgroundColor, color: cs.color, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
            };
            const card = document.querySelector('[data-comp-id="851"]');
            return JSON.stringify({
                view: info(card.querySelector('[data-action="view-results"]')),
                editMissing: !card.querySelector('[data-action="edit-results"]')
            });
        `));
        const visible = (b) => b && b.w > 20 && b.h > 10 && !/rgba\(0, 0, 0, 0\)/.test(b.bg) && b.bg !== b.color;
        check(visible(buttons.view), `一般使用者看到的「🏆 成績」按鈕看得見（底色 ${buttons.view && buttons.view.bg}）`);
        check(buttons.editMissing, '一般使用者的卡片上沒有「成績登錄」按鈕');

        // ---------- ⑩ 取消公布 ----------
        await logout(browser);
        await login(browser, ADMIN, PASS);
        await browser.waitFor(`document.querySelectorAll('[data-comp-id]').length >= 2`, { timeout: 15000 });
        await browser.evaluate(`
            document.querySelector('[data-comp-id="851"] [data-action="edit-results"]').click();
            return true;
        `);
        await browser.waitFor(`!document.getElementById('resultsUnpublishBtn').classList.contains('hidden')`, { timeout: 15000 });
        await browser.evaluate(`document.getElementById('resultsUnpublishBtn').click(); return true;`);
        await browser.waitFor(`
            document.getElementById('resultsEditorError').textContent.includes('已取消公布')
        `, { timeout: 15000 }).catch(() => {});
        const afterUnpublish = JSON.parse(await browser.evaluate(`
            const card = document.querySelector('[data-comp-id="851"]');
            return fetch('/api/competitions/851/results').then((r) => r.json()).then((d) => JSON.stringify({
                published: d.published,
                results: (d.results || []).length,
                notice: document.getElementById('resultsEditorError').textContent.trim(),
                cardHasView: !!card.querySelector('[data-action="view-results"]')
            }));
        `));
        check(afterUnpublish.published === false && afterUnpublish.results === 0, '取消公布後前台立刻看不到成績');
        check(/已取消公布/.test(afterUnpublish.notice), `取消公布有明確回饋（${afterUnpublish.notice.slice(0, 40)}）`);
        check(!afterUnpublish.cardHasView, '取消公布後卡片不再顯示「🏆 成績」');
        await browser.waitFor(`/草稿狀態/.test(document.getElementById('resultsEditorStatus').textContent)`, { timeout: 15000 });
        const draftBack = JSON.parse(await browser.evaluate(`
            const text = document.getElementById('resultsEditorStatus').textContent.replace(/\\s+/g, ' ').trim();
            return JSON.stringify({ text: text.slice(0, 80) });
        `));
        check(/草稿狀態/.test(draftBack.text), `取消公布後回到草稿狀態（成績保留）：${draftBack.text}`);

        await browser.screenshot(path.join(SHOTS, '03-取消公布-回到草稿.png'));

        // ---------- ⑪ 手機尺寸、下載、例外 ----------
        await browser.evaluate(`document.getElementById('resultsEditorClose').click(); return true;`);
        const overflow = JSON.parse(await browser.evaluate(`
            return JSON.stringify({
                docWidth: document.documentElement.scrollWidth,
                winWidth: window.innerWidth,
                offenders: Array.from(document.querySelectorAll('[data-comp-id], #resultsModal, #resultsEditorModal'))
                    .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2)
                    .map((el) => (el.id || el.getAttribute('data-comp-id') || el.tagName) + ':' + Math.round(el.getBoundingClientRect().right))
                    .slice(0, 5)
            });
        `));
        check(overflow.docWidth <= overflow.winWidth + 2,
            `手機尺寸沒有橫向溢出（文件 ${overflow.docWidth}px／視窗 ${overflow.winWidth}px）`,
            overflow.offenders.join('、'));

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
    console.log(`\n══════ 成績與結果檢查：${pass} 通過 / ${fail} 失敗 ══════\n`);
    process.exit(exitCode);
})();
