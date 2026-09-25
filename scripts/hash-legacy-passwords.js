#!/usr/bin/env node
/* 一次性升級腳本：把 admin_users 中「明碼儲存」的舊密碼改成 scrypt 雜湊（v2.12.1）
 *
 * 為什麼需要：早期帳號的密碼是明碼存在資料庫裡。只要資料庫憑證外流（或 Supabase 專案的
 * anon key 被取得），所有人的密碼就直接曝光；而且多數人會在不同網站重複使用同一組密碼。
 *
 * 為什麼安全：
 *   1. 與伺服器共用 lib/passwords.js（同一份 scrypt 實作），不會出現「腳本算的雜湊伺服器驗不過」。
 *   2. 寫入前先自我驗證（verifyPassword(newHash, 原密碼) === true），驗不過就整批中止、不改任何資料。
 *   3. 寫入後重新讀回再驗一次，並統計是否仍有明碼。
 *   4. 全程只印「帳號名稱 / 數量」，「絕不」輸出密碼或雜湊內容。
 *   5. 已經登入過的使用者其實不需要這支腳本（伺服器登入時會自動升級）；此腳本用來一次處理
 *      「還在睡」的舊帳號，讓資料庫不再有待升級的明碼。
 *
 * 用法：
 *   node scripts/hash-legacy-passwords.js            # 實際升級
 *   node scripts/hash-legacy-passwords.js --dry-run  # 只檢查，不寫入
 *
 * 環境變數來源：專案根目錄的 .env（SUPABASE_URL / SUPABASE_KEY），或直接由環境帶入。
 */

const fs = require('fs');
const path = require('path');
const { hashPassword, verifyPassword, needsPasswordUpgrade } = require('../lib/passwords');

const DRY_RUN = process.argv.includes('--dry-run');

function loadEnv() {
    let env = { ...process.env };
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
            if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    }
    const url = env.SUPABASE_URL;
    // v2.13.0：優先用 service_role key（啟用 RLS 後 anon key 會被完全擋下）
    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY || env.SUPABASE_ANON_KEY;
    if (!url || !key) {
        console.error('❌ 找不到 SUPABASE_URL / SUPABASE_SERVICE_KEY（請確認 .env 或環境變數）');
        process.exit(2);
    }
    if (!(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY)) {
        console.warn('⚠️ 目前使用 anon key；若資料庫已啟用 RLS，本腳本會被拒絕，請改用 SUPABASE_SERVICE_KEY。');
    }
    return { url: url.replace(/\/+$/, ''), key };
}

async function main() {
    const { url, key } = loadEnv();
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

    const listRes = await fetch(`${url}/rest/v1/admin_users?select=id,username,password&order=id.asc`, { headers });
    if (!listRes.ok) {
        console.error(`❌ 讀取帳號失敗（HTTP ${listRes.status}）`);
        process.exit(1);
    }
    const users = await listRes.json();
    const legacy = users.filter(u => needsPasswordUpgrade(u.password));

    console.log(`📋 帳號總數：${users.length}，其中仍是明碼：${legacy.length}`);
    if (!legacy.length) {
        console.log('✅ 沒有任何明碼密碼，無需處理。');
        return;
    }
    console.log(`   待升級帳號：${legacy.map(u => u.username).join('、')}`);
    if (DRY_RUN) {
        console.log('🔍 --dry-run：未做任何寫入。');
        return;
    }

    // 1) 先全部算好並自我驗證，任何一筆驗不過就中止
    const planned = [];
    for (const u of legacy) {
        const plain = String(u.password);
        const hashed = hashPassword(plain);
        if (!verifyPassword(hashed, plain) || needsPasswordUpgrade(hashed)) {
            console.error(`❌ ${u.username}：雜湊自我驗證失敗，整批中止（未寫入任何資料）`);
            process.exit(1);
        }
        planned.push({ id: u.id, username: u.username, plain, hashed });
    }
    console.log(`🧪 ${planned.length} 筆雜湊已通過自我驗證，開始寫入…`);

    // 2) 逐筆寫入
    let done = 0;
    for (const p of planned) {
        const res = await fetch(`${url}/rest/v1/admin_users?id=eq.${encodeURIComponent(p.id)}`, {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=representation' },
            body: JSON.stringify({ password: p.hashed })
        });
        if (!res.ok) {
            console.error(`❌ ${p.username} 寫入失敗（HTTP ${res.status}）：${(await res.text()).slice(0, 200)}`);
            continue;
        }
        done++;
    }
    console.log(`✍️  已升級 ${done}/${planned.length} 筆`);

    // 3) 重新讀回驗證
    const checkRes = await fetch(`${url}/rest/v1/admin_users?select=id,username,password&order=id.asc`, { headers });
    const after = await checkRes.json();
    let remain = 0;
    let broken = 0;
    for (const u of after) {
        if (needsPasswordUpgrade(u.password)) { remain++; console.error(`  ⚠️ ${u.username} 仍是明碼`); continue; }
        const p = planned.find(x => x.id === u.id);
        if (p && !verifyPassword(u.password, p.plain)) { broken++; console.error(`  ❌ ${u.username} 升級後驗證失敗（請用管理介面重設該帳號密碼）`); }
    }
    console.log(`🔎 複驗：剩餘明碼 ${remain} 筆、升級後驗證失敗 ${broken} 筆（帳號總數 ${after.length}）`);
    if (remain === 0 && broken === 0) console.log('✅ 全部帳號的密碼都已是 scrypt 雜湊。');
    else process.exit(1);
}

main().catch(err => {
    console.error('❌ 執行失敗：', err.message);
    process.exit(1);
});
