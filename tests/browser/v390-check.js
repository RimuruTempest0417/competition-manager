/* v3.9.0：賽事回顧報告、系列賽總積分、報名表自訂欄位的介面檢查
 *   真實 Chrome ＋ 本機 server ＋ 假 Supabase。依使用者指示：不寫任何截圖檔、不下載任何檔案。
 *
 * 為什麼要有這一支（node --test 抓不到的部分）：
 *   - 表單裡的「自訂欄位編輯器」是動態產生的 DOM，單元測試只驗得到規則、驗不到畫面接得對不對
 *   - 回顧報告的按鈕只在「開打／結束」後出現，卡片的狀態判斷接錯就只有肉眼看得出來
 *   - 報名彈窗要真的把欄位畫出來、填錯要真的顯示紅字
 */
const path = require('node:path');
const { once } = require('node:events');
const { Browser } = require('./lib/cdp');
const { startFakeSupabase } = require('../support/fake-supabase');

const PORT = Number(process.env.CHECK_PORT || 3329);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'owner390';
const PLAYER = 'coach390';
const PASS = 'checkpass123';
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString();

let pass = 0;
let fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) { pass++; console.log(`   ✅ ${label}`); }
    else { fail++; console.log(`   ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

/* 系列：700（根）＋ 701、702（子場次）；703 是「已結束」的賽事，用來看回顧報告 */
const SERIES_FIELDS = [
    { key: 'size', label: '衣服尺寸', type: 'select', required: true, options: ['S', 'M', 'L'] },
    { key: 'phone', label: '聯絡電話', type: 'text', required: true }
];

function seedState() {
    return {
        tables: {
            admin_users: [
                { id: 1, username: ADMIN, password: PASS, role: 'web_owner', is_active: true, created_at: daysAgo(90) },
                { id: 2, username: PLAYER, password: PASS, role: 'user', is_active: true, created_at: daysAgo(30) }
            ],
            competitions: [
                { id: 700, name: '秋季系列 第一站', location: '澳門運動場', date: '2027-03-01', time: '09:00',
                  is_registration_open: true, max_registrations: 30, waitlist_enabled: true, requires_approval: false,
                  is_deleted: false, created_at: daysAgo(10), series_points: { points: [10, 8, 6, 5] },
                  form_fields: SERIES_FIELDS },
                { id: 701, name: '秋季系列 第二站', location: '澳門運動場', date: '2027-03-08', time: '09:00',
                  is_registration_open: true, max_registrations: 30, waitlist_enabled: true, requires_approval: false,
                  is_deleted: false, created_at: daysAgo(10), recurrence_parent_id: 700 },
                { id: 702, name: '秋季系列 第三站', location: '澳門運動場', date: '2027-03-15', time: '09:00',
                  is_registration_open: true, max_registrations: 30, waitlist_enabled: true, requires_approval: false,
                  is_deleted: false, created_at: daysAgo(10), recurrence_parent_id: 700 },
                { id: 703, name: '夏季盃（已結束）', location: '氹仔運動場', date: daysAgo(20).slice(0, 10), time: '09:00',
                  is_registration_open: false, max_registrations: 20, waitlist_enabled: false, requires_approval: false,
                  is_deleted: false, created_at: daysAgo(60) }
            ],
            registrations: [
                { id: 1, competition_id: 703, user_id: 3, username: '阿明', status: 'confirmed', is_deleted: false, attended_at: daysAgo(20), created_at: daysAgo(30) },
                { id: 2, competition_id: 703, user_id: 4, username: '阿華', status: 'confirmed', is_deleted: false, attended_at: null, created_at: daysAgo(30) },
                { id: 3, competition_id: 703, user_id: 5, username: '小美', status: 'waitlisted', is_deleted: false, attended_at: null, created_at: daysAgo(31) },
                { id: 11, competition_id: 700, user_id: 3, username: '阿明', status: 'confirmed', is_deleted: false, created_at: daysAgo(9) },
                { id: 12, competition_id: 701, user_id: 4, username: '阿華', status: 'confirmed', is_deleted: false, created_at: daysAgo(9) },
                { id: 13, competition_id: 701, user_id: 3, username: '阿明', status: 'confirmed', is_deleted: false, created_at: daysAgo(9) },
                { id: 14, competition_id: 702, user_id: 5, username: '小美', status: 'confirmed', is_deleted: false, created_at: daysAgo(9) }
            ],
            competition_results: [
                { id: 1, competition_id: 703, registration_id: 1, username: '阿明', rank: 1, status: 'finished', score_text: '12.50' },
                { id: 2, competition_id: 703, registration_id: 2, username: '阿華', rank: 2, status: 'finished', score_text: '11.75' },
                { id: 21, competition_id: 700, registration_id: 11, username: '阿明', rank: 1, status: 'finished' },
                { id: 22, competition_id: 701, registration_id: 12, username: '阿華', rank: 1, status: 'finished' },
                { id: 23, competition_id: 701, registration_id: 13, username: '阿明', rank: 2, status: 'finished' },
                // v3.9.1：有出賽但未完賽（超表）→ 要在榜上看到「未完賽 +0」，不能整筆消失
                { id: 24, competition_id: 702, registration_id: 14, username: '小美', rank: null, status: 'dnf' }
            ],
            audit_logs: [], error_logs: [], app_settings: [], push_subscriptions: [], share_visits: []
        },
        nextId: { competitions: 800, registrations: 900, competition_results: 30, audit_logs: 1, error_logs: 1 },
        log: []
    };
}

const login = async (browser, username, password) => {
    await browser.waitFor(`document.getElementById('submitLoginBtn') !== null`, { timeout: 10000 });
    const fill = () => browser.evaluate(`
        document.getElementById('loginModal').classList.remove('hidden');
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        set('loginUsername', ${JSON.stringify(username)});
        set('loginPassword', ${JSON.stringify(password)});
        document.getElementById('submitLoginBtn').click();
        return true;
    `);
    await fill();
    try {
        await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 4000 });
    } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        await fill();
        await browser.waitFor(`String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 10000 });
    }
};

