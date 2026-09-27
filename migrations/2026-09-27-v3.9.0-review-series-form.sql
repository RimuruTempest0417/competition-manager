-- v3.9.0：賽事回顧報告、系列賽總積分、報名表自訂欄位
--
-- 1) competitions.series_points   ：系列積分規則（放在系列根賽事上）＝ { points: [10,8,6,...], count_best: 0 }
-- 2) competitions.form_fields     ：報名表自訂欄位定義 ＝ [{ key, label, type, required, options }]
-- 3) registrations.form_answers   ：報名者填的答案 ＝ { key: value }
--
-- 回顧報告不需要新欄位（全部即時從既有資料算出來：報名、簽到、成績、分享成效）。
-- 全部可重複執行。

alter table competitions add column if not exists series_points jsonb;
alter table competitions add column if not exists form_fields jsonb;
alter table registrations add column if not exists form_answers jsonb;

-- 系列排行要能快速撈出同一個系列的所有場次（系列是用既有的 recurrence_parent_id 表達，
-- 根賽事的 recurrence_parent_id 為空 → 撈「自己 + 子場次」）
create index if not exists competitions_recurrence_parent_idx
    on competitions (recurrence_parent_id)
    where recurrence_parent_id is not null;
