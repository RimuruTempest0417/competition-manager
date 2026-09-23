/* 假的 Supabase（PostgREST）服務，供 API 端到端測試使用。
   目的：完整跑過 express 路由、授權、驗證與錯誤處理，但完全不碰真實資料庫。

   支援：
   - GET/POST/PATCH/DELETE /rest/v1/<table>
   - 查詢參數 eq.<值> 過濾、order=<col>.asc|desc、select 中的欄位缺失模擬（42703）
   - maybeSingle()（Accept: application/vnd.pgrst.object+json）→ 0 筆回 406
   - select('*, competitions(...)') 的外鍵展開（僅 registrations → competitions）
   - 資料表缺失模擬（42P01）
   - 唯一鍵衝突模擬：registrations 的 (competition_id, user_id) 有效紀錄唯一 → 23505
*/
const http = require('node:http');

function matches(row, params) {
    for (const [key, rawValue] of params.entries()) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue;

        if (rawValue.startsWith('eq.')) {
            const want = rawValue.slice(3);
            if (String(row[key]) !== want) return false;
        } else if (rawValue === 'is.null') {
            if (row[key] !== null && row[key] !== undefined) return false;
        } else if (rawValue === 'is.true') {
            if (row[key] !== true) return false;
        } else if (rawValue === 'is.false') {
            if (row[key] !== false) return false;
        }
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

                    if (wantsObject) {
                        return result.length ? send(200, result[0]) : send(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
                    }
                    return send(200, result);
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
                    targets.forEach((r) => {
                        const i = rows.indexOf(r);
                        if (i >= 0) rows.splice(i, 1);
                    });
                    return send(200, []);
                }

                send(405, { message: 'method not allowed' });
            });
        });

        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

module.exports = { startFakeSupabase };
