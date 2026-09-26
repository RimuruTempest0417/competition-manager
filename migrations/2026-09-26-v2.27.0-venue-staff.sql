-- v2.27.0：場地地圖連結＋工作人員指派（Roadmap P1-5）
--
-- 目的：
--   ① 賽事多一個「地圖連結」欄位（沒填時前端會用地址自動產生 Google 地圖搜尋連結，
--      所以舊資料不用補，卡片照樣有地圖可按）。
--   ② 工作人員指派：哪些帳號在這場賽事擔任裁判／記錄／攝影（同一場同一人一個角色）。
--
-- 可重複執行（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS）。
-- 未執行時：地圖連結改用地址自動產生（功能照常）、工作人員清單回 schema_ready:false＋檔名、
-- 指派與移除回 503，其他功能完全不受影響（見 server.js 的 mapUrlSchemaReady() / staffSchemaReady()）。

alter table public.competitions add column if not exists map_url text;

create table if not exists public.competition_staff (
    id             bigserial   primary key,
    competition_id bigint      not null,
    user_id        bigint      not null,
    role           text        not null default 'other',  -- referee 裁判／recorder 記錄／photographer 攝影／medical 醫護／other 其他
    note           text,                                   -- 備註（例如「負責第三場地」）
    assigned_by    text,                                   -- 指派的操作者帳號
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    unique (competition_id, user_id)                        -- 同一場、同一人只有一個角色（改角色＝更新這一列）
);

create index if not exists competition_staff_comp_idx on public.competition_staff (competition_id);
create index if not exists competition_staff_user_idx on public.competition_staff (user_id);

-- 與其他表一致：開 RLS 且不建 policy。伺服器用 service_role（繞過 RLS），
-- anon/authenticated 一律擋下（前端從不直連資料庫）。
alter table public.competition_staff enable row level security;
