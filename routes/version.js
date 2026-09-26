/* 版本與更新紀錄（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/version')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */

module.exports = function registerVersionRoutes(app, ctx) {
    const { versionHandler } = ctx;
app.get('/api/version', versionHandler);

// ---------- v2.25.0：推播設定（時間與事件）----------
//
// 存在既有的 app_settings 鍵值表裡（不新增資料表、不需要 migration）。
// 讀不到（例如資料庫少這張表）時一律用預設值，絕不讓推播整個壞掉。
};
