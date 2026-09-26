# v3.5.4 — 選單彈窗在電腦上不再細成一條 ＋ 補齊 8 條沒有測試的端點

**兩件事**：① 使用者反映「右上角選單裡的按鈕點開後，在電腦看上去比較細（以通知為例）」；
② 把路由快照裡長期沒有測試的 8 條端點補上。

---

## ① 選單彈窗尺寸（先量測，再改）

**修正前實測**（1920×1080，通知設定；用真實 Chrome 量 computed style）：

| 項目 | 修正前 | 修正後 |
|---|---|---|
| 面板寬度（1920／1440） | **512px** | **704px** |
| 內容可用寬度 | 464px | 656px |
| 彈窗內 `.text-xs` | 12px | **13px** |
| 最矮的按鈕高度 | **24px** | **32px** |
| 按鈕列數（8 顆） | 4 列 | 3 列 |

作法（`public/css/custom.css`，純 CSS、無前端套件、CSP 不放寬）：

- **桌機（≥1024px）依原本的 `max-w-*` 分級加下限**，CSS 的 `min-width` 勝過 `max-width`，因此不必改 HTML：
  `max-w-md → 32rem`、`max-w-lg → 44rem`、`max-w-xl／2xl → 46rem`；`3xl` 以上不動（本來就夠寬，稽核日誌實測 768px 不變）。
- **平板（>640px）比照桌機處理字級與按鈕高度**：實測 834px 寬時彈窗按鈕只有 24px，**比手機的 36px 還小**，
  一次點不到就會以為「壞了」。現在平板與桌機都是 32px 按鈕、13px 內文。
- **手機（≤640px）完全不變**：面板 382px、按鈕 36px（原本的手機規則較嚴格，維持）。
- 6 個原本漏掉 `cm-modal-panel` 的彈窗（登入、註冊、改密碼、週期設定、帳號編輯、回報問題）一併補上，
  現在 23 個彈窗行為一致（含 `92dvh` 上限，手機網址列收起時按鈕不會被推出畫面）。

**怎麼守住**：新增 `tests/browser/modal-size-check.js`（正式站，四種尺寸）＋在 `tests/browser/layout-check.js`
加入同樣的量測（本機、真實 Chrome）。斷言：桌機面板 ≥636px、內文 ≥12.8px、按鈕 ≥28px；
平板／手機面板塞得進視窗且不被壓成細條；面板不得出現橫向捲動。

---

## ② 補齊 8 條沒有測試的端點

路由快照裡這 8 條以前完全沒有測試（用「METHOD + path 在 `tests/**` 找」掃出來的）：

| 端點 | 為什麼要測 |
|---|---|
| `POST /api/admin/login` | 登入別名；寫錯路徑會 404，行為必須與正式路徑一致 |
| `PUT /api/auth/change-password` | 會改 `admin_users.password`：舊密碼驗證、格式、雜湊儲存、稽核 |
| `POST /api/logs/error` | 未登入可寫：節流（30 次／分鐘）與欄位長度上限是唯二防線 |
| `POST /api/push/unsubscribe` | 未登入可寫：缺參數 400、只停用該裝置、未知 endpoint 不報錯 |
| `GET /api/competitions/trash` | 回收筒列表（admin 以上） |
| `GET /api/competitions/deleted` | 上一條的別名，結果必須一致 |
| `PUT /api/competitions/:id/restore` | 還原只能 soft delete，不得連帶影響其他筆 |
| `DELETE /api/competitions/:id/hard-delete` | **真的刪除**，只給 super_admin／web_owner |

新增 3 個測試檔（都用假 Supabase，完全不碰真實資料庫）：

- `tests/auth-endpoints.test.js` — 別名一致性、未登入 401、格式 400、舊密碼 400、
  成功後密碼以 `scrypt$` 儲存且舊密碼失效、新密碼可登入、稽核 `CHANGE_PASSWORD`、改自己不改別人。
- `tests/public-write-endpoints.test.js` — 五個欄位都被截斷（60／1000／4000／300／400）、安全預設值、
  截圖只留前 100 字不留整份 base64、灌 32 次出現 429、退訂只停用該裝置。
- `tests/trash-endpoints.test.js` — 401／403 權限階梯、只列已刪除、別名一致、
  還原只改 `is_deleted` 且不影響其他筆、admin 不能永久刪除、super_admin／web_owner 可以且資料真的消失、
  兩個動作都留稽核、回收筒空時回空陣列（不是 null）。

**RED 驗證**（每一項都故意改壞實作，確認測試真的抓得到）：

| 故意破壞 | 結果 |
|---|---|
| 回收筒路由拿掉 `requireAdmin` | `pass 0 / fail 1`（測試轉紅） |
| 錯誤回報不截斷欄位 | `pass 0 / fail 1` |
| 修改密碼不驗舊密碼 | `pass 0 / fail 1` |

三項還原後都回到 `pass 1 / fail 0`，且沒有殘留的臨時改動。

---

## 測試與驗證

| 項目 | 結果 |
|---|---|
| 單元／整合測試 | `npm test` **594 通過 / 0 失敗**（新增 3 個檔、8 條端點） |
| 本機瀏覽器檢查 | `npm run check:browser` **621＋彈窗量測全綠**（20 支） |
| 正式站（部署後） | `npm run check:prod`＝煙霧 97＋訪客 8＋線上樣式 15＋**彈窗尺寸 4 尺寸**，全數 0 失敗 |
| 錯誤日誌影響 | 跑完 `check:prod` 前後仍是 33 筆（自動化檢查不會再灌自己的日誌，v3.5.2 起有效） |
| 未動 | 資料庫、CSP（`style-src 'self'`）、後端邏輯、`.env`；無新增前端套件 |

## 檔案

- 新增：`tests/browser/modal-size-check.js`、`tests/auth-endpoints.test.js`、
  `tests/public-write-endpoints.test.js`、`tests/trash-endpoints.test.js`
- 修改：`public/css/custom.css`（桌機／平板彈窗尺寸與字級）、`public/index.html`（6 個彈窗補 `cm-modal-panel`）、
  `tests/browser/layout-check.js`（彈窗量測）、`package.json`（v3.5.4＋`check:prod` 納入彈窗檢查）、`README.md`
