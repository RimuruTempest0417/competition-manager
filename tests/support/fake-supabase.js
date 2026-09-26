/* 假的 Supabase（PostgREST）服務，供 API 端到端測試使用。
   目的：完整跑過 express 路由、授權、驗證與錯誤處理，但完全不碰真實資料庫。

   支援：
   - GET/POST/PATCH/DELETE /rest/v1/<table>
   - 查詢參數 eq.<值>／lt.／gt.／is.*／in.(a,b,c) 過濾、order=<col>.asc|desc、select 中的欄位缺失模擬（42703）
  - limit／offset 切片（PostgREST 的 limit=／offset= 查詢參數；offset 單獨出現＝從該筆取到最後）
  - count：請求帶 Prefer: count=exact 時回 Content-Range: <起>-<迄>/<總數>（supabase-js 會解析成 data.count）
    總數是「過濾後、切片前」的筆數，與真實 PostgREST 一致。
  - 注意：**刪除要 .select() 才會回傳被刪的列**
   - maybeSingle()（Accept: application/vnd.pgrst.object+json）→ 0 筆回 406
   - select('*, competitions(...)') 的外鍵展開（僅 registrations → competitions）
   - 資料表缺失模擬（42P01）
   - 唯一鍵衝突模擬：registrations 的 (competition_id, user_id) 有效紀錄唯一 → 23505
*/
const http = require('node:http');

/* 單一欄位條件的比對（eq. / is. / lt. / gt. / in.） */
function matchExpr(row, key, rawValue) {
    if (rawValue.startsWith('eq.')) {
        const want = rawValue.slice(3);
        if (String(row[key]) !== want) return false;
    } else if (rawValue === 'is.null') {
        if (row[key] !== null && row[key] !== undefined) return false;
    } else if (rawValue === 'is.true') {
        if (row[key] !== true) return false;
    } else if (rawValue === 'is.false') {
        if (row[key] !== false) return false;
    } else if (rawValue.startsWith('lt.')) {
        if (!(String(row[key]) < rawValue.slice(3))) return false;
    } else if (rawValue.startsWith('gt.')) {
        if (!(String(row[key]) > rawValue.slice(3))) return false;
    } else if (rawValue.startsWith('in.')) {
        // PostgREST 的 in.(1,2,3)：字串化的值比對（v2.17.0 批次標記錯誤日誌需要）
        const list = rawValue.slice(3).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        if (!list.includes(String(row[key]))) return false;
    }
    return true;
}

/* 依「括號深度」切開最上層的逗號：or=(a.is.null,b.in.(1,2)) 的值裡還有括號，不能用單純 split(',') */
function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of String(text)) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
        current += ch;
    }
    if (current) parts.push(current);
    return parts.map((s) => s.trim()).filter(Boolean);
}

function matches(row, params) {
    for (const [key, rawValue] of params.entries()) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue;

        // PostgREST 的 or=(a.eq.1,b.is.null)：任一條件成立就通過（v2.19.0 測 /api/competitions 需要）
        if (key === 'or') {
            const inner = String(rawValue).replace(/^\(|\)$/g, '');
            const ok = splitTopLevel(inner).some((part) => {
                const idx = part.indexOf('.');
                if (idx < 0) return false;
                return matchExpr(row, part.slice(0, idx), part.slice(idx + 1));
            });
            if (!ok) return false;
            continue;
        }

        if (!matchExpr(row, key, rawValue)) return false;
    }
    return true;
}

