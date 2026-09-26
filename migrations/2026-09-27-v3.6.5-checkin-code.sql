-- v3.6.5：現場報到的報到碼（QR 掃碼報到的地基）
--
-- 為什麼需要「報到碼」而不是直接掃報名編號：
--   ① 報名編號（registrations.id）可以從名單頁猜到，掃碼內容必須不可猜，否則任何人都能幫別人簽到
--   ② QR 內容要短（碼越短，QR 越小越好掃；手機螢幕亮度不足時特別明顯）
--   ③ 現場手動輸入也要能用（iPhone 的 Safari／Chrome 沒有 BarcodeDetector，相機掃碼做不到）
--
-- 設計：
--   checkin_code：每位報名者一組 8 碼（去掉容易看錯的 0/O/1/I/L 之後的 32 字元字母表，
--                 32^8 ≈ 1.1 兆，不可猜；現場手打也不容易錯）。
--   同一場賽事內唯一（unique index），不同賽事可以重複沒關係。
--   舊資料沒有碼：採「要用才產生」（lazy），不批次改寫既有資料。
--
-- 可重複執行：add column if not exists；索引用 if not exists。

alter table registrations add column if not exists checkin_code text;

comment on column registrations.checkin_code is
    '現場報到碼（v3.6.5，8 碼、同賽事內唯一；QR 掃碼與手動輸入共用；null＝尚未產生）';

create unique index if not exists idx_registrations_checkin_code
    on registrations (competition_id, checkin_code)
    where checkin_code is not null;
