-- v3.3.0（P1-6）：賽事規程 PDF 附件
--
-- 存法與 competition_posters 一致：檔案內容以 base64 存在資料庫，
-- 由同源 API（/api/competitions/:id/doc）提供，不需要外部物件儲存，
-- CSP 也不用放寬（維持 default-src 'self'）。
--
-- 一場賽事一份規程（primary key = competition_id），上傳即覆蓋。
-- RLS 開啟且「不加任何 policy」：anon key 讀不到，只有伺服器端的
-- service_role 能存取（與其他資料表相同）。
--
-- 可重複執行（IF NOT EXISTS）。

create table if not exists competition_docs (
    competition_id bigint primary key references competitions(id) on delete cascade,
    label          text not null default '賽事規程',
    mime           text not null default 'application/pdf',
    bytes          integer not null default 0,
    data           text not null,
    uploaded_by    text,
    uploaded_at    timestamptz not null default now()
);

create index if not exists competition_docs_uploaded_idx on competition_docs (uploaded_at desc);

alter table competition_docs enable row level security;
