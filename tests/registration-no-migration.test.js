/* v2.9.0 migration 尚未執行時的行為。
   獨立成檔：欄位／資料表偵測結果在行程內有快取，必須讓假 Supabase 從行程一開始就處於該狀態。
   重點：沒有新欄位時，既有功能（發佈賽事）必須完全不受影響。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v29-no-migration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

const state = {
    tables: {
        admin_users: [{ id: 1, username: 'admin1', password: 'plain-admin', role: 'admin' }],
        competitions: [
            { id: 100, name: '既有賽事', date: '2026-12-01', is_registration_open: true, is_deleted: false, category: null, tags: [] }
        ],
        audit_logs: []
    },
    // v2.9.0 的資料表與欄位都還不存在；v2.7.0 的分類/標籤已存在
    missingTables: ['registrations', 'competition_teams'],
    missingColumns: { competitions: ['is_team_event', 'team_size', 'registration_deadline', 'max_registrations'] },
    nextId: { competitions: 200 }
};

test('v2.9.0 migration 未執行時：新功能明確停用，舊功能不受影響', async (t) => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    const token = jwt.sign({ sub: 1, username: 'admin1', role: 'admin' }, SECRET);
    const auth = { Authorization: `Bearer ${token}` };
    const post = (url, body) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
        body: JSON.stringify(body || {})
    });

    t.after(() => { server.close(); stub.close(); });

    await t.test('報名人數端點不報錯，回空物件', async () => {
        const res = await fetch(`${base}/api/registration-counts`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.deepStrictEqual(data.counts, {});
        assert.strictEqual(data.unavailable, true, '應明確標示資料不可用');
    });

    await t.test('報名 / 我的報名 / 隊伍端點回 503 並附上 migration 指示', async () => {
        const reg = await post('/api/competitions/100/register', {});
        assert.strictEqual(reg.status, 503);
        assert.match((await reg.json()).error, /2026-09-24-v2\.9\.0/);

        const mine = await fetch(`${base}/api/my/registrations`, { headers: auth });
        assert.strictEqual(mine.status, 503);

        const teams = await fetch(`${base}/api/competitions/100/teams`, { headers: auth });
        assert.strictEqual(teams.status, 503);

        const createTeam = await post('/api/competitions/100/teams', { name: 'X' });
        assert.strictEqual(createTeam.status, 503);
    });

    await t.test('發佈賽事（不帶組隊欄位）仍然正常 —— 維持舊版行為', async () => {
        const res = await post('/api/competitions', { name: '新賽事', date: '2026-12-20', location: '台北', category: 'ball', tags: ['公開組'] });
        assert.strictEqual(res.status, 200, '未帶組隊欄位時不應受影響');
        const created = await res.json();
        assert.strictEqual(created.name, '新賽事');
        assert.strictEqual(created.category, 'ball', 'v2.7.0 的分類仍可寫入');
        assert.strictEqual(created.is_team_event, undefined, '不應送出 is_team_event 欄位');
    });

    await t.test('發佈賽事（帶組隊欄位）明確回報需要執行 migration', async () => {
        const res = await post('/api/competitions', { name: '組隊賽', date: '2026-12-25', is_team_event: true });
        assert.strictEqual(res.status, 503);
        assert.match((await res.json()).error, /組隊／報名欄位/);
    });

    await t.test('編輯既有賽事（不帶組隊欄位）仍可儲存', async () => {
        const res = await fetch(`${base}/api/competitions/100`, {
            method: 'PUT',
            headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
            body: JSON.stringify({ name: '既有賽事（改名）', date: '2026-12-01', location: '高雄' })
        });
        assert.strictEqual(res.status, 200, '編輯既有賽事不應因為缺少新欄位而失敗');
        assert.strictEqual((await res.json()).name, '既有賽事（改名）');
    });
});
