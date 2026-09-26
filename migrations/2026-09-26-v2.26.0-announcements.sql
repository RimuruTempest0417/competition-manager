-- v2.26.0：站內公告／訊息中心
--
-- 目的：取代 Email 通知（使用者已決定不做）。管理員可發布公告（對象：全部／管理員以上／
-- 特定分類訂閱者），使用者登入後在訊息中心看到，並記錄「誰讀過了」。
--
-- 可重複執行（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS）。
-- 未執行時：公告功能整組優雅停用（列表回 schema_ready:false 並附檔名，發布／修改回 503），
-- 其他功能完全不受影響（見 server.js 的 announcementsSchemaReady()）。

create table if not exists public.announcements (
    id           bigserial primary key,
    title        text        not null,
    body         text        not null,
    audience     text        not null default 'all',   -- all（所有使用者）／admin（管理員以上）／category（指定分類訂閱者）
    categories   text[]      not null default '{}',    -- audience = 'category' 時使用（值為 COMPETITION_CATEGORIES 的 id）
    is_pinned    boolean     not null default false,   -- 置頂
    is_active    boolean     not null default true,    -- 下架 = false（不刪資料，保留紀錄）
    publish_at   timestamptz not null default now(),   -- 何時開始顯示（可預約）
    expires_at   timestamptz,                          -- 何時自動下架（null = 永久）
    notify_push  boolean     not null default false,   -- 發布時是否同時發推播
    created_by   text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists announcements_visible_idx
    on public.announcements (is_active, publish_at desc);

-- 誰讀過了（一則公告一位使用者一列；重複標記已讀用 upsert，不會長出重複列）
create table if not exists public.announcement_reads (
    id              bigserial primary key,
    announcement_id bigint      not null,
    user_id         bigint      not null,
    read_at         timestamptz not null default now(),
    unique (announcement_id, user_id)
);

create index if not exists announcement_reads_user_idx
    on public.announcement_reads (user_id, announcement_id);

-- 使用者想收到哪些分類的公告（audience = 'category' 時比對這個欄位）
alter table public.admin_users add column if not exists announce_categories text[];

-- 與其他表一致：開 RLS 且不建 policy。伺服器用 service_role（繞過 RLS），
-- anon/authenticated 一律擋下（前端從不直連資料庫）。
alter table public.announcements       enable row level security;
alter table public.announcement_reads  enable row level security;