function startFakeSupabase(state, options = {}) {
    const tables = state.tables || {};
    const missingTables = state.missingTables || [];
    const missingColumns = state.missingColumns || {};
    const nextId = state.nextId || {};
    const log = state.log || [];
    const uniqueKeys = state.uniqueKeys || [{ table: 'registrations', columns: ['competition_id', 'user_id'], onlyActive: true }];

    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const url = new URL(req.url, 'http://127.0.0.1');
                const table = url.pathname.replace(/^\/rest\/v1\//, '');
                const params = url.searchParams;
                const accept = String(req.headers.accept || '');
                const prefers = String(req.headers.prefer || '');
                const wantsObject = accept.includes('vnd.pgrst.object+json');
                const wantsRepresentation = prefers.includes('return=representation');
                const payload = body ? JSON.parse(body) : null;

                const send = (status, data, extraHeaders = {}) => {
                    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders));
                    res.end(JSON.stringify(data === undefined ? [] : data));
                };

                log.push({ method: req.method, url: req.url, body: payload });

                if (missingTables.includes(table)) {
                    return send(404, { code: '42P01', message: `relation "public.${table}" does not exist` });
                }

                if (!tables[table]) tables[table] = [];
                const rows = tables[table];

                const select = params.get('select') || '*';
                const badColumns = missingColumns[table] || [];
                const askedMissing = badColumns.filter((c) => new RegExp(`(^|[,\\s(])${c}($|[,\\s)])`).test(select));

                if (req.method === 'GET') {
                    if (askedMissing.length) {
                        return send(400, { code: '42703', message: `column ${table}.${askedMissing[0]} does not exist` });
                    }

                    let result = rows.filter((r) => matches(r, params));

                    // 外鍵展開：registrations → competitions
                    if (table === 'registrations' && /competitions\s*\(/.test(select)) {
                        result = result.map((r) => Object.assign({}, r, {
                            competitions: (tables.competitions || []).find((c) => String(c.id) === String(r.competition_id)) || null
                        }));
                    }

                    const order = params.get('order');
                    if (order) {
                        const [col, dir] = order.split('.');
                        result = result.slice().sort((a, b) => {
                            const av = a[col], bv = b[col];
                            if (av === bv) return 0;
                            const cmp = (av === undefined || av === null) ? -1 : (bv === undefined || bv === null) ? 1 : (av > bv ? 1 : -1);
                            return dir === 'desc' ? -cmp : cmp;
                        });
                    }

                    // v3.0.0：limit／offset 切片（先算總數，再切——與 PostgREST 一致）
                    const grandTotal = result.length;
                    const limitRaw = params.get('limit');
                    const offsetRaw = params.get('offset');
                    const limitNum = limitRaw === null ? null : Math.max(0, parseInt(limitRaw, 10) || 0);
                    const offsetNum = offsetRaw === null ? 0 : Math.max(0, parseInt(offsetRaw, 10) || 0);
                    const start = offsetNum;
                    const end = limitNum === null ? result.length : offsetNum + limitNum;
                    const page = result.slice(start, end);

                    const extraHeaders = {};
                    if (/count=exact/.test(prefers)) {
                        // PostgREST：0-9/100；空集合是 */100
                        const last = page.length ? start + page.length - 1 : null;
                        extraHeaders['Content-Range'] = `${page.length ? `${start}-${last}` : '*'}/${grandTotal}`;
                    }

                    if (wantsObject) {
                        return page.length ? send(200, page[0], extraHeaders) : send(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
                    }
                    return send(200, page, extraHeaders);
                }

                if (req.method === 'POST') {
                    const incoming = Array.isArray(payload) ? payload : [payload];
                    const created = [];

                    // upsert 支援：on_conflict 指定欄位已有資料時合併更新（模擬 PostgREST merge-duplicates）
                    const conflictCols = String(params.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
                    const mergeMode = /merge-duplicates/.test(String(req.headers.prefer || ''));

                    for (const item of incoming) {
                        if (conflictCols.length && mergeMode) {
                            const existingIndex = rows.findIndex((r) => conflictCols.every((c) => String(r[c]) === String(item[c])));
                            if (existingIndex >= 0) {
                                const merged = Object.assign({}, rows[existingIndex], item);
                                rows[existingIndex] = merged;
                                created.push(merged);
                                continue;
                            }
                        }

                        // 唯一鍵檢查
                        for (const uk of uniqueKeys) {
                            if (uk.table !== table) continue;
                            const clash = rows.some((r) => uk.columns.every((c) => String(r[c]) === String(item[c]))
                                && (!uk.onlyActive || r.is_deleted === false));
                            if (clash) {
                                return send(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
                            }
                        }

                        const id = nextId[table] ? ++nextId[table] : (rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1);
                        const row = Object.assign({}, item);
                        if (row.id === undefined) row.id = id;
                        rows.push(row);
                        created.push(row);
                    }

                    return send(201, created);
                }

                if (req.method === 'PATCH') {
                    const targets = rows.filter((r) => matches(r, params));
                    targets.forEach((r) => Object.assign(r, payload));
                    return send(200, wantsRepresentation ? targets : []);
                }

                if (req.method === 'DELETE') {
                    const targets = rows.filter((r) => matches(r, params));
                    const removed = [];
                    targets.forEach((r) => {
                        const i = rows.indexOf(r);
                        if (i >= 0) {
                            rows.splice(i, 1);
                            removed.push(r);
                        }
                    });
                    // 有要求 representation 時回傳被刪除的列（PostgREST delete().select() 的行為）
                    return send(200, wantsRepresentation ? removed : []);
                }

                send(405, { message: 'method not allowed' });
            });
        });

        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

module.exports = { startFakeSupabase };
