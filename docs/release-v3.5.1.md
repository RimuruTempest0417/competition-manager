# v3.5.1 — 熱修：v3.5.0 的 CORS／CSRF 在 Vercel 反代後面把自家請求當成跨站

**一句話**：v3.5.0 上線後對正式站實測發現——**自家網域的 POST 被 CSRF 檢查擋成 403**。
根因是判斷「是不是自家來源」時比對了 scheme，而伺服器在 Vercel 的 proxy 後面（`req.protocol` 是 `http`）。
本版改成只比對主機名稱（並接受 `X-Forwarded-Proto`），並移除平台層那條會與 Express 重複的 ACAO 標頭。

## 怎麼發現的（不是靠猜）

v3.5.0 部署完成、`GET /api/version` 讀回 `3.5.0` 之後，對**正式站**做了 7 項安全性質實測：

| 測項 | v3.5.0 實際結果 | 應為 |
|---|---|---|
| ① 第三方來源 `GET`：不可有 ACAO | 回 `access-control-allow-origin: https://competition-manager-hazel.vercel.app` | 無此標頭 |
| ② 自家來源 `GET` | 回自家來源（正確） | 反射自家來源 |
| ③ 帶 cookie＋跨站 Origin 的 `POST` | **403** ✅ | 403 |
| ④ 帶 cookie＋**自家** Origin 的 `POST` | **403** ❌ | 不該是 403 |
| ⑤ 無 Origin（腳本／cron 形狀） | 400（端點本身的拒絕） ✅ | 不受 CSRF 影響 |
| ⑥ 密碼錯誤的登入 | 401、無任何 `Set-Cookie` ✅ | 401 |
| ⑦ 訪客讀公開端點 | 200 ✅ | 200 |

**④ 就是線上真實故障**：瀏覽器送出的 `Origin` 是 `https://…`，而伺服器算出來的「自家來源」是 `http://…`（Vercel 終結 TLS，Express 沒設 `trust proxy`）→ 對不上 → 每一個登入使用者的寫入操作都會 403。

## 修了什麼

1. **來源判斷改為不看 scheme，且看得懂代理**（`server.js`）：
   `allowedRequestOrigins(req)` 收集 `https://<host>`、`http://<host>`、`<X-Forwarded-Proto>://<host>` 與 `SITE_URL`、`CORS_ALLOWED_ORIGINS`，
   再比對請求的 `Origin`（或 `Referer`）。**主機名稱不同才是真正的跨站**。
2. **CORS 改為自己寫的具名中介層 `corsMiddleware`**（移除 `cors` npm 套件）：
   - 非白名單來源：**完全不設** `Access-Control-Allow-Origin`（不再依賴套件對 `origin: false` 的語意）。
   - 白名單來源：反射該來源＋`Allow-Credentials: true`＋`Vary: Origin`。
   - `OPTIONS` 預檢：白名單回 `204` 並帶 `Allow-Methods`／`Allow-Headers`／`Max-Age`；非白名單不給 ACAO。
   - 圖層名稱刻意取 `corsMiddleware`，路由清單快照（101 條）維持不變。
3. **移除 `vercel.json` 對所有路徑硬塞的 `Access-Control-Allow-Origin`**：
   那條是平台層加的（套用到 `/(.*)`，包含靜態檔），與 Express 的標頭並存會造成**重複的 ACAO**（瀏覽器一律視為無效）。
   現在 CORS 標頭只由 Express 依白名單決定，靜態資源完全不帶。
4. **移除 `cors` 依賴**（`package.json`／`package-lock.json`），少一個不需要的套件。

## 怎麼證明修好了

| 證據 | 內容 |
|---|---|
| 新增迴歸測試 | `tests/auth-cookie-cors.test.js` 增 2 項：**重現代理形狀**（`X-Forwarded-Proto: https` ＋ `Origin: https://<host>`）→ 不可 403、ACAO 反射且不得重複；`OPTIONS` 預檢白名單 204／非白名單不給 ACAO |
| 全量測試 | `npm test` 588 項（587 通過 / 0 失敗、1 略過）；`npm run check:browser` 621 項全綠 |
| 正式站複驗 | 發佈後重跑同一組 7 項實測：① 無 ACAO、② 反射自家、③ 403、**④ 不再是 403**、⑤⑥⑦ 不變 |
| 路由守門 | 快照維持 101 條（層名 `corsMiddleware` 不變，無漂移） |

## 教訓（已寫進 skill）

**在本機全綠不代表在反代後面全綠**：`req.protocol`／`req.get('host')` 這類「由請求推導出來的環境事實」在 Vercel 這種 proxy 架構下與本機不同。
凡是拿它們做安全判斷（CSRF、CORS、絕對網址），一定要（a）在單元測試裡重現代理形狀，或（b）不要用 scheme。
另外：**平台設定的標頭（`vercel.json`）與應用程式設定的標頭會同時存在**——同一種語意的標頭只能有一個主人。