(async () => {
    const state = seedState();
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    process.env.SUPABASE_KEY = 'stub-key';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'v390-browser-secret';
    process.env.SITE_URL = BASE;
    delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'server.js'))];
    const app = require(path.join(__dirname, '..', '..', 'server.js'));
    const server = app.listen(PORT, '127.0.0.1');
    await once(server, 'listening');

    const browser = new Browser({ width: 1280, height: 900 });
    let exitCode = 0;
    try {
        await browser.start();
        await browser.goto(`${BASE}/`);
        await login(browser, ADMIN, PASS);
        console.log('\n══════ v3.9.0：賽事回顧報告 / 系列總積分 / 報名表自訂欄位 ══════\n');

        /* ① 已結束的賽事卡片要有「回顧報告」按鈕，未開打的不要有 */
        const buttons = await browser.evaluate(`
            return (() => {
                const html = document.documentElement.outerHTML;
                return {
                    review: html.indexOf('data-action="view-review"') >= 0,
                    series: html.indexOf('data-action="view-series"') >= 0,
                    reviewIds: (html.match(/data-action="view-review" data-id="(\\d+)"/g) || []).map((s) => s.replace(/\\D+/g, ''))
                };
            })()
        `);
        check(buttons.review, '已結束的賽事卡片出現「📊 回顧報告」');
        check(buttons.reviewIds.indexOf('703') >= 0, '按鈕指的是那場已結束的賽事（703）', JSON.stringify(buttons.reviewIds));
        check(buttons.reviewIds.indexOf('700') < 0, '還沒開打的系列賽不會出現回顧按鈕');
        check(buttons.series, '系列賽出現「🏆 系列總積分」按鈕');

        /* ② 回顧報告彈窗：人數、到場率、頒獎台 */
        await browser.evaluate(`CMReview.open(703); return true;`);
        await browser.waitFor(`document.getElementById('reviewBody').innerText.indexOf('到場率') >= 0`, { timeout: 8000 });
        const reviewText = await browser.evaluate(`return document.getElementById('reviewBody').innerText`);
        check(/50%/.test(reviewText), '到場率算得出來（1／2＝50%）', reviewText.slice(0, 80));
        check(reviewText.indexOf('阿明') >= 0 && reviewText.indexOf('阿華') >= 0, '頒獎台帶出前兩名');
        check(/報名總數\s*3|3/.test(reviewText), '報名總數正確');
        const reviewSvg = await browser.evaluate(`return document.getElementById('reviewBody').querySelectorAll('svg').length`);
        check(reviewSvg >= 1, '到場率圓環是手寫 SVG（沒有引入圖表套件）');

        /* ③ 系列總積分：跨場次累加 */
        await browser.evaluate(`CMReview.openSeries(700); return true;`);
        await browser.waitFor(`document.getElementById('seriesBody').innerText.indexOf('總分') >= 0 || document.getElementById('seriesBody').innerText.indexOf('積分') >= 0`, { timeout: 8000 });
        const seriesText = await browser.evaluate(`return document.getElementById('seriesBody').innerText`);
        check(seriesText.indexOf('秋季系列 第一站') >= 0, '顯示系列名稱', seriesText.slice(0, 60));
        check(seriesText.indexOf('阿明') >= 0 && seriesText.indexOf('阿華') >= 0, '兩位選手都在榜上');
        check(/18/.test(seriesText), '阿明 10（第1站冠軍）＋8（第2站亞軍）＝18 分', seriesText.slice(0, 120));
        check(seriesText.indexOf('共 3 場') >= 0, '系列場次數正確（3 場）');
        // v3.9.1：超表（未完賽）＝0 分，但仍然要出現在排行與每一場的明細裡
        check(seriesText.indexOf('小美') >= 0, '★v3.9.1：只有未完賽紀錄的人也要在榜上（不是整筆消失）', seriesText.slice(0, 200));
        const dnfRow = await browser.evaluate(`
            const details = document.querySelectorAll('#seriesBody details');
            if (!details.length) return '（沒有每一場的明細區塊）';
            details[0].open = true;
            // 只看明細表（排行表在最外層，那一列只有總分，不會有「未完賽」）
            const rows = Array.from(details[0].querySelectorAll('table tbody tr'));
            const hit = rows.find((tr) => tr.textContent.indexOf('小美') >= 0);
            if (!hit) return '（明細表裡找不到小美）';
            return hit.textContent.split(/\s+/).filter(Boolean).join(' ');
        `);
        check(dnfRow.indexOf('未完賽') >= 0 && dnfRow.indexOf('+0') >= 0,
            `★v3.9.1：未完賽那一場顯示「未完賽 +0」（不是空白或「—」）`, dnfRow.slice(0, 120));

        /* ③-b ★v3.9.2：彈窗按鈕真的按得動（CSP `script-src 'self'` 會把行內 onclick 直接擋掉，
           按鈕看起來正常、按下去完全沒反應 —— v3.9.0 就是這樣壞的） */
        await browser.evaluate(`
            window.__cspViolations = [];
            document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.effectiveDirective || 'csp'));
            return true;
        `);
        const closeBy = async (label, modalId, buttonId) => {
            await browser.evaluate(`CMReview.open(703); CMReview.openSeries(700); return true;`);
            await browser.evaluate(`document.getElementById('${modalId}').classList.remove('hidden'); return true;`);
            await browser.evaluate(`document.getElementById('${buttonId}').click(); return true;`);
            await new Promise((r) => setTimeout(r, 150));
            const hidden = await browser.evaluate(`return document.getElementById('${modalId}').classList.contains('hidden')`);
            check(hidden, `★v3.9.2：${label} 按下去真的會關掉彈窗`, `hidden=${hidden}`);
        };
        await closeBy('回顧報告的 ✕', 'reviewModal', 'reviewCloseBtn');
        await closeBy('回顧報告的「關閉」', 'reviewModal', 'reviewCloseBtn2');
        await closeBy('系列總積分的 ✕', 'seriesModal', 'seriesCloseBtn');
        await closeBy('系列總積分的「關閉」', 'seriesModal', 'seriesCloseBtn2');

        // 回顧報告內文那顆「🏆 看這個系列的總積分」是動態產生的 → 用委派監聽，也要真的能開
        await browser.evaluate(`CMReview.open(703); return true;`);
        await browser.waitFor(`document.querySelector('#reviewBody [data-series-root]') !== null`, { timeout: 8000 });
        await browser.evaluate(`document.querySelector('#reviewBody [data-series-root]').click(); return true;`);
        await browser.waitFor(`!document.getElementById('seriesModal').classList.contains('hidden')`, { timeout: 5000 });
        const opened = await browser.evaluate(`return document.getElementById('seriesBody').innerText.slice(0, 40)`);
        check(opened.length > 3, '★v3.9.2：回顧報告裡的「看這個系列的總積分」按得動', opened);
        await browser.evaluate(`CMReview.closeSeries(); return true;`);

        // 複製文字摘要：真的把文字送去剪貼板（樁掉 clipboard 以免無頭環境被拒）
        const copied = await browser.evaluate(`
            return (async () => {
                window.__copied = null;
                try {
                    Object.defineProperty(navigator, 'clipboard', { configurable: true,
                        value: { writeText: async (t) => { window.__copied = t; } } });
                } catch (err) { /* 改不動就用真的剪貼板 */ }
                CMReview.open(703);
                await new Promise((r) => setTimeout(r, 600));
                document.getElementById('reviewCopyBtn').click();
                await new Promise((r) => setTimeout(r, 300));
                return window.__copied ? window.__copied.slice(0, 30) : '(沒送出文字)';
            })()
        `);
        check(copied.indexOf('回顧報告') >= 0, '★v3.9.2：複製文字摘要按鈕有作用', copied);

        // 這一整套流程（回顧／系列／報名與欄位編輯）不應該有任何 CSP 違規：
        // 行內 onclick 會被 script-src-attr 擋（按鈕變啞的）、行內 style 會被 style-src-attr 擋（樣式安靜失效）
        const violations = await browser.evaluate(`return window.__cspViolations.slice(0, 5)`);
        check(violations.length === 0, '★v3.9.2：整個流程沒有 CSP 違規（行內事件／行內 style）', JSON.stringify(violations));

        // 長條圖寬度真的套用（行內 style 被擋時會變成 0 或整條）
        const barInfo = await browser.evaluate(`
            CMReview.openSeries(700);
            await new Promise((r) => setTimeout(r, 600));
            const bars = Array.from(document.querySelectorAll('#seriesBody .cm-bar-0, #seriesBody [class*="cm-bar-"]'));
            const widths = bars.map((b) => b.getBoundingClientRect().width);
            return { count: bars.length, widths };
        `);
        check(barInfo.count >= 2 && barInfo.widths[0] > barInfo.widths[barInfo.widths.length - 1],
            '★v3.9.2：積分長條的寬度真的套用了（用類別，不是被擋掉的行內 style）', JSON.stringify(barInfo));
        await browser.evaluate(`CMReview.closeSeries(); return true;`);

        /* ④ 報名彈窗：自訂欄位畫得出來、必填會擋、選項來自設定 */
        await browser.evaluate(`CMReview.closeSeries(); return true;`);
        await browser.evaluate(`openRegisterModal(700); return true;`);
        await browser.waitFor(`document.querySelectorAll('#registerCustomFields [data-field-key]').length > 0`, { timeout: 8000 });
        const fieldInfo = await browser.evaluate(`
            return (() => {
                const wrap = document.getElementById('registerCustomFields');
                const select = wrap.querySelector('select[data-field-key="size"]');
                return {
                    count: wrap.querySelectorAll('[data-field-key]').length,
                    options: select ? Array.from(select.options).map((o) => o.value) : [],
                    labels: wrap.innerText
                };
            })()
        `);
        check(fieldInfo.count === 2, '兩個自訂欄位都畫出來了', String(fieldInfo.count));
        check(fieldInfo.options.join(',') === ',S,M,L', '下拉選項來自主辦設定（＋一個「請選擇」）', fieldInfo.options.join(','));
        check(fieldInfo.labels.indexOf('衣服尺寸') >= 0, '欄位標籤顯示正確');

        // 沒填就送出 → 要出現紅字、而且不該送出
        await browser.evaluate(`
            document.getElementById('registerTeamName') && (document.getElementById('registerTeamName').value = '');
            confirmRegister();
            return true;
        `);
        await new Promise((r) => setTimeout(r, 600));
        const errText = await browser.evaluate(`
            return (() => {
                const wrap = document.getElementById('registerCustomFields');
                const shown = Array.from(wrap.querySelectorAll('[id$="_err"]')).filter((el) => !el.classList.contains('hidden'));
                return { count: shown.length, text: shown.map((el) => el.textContent).join('｜') };
            })()
        `);
        check(errText.count >= 2 && /衣服尺寸/.test(errText.text), '必填沒填會逐欄顯示紅字（不是只彈一句錯誤）', errText.text);

        // 選項外的值不可能從畫面產生：確認送出的內容只會有白名單欄位
        const payloadCheck = await browser.evaluate(`
            return (() => {
                const wrap = document.getElementById('registerCustomFields');
                const set = (k, v) => { const el = wrap.querySelector('[data-field-key="' + k + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
                set('size', 'M');
                set('phone', '9123 4567');
                return CMRegistrationForm.validate(wrap);
            })()
        `);
        check(payloadCheck.ok && payloadCheck.clean.size === 'M' && payloadCheck.clean.phone === '9123 4567',
            '填好之後本機驗證通過、只帶白名單欄位', JSON.stringify(payloadCheck.clean));
        await browser.evaluate(`closeRegisterModal(); return true;`);

        /* ⑤ 管理員在表單裡新增自訂欄位 → 存檔 → 讀回 API 確認真的存進資料庫 */
        await browser.evaluate(`
            startEdit(700);
            document.getElementById('formFieldsEditor').scrollIntoView();
            addFormField();
            return true;
        `);
        await browser.waitFor(`document.querySelectorAll('#formFieldsEditor [data-field-row]').length === 3`, { timeout: 6000 });
        await browser.evaluate(`
            const rows = document.querySelectorAll('#formFieldsEditor [data-field-row]');
            const last = rows[rows.length - 1];
            const label = last.querySelector('[data-ff="label"]');
            label.value = '是否需要接駁車';
            label.dispatchEvent(new Event('input', { bubbles: true }));
            const type = last.querySelector('[data-ff="type"]');
            type.value = 'checkbox';
            type.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        `);
        await new Promise((r) => setTimeout(r, 300));
        const editorState = await browser.evaluate(`
            return (() => {
                const rows = document.querySelectorAll('#formFieldsEditor [data-field-row]');
                return { rows: rows.length, optionsHidden: rows[rows.length - 1].querySelector('[data-ff="options"]').classList.contains('hidden') };
            })()
        `);
        check(editorState.rows === 3, '編輯器可以新增欄位（3 個）', String(editorState.rows));
        check(editorState.optionsHidden, '改成勾選框後，選項欄位自動隱藏（不會留下看不懂的欄位）');

        /* ⑥ 真的按「發佈比賽」存檔 → 重新載入頁面 → 報名的人應該看到 3 個欄位
              （用「使用者視角」驗證，不依賴 API 回應的形狀） */
        await browser.evaluate(`
            document.getElementById('submitBtn').click();
            return true;
        `);
        await new Promise((r) => setTimeout(r, 1500));
        await browser.goto(`${BASE}/`);
        await browser.waitFor(`document.getElementById('submitLoginBtn') !== null || String(localStorage.getItem('competition_user') || '').length > 0`, { timeout: 10000 });
        await new Promise((r) => setTimeout(r, 800));
        await browser.evaluate(`openRegisterModal(700); return true;`);
        await browser.waitFor(`document.querySelectorAll('#registerCustomFields [data-field-key]').length > 0`, { timeout: 8000 });
        const afterSave = await browser.evaluate(`
            return (() => {
                const wrap = document.getElementById('registerCustomFields');
                const rows = Array.from(wrap.querySelectorAll('[data-field-key]'));
                return {
                    count: rows.length,
                    keys: rows.map((el) => el.dataset.fieldKey),
                    lastType: rows.length ? rows[rows.length - 1].type : null,
                    text: wrap.innerText
                };
            })()
        `);
        check(afterSave.count === 3, '存檔後重新載入，報名表變成 3 個欄位', JSON.stringify(afterSave.count));
        check(afterSave.text.indexOf('是否需要接駁車') >= 0, '新欄位出現在報名表上');
        check(afterSave.lastType === 'checkbox', '新欄位是勾選框（型別存對了）', String(afterSave.lastType));
        check(afterSave.keys[0] === 'size', '既有欄位的 key 沒被改掉（舊報名資料不會對不上）', JSON.stringify(afterSave.keys));
        await browser.evaluate(`closeRegisterModal(); return true;`);

        console.log(`\n══════ v3.9.0 介面檢查：${pass} 通過 / ${fail} 失敗 ══════`);
    } catch (err) {
        fail++;
        console.error('檢查中斷：', err.message);
        exitCode = 1;
    } finally {
        await browser.close().catch(() => {});
        server.close();
        stub.close();
    }
    process.exit(fail > 0 ? 1 : exitCode);
})();
