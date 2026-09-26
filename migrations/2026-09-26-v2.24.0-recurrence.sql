-- v2.24.0：週期性賽事（複製賽事不需要新欄位，自動建立下一場才需要）
--
-- 為什麼要欄位：手動複製只要一次 API 就夠；但「每週／每兩週／每月自動開下一場」需要
-- 把「這個系列怎麼重複、重複到什麼時候、屬於哪個系列」記在資料庫裡，cron 才知道要做什麼。
--
-- recurrence         ：null（不重複）／'weekly'／'biweekly'／'monthly'
-- recurrence_until   ：重複到哪一天為止（null＝一直重複）
-- recurrence_parent_id：系列的第一場 id（用來判斷「這個日期是不是已經有了」）
--
-- 可重複執行（IF NOT EXISTS）；沒有執行時相關功能會自動停用並回報需要 migration。

ALTER TABLE competitions ADD COLUMN IF NOT EXISTS recurrence text;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS recurrence_until date;
ALTER TABLE competitions ADD COLUMN IF NOT EXISTS recurrence_parent_id integer;

-- cron 每天都掃一次「有設定週期」的賽事，加個部分索引避免全表掃描
CREATE INDEX IF NOT EXISTS competitions_recurrence_idx
    ON competitions (recurrence, date)
    WHERE recurrence IS NOT NULL;
