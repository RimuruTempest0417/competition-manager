# v3.7.2 — 桌機日期欄文字重疊修正（提示只在 iOS 注入）

發佈日期：2026-09-27
線上版本：<https://competition-manager-hazel.vercel.app>

## 問題

使用者回報：**手機的日期欄已經正常，但電腦上出現「奇怪的文字重疊」**（附螢幕截圖）。

## 成因（v3.6.8 留下來的錯誤假設）

v3.6.8 為了修 iOS「空日期欄完全不顯示文字」，用 JS 在每個日期欄注入一個「年/月/日」提示。
當時我在程式註解裡寫下判斷：

> 有值時自動隱藏（桌機 Chrome 本來就會顯示「年/月/日」，加了也不衝突）。

**這句是錯的。** 桌機 Chrome 本來就會**自己**在日期欄畫出「年/月/日」，
再疊一層提示元素就成了兩層文字疊在一起——正是截圖看到的樣子。

## 修法：提示只在 iOS 注入

- 新增純函式 `isIOSUserAgent(ua, maxTouchPoints)`：`iPad／iPhone／iPod` 的 UA 為真；
  **新版 iPadOS 的 UA 已經不寫 iPad，而是假裝成 Mac** → 再用「Mac + 多點觸控」辨識。
- `applyDateHints()` 先算 `wantsHint`，**只有 iOS 才建立提示元素**；桌機／Android／不認識的 UA 完全不產生那個元素。
- **外框（`.cm-date-wrap`）維持一律建立**：v3.7.1 的手機凸出修法完全不受影響。
- 順手把那段錯誤註解改掉，避免以後又被它誤導。

## 新增守門

| 檢查 | 斷言 |
|---|---|
| `tests/date-hint-ios.test.js`（新，5 項） | UA 矩陣：iPhone／iPad／iPadOS-假裝成-Mac → iOS；桌機 Mac／Windows／Android／空 UA → 非 iOS。另加**結構斷言**：建立提示的程式碼必須被 `if (wantsHint)` 包住。 |
| `mobile-layout-«redacted-vault-secret».js` | ①每個手機尺寸下**桌機 UA 不得有提示元素**（把 v3.6.8 那條方向錯誤的舊斷言換掉）②**用 iOS 的 UA 另開一次瀏覽器**：必須有提示（11 個）、文字是「年/月/日」、填入日期後 `has-value` 且提示 `display:none`。 |
| `live-style-«redacted-vault-secret».js` | 正式站桌機不得有提示元素。 |
| `tests/browser/lib/cdp.js` | 新增 `userAgent`／`platform` 選項（`Emulation.setUserAgentOverride`）——這才有辦法在 Chrome 裡真的模擬 iOS 的 UA。 |

**RED 驗證**：把 iOS 閘門拿掉（`if (true)`）→ **92 通過 / 15 失敗**（紅的正是「非 iOS 不產生提示」）；還原後 **107 通過 / 0 失敗**。

## 驗證數據

| 項目 | 結果 |
|---|---|
| `tests/date-hint-ios.test.js`（新） | **5 通過 / 0 失敗** |
| `npm test`（單元／API） | **622 通過 / 0 失敗**（v3.7.1 為 617） |
| `npm run check:browser`（真實 Chrome） | **27 支套件、914 項全綠**（v3.7.1 為 907） |
| `mobile-layout-«redacted-vault-secret».js` | **107 通過 / 0 失敗**（RED 時 92／15） |
| 路由覆蓋 | 99／99（本版無新增端點） |
| 正式站 `npm run check:prod` | （發佈後填入） |

## 升級注意

- **沒有資料庫結構變更、沒有新增端點**（路由覆蓋仍 99／99）。
- 使用者可見行為：桌機日期欄恢復成單層文字；iOS 行為不變（含提示與點擊叫出轉盤）。
