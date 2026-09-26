/* qr.js — 手寫 QR Code 產生器（v3.6.5，現場報到用）
 *
 * 為什麼要自己寫：本專案不放任何前端外部套件（CSP 是 script-src 'self'、style-src 'self'），
 * 所以不能引入 qrcode 之類的函式庫。
 *
 * 刻意只做「夠用」的範圍（寧可小但要正確）：
 *   - byte mode（UTF-8）＋ 錯誤修正等級 M（約 15% 容錯，現場手機螢幕反光仍掃得到）
 *   - 版本 1／2／3：都是**單一 RS 區塊**，不需要交錯（interleaving），程式碼少一半、錯誤也少一半
 *   - 內容長度上限：v1-M 14 bytes、v2-M 26 bytes、v3-M 42 bytes（超過就丟錯，不靜默產生壞碼）
 *   - 不做版本資訊區塊（那是版本 7 以上才要）
 *
 * 產出是 SVG 字串（純文字、可放進 DOM、可列印、可被 <img> 或直接貼進 HTML）；
 * 需要點陣圖時由呼叫端自行處理（測試用 Node 的 zlib 寫 PNG，不進版控）。
 *
 * 對外 API（掛在 window.CMQr，也支援 Node 端 require 做測試）：
 *   CMQr.encode(text)          → { version, size, mask, matrix }（matrix 是 0/1 的二維陣列）
 *   CMQr.svg(text, options)    → SVG 字串（options: { scale, margin, dark, light, alt })
 *   CMQr.capacity(version)     → 該版本可容納的 byte 數（等級 M）
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CMQr = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* ---------- 版本表（等級 M、單一區塊）----------
       total：該版本總 codeword 數（＝資料 + 錯誤修正）
       data ：資料 codeword 數
       ecc  ：錯誤修正 codeword 數
       align：對齊圖樣中心（版本 1 沒有） */
    const VERSIONS = {
        1: { total: 26, data: 16, ecc: 10, align: [] },
        2: { total: 44, data: 28, ecc: 16, align: [6, 18] },
        3: { total: 70, data: 44, ecc: 26, align: [6, 22] }
    };

    /* ---------- GF(256) 運算（QR 用的 RS 編碼在 GF(256)、本原多項式 0x11D）---------- */
    const EXP = new Uint8Array(512);
    const LOG = new Uint8Array(256);
    (function initGalois() {
        let x = 1;
        for (let i = 0; i < 255; i += 1) {
            EXP[i] = x;
            LOG[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11D;
        }
        for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
    }());

    function gfMul(a, b) {
        if (a === 0 || b === 0) return 0;
        return EXP[LOG[a] + LOG[b]];
    }

    /* 產生多項式 g(x) = (x - a^0)(x - a^1)...(x - a^(n-1))，係數由高次到低次 */
    function rsGenerator(n) {
        let poly = [1];
        for (let i = 0; i < n; i += 1) {
            const next = new Array(poly.length + 1).fill(0);
            for (let j = 0; j < poly.length; j += 1) {
                next[j] ^= poly[j];
                next[j + 1] ^= gfMul(poly[j], EXP[i]);
            }
            poly = next;
        }
        return poly;
    }

    /* 計算 n 個錯誤修正 codeword（多項式長除法取餘式） */
    function rsEncode(data, n) {
        const gen = rsGenerator(n);
        const rem = new Array(n).fill(0);
        for (const byte of data) {
            const factor = byte ^ rem[0];
            rem.shift();
            rem.push(0);
            for (let i = 0; i < n; i += 1) rem[i] ^= gfMul(gen[i + 1], factor);
        }
        return rem;
    }

    /* ---------- 位元緩衝 ---------- */
    function BitBuffer() {
        this.bits = [];
    }
    BitBuffer.prototype.put = function (value, length) {
        for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
    };

    function utf8Bytes(text) {
        if (typeof Buffer !== 'undefined') return Array.from(Buffer.from(String(text), 'utf8'));
        return Array.from(new TextEncoder().encode(String(text)));
    }

    /* ---------- 資料編碼（byte mode）---------- */
    function buildCodewords(bytes, versionInfo) {
        const buffer = new BitBuffer();
        buffer.put(0b0100, 4);                     // byte mode
        buffer.put(bytes.length, 8);               // v1-9 的字元計數指標是 8 位
        for (const b of bytes) buffer.put(b, 8);

        const capacityBits = versionInfo.data * 8;
        if (buffer.bits.length > capacityBits) return null;

        // 終止符（最多 4 個 0）
        const terminator = Math.min(4, capacityBits - buffer.bits.length);
        buffer.put(0, terminator);
        // 補齊到 8 的倍數
        while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);

        const data = [];
        for (let i = 0; i < buffer.bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j += 1) byte = (byte << 1) | buffer.bits[i + j];
            data.push(byte);
        }
        // 補滿資料區（0xEC / 0x11 交替，規範指定）
        const pad = [0xEC, 0x11];
        let p = 0;
        while (data.length < versionInfo.data) data.push(pad[p++ % 2]);
        return data;
    }

    /* ---------- 矩陣 ---------- */
    function createMatrix(size) {
        const m = [];
        for (let i = 0; i < size; i += 1) m.push(new Array(size).fill(null));
        return m;
    }

    function placeFinder(m, row, col) {
        for (let r = -1; r <= 7; r += 1) {
            for (let c = -1; c <= 7; c += 1) {
                const rr = row + r;
                const cc = col + c;
                if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
                const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
                const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
                m[rr][cc] = (inRing || inCore) ? 1 : 0;
            }
        }
    }

    function placeAlignment(m, version) {
        const centers = VERSIONS[version].align;
        for (const r of centers) {
            for (const c of centers) {
                // 跳過與定位圖樣重疊的三個角落
                if ((r === 6 && c === 6) || (r === 6 && c === m.length - 7) || (r === m.length - 7 && c === 6)) continue;
                for (let dr = -2; dr <= 2; dr += 1) {
                    for (let dc = -2; dc <= 2; dc += 1) {
                        const isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
                        m[r + dr][c + dc] = isDark ? 1 : 0;
                    }
                }
            }
        }
    }

    function reserveFormatAreas(m) {
        const size = m.length;
        for (let i = 0; i < 9; i += 1) {
            if (m[8][i] === null) m[8][i] = 0;
            if (m[i][8] === null) m[i][8] = 0;
        }
        for (let i = 0; i < 8; i += 1) {
            if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
            if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
        }
        m[size - 8][8] = 1;   // 固定的暗模組
    }

    function placeTiming(m) {
        for (let i = 8; i < m.length - 8; i += 1) {
            if (m[6][i] === null) m[6][i] = (i % 2 === 0) ? 1 : 0;
            if (m[i][6] === null) m[i][6] = (i % 2 === 0) ? 1 : 0;
        }
    }

    function reserveDataMap(m) {
        // 標記哪些格子是功能圖樣（true＝不可放資料）
        const size = m.length;
        const reserved = [];
        for (let i = 0; i < size; i += 1) reserved.push(new Array(size).fill(false));
        for (let r = 0; r < size; r += 1) {
            for (let c = 0; c < size; c += 1) reserved[r][c] = m[r][c] !== null;
        }
        return reserved;
    }

    function placeData(m, reserved, codewords) {
        const size = m.length;
        let bitIndex = 0;
        const totalBits = codewords.length * 8;
        let upward = true;
        for (let col = size - 1; col > 0; col -= 2) {
            if (col === 6) col = 5;   // 跳過垂直計時列
            for (let i = 0; i < size; i += 1) {
                const row = upward ? size - 1 - i : i;
                for (let k = 0; k < 2; k += 1) {
                    const c = col - k;
                    if (reserved[row][c]) continue;
                    let bit = 0;
                    if (bitIndex < totalBits) {
                        const byte = codewords[bitIndex >> 3];
                        bit = (byte >>> (7 - (bitIndex & 7))) & 1;
                    }
                    m[row][c] = bit;
                    bitIndex += 1;
                }
            }
            upward = !upward;
        }
    }

    const MASKS = [
        (r, c) => (r + c) % 2 === 0,
        (r) => r % 2 === 0,
        (r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
        (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
        (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    ];

    function applyMask(matrix, reserved, maskIndex) {
        const size = matrix.length;
        const out = matrix.map((row) => row.slice());
        const fn = MASKS[maskIndex];
        for (let r = 0; r < size; r += 1) {
            for (let c = 0; c < size; c += 1) {
                if (reserved[r][c]) continue;
                if (fn(r, c)) out[r][c] ^= 1;
            }
        }
        return out;
    }

    function formatBits(maskIndex) {
        // 等級 M = 00；5 位元 BCH(15,5)，產生多項式 0x537，最後 XOR 0x5412
        const data = (0b00 << 3) | maskIndex;
        let value = data << 10;
        for (let i = 4; i >= 0; i -= 1) {
            if ((value >>> (10 + i)) & 1) value ^= 0x537 << i;
        }
        return ((data << 10) | value) ^ 0x5412;
    }

    function placeFormat(m, maskIndex) {
        const size = m.length;
        const bits = formatBits(maskIndex);
        const bit = (i) => (bits >>> i) & 1;   // i = 位元編號（0 = 最低位）
        // ★規範順序：第一份從**最高位（bit 14）**開始擺，橫向由左而右、再縱向由下而上。
        // （曾經寫成最低位先擺：自己的讀取器用同一套錯誤假設所以「驗過」，但真實解碼器讀不到。）
        for (let i = 0; i <= 5; i += 1) m[8][i] = bit(14 - i);     // (8,0)…(8,5)
        m[8][7] = bit(8);                                          // 跳過 (8,6) 的垂直計時列
        m[8][8] = bit(7);
        m[7][8] = bit(6);
        for (let i = 0; i <= 5; i += 1) m[5 - i][8] = bit(5 - i);  // (5,8)…(0,8)
        // 右上／左下：第二份（損壞時仍可讀）
        for (let i = 0; i <= 7; i += 1) m[size - 1 - i][8] = bit(i);
        for (let i = 8; i <= 14; i += 1) m[8][size - 15 + i] = bit(i);
        m[size - 8][8] = 1;   // 暗模組（固定為 1）
    }

    /* ---------- 遮罩評分（規範的四條規則，取最低分）---------- */
    function penalty(matrix) {
        const size = matrix.length;
        let score = 0;
        const lines = matrix.concat(matrix[0].map((_, c) => matrix.map((row) => row[c])));
        for (const line of lines) {
            let run = 1;
            for (let i = 1; i < line.length; i += 1) {
                if (line[i] === line[i - 1]) {
                    run += 1;
                } else {
                    if (run >= 5) score += 3 + (run - 5);
                    run = 1;
                }
            }
            if (run >= 5) score += 3 + (run - 5);
        }
        // 2x2 同色區塊
        for (let r = 0; r < size - 1; r += 1) {
            for (let c = 0; c < size - 1; c += 1) {
                const v = matrix[r][c];
                if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
            }
        }
        // 1:1:3:1:1 樣式（前後接 4 個淺色）
        const pattern = [1, 0, 1, 1, 1, 0, 1];
        const hasRun = (line, start) => {
            for (let i = 0; i < 7; i += 1) if (line[start + i] !== pattern[i]) return false;
            const before = start - 4 < 0 || line.slice(start - 4, start).every((v) => v === 0);
            const after = start + 11 > line.length || line.slice(start + 7, start + 11).every((v) => v === 0);
            return before || after;
        };
        for (const line of lines) {
            for (let i = 0; i + 7 <= line.length; i += 1) if (hasRun(line, i)) score += 40;
        }
        // 深色比例偏離 50%
        let dark = 0;
        for (const row of matrix) for (const v of row) if (v) dark += 1;
        const percent = (dark * 100) / (size * size);
        score += Math.floor(Math.abs(percent - 50) / 5) * 10;
        return score;
    }

    function buildMatrix(bytes, version) {
        const info = VERSIONS[version];
        const data = buildCodewords(bytes, info);
        if (!data) return null;
        const ecc = rsEncode(data, info.ecc);
        const all = data.concat(ecc);

        const size = version * 4 + 17;
        const base = createMatrix(size);
        placeFinder(base, 0, 0);
        placeFinder(base, 0, size - 7);
        placeFinder(base, size - 7, 0);
        placeAlignment(base, version);
        placeTiming(base);
        reserveFormatAreas(base);

        const reserved = reserveDataMap(base);
        placeData(base, reserved, all);

        let best = null;
        for (let mask = 0; mask < 8; mask += 1) {
            const candidate = applyMask(base, reserved, mask);
            placeFormat(candidate, mask);
            const score = penalty(candidate);
            if (!best || score < best.score) best = { score, mask, matrix: candidate };
        }
        return { version, size, mask: best.mask, matrix: best.matrix };
    }

    function encode(text) {
        const bytes = utf8Bytes(text);
        for (const version of [1, 2, 3]) {
            if (bytes.length <= VERSIONS[version].data - 2) {   // 扣掉模式(4bit)與長度(8bit)後仍塞得下
                const built = buildMatrix(bytes, version);
                if (built) return built;
            }
        }
        throw new Error(`內容太長（${bytes.length} bytes）：這個產生器支援到版本 3（等級 M 最多 ${VERSIONS[3].data - 2} bytes）`);
    }

    function svg(text, options) {
        const opts = options || {};
        const scale = opts.scale || 6;
        const margin = opts.margin === undefined ? 3 : opts.margin;
        const dark = opts.dark || '#0f172a';
        const light = opts.light || '#ffffff';
        const { size, matrix } = encode(text);
        const dim = (size + margin * 2) * scale;
        const rects = [];
        for (let r = 0; r < size; r += 1) {
            for (let c = 0; c < size; c += 1) {
                if (!matrix[r][c]) continue;
                rects.push(`<rect x="${(c + margin) * scale}" y="${(r + margin) * scale}" width="${scale}" height="${scale}"/>`);
            }
        }
        const label = opts.alt ? `<title>${String(opts.alt).replace(/[<>&]/g, '')}</title>` : '';
        // 形狀渲染（shape-rendering=crispEdges）避免瀏覽器把格子糊成一團導致掃不到
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" `
            + `role="img" shape-rendering="crispEdges" class="cm-qr">${label}`
            + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
            + `<g fill="${dark}">${rects.join('')}</g></svg>`;
    }

    return {
        encode,
        svg,
        capacity: (version) => VERSIONS[version].data - 2,
        versions: Object.keys(VERSIONS).map(Number),
        _internal: { buildMatrix, rsEncode, formatBits, penalty, MASKS }
    };
}));
