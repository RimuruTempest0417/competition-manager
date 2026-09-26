# v3.5.0 — P0 安全修復：CORS 白名單 ＋ 登入憑證改 HttpOnly Cookie

**一句話**：把 2026-09-26 ZAP 被動掃描回報的 **2 個中風險**處理掉——CORS 不再回 `Access-Control-Allow-Origin: *`，
登入憑證從 `localStorage` 移到 **HttpOnly Cookie**（JavaScript 讀不到就偷不走），並補上 CSRF 第二道防線。

## 為什麼要做

ZAP 報告有 2 個中風險屬實（其餘誤報已於 8.10 留檔）：

1. **跨域配置錯誤**：`server.js` 是裸的 `app.use('/api', cors())` → 所有 API 回應都帶 `Access-Control-Allow-Origin: *`。
2. **JWT 存放於瀏覽器 localStorage**：XSS 一旦成立就能取走憑證。本專案 CSP 是 `script-src 'self'`、
   無 inline script，攻擊面很小，但「憑證能被 JS 讀到」本身就不該留著。

使用者決定：**CORS 改白名單**、**JWT 存放採 (C) 改 httpOnly cookie ＋ CSRF**、掃描報告已自行刪除、**`JWT_SECRET` 不換**。

## 改了什麼

### 1. CORS 白名單（`server.js`）

改為動態判斷：

| 來源 | 回應 |
|---|---|
| 自家網域（請求的 host，或 `SITE_URL`） | 反射該來源＋`Access-Control-Allow-Credentials: true` |
| `CORS_ALLOWED_ORIGINS` 列出的來源 | 同上 |
| 其他任何來源 | **完全不給** ACAO 標頭（瀏覽器會擋下讀取） |
| 不帶 `Origin`（curl、腳本） | 不受影響（CORS 只管瀏覽器） |

前端是同源，本來就不需要 CORS header，所以**沒有相容性風險**。

### 2. 登入憑證改存 HttpOnly Cookie

| | 之前 | 之後 |
|---|---|---|
| 登入回應 | 回傳 `token`（JS 讀得到） | **不回傳 token**（改由 `Set-Cookie: cm_token=…`） |
| 前端儲存 | `localStorage.setItem('auth_token', …)` | **完全不存**（HttpOnly cookie，JS 與 `document.cookie` 都讀不到） |
| 送出方式 | `Authorization: Bearer <token>`（手動塞） | 同源請求**自動帶 cookie** |
| cookie 屬性 | — | `HttpOnly`、`SameSite=Strict`、`Secure`（production）、`Path=/`、`Max-Age=43200`（12 小時，與 JWT 一致） |
| 登入狀態判斷 | 看 localStorage 有沒有權杖 | **問伺服器** `GET /api/auth/me`（角色一律以伺服器為準，localStorage 被改也騙不到權限） |
| 登出 | 前端清 localStorage | 呼叫 `POST /api/auth/logout` 讓**伺服器清 cookie**（並留 LOGOUT 稽核） |

涵蓋的發憑證點：`POST /api/auth/login`、`POST /api/auth/login/2fa`（含備援碼）、`POST /api/auth/register`。
兩步驟驗證的中間權杖（`challenge_token`）本來就只存在 JS 記憶體變數裡，不落地、不寫 cookie。

**向後相容**：`Authorization: Bearer` 仍然完整支援——維運腳本、Vercel Cron、正式站煙霧測試都靠它。
兩者同時出現時 **cookie 優先**（瀏覽器走 cookie，腳本沒有 cookie 自然走 Bearer）。

### 3. CSRF 第二道防線（`csrfCookieGuard`）

`SameSite=Strict` 已經是第一道；再加一層中介層：

```
帶著我們的登入 cookie ＋ POST/PUT/PATCH/DELETE ＋ 來源不是自家／白名單  → 403（跨站請求已被拒絕）
```

- 掛在 `/api` **全域**（不只掛需要登入的路由）：公開寫入端點（如 `/api/push/test`）同樣會用到登入狀態，
  也不該被別的網站借使用者的瀏覽器觸發。
