/* v3.5.0：登入憑證改存 HttpOnly cookie（回應不再帶 token）。
 *
 * 為什麼測試要改：以前測試從登入回應的 body.token 拿權杖，現在 body 裡沒有 token 了
 * （這正是改动的目的：JS 讀不到權杖）。所以：
 *   - 要驗「登入成功」→ 讀 Set-Cookie 有沒有 cm_token
 *   - 要帶著身分打 API    → 用 Cookie 標頭（cookieHeader）
 * 伺服器仍接受 Authorization: Bearer，所以「自己簽權杖」的測試不受影響。
 */
function setCookieLines(res) {
    if (res && res.headers && typeof res.headers.getSetCookie === 'function') {
        return res.headers.getSetCookie().map(String);
    }
    const single = res && res.headers ? res.headers.get('set-cookie') : '';
    return single ? [String(single)] : [];
}

/* 回傳完整的 Set-Cookie 行（含 HttpOnly / SameSite 等屬性），找不到回空字串 */
function authCookieLine(res) {
    return setCookieLines(res).find((c) => c.startsWith('cm_token=')) || '';
}

/* 直接可用的請求標頭 { Cookie: 'cm_token=...' }；沒有 cookie 時回空物件 */
function cookieHeader(res) {
    const line = authCookieLine(res);
    return line ? { Cookie: line.split(';')[0] } : {};
}

module.exports = { setCookieLines, authCookieLine, cookieHeader };
