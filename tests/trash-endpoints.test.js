/* v3.5.4：補齊「8 條沒有測試的端點」之三 —— 回收筒四條
 *
 *   GET    /api/competitions/trash              （admin 以上）
 *   GET    /api/competitions/deleted            （同一支 handler 的別名）
 *   PUT    /api/competitions/:id/restore        （admin 以上）
 *   DELETE /api/competitions/:id/hard-delete    （super_admin 以上，真的刪除）
 *
 * 為什麼要補：這四條是「刪除」的最後一道門。soft delete 錯成 hard delete
 * 會直接讓資料消失，而且不會有任何錯誤訊息（回應照樣 200）。
 * 這裡用假 Supabase 直接檢查資料表的實際狀態，不看回應訊息說什麼。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v354-trash-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const comp = (id, name, isDeleted) => ({
    id, name, location: '澳門運動場', date: '2026-12-01', time: '09:00',
    description: '', is_registration_open: true, is_deleted: isDeleted
});

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'x', role: 'web_owner', is_active: true },
            { id: 2, username: 'staff', password: 'x', role: 'admin', is_active: true },
            { id: 3, username: 'helper', password: 'x', role: 'super_admin', is_active: true },
            { id: 4, username: 'player', password: 'x', role: 'user', is_active: true }
        ],
        competitions: [
            comp(801, '還在線上的賽事', false),
            comp(802, '被刪掉的賽事 A', true),
            comp(803, '被刪掉的賽事 B', true)
        ],
        registrations: [],
        audit_logs: []
    },
    nextId: { competitions: 900, audit_logs: 900 }
};

test('v3.5.4 回收筒端點：列表、還原與永久刪除', async (t) => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        try { server.close(); } catch (err) { /* 忽略 */ }
        try { stub.close(); } catch (err) { /* 忽略 */ }
    });

    const token = (sub, username, role) => jwt.sign({ sub, username, role }, SECRET, { expiresIn: '10m' });
    const asStaff = 'Bearer ' + token(2, 'staff', 'admin');
    const asHelper = 'Bearer ' + token(3, 'helper', 'super_admin');
    const asPlayer = 'Bearer ' + token(4, 'player', 'user');
    const asOwner = 'Bearer ' + token(1, 'owner', 'web_owner');
    const get = (url, auth) => fetch(base + url, { headers: auth ? { Authorization: auth } : {} });
    const put = (url, auth) => fetch(base + url, { method: 'PUT', headers: auth ? { Authorization: auth } : {} });
    const del = (url, auth) => fetch(base + url, { method: 'DELETE', headers: auth ? { Authorization: auth } : {} });
    const ids = (list) => list.map((c) => c.id);

    /* ---------- ① 權限：未登入 401、一般使用者 403、admin 以上才看得到 ---------- */
    assert.strictEqual((await get('/api/competitions/trash')).status, 401, '未登入不可讀回收筒');
    assert.strictEqual((await get('/api/competitions/trash', asPlayer)).status, 403, '一般使用者不可讀回收筒');

    const list = await (await get('/api/competitions/trash', asStaff)).json();
    assert.deepStrictEqual(ids(list).sort(), [802, 803], `回收筒只列 is_deleted 的賽事（實際 ${JSON.stringify(ids(list))}）`);

    /* ---------- ② 別名 /deleted 必須與 /trash 同一個結果 ---------- */
    const alias = await (await get('/api/competitions/deleted', asStaff)).json();
    assert.deepStrictEqual(ids(alias).sort(), ids(list).sort(), '/deleted 是 /trash 的別名，結果要一致');

    /* ---------- ③ 還原：admin 可用，只把那一筆設回 is_deleted=false ---------- */
    assert.strictEqual((await put('/api/competitions/802/restore')).status, 401, '未登入不可還原');
    assert.strictEqual((await put('/api/competitions/802/restore', asPlayer)).status, 403, '一般使用者不可還原');

    const restored = await put('/api/competitions/802/restore', asStaff);
    assert.strictEqual(restored.status, 200, '管理員要能還原賽事');
    const row802 = state.tables.competitions.find((c) => c.id === 802);
    assert.strictEqual(row802.is_deleted, false, '還原後 is_deleted 必須是 false（這是前台看不看得到的依據）');
    assert.strictEqual(row802.name, '被刪掉的賽事 A', '還原不得改動其他欄位');
    assert.strictEqual(state.tables.competitions.find((c) => c.id === 803).is_deleted, true, '還原一筆不得連帶還原其他筆');

    const afterRestore = await (await get('/api/competitions/trash', asStaff)).json();
    assert.deepStrictEqual(ids(afterRestore), [803], '還原後回收筒只剩還沒還原的那筆');

    const auditRestore = state.tables.audit_logs.filter((l) => l.action === 'RESTORE_COMPETITION');
    assert.strictEqual(auditRestore.length, 1, '還原要留一筆稽核');
    assert.match(String(auditRestore[0].details), /被刪掉的賽事 A/, '稽核要記下賽事名稱，之後查得到還原了什麼');

    /* ---------- ④ 永久刪除：admin 不行（要 super_admin），而且是真的刪掉 ---------- */
    assert.strictEqual((await del('/api/competitions/803/hard-delete', asStaff)).status, 403,
        '永久刪除只給 super_admin（admin 只能 soft delete／還原）');
    assert.ok(state.tables.competitions.some((c) => c.id === 803), '被拒絕的請求不得刪掉任何資料');

    const hardDeleted = await del('/api/competitions/803/hard-delete', asHelper);
    assert.strictEqual(hardDeleted.status, 200, 'super_admin 要能永久刪除');
    assert.ok(!state.tables.competitions.some((c) => c.id === 803), '永久刪除後資料列必須真的消失');

    const auditHard = state.tables.audit_logs.filter((l) => l.action === 'PERMANENT_DELETE_COMPETITION');
    assert.strictEqual(auditHard.length, 1, '永久刪除要留稽核（否則資料怎麼不見的查不出來）');
    assert.strictEqual(String(auditHard[0].target_id), '803', '稽核要指向被刪的那一筆');

    /* ---------- ⑤ web_owner 也可以永久刪除（階梯最高）---------- */
    const ownerDelete = await del('/api/competitions/801/hard-delete', asOwner);
    assert.strictEqual(ownerDelete.status, 200, 'web_owner 屬於最高階，也應能永久刪除');
    assert.ok(!state.tables.competitions.some((c) => c.id === 801), 'web_owner 的永久刪除要真的生效');

    /* ---------- ⑥ 回收筒已清空時要回空陣列，不是 null ---------- */
    const empty = await (await get('/api/competitions/trash', asStaff)).json();
    assert.ok(Array.isArray(empty), '回收筒要回陣列（前端直接 .length，回 null 會爆）');
    assert.strictEqual(empty.length, 0, '沒有已刪除的賽事時要回空陣列');
});
