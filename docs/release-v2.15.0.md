# v2.15.0 — 管理員兩步驟驗證（TOTP，純手寫不引套件）

發佈日期：2026-09-26

## 一、為什麼要做

管理員帳號能改帳號、刪資料、發推播，只有一道密碼防線。密碼一旦外洩（或與其他網站重複使用），
後台等於門戶大開。這一版為管理員以上帳號加上**第二因素**：手機上的驗證器 App。

## 二、怎麼做的（全部手寫，不引入任何外部套件）

- **`lib/totp.js`**：依 RFC 4226（HOTP）與 RFC 6238（TOTP）手寫實作，只用 Node 內建 `crypto`。
  這樣做有兩個理由：① 不想為了 6 行程式碼背一條供應鏈風險；② 前端 CSP 是嚴格的 `script-src 'self'`，
  本來就不能用 CDN 的 QR／TOTP 套件。
  正確性用**官方測試向量**驗證（RFC 4226 Appendix D 的 10 組 HOTP、RFC 6238 Appendix B 的 6 組 TOTP），
  不是「自己算的自己驗」。
- **登入分兩段**：密碼正確 → 發 **5 分鐘中間權杖**（`stage: '2fa'`）→ 輸入 App 的 6 位數才發 12 小時正式權杖。
  中間權杖在 `authenticateToken` 會**被直接拒絕**（實測拿它去讀 `/api/admin/users` 得到 401），
  所以就算被攔截也換不到任何資料。
- **防重放**：同一組驗證碼在同一個時間步只能用一次（伺服器記住 `totp_last_step`）。
  驗證容忍 ±1 個時間步，吸收手機與伺服器的時鐘差；超過就拒絕。
- **備援碼 8 組**：每組 12 碼（約 60 bit）、刻意排除容易看錯的 `0/1/8/9/I/L/O`，
  只存雜湊（每組獨立 salt，**資料庫沒有明文**）、用過即標記。剩餘 2 組以內會寫警告級日誌。
- **暴力嘗試也會被擋**：驗證碼錯誤走既有登入失敗計數（IP 10 次／帳號多來源 10 次），實測連續錯 10 次 → HTTP 429。
- **停用需要「密碼 + 一組驗證碼或備援碼」**；`2FA_ENABLED`／`2FA_DISABLED`／`2FA_RECOVERY_CODE_USED` 都留稽核紀錄。
- **手機遺失的補救**：上級管理員可在「👥 使用者管理」按「重設 2FA」（只限權限嚴格低於自己的帳號），
  留下 `2FA_RESET_BY_ADMIN` 稽核與警告級錯誤日誌。
- **未執行 migration 時完全無感**：`GET /api/auth/2fa/status` 回 `schema_ready: false`、設定端點回 503 並附上檔案路徑，
  原本的登入流程一行都不受影響（有獨立測試覆蓋）。

## 三、順手完成的另一件事

新增 **`tests/browser/prod-visitor-check.js`（正式站「訪客視角」檢查）**：
用真實 Chrome 打正式站，確認賽事卡片真的渲染出來（不是「畫面有、資料空白」）、沒有未捕捉的前端例外、
手機寬度沒有橫向溢出。開啟 RLS 之後這項檢查特別重要，已納入 `npm run check:prod`。

## 四、驗證數據（全部實跑）

| 項目 | 結果 |
|---|---|
| `npm test` | **118 / 118**（新增 TOTP 7 項、兩步驟 API 7 項） |
| `npm run check:browser`（真實 Chrome、手機尺寸） | **28 / 28**（提示橫幅 13＋兩步驟驗證全流程 15） |
| `npm run check:prod` | **54 / 54**（正式站 HTTP 煙霧 48＋訪客視角 6） |
| 線上版本 | v2.15.0 |

兩步驟驗證的瀏覽器流程檢查實際做了：密碼登入 → 開啟設定 → 產生密鑰 → **用 lib/totp 算出 App 會顯示的碼** →
啟用 → 取得 8 組備援碼 → 登出 → 再登入（此時要求第二因素）→ 錯碼被拒 → 正碼登入 → 用備援碼登入並提示剩餘組數。

## 五、需要你做的一件事

在 **Supabase → SQL Editor** 執行 `migrations/2026-09-26-v2.15.0-admin-2fa.sql`（可重複執行），
然後在網站選單「🔐 兩步驟驗證」用手機 App（Google／Microsoft Authenticator 等）選「手動輸入金鑰」貼上密鑰完成綁定。
**備援碼只會顯示一次**，請當下抄下來或存進密碼管理器。

## 六、檔案異動

- 新增：`lib/totp.js`、`migrations/2026-09-26-v2.15.0-admin-2fa.sql`、`tests/totp.test.js`、`tests/twofactor-api.test.js`、
  `tests/browser/twofactor-check.js`、`tests/browser/prod-visitor-check.js`
- 修改：`server.js`（兩步驟驗證 6 個端點、登入兩段式、`authenticateToken` 拒絕中間權杖、使用者清單帶出 2FA 狀態）、
  `public/index.html`（登入第二階段、兩步驟驗證設定視窗）、`public/js/app.js`（登入流程、設定視窗、使用者管理重設 2FA）、
  `public/css/custom.css`（`.cm-secret` 等寬字型）、`package.json`（新增 `check:browser`／`check:prod`／`triage`）、
  `README.md`、`docs/功能總覽與規劃.md`