- 沒有 `Origin` 也沒有 `Referer` 的請求（curl、維運腳本、Cron）**不受影響**——那種請求不會自動帶上使用者的 cookie。
- `Bearer` 憑證不受 CSRF 限制（攻擊者的網站沒辦法讓瀏覽器自動帶上它）。

## 怎麼證明有效

| 證據 | 內容 |
|---|---|
| 新增單元／API 測試 | `tests/auth-cookie-cors.test.js`：cookie 屬性（HttpOnly／SameSite=Strict／Secure／Path／Max-Age）、**回應內容不得出現任何 JWT**、帶 cookie 通過驗證／不帶 401、跨站 Origin＋cookie 的 POST 403、同源放行、`Bearer` 不受 CSRF 影響、CORS 只反射自家與白名單、登出清 cookie（`Max-Age=0`）＋LOGOUT 稽核、帶 `stage` 的權杖放進 cookie 也要被拒 |
| 既有測試 | `npm test` **586 項，585 通過 / 0 失敗**（1 項深夜跨午夜情境略過） |
| 真實瀏覽器 | `npm run check:browser` **621 項全部通過 / 0 失敗**（20→21 支檢查腳本） |
| 新增端到端安全性質檢查（真的用 Chrome 跑） | 登入後 ① `localStorage` 沒有權杖 ② `document.cookie` 讀不到憑證（HttpOnly 生效）③ 同源請求單靠 cookie 就通過驗證 |
| 路由清單守門 | 新增一層中間件 → 快照 **100 → 101 條**（`USE csrfCookieGuard`），守門測試同步更新（這是刻意的新增，非重構漂移） |
| 正式站 | 發佈後 `npm run check:prod`（煙霧＋訪客視角＋線上樣式實算） |

## 測試腳本一起更新（13 支瀏覽器檢查）

以前檢查腳本靠 `localStorage.getItem('auth_token')` 判斷「登入完成」、並手動組 `Authorization` 標頭。
這一版憑證不在 localStorage 了，所以：

- 登入完成的訊號改用 `competition_user`（顯示用資料）。
- 頁面內 `fetch` 不再手動塞 `Authorization`——同源請求自動帶 cookie。
- 「訪客」情境改成真的呼叫 `/api/auth/logout`（只清 localStorage 已經不會登出）。
- 2FA 檢查裡「有沒有憑證」的斷言改用 `GET /api/auth/me` 的狀態碼（伺服器當權威）。

## 檔案

- 修改：`server.js`（CORS 白名單、`csrfCookieGuard`、`authenticateToken` 支援 cookie、發／清 cookie 的輔助函式、`loginHandler`）、
  `routes/auth.js`（2FA 完成改發 cookie）、`routes/registrations.js`（註冊改發 cookie、登出清 cookie）、
  `public/js/app.js`（`customFetch`、`verifySession()`、登入／註冊／2FA／登出流程）、`public/js/notify.js`（不再組 Authorization）
- 測試：新增 `tests/auth-cookie-cors.test.js`、`tests/support/auth-cookie.js`；
  更新 `tests/registration-api.test.js`、`tests/twofactor-api.test.js`、13 支 `tests/browser/*-check.js`、
  `tests/fixtures/route-inventory.json`
- 文件：`README.md`（安全性實作＋環境變數＋版本歷程）、`docs/功能總覽與規劃.md`（8.2 三項改 ☑、8.9 順序、8.10 判讀）
- **沒有**任何資料庫變更、沒有 CSP 變更、沒有新增 npm 套件

## 給維運的提醒

- Vercel 上 `NODE_ENV=production` → cookie 一定是 `Secure`（僅 HTTPS 傳送）。
- 若日後要讓**其他網域**的前端呼叫 API，把它加進 `CORS_ALLOWED_ORIGINS`（逗號分隔）即可；不填＝只允許自家來源。
- 改版後**所有人不需要重新登入**：舊的 `Bearer` 仍可用，瀏覽器端下次登入就會拿到 cookie。
