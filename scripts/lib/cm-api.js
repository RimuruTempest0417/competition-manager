/* 本機維運腳本共用的迷你 API 連線工具（v2.18.0）
 *
 * 為什麼需要：`scripts/` 底下已經有三個腳本（錯誤日誌巡檢、備份、還原）都要「讀 .env → 簽管理權杖 →
 * 打自家 API」。這三件事各寫一份遲早會走鐘（例如其中一支忘了支援 --token，或讀 .env 的方式不同）。
 *
 * 原則：
 *   - **只讀 .env 的 JWT_SECRET 來簽短效權杖**，不碰資料庫金鑰、不印出任何機密。
 *   - 一律走自家 API（服務開啟 RLS 後照樣可用，也讓操作自動進稽核日誌）。
 *   - 權杖與機密只留在記憶體，錯誤訊息不外洩（回應內容原樣回傳，由呼叫端決定怎麼顯示）。
 */
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const DEFAULT_SITE = 'https://competition-manager-hazel.vercel.app';

/* 讀取 .env（存在才讀；不覆蓋已存在的 process.env） */
function loadEnv(root) {
    const envPath = path.join(root, '.env');
    const env = { ...process.env };
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
            if (m && !env[m[1]]) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
    }
    return env;
}

function resolveSite(explicit) {
    return String(explicit || process.env.TRIAGE_URL || DEFAULT_SITE).replace(/\/+$/, '');
}

/* 簽發短效管理權杖（預設網站擁有者；可用環境變數覆寫身分） */
function ownerToken(env, options = {}) {
    if (options.token) return options.token;
    if (!env.JWT_SECRET) return '';
    return jwt.sign({
        sub: Number(options.userId || env.TRIAGE_USER_ID || 1),
        username: options.username || env.TRIAGE_USERNAME || 'rimuru',
        role: options.role || env.TRIAGE_ROLE || 'web_owner'
    }, env.JWT_SECRET, { expiresIn: options.expiresIn || '10m' });
}

/* 統一的 API 呼叫：自動帶 Content-Type 與權杖，回傳 { status, ok, body, text } */
async function apiRequest(site, apiPath, { token, method = 'GET', body, fetchImpl = fetch } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(`${site}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    let parsed = null;
    let text = '';
    try {
        text = await res.text();
        parsed = text ? JSON.parse(text) : null;
    } catch (e) {
        parsed = null;
    }
    return { status: res.status, ok: res.ok, body: parsed, text, headers: res.headers };
}

/* 解析 CLI 參數（--flag 與 --opt value 兩種形式） */
function parseArgv(argv) {
    const flag = (name) => argv.includes(name);
    const opt = (name, dflt) => {
        const i = argv.indexOf(name);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
    };
    return { flag, opt };
}

module.exports = { loadEnv, ownerToken, resolveSite, apiRequest, parseArgv, DEFAULT_SITE };
