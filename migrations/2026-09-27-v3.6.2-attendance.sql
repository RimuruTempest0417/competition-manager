-- v3.6.2：現場報到（簽到）與現場代報名
--
-- 為什麼需要：Roadmap 8.7 ⑤。線下比賽當天要能「以系統點名」而不是印名單人工勾選，
-- 而且沒事先線上報名的人（現場臨時參加）要能由管理員代為報名。
--
-- 三個欄位都掛在既有的 registrations 表上（RLS 已於 2026-09-25 開啟，新欄位沿用同一政策，不需另外處理）：
--   attended_at：簽到時間；null＝未簽到。用「時間」而不是布林值，才能事後看出誰幾點到。
--   attended_by：勾選簽到的操作者帳號（稽核用）。
--   onsite     ：這一筆是不是「現場代報名」（非事前線上報名）。
--
-- 可重複執行：全部使用 if not exists / 已存在就略過。

alter table registrations add column if not exists attended_at timestamptz;
alter table registrations add column if not exists attended_by text;
alter table registrations add column if not exists onsite boolean not null default false;

comment on column registrations.attended_at is '現場簽到時間（null＝未簽到）';
comment on column registrations.attended_by is '勾選簽到的操作者帳號';
comment on column registrations.onsite is '是否為現場代報名（非事前線上報名）';

-- 現場名單查詢用：同一場賽事、未刪除的資料，依簽到時間排序。
create index if not exists idx_registrations_attendance
    on registrations (competition_id, attended_at)
    where is_deleted = false;
