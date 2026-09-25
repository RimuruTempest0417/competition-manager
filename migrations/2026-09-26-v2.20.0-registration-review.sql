-- v2.20.0：報名審核與候補名單
-- ============================================================
-- 這份 SQL 可以在 Supabase SQL Editor 直接執行，**可重複執行**（全部 IF NOT EXISTS）。
--
-- 新增的東西：
--   competitions.requires_approval  報名需審核（報名後是「待審核」，由管理員核准／拒絕）
--   competitions.waitlist_enabled   額滿可排候補（有人取消時自動遞補第一位候補）
--   registrations.status            報名狀態：pending／confirmed／waitlisted／rejected（v2.9.0 已存在，這裡是保險）
--   registrations.reviewed_at       審核時間
--   registrations.reviewed_by       審核人帳號
--   registrations.review_note       審核備註（拒絕原因等）
--
-- 為什麼「名額」不需要新欄位：
--   佔名額 = 已核准（confirmed）＋ 待審核（pending）；候補（waitlisted）不佔名額。
--   這條規則寫在 public/js/competition-state.js（前後端共用），不靠資料庫欄位。
--
-- 既有資料：status 全都已經是 'confirmed'（v2.9.0 的預設值），不需要搬移。
-- 沒有執行這份 SQL 會怎樣：網站照常運作，只是「報名審核」與「候補」兩個開關無效
--   （報名一律直接核准），審核端點會回 503 並提示這份檔案的路徑。
-- ============================================================

-- 1) 賽事：兩個開關
alter table competitions add column if not exists requires_approval boolean not null default false;
alter table competitions add column if not exists waitlist_enabled boolean not null default false;

-- 2) 報名：狀態與審核軌跡
alter table registrations add column if not exists status text not null default 'confirmed';
alter table registrations add column if not exists reviewed_at timestamptz;
alter table registrations add column if not exists reviewed_by text;
alter table registrations add column if not exists review_note text;

-- 3) 保險：把意外的空狀態補成既有的語意（已核准），避免舊程式寫入的 null 被當成未知狀態
update registrations set status = 'confirmed' where status is null or btrim(status) = '';

-- 4) 查詢用索引（審核清單、候補順位都用 competition_id + status 過濾）
create index if not exists registrations_competition_status_idx
    on registrations (competition_id, status)
    where is_deleted = false;

-- ============================================================
-- 回復（ROLLBACK）：如果確定不要這兩個功能，貼下面兩行執行
-- ============================================================
-- alter table competitions drop column if exists requires_approval;
-- alter table competitions drop column if exists waitlist_enabled;
-- （registrations 的三個審核欄位與 status 欄位保留無害：程式不帶就不會寫入）
