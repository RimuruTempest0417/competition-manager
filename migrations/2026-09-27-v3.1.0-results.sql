-- ==========================================
-- v3.1.0：成績與結果（P1-3）
-- ==========================================
-- 系統原本只做到「報名 → 審核 → 賽事當天」，賽後完全沒有地方記錄成績。
-- 這一支補上賽後的那一段：
--   1. competition_results —— 每筆報名對應一筆成績（名次／成績／狀態／備註）
--   2. competitions 的三個公布欄位 —— 成績先登錄（草稿），管理員確認後才公布給大家看
--
-- 可以重複執行：全部 IF NOT EXISTS。
-- 執行後不需要重新部署或重啟。
--
-- 事前檢查（可選）：
--   select count(*) from public.competitions where is_deleted is not true;
-- 事後確認（可選）：
--   select competition_id, count(*) from public.competition_results group by 1;
--
-- 未執行這支 migration 時的行為（一律優雅降級，不會壞）：
--   - 賽事照常建立／報名／審核，只是沒有成績功能
--   - 成績相關端點回 503 並附上這支檔案的名稱
--   - 前台卡片不會出現「🏆 成績」按鈕

-- ---------- 1. 成績表 ----------
-- 設計取捨：
--   - 一筆報名一筆成績（registration_id 唯一，只對非 null 生效）——
--     成績是「誰的成績」，而誰參加了是由報名決定的，不是另一份名單。
--   - username / display_name 是快照：報名被刪掉或帳號改名後，成績表仍然看得懂。
--   - score_text 存自由文字（12:34.56／85／3–2 都行），名次另外用整數存；
--     兩者分開是因為不同運動的成績格式差很多，但不該因此放棄「名次」這個共同語言。
--   - 刻意「不」對 rank 加唯一鍵：同分並列（1,1,3）在真實比賽很常見，
--     硬性唯一會讓並列名次直接存不進去。
create table if not exists public.competition_results (
    id              bigserial primary key,
    competition_id  bigint      not null references competitions(id) on delete cascade,
    registration_id bigint      references registrations(id) on delete cascade,
    user_id         bigint      references admin_users(id) on delete set null,
    username        text,
    display_name    text,
    status          text        not null default 'finished',
    score_text      text,
    rank            integer,
    note            text,
    recorded_by     text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

comment on table public.competition_results is
    '賽事成績：一筆報名一筆成績；competitions.result_published_at 為 null 時只是草稿（前台看不到）';
comment on column public.competition_results.status is
    'finished（完賽）／dnf（未完賽）／dns（未出賽）／dsq（取消資格）／other';
comment on column public.competition_results.score_text is
    '成績的自由文字表示（例如 12:34.56、85、3–2）；名次在 rank 欄位';

-- 唯一鍵刻意「不加」where 條件：PostgREST 的 upsert（on_conflict）用的是
-- ON CONFLICT 語法，而部分索引（partial index）沒有同樣的 where 條件時無法被採用，
-- 會直接報「no unique or exclusion constraint matching the ON CONFLICT specification」。
-- 一般唯一索引對 null 是寬鬆的（多筆 null 可以並存），而這裡 registration_id 一律有值。
create unique index if not exists competition_results_registration_unique
    on public.competition_results (competition_id, registration_id);

create index if not exists competition_results_competition_idx
    on public.competition_results (competition_id);

create index if not exists competition_results_user_idx
    on public.competition_results (user_id);

-- ---------- 2. 公布欄位 ----------
-- result_published_at 是「前台看不看得到」的唯一依據：null＝草稿。
alter table public.competitions add column if not exists result_published_at timestamptz;
alter table public.competitions add column if not exists result_published_by   text;
alter table public.competitions add column if not exists result_summary       text;

comment on column public.competitions.result_published_at is
    '成績公布時間；非 null 代表前台看得到成績（null＝只有管理員看得到草稿）';
comment on column public.competitions.result_summary is
    '成績頁的補充說明（例如「計時賽，取最佳成績」），選填';

-- ---------- 3. RLS ----------
-- 新表一律開啟 RLS 且不開放 anon：伺服器用 service_role 存取（與其他表一致）。
-- 沒開的話 anon key 讀得到，等於把成績表公開出去。
alter table if exists public.competition_results enable row level security;

-- 完成
