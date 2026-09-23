-- ============================================================
-- v2.9.0 migration：普通用戶、報名參加、組隊比賽與隊伍編排
-- 執行方式：Supabase → SQL Editor → 貼上本檔全部內容 → Run
-- 特性：全部使用 IF NOT EXISTS，可重複執行；不會刪除任何既有資料。
-- 未執行時網站不會壞：報名／組隊相關欄位會自動停用並回傳明確提示。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 賽事新增欄位
-- ------------------------------------------------------------
-- 組隊比賽（報名時需填隊伍名稱，並可由管理員編排隊伍）
alter table competitions add column if not exists is_team_event boolean not null default false;
-- 每隊人數上限（0 = 不限）
alter table competitions add column if not exists team_size integer not null default 0;
-- 報名截止日（YYYY-MM-DD；留空表示不自動截止）
alter table competitions add column if not exists registration_deadline date;
-- 報名人數上限（0 = 不限）
alter table competitions add column if not exists max_registrations integer not null default 0;

create index if not exists competitions_registration_deadline_idx on competitions(registration_deadline);

-- ------------------------------------------------------------
-- 2) 報名紀錄
-- ------------------------------------------------------------
create table if not exists registrations (
    id bigserial primary key,
    competition_id bigint not null references competitions(id) on delete cascade,
    user_id bigint references admin_users(id) on delete set null,
    username text not null,
    -- 組隊比賽時指向 competition_teams；個人賽為 null
    team_id bigint,
    team_name text,
    note text,
    status text not null default 'confirmed',
    is_deleted boolean not null default false,
    created_at timestamptz not null default now()
);

-- 同一人同一賽事只能有一筆有效報名（軟刪除後可重新報名）
create unique index if not exists registrations_unique_active
    on registrations(competition_id, user_id) where is_deleted = false;

create index if not exists registrations_competition_idx on registrations(competition_id) where is_deleted = false;
create index if not exists registrations_user_idx on registrations(user_id);

-- ------------------------------------------------------------
-- 3) 比賽隊伍（由管理員編排）
-- ------------------------------------------------------------
create table if not exists competition_teams (
    id bigserial primary key,
    competition_id bigint not null references competitions(id) on delete cascade,
    name text not null,
    note text,
    created_by text,
    is_deleted boolean not null default false,
    created_at timestamptz not null default now()
);

create index if not exists competition_teams_competition_idx on competition_teams(competition_id) where is_deleted = false;

-- ------------------------------------------------------------
-- 4) 推播訂閱（v2.10.0 使用；先建好避免二次 migration）
-- ------------------------------------------------------------
create table if not exists push_subscriptions (
    id bigserial primary key,
    endpoint text not null unique,
    p256dh text not null,
    auth text not null,
    user_id bigint,
    username text,
    user_agent text,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz
);

create index if not exists push_subscriptions_active_idx on push_subscriptions(is_active);

-- 推播寄送紀錄（避免同一場賽事重複推播）
create table if not exists push_log (
    id bigserial primary key,
    competition_id bigint,
    kind text not null,
    sent_count integer not null default 0,
    sent_at timestamptz not null default now()
);

create unique index if not exists push_log_unique
    on push_log(competition_id, kind) where competition_id is not null;

-- ------------------------------------------------------------
-- 5) 允許「普通用戶」角色
--    admin_users.role 可能帶有列舉 admin/super_admin/web_owner/test 的 CHECK 約束，
--    會擋住新的 'user' 角色。這裡只移除「與 role 相關」的 CHECK 約束，
--    不新增新約束（既有資料含 test 等角色，寫死清單會失敗）。
--    角色白名單改由後端 API 控制（見 server.js 的 REGISTERABLE_ROLES）。
-- ------------------------------------------------------------
do $$
declare c record;
begin
    for c in
        select conname
        from pg_constraint
        where conrelid = 'admin_users'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) ilike '%role%'
    loop
        execute format('alter table admin_users drop constraint %I', c.conname);
        raise notice '已移除 admin_users 的 role 檢查約束：%', c.conname;
    end loop;
end $$;

-- ------------------------------------------------------------
-- 6) 資料表權限（沿用專案既有的 RLS 設定風格）
--    後端使用 service role key 連線，RLS 不影響 API；
--    這裡只確保 anon 無法直接讀寫新表。
-- ------------------------------------------------------------
alter table registrations enable row level security;
alter table competition_teams enable row level security;
alter table push_subscriptions enable row level security;
alter table push_log enable row level security;

-- ------------------------------------------------------------
-- 完成。可用下列查詢確認：
--   select column_name from information_schema.columns
--    where table_name = 'competitions' and column_name in
--          ('is_team_event','team_size','registration_deadline','max_registrations');
--   select count(*) from registrations;
-- ------------------------------------------------------------
