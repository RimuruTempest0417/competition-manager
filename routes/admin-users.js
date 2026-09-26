/* 管理員帳號維護（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/admin-users')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const { hashPassword, verifyPassword, needsPasswordUpgrade } = require('../lib/passwords');
// v2.15.0：兩步驟驗證（TOTP）—— 純手寫實作，只用 Node 內建 crypto，無外部套件

module.exports = function registerAdminUsersRoutes(app, ctx) {
    const { GENERIC_DB_ERROR, MANAGED_ROLES, PASSWORD_RE, ROLE_LABELS, USERNAME_RE, USER_MIGRATION_HINT, assertRoleAssignable, canCreateRole, canManageUser, columnExists, countWebOwners, findUserByKey, logAudit, logErrorToDb, requireAdmin, roleLevel, supabase } = ctx;
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const actor = req.currentUser;
        const cols = ['id', 'username', 'role', 'created_at'];
        if (await columnExists('admin_users', 'is_active')) cols.push('is_active');
        if (await columnExists('admin_users', 'last_login_at')) cols.push('last_login_at');
        if (await columnExists('admin_users', 'updated_at')) cols.push('updated_at');
        if (await columnExists('admin_users', 'totp_enabled')) cols.push('totp_enabled');   // v2.15.0

        const { data: admins, error } = await supabase
            .from('admin_users')
            .select(cols.join(','))
            .order('created_at', { ascending: true });

        if (error) throw error;

        // v2.15.0：列表帶出兩步驟驗證狀態（未執行 migration 時為 undefined，前端據此隱藏）
        const twoFactorSchema = await columnExists('admin_users', 'totp_enabled');

        const users = (admins || []).map((u) => ({
            id: u.id,
            username: u.username,
            role: u.role,
            two_factor_enabled: twoFactorSchema ? u.totp_enabled === true : undefined,
            role_label: ROLE_LABELS[u.role] || u.role,
            created_at: u.created_at || null,
            is_active: u.is_active === undefined ? true : u.is_active !== false,
            last_login_at: u.last_login_at || null,
            is_self: String(actor.id) === String(u.id),
            can_manage: canManageUser(actor, u),
            can_change_role: actor.role === 'web_owner' && String(actor.id) !== String(u.id),
            assignable_roles: MANAGED_ROLES.filter((r) => canCreateRole(actor.role, r))
        }));

        res.json({
            success: true,
            users,
            roles: ROLE_LABELS,
            my_role: actor.role,
            my_role_label: ROLE_LABELS[actor.role] || actor.role,
            my_level: roleLevel(actor.role),
            can_edit_roles: actor.role === 'web_owner',
            can_create: MANAGED_ROLES.filter((r) => canCreateRole(actor.role, r)),
            schema_ready: await columnExists('admin_users', 'is_active')
        });
    } catch (err) {
        await logErrorToDb(req, 'fetch_admin_users_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    const operator = req.currentUser;

    if (!username || !password) {
        return res.status(400).json({ error: '帳號與密碼為必填欄位' });
    }

    if (!USERNAME_RE.test(String(username))) {
        return res.status(400).json({ error: '帳號格式錯誤：僅允許 3～20 個英文字母、數字或底線' });
    }

    if (!PASSWORD_RE.test(String(password))) {
        return res.status(400).json({ error: '密碼格式錯誤：僅允許 6～64 個英文字母或數字' });
    }

    // v2.12.0：管理員可建立普通用戶／測試帳號；超級管理員可再建立管理員；Web Owner 可建立任何角色
    const targetRole = role || 'user';
    const roleErr = assertRoleAssignable(operator.role, targetRole);
    if (roleErr) {
        return res.status(403).json({ error: roleErr });
    }

    try {
        const { data: existingUser } = await supabase
            .from('admin_users')
            .select('id')
            .eq('username', username)
            .maybeSingle();

        if (existingUser) {
            return res.status(400).json({ error: '此帳號名稱已存在' });
        }

        const payload = { username, password: hashPassword(password), role: targetRole };
        if (await columnExists('admin_users', 'is_active')) payload.is_active = true;
        if (await columnExists('admin_users', 'updated_at')) payload.updated_at = new Date().toISOString();

        const { data, error } = await supabase
            .from('admin_users')
            .insert([payload])
            .select('id, username, role');

        if (error) throw error;

        await logAudit(operator.username, 'CREATE_USER', data[0].id, {
            action: '建立帳號',
            actor_role: operator.role,
            new_user: username,
            new_role: targetRole
        }, req.userAgent);

        res.json({ message: `帳號 ${username} 建立成功（${ROLE_LABELS[targetRole] || targetRole}）`, id: data[0].id, username, role: targetRole });
    } catch (err) {
        await logErrorToDb(req, 'create_admin_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;

    try {
        const targetUser = await findUserByKey(id);
        if (!targetUser) {
            return res.status(404).json({ error: '找不到該帳號' });
        }

        if (String(targetUser.id) === String(operator.id) || targetUser.username === operator.username) {
            return res.status(400).json({ error: '無法刪除目前正在使用的帳號' });
        }

        if (targetUser.role === 'web_owner') {
            return res.status(403).json({ error: '保護機制：無法刪除網站擁有者帳號' });
        }

        // v2.12.0：一律依角色階梯（權限必須高於目標），管理員只能刪除普通用戶／測試帳號
        if (!canManageUser(operator, targetUser)) {
            return res.status(403).json({ error: '權限不足：不可刪除同級或更高權限的帳號' });
        }

        const { error: delErr } = await supabase
            .from('admin_users')
            .delete()
            .eq('id', targetUser.id);

        if (delErr) throw delErr;

        await logAudit(operator.username, 'DELETE_USER', targetUser.id, {
            action: '刪除帳號',
            actor_role: operator.role,
            deleted_user: targetUser.username,
            deleted_role: targetUser.role
        }, req.userAgent);

        res.json({ message: `帳號 ${targetUser.username} 已刪除` });
    } catch (err) {
        await logErrorToDb(req, 'delete_admin_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// v2.12.0：修改帳號（角色調整僅限 Web Owner；密碼／帳號名／停用依角色階梯）
app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const operator = req.currentUser;
    const { role, password, username, is_active } = req.body || {};

    try {
        const target = await findUserByKey(id);
        if (!target) {
            return res.status(404).json({ error: '找不到該帳號' });
        }

        const isSelf = String(target.id) === String(operator.id) || target.username === operator.username;
        const updates = {};
        const changes = [];

        // (1) 角色調整：只有網站擁有者可以調整他人角色
        if (role !== undefined && role !== target.role) {
            if (operator.role !== 'web_owner') {
                return res.status(403).json({ error: '權限不足：只有網站擁有者可以調整他人角色' });
            }
            if (isSelf) {
                return res.status(400).json({ error: '無法修改自己的角色' });
            }
            if (!MANAGED_ROLES.includes(role)) {
                return res.status(400).json({ error: '未知的角色：' + role });
            }
            if (target.role === 'web_owner' && (await countWebOwners(target.id)) < 1) {
                return res.status(400).json({ error: '保護機制：系統必須保留至少一位網站擁有者' });
            }
            updates.role = role;
            changes.push(`角色 ${ROLE_LABELS[target.role] || target.role} → ${ROLE_LABELS[role] || role}`);
        }

        // (2) 重設密碼
        if (password !== undefined && password !== '') {
            if (!canManageUser(operator, target)) {
                return res.status(403).json({ error: '權限不足：只能重設權限低於你的帳號密碼（自己的密碼請用「修改密碼」）' });
            }
            if (!PASSWORD_RE.test(String(password))) {
                return res.status(400).json({ error: '密碼格式錯誤：僅允許 6～64 個英文字母或數字' });
            }
            updates.password = hashPassword(String(password));
            changes.push('重設密碼');
        }

        // (3) 修改帳號名稱
        if (username !== undefined && username !== '' && username !== target.username) {
            if (!canManageUser(operator, target)) {
                return res.status(403).json({ error: '權限不足：只能修改權限低於你的帳號名稱' });
            }
            if (!USERNAME_RE.test(String(username))) {
                return res.status(400).json({ error: '帳號格式錯誤：僅允許 3～20 個英文字母、數字或底線' });
            }
            const { data: dup } = await supabase
                .from('admin_users')
                .select('id')
                .eq('username', username)
                .maybeSingle();
            if (dup && String(dup.id) !== String(target.id)) {
                return res.status(400).json({ error: '此帳號名稱已存在' });
            }
            updates.username = String(username);
            changes.push(`帳號名稱 ${target.username} → ${username}`);
        }

        // (4) 停用／啟用帳號
        if (is_active !== undefined) {
            const wantActive = is_active === true || is_active === 'true';
            if (wantActive !== (target.is_active !== false)) {
                if (isSelf) {
                    return res.status(400).json({ error: '無法停用目前正在使用的帳號' });
                }
                if (!canManageUser(operator, target)) {
                    return res.status(403).json({ error: '權限不足：只能停用權限低於你的帳號' });
                }
                if (target.role === 'web_owner' && !wantActive && (await countWebOwners(target.id)) < 1) {
                    return res.status(400).json({ error: '保護機制：系統必須保留至少一位網站擁有者' });
                }
                if (!(await columnExists('admin_users', 'is_active'))) {
                    return res.status(503).json({ error: USER_MIGRATION_HINT });
                }
                updates.is_active = wantActive;
                changes.push(wantActive ? '啟用帳號' : '停用帳號');
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: '沒有需要變更的內容' });
        }

        if (await columnExists('admin_users', 'updated_at')) {
            updates.updated_at = new Date().toISOString();
        }

        const { error: updateErr } = await supabase
            .from('admin_users')
            .update(updates)
            .eq('id', target.id);

        if (updateErr) throw updateErr;

        await logAudit(operator.username, 'UPDATE_USER', target.id, {
            action: '修改帳號',
            actor_role: operator.role,
            target_user: target.username,
            changes
        }, req.userAgent);

        const roleChanged = updates.role !== undefined;
        res.json({
            message: `已更新帳號 ${updates.username || target.username}：${changes.join('、')}`,
            changes,
            role_changed: roleChanged,
            password_changed: updates.password !== undefined
        });
    } catch (err) {
        await logErrorToDb(req, 'update_admin_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 身份驗證 API (登入與修改密碼)
// ==========================================
};
