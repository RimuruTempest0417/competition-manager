# v3.6.2 — 現場報到與現場代報名

發佈日：2026-09-27（Roadmap 8.7 ⑤）

## 這件事要解決什麼

比賽當天的實況是這樣：選手陸續到場，主辦要在入口確認「誰來了」，還有人根本沒線上報名、臨時想參加。
在這版之前，系統完全幫不上忙——說明書老實寫著「請列印名單人工勾選」。

依使用者 2026-09-26 定的方式（**先由管理員勾選簽到**，不做 QR code 掃描），這版把整個線下流程做成系統功能。

## 新增功能

| 功能 | 位置 | 規則 |
|---|---|---|
| 🎫 現場報到 | 賽事卡片 →「報名／隊伍」→ 彈窗最上方 | **只有「正取」會出現在名單上**；點「簽到」即完成，記下**時間與操作者**；勾錯可「取消簽到」（同樣留稽核） |
| ➕ 現場代報名 | 同區塊 | 沒線上報名的人當場加人；標記「現場」、直接算正取；**仍然守名額上限**；同名（不分大小寫）不重複建立，改為請管理員去名單上簽到 |
| 搜尋姓名 | 現場報到區 | 電話亭式的人多場合不用捲名單 |
| 統計 | 現場報到區 | 「已簽到 X／應到 Y｜現場代報名 Z｜未到 W」＋提示還剩幾位沒到 |
| CSV 補簽到欄 | ⬇️ 匯出報名名單 | 多「簽到」「現場代報名」兩欄，可列印當紙本備援點名表 |

## 為什麼這樣設計（決策與理由）

- **只有正取能簽到**：候補與待審核還沒拿到資格，先簽到會讓「現場名額」與帳對不上。前端名單根本不放他們，後端也會擋（回 400 並說明要先核准／遞補）。
- **簽到記時間不只記布林值**：用 `attended_at` 才能事後看出誰幾點到、誰最後才來（布林值做不到）。
- **取消簽到不做二次確認**：現場勾錯是常態，多一次確認只會讓人卡住；取消本身留稽核紀錄（誰在什麼時候取消），事後追得到。
- **現場代報名刻意允許在「報名已截止」時使用**：賽事當天的臨時參加就是這樣發生的；但名額上限照守，額滿回 409 並說明要「提高名額或先處理候補」。
- **重複檢查排在名額檢查之前**：現場最常見的情況其實是「這個人早就線上報名了」，此時回「名單上簽到就好」比回「名額已滿」有用得多（這是寫測試時發現的順序問題，已調整）。
- **沒跑 migration 時整塊介面不顯示**，後端回 503 並指出要跑哪一支；不會出現一個按了會失敗的按鈕。

## 資料庫

新增 `migrations/2026-09-27-v3.6.2-attendance.sql`（可重複執行，已套用到正式 Supabase）：

| 欄位 | 型別 | 用途 |
|---|---|---|
| `registrations.attended_at` | timestamptz | 簽到時間（null＝未簽到） |
| `registrations.attended_by` | text | 勾選簽到的操作者帳號 |
| `registrations.onsite` | boolean not null default false | 是否為現場代報名 |

另加索引 `idx_registrations_attendance (competition_id, attended_at) where is_deleted = false`。RLS 沿用既有政策（新欄位在同一張表上）。

## 新增端點

| 端點 | 權限 | 說明 |
|---|---|---|
| `POST /api/registrations/:id/attendance` | 管理員以上 | 簽到／取消簽到；正取才能簽 |
| `POST /api/competitions/:id/onsite-registration` | 管理員以上 | 現場代報名；守名額上限、不重複 |

`GET /api/competitions/:id/registrations` 與 `/teams` 多回 `attendance`（統計）、`attendance_schema_ready`，以及每筆的 `attended_at／attended_by／onsite`（只給管理員看統計）。

## 稽核

新增三個動作並已登記在 `AUDIT_ACTION_LABELS`（`tests/audit-actions.test.js` 守門）：
`REGISTER_ATTENDED`（現場簽到）、`REGISTER_ATTENDANCE_UNDONE`（取消現場簽到）、`REGISTER_ONSITE`（現場代報名）。

## 使用說明同步更新

`public/js/guide.js`（說明的唯一來源）新增「🎫 現場報到與現場代報名」段落，管理員操作清單第 9 步從「（尚未有系統功能）」改成真正的操作位置與限制；
並在測試裡明確禁止說明暗示系統有 **QR code 掃碼報到**（沒有這個功能）。

## 測試

| 項目 | 結果 |
|---|---|
| 新增 `tests/attendance.test.js` | 權限（401／403）、正取可簽／候補不可簽、取消簽到、404 邊界、代報名建立與標記、同名（含大小寫）不重複、額滿擋下、連結既有帳號、統計只給管理員、未跑 migration 回 503 |
| 新增 `tests/browser/attendance-check.js` | **35 項**（真實 Chrome 手機尺寸）：統計文字、名單只有正取、簽到後資料庫真的有時間與操作者、取消簽到、搜尋、現場代報名建檔與標記、同名提示、額滿提示、手機不溢出、無前端例外 |
| 正式站煙霧 | 新增 7 項唯讀斷言：`attendance_schema_ready`、統計欄位齊全、簽到數不超過應到、未登入／一般角色打簽到與代報名各回 401／403、不存在 id 回 404 |
| RED 驗證 | 兩項關鍵規則確認會轉紅：①拿掉「只有正取可簽到」→ 測試在「候補者不可簽到」失敗 ②拿掉同名檢查 → 測試在「要告訴管理員既有紀錄是哪一筆」失敗。還原後**重新 grep 關鍵行並重跑綠燈**（v3.6.1 的教訓） |

## 檔案

- 新增：`migrations/2026-09-27-v3.6.2-attendance.sql`、`tests/attendance.test.js`、`tests/browser/attendance-check.js`
- 修改：`server.js`（`attendanceSchemaReady` 探測＋稽核動作標籤＋注入 ctx）、`routes/registrations.js`（兩個端點＋名單帶簽到欄位與統計）、
  `routes/teams.js`（現場名單與統計）、`public/index.html`（現場報到區塊）、`public/js/app.js`（渲染、事件、CSV 簽到欄）、
  `public/js/guide.js`（說明＋操作清單）、`tests/guide.test.js`、`tests/browser/prod-smoke.js`、`tests/fixtures/route-inventory.json`、`package.json`
- **未動**：CSP、既有權限模型、推播流程、`.env`、任何外部套件（前端仍是純手寫）
