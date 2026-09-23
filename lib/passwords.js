/* 密碼雜湊模組（v2.12.1）
   server.js 與 scripts/hash-legacy-passwords.js 共用同一份實作，
   避免「升級腳本用自己的演算法」而與伺服器驗證邏輯不一致、把使用者鎖在門外。

   - 格式：scrypt$<salt(hex)>$<hash(hex, 64 bytes)>
   - 舊資料相容：非 scrypt$ 開頭者視為明碼（歷史因素），驗證時以固定時間比較，
     登入成功後由伺服器自動升級為雜湊（needsPasswordUpgrade() 判斷）。 */
const crypto = require('crypto');

function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

// 舊帳號是明碼儲存，登入成功時應順手升級為 scrypt 雜湊（無法在登入前升級，因為拿不到明碼）
function needsPasswordUpgrade(stored) {
    return typeof stored === 'string' && stored !== '' && !stored.startsWith('scrypt$');
}

function verifyPassword(stored, input) {
    if (typeof stored !== 'string' || stored === '') return false;
    if (!stored.startsWith('scrypt$')) {
        // 舊資料：明碼比對（長度不同時避免 timingSafeEqual 拋錯）
        const a = Buffer.from(stored);
        const b = Buffer.from(String(input));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const expected = Buffer.from(parts[2], 'hex');
    const candidate = crypto.scryptSync(String(input), parts[1], 64);
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

module.exports = { hashPassword, verifyPassword, needsPasswordUpgrade };
