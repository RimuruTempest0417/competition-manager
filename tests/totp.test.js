/* v2.15.0：TOTP 兩步驟驗證核心測試
 * 重點是用 **RFC 4226 / RFC 6238 官方測試向量**驗證實作正確，而不是「自己算的自己驗」。
 * RFC 6238 Appendix B 的密鑰是 ASCII "12345678901234567890"（SHA-1 用 20 bytes 版本）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
    base32Encode, base32Decode, generateSecret, hotp, counterAt, totp, verifyTotp,
    otpauthUri, generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode
} = require(path.join(__dirname, '..', 'lib', 'totp.js'));

const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('v2.15.0 Base32：編碼與解碼可往返，且與 RFC 4648 範例一致', () => {
    assert.strictEqual(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.strictEqual(base32Decode('MZXW6YTBOI').toString(), 'foobar');
    // 小寫、空白、連字號都要能容忍（使用者手動輸入時很常見）
    assert.strictEqual(base32Decode('mzxw-6ytb oi').toString(), 'foobar');
    assert.strictEqual(base32Decode(RFC_SECRET_B32).toString(), RFC_SECRET_ASCII);
    assert.strictEqual(base32Encode(base32Decode(RFC_SECRET_B32)).toString(), RFC_SECRET_B32);
});

test('v2.15.0 HOTP：符合 RFC 4226 Appendix D 測試向量', () => {
    const key = Buffer.from(RFC_SECRET_ASCII);
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => {
        assert.strictEqual(hotp(key, counter), code, `counter=${counter} 應為 ${code}`);
    });
});

test('v2.15.0 TOTP：符合 RFC 6238 Appendix B 測試向量（SHA-1）', () => {
    const cases = [
        [59, '94287082'],
        [1111111109, '07081804'],
        [1111111111, '14050471'],
        [1234567890, '89005924'],
        [2000000000, '69279037'],
        [20000000000, '65353130']
    ];
    for (const [seconds, expected] of cases) {
        assert.strictEqual(
            totp(RFC_SECRET_B32, { at: seconds * 1000, digits: 8 }),
            expected,
            `t=${seconds} 應為 ${expected}`
        );
    }
    // 專案實際使用 6 位數，取同一組向量的前 6 位
    assert.strictEqual(totp(RFC_SECRET_B32, { at: 59000 }), '287082');
});

test('v2.15.0 驗證：容忍時鐘差但擋下超時與格式錯誤', () => {
    const secret = generateSecret();
    const now = 1758800000000;
    const code = totp(secret, { at: now });

    assert.strictEqual(verifyTotp(secret, code, { at: now }).valid, true);
    // 前後一步以內（手機慢幾秒）仍應接受
    assert.strictEqual(verifyTotp(secret, code, { at: now + 29 * 1000 }).valid, true, '晚 29 秒應接受（同一步）');
    assert.strictEqual(verifyTotp(secret, code, { at: now + 31 * 1000 }).valid, true, '晚一步應接受（容忍窗）');
    // 超過容忍窗就要拒絕
    assert.strictEqual(verifyTotp(secret, code, { at: now + 3 * 60 * 1000 }).valid, false, '晚 3 分鐘必須拒絕');
    // 格式錯誤
    assert.strictEqual(verifyTotp(secret, '12345', { at: now }).valid, false);
    assert.strictEqual(verifyTotp(secret, 'abcdef', { at: now }).valid, false);
    assert.strictEqual(verifyTotp(secret, '', { at: now }).valid, false);
    // 別的密鑰產生的碼不能通過
    assert.strictEqual(verifyTotp(generateSecret(), code, { at: now }).valid, false);
    // 允許使用者輸入時夾雜空白／連字號
    assert.strictEqual(verifyTotp(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `, { at: now }).valid, true);
});

test('v2.15.0 驗證：同一個時間步不能重複使用（防重放）', () => {
    const secret = generateSecret();
    const now = 1758800000000;
    const code = totp(secret, { at: now });

    const first = verifyTotp(secret, code, { at: now });
    assert.strictEqual(first.valid, true);
    assert.strictEqual(typeof first.counter, 'number');

    const replay = verifyTotp(secret, code, { at: now, lastUsedCounter: first.counter });
    assert.strictEqual(replay.valid, false, '同一組碼不能再用一次');
    assert.strictEqual(replay.reason, 'replayed');

    // 下一步的新碼仍然可用
    const next = totp(secret, { at: now + 30 * 1000 });
    assert.strictEqual(verifyTotp(secret, next, { at: now + 30 * 1000, lastUsedCounter: first.counter }).valid, true);
});

test('v2.15.0 密鑰與 otpauth 連結', () => {
    const secret = generateSecret();
    assert.strictEqual(secret.length, 32, '160 bit → 32 個 Base32 字元');
    assert.match(secret, /^[A-Z2-7]+$/);
    assert.notStrictEqual(generateSecret(), secret, '每次都要是新的隨機密鑰');

    const uri = otpauthUri({ secret, account: 'alice' });
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.ok(uri.includes('secret=' + secret));
    assert.ok(uri.includes('issuer=' + encodeURIComponent('比賽管理系統')));
    assert.ok(uri.includes('digits=6') && uri.includes('period=30'));
});

test('v2.15.0 備援碼：一次性、可雜湊驗證、格式易讀', () => {
    const codes = generateRecoveryCodes(8);
    assert.strictEqual(codes.length, 8);
    assert.strictEqual(new Set(codes).size, 8, '每個備援碼都不同');
    for (const c of codes) {
        assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/, `格式不符：${c}`);
        assert.ok(!/[0189ILO]/.test(c), '不含易混淆字元 0/1/8/9/I/L/O');
    }

    const entry = hashRecoveryCode(codes[0]);
    assert.notStrictEqual(entry.hash, codes[0], '不可明文儲存');
    assert.strictEqual(verifyRecoveryCode(codes[0], entry), true);
    assert.strictEqual(verifyRecoveryCode(codes[0].toLowerCase(), entry), true, '大小寫不拘');
    assert.strictEqual(verifyRecoveryCode(codes[0].replace(/-/g, ''), entry), true, '使用者可能省略連字號');
    assert.strictEqual(verifyRecoveryCode(codes[1], entry), false);
    assert.strictEqual(verifyRecoveryCode(codes[0], { salt: entry.salt }), false, '缺少雜湊不可通過');
    assert.strictEqual(verifyRecoveryCode(codes[0], null), false);

    // 同樣的碼在不同 salt 下雜湊不同（避免看出兩組是否相同）
    const other = hashRecoveryCode(codes[0]);
    assert.notStrictEqual(other.hash, entry.hash);

    assert.strictEqual(counterAt(30 * 1000), 1);
    assert.strictEqual(counterAt(29 * 1000), 0);
});
