-- v2.22.0：遞補通知開關（每個賽事可決定「遞補時要不要推播通知」）
--
-- 為什麼要這個開關：
--   預設「遞補就通知」是對的，但實務上有兩種情況需要關掉——
--   ① 主辦正在連續調整名單（先遞補 A、再取消、再遞補 B），中途通知只會讓對方一頭霧水；
--   ② 通知只是提醒，實際聯絡是另外用電話／群組做，重複通知反而像系統在亂發。
--   關掉之後**遞補本身照常成立**（狀態、稽核、名單都不變），只是不推播，
--   稽核與介面回報都會寫明「依賽事設定未通知」，事後查得到。
--
-- 未執行這個 migration 時：伺服器以「通知＝開啟」運作（既有行為完全不變），
-- 介面上的勾選框會顯示為停用並說明要先執行 migration。
--
-- 可重複執行（IF NOT EXISTS）。

ALTER TABLE competitions
    ADD COLUMN IF NOT EXISTS waitlist_notify boolean DEFAULT true;

-- 既有資料列補上預設值（DEFAULT 只影響新資料列；這行讓舊賽事也變「通知＝開啟」）
UPDATE competitions SET waitlist_notify = true WHERE waitlist_notify IS NULL;
