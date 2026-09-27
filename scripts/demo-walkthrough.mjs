#!/usr/bin/env node
/* v3.6.9：示範賽事走一遍報名流程（可重複執行）
 *
 * 用途：把「新使用者自助註冊 → 看到示範賽事 → 報名（含額滿排候補）」在正式站真實跑一次。
 * 為什麼需要：線上報名一直是 0 筆，代表這條路從來沒有人真的走過；
 * 這個腳本讓任何人（包含你示範給別人看時）能一鍵重跑，並印出可核對的結果。
 *
 * 特性：
 *  - 帳號與密碼**在記憶體中隨機產生**，不寫檔、不印出（跑完即忘；要清理就刪帳號）。
 *  - 只讀結果、不寫任何檔案到本機（符合「不要把檔案下載到我的電腦」）。
 *  - 賽事名稱關鍵字與站台網址可用環境變數覆寫：
 *      CM_DEMO_SITE=https://competition-manager-hazel.vercel.app
 *      CM_DEMO_KEYWORD=【示範】
 *
 * 用法：node scripts/demo-walkthrough.mjs
 */

const SITE = (process.env.CM_DEMO_SITE || 'https://competition-manager-hazel.vercel.app').replace(/\/$/, '');
const KEYWORD = process.env.CM_DEMO_KEYWORD || '【示範】';

const rand = (n) => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 54)]).join('');
const username = `demo_${Date.now().toString(36)}${rand(3)}`.slice(0, 20);
const password = rand(16);
let cookie = '';

async function call(method, path, body) {
    const res = await fetch(`${SITE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookie) {
        const pair = c.split(';')[0];
        if (pair.startsWith('cm_token=')) cookie = pair;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 就留原文 */ }
    return { status: res.status, json, text };
}

const steps = [];
const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `｜${detail}` : ''}`);
};

(async () => {
    console.log(`站台：${SITE}｜示範賽事關鍵字：${KEYWORD}\n`);

    const reg = await call('POST', '/api/auth/register', { username, password });
    const registered = reg.status === 200 && reg.json?.user?.role === 'user';
    record('自助註冊新帳號（role: user）', registered, reg.json?.user ? `id ${reg.json.user.id}、帳號 ${reg.json.user.username}` : `HTTP ${reg.status} ${reg.json?.error || ''}`);
    if (!registered) process.exit(1);

    const list = await call('GET', '/api/competitions');
    const comps = Array.isArray(list.json) ? list.json : (list.json?.competitions || []);
    const demo = comps.find((c) => String(c.name || '').includes(KEYWORD));
    record('找到示範賽事', !!demo, demo ? `id ${demo.id}｜${demo.name}｜報名開放中 ${!!demo.is_registration_open}` : `共 ${comps.length} 場但沒有符合「${KEYWORD}」的`);
    if (!demo) process.exit(1);

    const signup = await call('POST', `/api/competitions/${demo.id}/register`, { note: '示範腳本自動報名（可刪除）' });
    const status = signup.json?.registration?.status || signup.json?.status || null;
    const order = signup.json?.registration?.waitlist_order ?? signup.json?.waitlist_order ?? null;
    const ok = signup.status === 200 || signup.status === 201;
    record('送出報名', ok, ok ? `狀態 ${status}${order ? `｜候補第 ${order} 順位` : ''}` : `HTTP ${signup.status} ${signup.json?.error || ''}`);

    const mine = await call('GET', '/api/my/registrations');
    const mineRegs = Array.isArray(mine.json) ? mine.json : (mine.json?.registrations || []);
    const found = mineRegs.find((r) => Number(r.competition_id) === Number(demo.id));
    record('讀回「我的報名」', !!found, found ? `狀態 ${found.status}${found.waitlist_order ? `｜候補第 ${found.waitlist_order} 順位` : ''}` : '找不到剛送出的報名');

    const failed = steps.filter((s) => !s.ok).length;
    console.log(`\n═══ 示範流程：${steps.length - failed} 步成功 / ${failed} 步失敗 ═══`);
    console.log(`（示範帳號 ${username} 已建立，如要清掉請在資料庫刪除 admin_users 同名帳號）`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('❌ 執行失敗：', e.message); process.exit(1); });
