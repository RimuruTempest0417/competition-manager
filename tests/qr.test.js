/* v3.6.5：手寫 QR 產生器的驗證
 *
 * 為什麼要驗得這麼細：QR 是「錯一個位元就整張掃不到」的東西，而且**不會報錯**——
 * 畫面看起來很正常，只是現場掃不出來，等到有人排隊才發現就太晚了。
 *
 * 三層驗證，一層比一層獨立：
 *   ① 結構：定位圖樣、計時列、暗模組、尺寸（自己就能驗的硬性規範）
 *   ② 反向讀回：在測試裡**另外寫一份**依照規範的讀取器，把資料位元流讀回來、
 *      解遮罩、還原成原始文字（驗證放置順序與遮罩是對的，不是驗程式自己）
 *   ③ 真正解碼：把矩陣畫成 PNG，交給 macOS 的 Vision 框架解（第三方解碼器，
 *      完全不知道我們的程式怎麼寫的）——解出來的內容必須一模一樣
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CMQr = require(path.join(ROOT, 'public', 'js', 'qr.js'));

/* ---------- 極簡 PNG 產生器（8-bit 灰階）----------
   只是為了把矩陣餵給 Vision，不進版控、跑完就刪。 */
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function pngFromMatrix(matrix, scale = 8, margin = 4) {
    const size = matrix.length;
    const dim = (size + margin * 2) * scale;
    const raw = Buffer.alloc(dim * (dim + 1));
    let p = 0;
    for (let y = 0; y < dim; y += 1) {
        raw[p] = 0;                                  // filter type 0
        p += 1;
        const r = Math.floor(y / scale) - margin;
        for (let x = 0; x < dim; x += 1) {
            const c = Math.floor(x / scale) - margin;
            const dark = r >= 0 && c >= 0 && r < size && c < size && matrix[r][c];
            raw[p] = dark ? 0 : 255;
            p += 1;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(dim, 0);
    ihdr.writeUInt32BE(dim, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 0;    // grayscale
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

/* ---------- 規範版讀取器（測試自己實作，不呼叫產生器的內部邏輯）---------- */
const READER_MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function readFormat(m) {
    // 讀左上那一份格式資訊（15 位，低位在前）
    // 規範順序：最高位在 (8,0)，依序往右、再往上（跳過 (6,8) 的計時列）
    const positions = [];
    for (let i = 0; i <= 5; i += 1) positions.push([8, i]);
    positions.push([8, 7], [8, 8], [7, 8]);
    for (let i = 5; i >= 0; i -= 1) positions.push([i, 8]);
    let value = 0;
    for (const [r, c] of positions) value = (value << 1) | m[r][c];
    const unmasked = value ^ 0x5412;
    // BCH(15,5) 檢查：除以 0x537 餘數必須是 0
    let check = unmasked;
    for (let i = 14; i >= 10; i -= 1) if ((check >>> i) & 1) check ^= 0x537 << (i - 10);
    return { ecc: (unmasked >>> 13) & 0b11, mask: (unmasked >>> 10) & 0b111, remainder: check };
}

function readPayload(matrix) {
    const size = matrix.length;
    const format = readFormat(matrix);
    assert.strictEqual(format.remainder, 0, '格式資訊的 BCH 檢查碼要正確（由規範獨立驗算）');
    assert.strictEqual(format.ecc, 0b00, '錯誤修正等級要是 M');

    // 功能圖樣的區域（與產生器同樣的規則，但這裡是照規範重寫）
    const reserved = [];
    for (let i = 0; i < size; i += 1) reserved.push(new Array(size).fill(false));
    const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) reserved[r][c] = true; };
    for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) mark(r, c);
    for (let r = 0; r < 9; r += 1) for (let c = size - 8; c < size; c += 1) mark(r, c);
    for (let r = size - 8; r < size; r += 1) for (let c = 0; c < 9; c += 1) mark(r, c);
    for (let i = 0; i < size; i += 1) { mark(6, i); mark(i, 6); }
    if (size >= 25) {   // 版本 2／3 的對齊圖樣
        const centers = size === 25 ? [6, 18] : [6, 22];
        for (const r of centers) for (const c of centers) {
            if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
            for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) mark(r + dr, c + dc);
        }
    }

    const maskFn = READER_MASKS[format.mask];
    const bits = [];
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col = 5;
        for (let i = 0; i < size; i += 1) {
            const row = upward ? size - 1 - i : i;
            for (let k = 0; k < 2; k += 1) {
                const c = col - k;
                if (reserved[row][c]) continue;
                let bit = matrix[row][c];
                if (maskFn(row, c)) bit ^= 1;
                bits.push(bit);
            }
        }
        upward = !upward;
    }

    // byte mode：模式 4 位（0100）＋長度 8 位＋資料
    let idx = 0;
    const take = (n) => {
        let v = 0;
        for (let i = 0; i < n; i += 1) v = (v << 1) | bits[idx++];
        return v;
    };
    assert.strictEqual(take(4), 0b0100, '模式必須是 byte mode');
    const length = take(8);
    const bytes = [];
    for (let i = 0; i < length; i += 1) bytes.push(take(8));
    return { text: Buffer.from(bytes).toString('utf8'), mask: format.mask };
}

