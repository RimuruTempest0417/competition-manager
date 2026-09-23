/* v2.9.0：普通用戶、報名、隊伍編排的 API 端到端測試。
   使用 tests/support/fake-supabase.js 模擬 PostgREST，完全不碰真實資料庫。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const { startFakeSupabase } = require('./support/fake-supabase');

const SECRET = 'v29-integration-secret';
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_KEY = 'stub-key';

// 以「今天」推算日期，讓測試不會隨時間失效
const pad = (n) => String(n).padStart(2, '0');
function dateOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const state = {
    tables: {
        admin_users: [
            { id: 1, username: 'admin1', password: 'plain-admin', role: 'admin' },
            { id: 2, username: 'player1', password: 'plain-player', role: 'user' },
            { id: 3, username: 'boss', password: 'plain-boss', role: 'super_admin' },
            { id: 4, username: 'player2', password: 'plain-player2', role: 'user' }
        ],
        competitions: [
            { id: 100, name: '個人賽', date: dateOffset(30), is_registration_open: true, is_deleted: false, is_team_event: false, team_size: 0, max_registrations: 0, registration_deadline: null },
            { id: 101, name: '組隊賽', date: dateOffset(40), is_registration_open: true, is_deleted: false, is_team_event: true, team_size: 2, max_registrations: 0, registration_deadline: dateOffset(20) },
            { id: 102, name: '已截止賽', date: dateOffset(50), is_registration_open: true, is_deleted: false, is_team_event: false, team_size: 0, registration_deadline: dateOffset(-3) },
            { id: 103, name: '未開放報名賽', date: dateOffset(60), is_registration_open: false, is_deleted: false, is_team_event: false, team_size: 0, max_registrations: 0 },
            { id: 104, name: '限額 1 人賽', date: dateOffset(70), is_registration_open: true, is_deleted: false, is_team_event: false, team_size: 0, max_registrations: 1 }
        ],
        registrations: [],
        competition_teams: [],
        audit_logs: []
    },
    nextId: { registrations: 500, competition_teams: 900, admin_users: 50 }
};

test('v2.9.0 報名與隊伍編排 API', async (t) => {
    const stub = await startFakeSupabase(state);
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = require(path.join(__dirname, '..', 'server.js'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    const sign = (sub, username, role) => jwt.sign({ sub, username, role }, SECRET);
    const asAdmin = { Authorization: `Bearer ${sign(1, 'admin1', 'admin')}` };
    const asPlayer1 = { Authorization: `Bearer ${sign(2, 'player1', 'user')}` };
    const asPlayer2 = { Authorization: `Bearer ${sign(4, 'player2', 'user')}` };
    const asBoss = { Authorization: `Bearer ${sign(3, 'boss', 'super_admin')}` };
    const post = (url, body, headers) => fetch(base + url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body || {})
    });

    t.after(() => { server.close(); stub.close(); });

    // ---------- 註冊 / 登入 ----------
    await t.test('註冊普通用戶：格式驗證、成功後即登入、密碼雜湊儲存', async () => {
        assert.strictEqual((await post('/api/auth/register', { username: 'ab', password: 'abcd12' })).status, 400);
        assert.strictEqual((await post('/api/auth/register', { username: 'newplayer', password: 'abc' })).status, 400);
        assert.strictEqual((await post('/api/auth/register', { username: '中文', password: 'abcd12' })).status, 400);

        const res = await post('/api/auth/register', { username: 'newplayer', password: 'abcd12' });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.user.role, 'user', '新註冊帳號應為普通用戶');
        assert.ok(data.token, '應直接回傳 token');

        const stored = state.tables.admin_users.find((u) => u.username === 'newplayer');
        assert.outcome ? null : null;
        assert.match(stored.password, /^scrypt\$/, '密碼應以 scrypt 雜湊儲存，不可存明碼');
        assert.ok(!stored.password.includes('abcd12'));

        assert.strictEqual((await post('/api/auth/register', { username: 'newplayer', password: 'abcd12' })).status, 409, '帳號重複應 409');
    });

    await t.test('登入：新雜湊密碼可登入、舊明碼帳號仍可登入、錯密碼 401', async () => {
        const hashed = await post('/api/auth/login', { username: 'newplayer', password: 'abcd12' });
        assert.strictEqual(hashed.status, 200, '雜湊密碼應可登入');

        const legacy = await post('/api/auth/login', { username: 'player1', password: 'plain-player' });
        assert.strictEqual(legacy.status, 200, '舊的明碼帳號仍可登入');
        assert.strictEqual((await legacy.json()).user.role, 'user');

        assert.strictEqual((await post('/api/auth/login', { username: 'player1', password: 'wrong' })).status, 401);
    });

    await t.test('GET /api/auth/me 與公開端點', async () => {
        const me = await fetch(`${base}/api/auth/me`, { headers: asPlayer1 });
        assert.strictEqual((await me.json()).user.username, 'player1');

        const cfg = await (await fetch(`${base}/api/public-config`)).json();
        assert.strictEqual(cfg.requireRegistrationCode, false);

        const counts = await (await fetch(`${base}/api/registration-counts`)).json();
        assert.deepStrictEqual(counts.counts, {});
    });

    // ---------- 報名 ----------
    await t.test('報名：未登入 401、成功、重複 409、稽核紀錄', async () => {
        assert.strictEqual((await post('/api/competitions/100/register', {})).status, 401, '未帶 token 應 401');

        const ok = await post('/api/competitions/100/register', { note: '第一次參加' }, asPlayer1);
        assert.strictEqual(ok.status, 200);
        const data = await ok.json();
        assert.strictEqual(data.message, '報名成功');
        assert.strictEqual(data.registrations, 1);
        assert.strictEqual(data.registration.username, 'player1');
        assert.strictEqual(data.registration.is_deleted, false);

        assert.ok(state.tables.audit_logs.some((l) => l.action === 'REGISTER_COMPETITION'), '應寫入報名稽核');

        const dup = await post('/api/competitions/100/register', {}, asPlayer1);
        assert.strictEqual(dup.status, 409);
        assert.match((await dup.json()).error, /已經報名過/);

        // 另一個人可以報名同一場
        assert.strictEqual((await post('/api/competitions/100/register', {}, asPlayer2)).status, 200);
    });

    await t.test('報名：截止日已過／未開放／不存在／額滿都會被擋', async () => {
        const closed = await post('/api/competitions/102/register', {}, asPlayer1);
        assert.strictEqual(closed.status, 400);
        assert.match((await closed.json()).error, /截止/);

        const notOpen = await post('/api/competitions/103/register', {}, asPlayer1);
        assert.strictEqual(notOpen.status, 400);
        assert.match((await notOpen.json()).error, /未開放報名/);

        assert.strictEqual((await post('/api/competitions/999/register', {}, asPlayer1)).status, 404);

        // 限額 1 人：player1 報名後，player2 應被擋
        assert.strictEqual((await post('/api/competitions/104/register', {}, asPlayer1)).status, 200);
        const full = await post('/api/competitions/104/register', {}, asPlayer2);
        assert.strictEqual(full.status, 400);
        assert.match((await full.json()).error, /已達上限/);
    });

    await t.test('組隊比賽：必須填隊伍名稱', async () => {
        const noTeam = await post('/api/competitions/101/register', { note: '沒填隊名' }, asPlayer1);
        assert.strictEqual(noTeam.status, 400);
        assert.match((await noTeam.json()).error, /隊伍名稱/);

        const withTeam = await post('/api/competitions/101/register', { team_name: '猛虎隊' }, asPlayer1);
        assert.strictEqual(withTeam.status, 200);
        assert.strictEqual((await withTeam.json()).registration.team_name, '猛虎隊');

        assert.strictEqual((await post('/api/competitions/101/register', { team_name: '飛鷹隊' }, asPlayer2)).status, 200);
    });

    await t.test('我的報名：含賽事資訊、取消後可重新報名', async () => {
        const mine = await (await fetch(`${base}/api/my/registrations`, { headers: asPlayer1 })).json();
        assert.strictEqual(mine.length, 3, 'player1 報了三場');
        assert.ok(mine.every((r) => r.competitions && r.competitions.name), '應展開賽事資訊');

        const reg = mine.find((r) => String(r.competition_id) === '100');

        // 別人不能取消
        const forbidden = await fetch(`${base}/api/registrations/${reg.id}`, { method: 'DELETE', headers: asPlayer2 });
        assert.strictEqual(forbidden.status, 403);

        // 本人可以取消
        const ok = await fetch(`${base}/api/registrations/${reg.id}`, { method: 'DELETE', headers: asPlayer1 });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(state.tables.registrations.find((r) => r.id === reg.id).is_deleted, true);

        // 取消後可重新報名
        assert.strictEqual((await post('/api/competitions/100/register', {}, asPlayer1)).status, 200);

        // 管理員可代為取消
        const mineNow = await (await fetch(`${base}/api/my/registrations`, { headers: asPlayer1 })).json();
        const target = mineNow.find((r) => String(r.competition_id) === '100');
        const byAdmin = await fetch(`${base}/api/registrations/${target.id}`, { method: 'DELETE', headers: asAdmin });
        assert.strictEqual(byAdmin.status, 200);
    });

    await t.test('報名名單：一般用戶只看自己，管理員看全部', async () => {
        const own = await (await fetch(`${base}/api/competitions/100/registrations`, { headers: asPlayer1 })).json();
        assert.ok(own.registrations.every((r) => r.username === 'player1'), '一般用戶只應看到自己的報名');

        const all = await (await fetch(`${base}/api/competitions/100/registrations`, { headers: asAdmin })).json();
        const names = all.registrations.map((r) => r.username).sort();
        assert.deepStrictEqual(names, ['player2'], 'player1 剛剛被取消了，只剩 player2');
    });

    // ---------- 隊伍編排 ----------
    await t.test('建立隊伍：一般用戶 403、管理員可建立、同名 409', async () => {
        assert.strictEqual((await post('/api/competitions/101/teams', { name: '無權隊' }, asPlayer1)).status, 403);
        assert.strictEqual((await post('/api/competitions/101/teams', { name: '' }, asAdmin)).status, 400);

        const ok = await post('/api/competitions/101/teams', { name: '正式隊', note: '公開組' }, asAdmin);
        assert.strictEqual(ok.status, 200);
        const team = (await ok.json()).team;
        assert.strictEqual(team.name, '正式隊');
        assert.strictEqual(team.created_by, 'admin1');

        assert.strictEqual((await post('/api/competitions/101/teams', { name: '正式隊' }, asAdmin)).status, 409);
        assert.strictEqual((await post('/api/competitions/999/teams', { name: 'X' }, asAdmin)).status, 404);
    });

    await t.test('編排隊員：需同場賽事、受隊伍人數上限限制', async () => {
        const teams = await (await fetch(`${base}/api/competitions/101/teams`, { headers: asAdmin })).json();
        assert.strictEqual(teams.canArrange, true, 'admin 可編排');
        assert.strictEqual(teams.canDelete, false, 'admin 不可刪除（需 super_admin 以上）');

        const bossView = await (await fetch(`${base}/api/competitions/101/teams`, { headers: asBoss })).json();
        assert.strictEqual(bossView.canDelete, true, 'super_admin 應可刪除');
        assert.strictEqual(teams.teams.length, 1);
        assert.strictEqual(teams.unassigned.length, 2, '兩位報名者都還沒編排');

        const teamId = teams.teams[0].id;
        const regs = await (await fetch(`${base}/api/competitions/101/registrations`, { headers: asAdmin })).json();
        const [first, second] = regs.registrations.sort((a, b) => a.id - b.id);

        // 編入第一位
        const assign = await post(`/api/teams/${teamId}/members`, { registrationId: first.id }, asAdmin);
        assert.strictEqual(assign.status, 200);
        assert.match((await assign.json()).message, /編入/);
        assert.strictEqual(state.tables.registrations.find((r) => r.id === first.id).team_id, teamId);

        // 隊伍上限 2 人：加入第二位沒問題
        assert.strictEqual((await post(`/api/teams/${teamId}/members`, { registrationId: second.id }, asAdmin)).status, 200);

        // 第三位（來自個人賽的報名）→ 不同賽事，應被擋
        const otherReg = state.tables.registrations.find((r) => String(r.competition_id) === '100' && !r.is_deleted);
        const wrongComp = await post(`/api/teams/${teamId}/members`, { registrationId: otherReg.id }, asAdmin);
        assert.strictEqual(wrongComp.status, 400);
        assert.match((await wrongComp.json()).error, /不屬於同一場賽事/);

        // 把隊伍上限調成 2 後再加入第三人 → 應擋
        state.tables.competitions.find((c) => c.id === 101).team_size = 2;
        const third = { id: 999, competition_id: 101, user_id: 4, username: 'player2b', is_deleted: false };
        state.tables.registrations.push(third);
        const overLimit = await post(`/api/teams/${teamId}/members`, { registrationId: third.id }, asAdmin);
        assert.strictEqual(overLimit.status, 400);
        assert.match((await overLimit.json()).error, /人數上限/);

        assert.strictEqual((await post(`/api/teams/${teamId}/members`, {}, asAdmin)).status, 400, '缺 registrationId 應 400');
        assert.strictEqual((await post('/api/teams/99999/members', { registrationId: first.id }, asAdmin)).status, 404);
    });

    await t.test('移除隊員與刪除隊伍：僅超級管理員以上', async () => {
        const teams = await (await fetch(`${base}/api/competitions/101/teams`, { headers: asBoss })).json();
        const teamId = teams.teams[0].id;
        const member = teams.teams[0].members[0];

        assert.strictEqual((await fetch(`${base}/api/teams/${teamId}/members/${member.id}`, { method: 'DELETE', headers: asAdmin })).status, 403);
        assert.strictEqual((await fetch(`${base}/api/teams/${teamId}`, { method: 'DELETE', headers: asAdmin })).status, 403);

        const removed = await fetch(`${base}/api/teams/${teamId}/members/${member.id}`, { method: 'DELETE', headers: asBoss });
        assert.strictEqual(removed.status, 200);
        assert.strictEqual(state.tables.registrations.find((r) => r.id === member.id).team_id, null);

        const deleted = await fetch(`${base}/api/teams/${teamId}`, { method: 'DELETE', headers: asBoss });
        assert.strictEqual(deleted.status, 200);
        assert.strictEqual(state.tables.competition_teams.find((t) => t.id === teamId).is_deleted, true);

        // 隊員應全部回到未編排
        const after = await (await fetch(`${base}/api/competitions/101/teams`, { headers: asBoss })).json();
        assert.strictEqual(after.teams.length, 0);
        assert.ok(after.unassigned.every((r) => !r.team_id), '隊員應被移出隊伍');
        assert.ok(after.unassigned.some((r) => r.id === member.id), '被移出的隊員應回到未編排名單');
    });

    await t.test('只有管理員以上能查詢隊伍名單', async () => {
        // 一般用戶可讀（用於確認自己的隊伍），但不會拿到管理權限旗標
        const asUser = await (await fetch(`${base}/api/competitions/101/teams`, { headers: asPlayer1 })).json();
        assert.strictEqual(asUser.canArrange, false);
        assert.strictEqual(asUser.canDelete, false);

        assert.strictEqual((await fetch(`${base}/api/competitions/101/teams`)).status, 401, '未登入應 401');
    });
});
