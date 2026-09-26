/* v3.6.3：卡片公告的渲染（Roadmap 8.8⑥）
 *
 * 為什麼要單獨驗渲染：狀態規則在 competition-state.js（單元測試已驗），
 * 但「卡片上到底畫出什麼」是另一段程式——它如果壞了，使用者就是看不到公告，
 * 而狀態卻是對的（假綠燈）。這裡直接把 app.js 裡的 noticeBannerHtml 抽出來、
 * 餵真實的賽事資料，檢查輸出 HTML 有沒有正確顯示取消／延期／最新消息。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/* 從 app.js 抽出指定函式的原始碼（含巢狀大括號），這樣驗的就是真正上線的那段程式 */
function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start > -1, `app.js 裡找不到 ${name}()`);
    let i = source.indexOf('{', start);
    let depth = 0;
    for (let j = i; j < source.length; j += 1) {
        if (source[j] === '{') depth += 1;
        else if (source[j] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, j + 1);
        }
    }
    throw new Error(`解析 ${name}() 失敗`);
}

test('v3.6.3 卡片公告渲染', async (t) => {
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    const CMState = require(path.join(ROOT, 'public', 'js', 'competition-state.js'));

    const escapeHtml = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const sandbox = { window: { CMCompetitionState: CMState }, CMCompetitionState: CMState, escapeHtml, console };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction(appSource, 'noticeBannerHtml'), sandbox);
    const banner = (item) => sandbox.noticeBannerHtml(item);

    const base = { id: 1, name: '颱風盃', date: '2026-10-05', time: '09:00' };

    /* ① 沒有公告：不可以多畫一個空框（卡片會變得又亂又花） */
    assert.strictEqual(banner(base), '', '沒有公告時不應該輸出任何 HTML');
    assert.strictEqual(banner({ ...base, news: '   ' }), '', '只有空白的最新消息不算公告');

    /* ② 取消：要顯示⛔、原因，而且用紅色系 */
    const cancelled = banner({ ...base, cancelled_at: '2026-10-01T02:00:00.000Z', cancel_reason: '颱風來襲，場地封閉' });
    assert.ok(cancelled.includes('⛔ 賽事已取消'), '要顯示已取消');
    assert.ok(cancelled.includes('颱風來襲，場地封閉'), '要顯示取消原因（大家看得到才知道為什麼）');
    assert.ok(cancelled.includes('bg-red-50'), '取消要用紅色系，視覺上分得出輕重');
    assert.ok(!cancelled.includes('🕒'), '取消時不該同時顯示延期');

    /* ③ 延期：要同時顯示新時間與原訂時間（事後追查靠這個） */
    const postponed = banner({ ...base, postponed_date: '2026-11-15', postponed_time: '08:30' });
    assert.ok(postponed.includes('🕒 賽事延期至 2026-11-15 08:30'), '要顯示延期後的新時間');
    assert.ok(postponed.includes('原訂 2026-10-05'), '★要顯示原訂時間');
    assert.ok(postponed.includes('bg-amber-50'), '延期用琥珀色系');

    /* ④ 最新消息：不需要訂閱就看得到（這是 8.8⑥ 的核心價值） */
    const news = banner({ ...base, news: '集合時間改為 08:30', news_updated_at: '2026-10-01T02:30:00.000Z' });
    assert.ok(news.includes('📣 集合時間改為 08:30'), '要顯示最新消息內容');
    const updated = new Date('2026-10-01T02:30:00.000Z');
    const expectWhen = `${String(updated.getMonth() + 1).padStart(2, '0')}-${String(updated.getDate()).padStart(2, '0')} `
        + `${String(updated.getHours()).padStart(2, '0')}:${String(updated.getMinutes()).padStart(2, '0')}`;
    assert.ok(news.includes(expectWhen + ' 更新'), `要顯示更新時間（本地時區，不是 UTC）：預期 ${expectWhen} 更新`);
    assert.ok(news.includes('bg-blue-50'), '一般公告用藍色系');
    assert.ok(!news.includes('⛔') && !news.includes('🕒'), '只有消息時不該顯示取消或延期');

    /* ⑤ 三者並存：取消優先於延期，兩者與消息可以同時存在 */
    const all = banner({ ...base, cancelled_at: '2026-10-01T02:00:00.000Z', cancel_reason: '颱風', postponed_date: '2026-11-15', news: '請注意公告' });
    assert.ok(all.includes('⛔') && all.includes('📣'), '取消與消息可以同時顯示');
    assert.ok(!all.includes('🕒'), '已取消就不該再顯示延期（取消是最終狀態）');
    assert.ok(all.includes('bg-red-50'), '取消優先，底色用紅色');

    /* ⑥ 使用者輸入要跳脫：公告是管理員打的字，直接塞進 HTML 會出事 */
    const evil = banner({ ...base, news: '<img src=x onerror=alert(1)>' });
    assert.ok(!evil.includes('<img'), '★公告內容要跳脫，不能讓 HTML 直接執行');
    assert.ok(evil.includes('&lt;img'), '要跳脫成純文字顯示');

    /* ⑦ 卡片與彈窗讀的是同一份規則（避免兩邊各寫一套而不同步） */
    assert.ok(appSource.includes('CMCompetitionState.competitionNotice(item)'), '卡片要用共用模組算公告');
    assert.ok(!/function competitionCardHtml[\s\S]{0,4000}?\bpostponed_date\s*==/.test(appSource),
        '卡片不應該自己再寫一套判斷，否則會與狀態模組不一致');
    t.diagnostic('noticeBannerHtml 抽取自 public/js/app.js，餵真實欄位驗證輸出');
});