/* ---------- ① 結構 ---------- */
test('v3.6.5 QR 產生器：結構符合規範', () => {
    const { matrix, size, version } = CMQr.encode('CM1:PLAY2K47');
    assert.strictEqual(size, version * 4 + 17, '邊長要符合版本公式');
    assert.strictEqual(size, 21, '短的報到碼應該用版本 1（21×21）');

    // 三個定位圖樣：中心 3×3 全暗、外框全暗、中間一圈亮
    const finderAt = (row, col) => {
        for (let r = 0; r < 7; r += 1) {
            for (let c = 0; c < 7; c += 1) {
                const expected = (r === 0 || r === 6 || c === 0 || c === 6) ? 1 : ((r >= 2 && r <= 4 && c >= 2 && c <= 4) ? 1 : 0);
                assert.strictEqual(matrix[row + r][col + c], expected, `定位圖樣 (${row + r},${col + c}) 不對`);
            }
        }
    };
    finderAt(0, 0);
    finderAt(0, size - 7);
    finderAt(size - 7, 0);

    // 計時列要 1 0 1 0 交替
    for (let i = 8; i < size - 8; i += 1) {
        assert.strictEqual(matrix[6][i], i % 2 === 0 ? 1 : 0, `水平計時列第 ${i} 格不對`);
        assert.strictEqual(matrix[i][6], i % 2 === 0 ? 1 : 0, `垂直計時列第 ${i} 格不對`);
    }
    assert.strictEqual(matrix[size - 8][8], 1, '固定的暗模組要是 1');
});

/* ---------- ② 反向讀回 ---------- */
test('v3.6.5 QR 產生器：資料可以反向讀回', () => {
    const payload = 'CM1:PLAY2K47';
    const { matrix } = CMQr.encode(payload);
    assert.strictEqual(readPayload(matrix).text, payload, '★讀回的文字必須與輸入完全一致');

    // 換一段較長、含中文的內容（UTF-8、版本會往上跳）
    const long = 'CM1:颱風盃-現場報到-ABCD2345';
    const built = CMQr.encode(long);
    assert.strictEqual(readPayload(built.matrix).text, long, '★中文（多位元組）也要讀得回來');
    assert.ok(built.version >= 2, '內容變長要自動用更大的版本');
    assert.ok([1, 2, 3].includes(built.mask), '遮罩編號要在合法範圍');
});

/* ---------- ③ 交給系統解碼器（Vision）---------- */
test('v3.6.5 QR 產生器：macOS Vision 解得出來', (t) => {
    const swiftc = (() => {
        try { return execFileSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).trim(); } catch (err) { return null; }
    })();
    if (!swiftc) {
        t.skip('這台機器沒有 swiftc（macOS 開發工具），跳過系統解碼驗證');
        return;
    }

    const payloads = ['CM1:PLAY2K47', 'CM1:颱風盃-ABCD2345'];
    for (const payload of payloads) {
        const { matrix } = CMQr.encode(payload);
        const png = path.join(os.tmpdir(), `cm-qr-verify-${Date.now()}.png`);
        fs.writeFileSync(png, pngFromMatrix(matrix));
        try {
            const out = execFileSync('swift', [path.join(ROOT, 'scripts', 'qr-decode.swift'), png], {
                encoding: 'utf8',
                timeout: 180000
            }).trim();
            assert.strictEqual(out, payload, `★系統解碼結果必須等於原始內容（${payload}）`);
        } finally {
            fs.rmSync(png, { force: true });   // 驗證完就刪，不留任何圖檔
        }
    }
});

/* ---------- 邊界與 SVG ---------- */
test('v3.6.5 QR 產生器：容量上限與 SVG 輸出', () => {
    assert.strictEqual(CMQr.capacity(1), 14, 'v1-M 可放 14 bytes');
    assert.throws(() => CMQr.encode('x'.repeat(200)), /內容太長/, '超過容量要明確丟錯，不可以產生壞碼');

    const payload = 'CM1:PLAY2K47';
    const svg = CMQr.svg(payload, { scale: 4, margin: 2, alt: '報到碼' });
    assert.ok(svg.startsWith('<svg ') && svg.trim().endsWith('</svg>'), '要是完整的 SVG');
    assert.ok(svg.includes('shape-rendering="crispEdges"'), '要用 crispEdges，否則格子會被糊掉而掃不到');
    assert.ok(svg.includes('<title>報到碼</title>'), '要有無障礙標題');
    assert.ok(!svg.includes('<script'), 'SVG 不可以夾帶任何 script（CSP 與安全）');
    const rects = (svg.match(/<rect /g) || []).length;
    const { matrix } = CMQr.encode(payload);
    const dark = matrix.flat().filter(Boolean).length;
    assert.strictEqual(rects, dark + 1, '深色格子數要與矩陣一致（外加底色那一個 rect）');
});
