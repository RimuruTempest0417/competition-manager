/* v2.13.0：資料庫金鑰解析與 RLS 準備狀態測試
   - resolveSupabaseKey：名稱優先序（SUPABASE_SERVICE_ROLE_KEY → SUPABASE_SERVICE_KEY → SUPABASE_KEY）
   - 健康端點回報 db_key_type / rls_ready（讓「能不能安全開啟 RLS」變成可觀測）
   全程使用假 Supabase，不碰真實資料庫。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v2130-key-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;

// resolveSupabaseKey 是純函式，不需要連線即可測試
const { resolveSupabaseKey } = require(path.join(__dirname, '..', 'server.js')).__test__;

test('v2.13.0 金鑰名稱優先序：service_role 優先於 anon', () => {
    assert.strictEqual(resolveSupabaseKey({
        SUPABASE_SERVICE_ROLE_KEY: 'svc-role', SUPABASE_SERVICE_KEY: 'svc-short', SUPABASE_KEY: 'anon'
    }), 'svc-role');
    assert.strictEqual(resolveSupabaseKey({
        SUPABASE_SERVICE_KEY: 'svc-short', SUPABASE_KEY: 'anon'
    }), 'svc-short', '沒有官方命名時應接受 SUPABASE_SERVICE_KEY');
    assert.strictEqual(resolveSupabaseKey({ SUPABASE_KEY: 'anon' }), 'anon', '只有 anon 時仍可運作（尚未開啟 RLS）');
    assert.strictEqual(resolveSupabaseKey({}), '', '完全沒設定時回空字串（啟動時會警告）');
    assert.strictEqual(resolveSupabaseKey(undefined), '', '不應因 undefined 而拋錯');
});

async function bootApp(state, envPatch) {
    const stub = await startFakeSupabase(state);
    const saved = {};
    for (const [k, v] of Object.entries(envPatch)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    delete require.cache[require.resolve(path.join(__dirname, '..', 'server.js'))];
    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { stub, server, base: `http://127.0.0.1:${server.address().port}`, restore: () => Object.assign(process.env, saved) };
}

const baseState = () => ({
    tables: {
        admin_users: [
            { id: 1, username: 'owner', password: 'plain-owner', role: 'web_owner', is_active: true },
            { id: 9, username: 'Melody', password: 'plain-m9', role: 'admin', is_active: true }
        ],
        error_logs: [],
        competitions: [],
        registrations: []
    },
    missingColumns: {},
    nextId: { admin_users: 20, error_logs: 1 }
});

test('v2.13.0 健康端點回報金鑰類型：使用 anon 時 rls_ready=false', async (t) => {
    const { stub, server, base, restore } = await bootApp(baseState(), {
        SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SERVICE_KEY: undefined, SUPABASE_KEY: 'anon-key'
    });
    t.after(() => { server.close(); stub.close(); restore(); });

    const token = jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
    const r = await fetch(base + '/api/admin/error-logs/health', { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.db_key_type, 'anon');
    assert.strictEqual(body.rls_ready, false, '仍用 anon key 時不得回報可以開 RLS');
    assert.ok(!JSON.stringify(body).includes('anon-key'), '回應不得包含金鑰本身');
});

test('v2.13.0 健康端點回報金鑰類型：使用 service_role 時 rls_ready=true', async (t) => {
    const { stub, server, base, restore } = await bootApp(baseState(), {
        SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SERVICE_KEY: 'service-key-value', SUPABASE_KEY: 'anon-key'
    });
    t.after(() => { server.close(); stub.close(); restore(); });

    const token = jwt.sign({ sub: 1, username: 'owner', role: 'web_owner' }, SECRET);
    const r = await fetch(base + '/api/admin/error-logs/health', { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json();
    assert.strictEqual(body.db_key_type, 'service_role');
    assert.strictEqual(body.rls_ready, true, '改用 service_role 後才回報可以安全開啟 RLS');
    assert.ok(!JSON.stringify(body).includes('service-key-value'), '回應不得包含金鑰本身');

    // 伺服器仍須正常運作（清單、日誌皆可讀）
    const list = await fetch(base + '/api/admin/users', { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(list.status, 200);
});
