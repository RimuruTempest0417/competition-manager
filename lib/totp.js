/* TOTP（時間型一次性密碼）——純手寫，只用 Node 內建 crypto（v2.15.0）
 *
 * 為什麼自己寫：本專案 CSP 為 `script-src 'self'`、專案慣例是「純手寫、不引入前端外部套件」，
 * 後端也不想為了 6 行程式碼多一個相依套件（供應鏈風險）。
 *
 * 實作依 RFC 4226（HOTP）與 RFC 6238（TOTP），相容 Google Authenticator / Microsoft Authenticator /
 * 1Password / Authy 等常見 App（它們預設都是 SHA-1、6 位數、30 秒一步）。
 *
 * 安全設計：
 *   - 驗證允許 ±1 個時間步（容忍手機與伺服器的時鐘差），但**同一步只能用一次**：
 *     呼叫端要把已接受過的 counter 記下來（見 server.js 的 totp_last_step），避免同一組碼被重放。
 *   - 密鑰與備援碼都不在回應中重複出現；備援碼只用一次（比對雜湊、用掉就標記）。
 */
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_STEP = 30;
const DEFAULT_DIGITS = 6;

/* ---------- Base32（RFC 4648，無 padding，Authenticator App 接受） ---------- */
function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str) {
    const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = BASE32_ALPHABET.indexOf(ch);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/* ---------- 密鑰 ---------- */
// 160 bit（20 bytes）是 RFC 4226 建議長度，也是 Google Authenticator 的預設
function generateSecret(bytes = 20) {
    return base32Encode(crypto.randomBytes(bytes));
}

/* ---------- HOTP / TOTP ---------- */
function hotp(key, counter, digits = DEFAULT_DIGITS, algorithm = 'sha1') {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac(algorithm, key).update(buf).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    return String(binary % (10 ** digits)).padStart(digits, '0');
}

function counterAt(atMs, step = DEFAULT_STEP) {
    return Math.floor(atMs / 1000 / step);
}

function totp(secretBase32, options = {}) {
    const { at = Date.now(), step = DEFAULT_STEP, digits = DEFAULT_DIGITS, algorithm = 'sha1' } = options;
    return hotp(base32Decode(secretBase32), counterAt(at, step), digits, algorithm);
}

/* 驗證：回傳 { valid, counter }（counter 供呼叫端記錄以防重放）；window=1 表示前後各容忍一步 */
function verifyTotp(secretBase32, token, options = {}) {
    const {
        at = Date.now(), step = DEFAULT_STEP, digits = DEFAULT_DIGITS,
        algorithm = 'sha1', window = 1, lastUsedCounter = null
    } = options;

    const clean = String(token || '').replace(/\D/g, '');
    if (clean.length !== digits) return { valid: false, counter: null, reason: 'format' };

    const key = base32Decode(secretBase32);
    const current = counterAt(at, step);
    for (let offset = -window; offset <= window; offset += 1) {
        const counter = current + offset;
        if (counter < 0) continue;
        const expected = hotp(key, counter, digits, algorithm);
        // 固定時間比較，避免用回應時間推測位數
        const a = Buffer.from(expected);
        const b = Buffer.from(clean);
        const same = a.length === b.length && crypto.timingSafeEqual(a, b);
        if (same) {
            if (lastUsedCounter !== null && counter <= Number(lastUsedCounter)) {
                return { valid: false, counter, reason: 'replayed' };
            }
            return { valid: true, counter, reason: null };
        }
    }
    return { valid: false, counter: null, reason: 'mismatch' };
}

/* ---------- 給 Authenticator App 的 otpauth:// 連結 ---------- */
function otpauthUri({ secret, account, issuer = '比賽管理系統', digits = DEFAULT_DIGITS, step = DEFAULT_STEP }) {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({
        secret: String(secret || ''),
        issuer,
        algorithm: 'SHA1',
        digits: String(digits),
        period: String(step)
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

/* 備援碼用的字母表：刻意排除容易看錯的 0/O、1/I/L、8/B、9/g → 正好 32 個字元（每位 5 bit）
   使用者是要用紙抄或手打的，避免混淆比多幾個字元重要 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ234567';

function generateRecoveryCodes(count = 8, length = 12) {
    const codes = [];
    for (let i = 0; i < count; i += 1) {
        let raw = '';
        const bytes = crypto.randomBytes(length);
        for (let j = 0; j < length; j += 1) raw += RECOVERY_ALPHABET[bytes[j] % RECOVERY_ALPHABET.length];
        codes.push(raw.match(/.{1,4}/g).join('-'));
    }
    return codes;
}

// 備援碼 12 碼（約 59 bit）＋每個獨立 salt 的 sha256：離線暴力破解不可行，且驗證不需要 scrypt 的延遲
function hashRecoveryCode(code, salt = crypto.randomBytes(16).toString('hex')) {
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return { salt, hash: crypto.createHash('sha256').update(`${salt}:${normalized}`).digest('hex') };
}

function verifyRecoveryCode(code, entry) {
    if (!entry || !entry.salt || !entry.hash) return false;
    const candidate = hashRecoveryCode(code, entry.salt).hash;
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(String(entry.hash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
    BASE32_ALPHABET,
    DEFAULT_STEP,
    DEFAULT_DIGITS,
    base32Encode,
    base32Decode,
    generateSecret,
    hotp,
    counterAt,
    totp,
    verifyTotp,
    otpauthUri,
    generateRecoveryCodes,
    hashRecoveryCode,
    verifyRecoveryCode
};
