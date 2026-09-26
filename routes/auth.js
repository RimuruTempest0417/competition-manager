/* 登入、密碼與兩步驟驗證（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/auth')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */
// 套件／自寫模組（原封不動搬過來；相對路徑補一層，因為本檔在 routes/ 底下）
const jwt = require('jsonwebtoken');
const {
    generateSecret, verifyTotp, otpauthUri,
    generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode
} = require('../lib/totp');
const { hashPassword, verifyPassword, needsPasswordUpgrade } = require('../lib/passwords');
// v2.15.0：兩步驟驗證（TOTP）—— 純手寫實作，只用 Node 內建 crypto，無外部套件

module.exports = function registerAuthRoutes(app, ctx) {
    const { GENERIC_DB_ERROR, JWT_SECRET, LOGIN_ACCOUNT_MAX_FAILURES, LOGIN_ACCOUNT_MIN_IPS, SUPER_ADMIN_ROLES, TFA_MIGRATION_HINT, TFA_RECOVERY_CODE_COUNT, authenticateToken, canManageUser, clearLoginFailures, columnExists, errorLogAlertSummary, findUserByKey, logAudit, logErrorToDb, loginHandler, loginLockRemaining, recordLoginFailure, requireAdmin, supabase, twoFactorSchemaReady, unusedRecoveryCodes, verifySecondFactor } = ctx;
app.post('/api/auth/login', loginHandler);
app.post('/api/admin/login', loginHandler);
app.put('/api/auth/change-password', authenticateToken, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const { sub: userId, username } = req.user;

    if (!newPassword || !/^[a-zA-Z0-9]+$/.test(newPassword)) {
        return res.status(400).json({ error: '新密碼格式錯誤：僅允許英文字母與數字' });
    }

    try {
        const { data: user, error: findErr } = await supabase
            .from('admin_users')
            .select('*')
            .eq('id', userId)
            .single();

        if (findErr || !user || !verifyPassword(user.password, oldPassword)) {
            return res.status(400).json({ error: '舊密碼不正確' });
        }

        const { error: updateErr } = await supabase
            .from('admin_users')
            .update({ password: hashPassword(newPassword) })
            .eq('id', userId);

        if (updateErr) throw updateErr;

        await logAudit(username, 'CHANGE_PASSWORD', userId, '使用者修改個人密碼成功', req.userAgent);

        res.json({ message: '密碼修改成功' });
    } catch (err) {
        await logErrorToDb(req, 'change_password_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 兩步驟驗證（TOTP，v2.15.0）
// ------------------------------------------
// 設計重點：
//   - 密鑰與備援碼都只存在資料庫，回應中只出現「一次」（備援碼）或「綁定中」（密鑰）。
//   - 登入流程分兩段：密碼正確 → 發 5 分鐘中間權杖（stage: '2fa'）→ 通過驗證才發正式權杖。
//     中間權杖在 authenticateToken 會被直接拒絕，不會被當成登入成功。
//   - 驗證碼同一個時間步只能用一次（totp_last_step），避免被錄下重放。
//   - 驗證失敗也走登入失敗計數（recordLoginFailure），所以暴力嘗試會被 IP／帳號鎖定規則擋下。
//   - 未執行 migration 時（欄位不存在）整個功能自動停用並回報 503 + 指示，不影響原有登入。
// ==========================================
app.get('/api/auth/2fa/status', authenticateToken, async (req, res) => {
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.json({ success: true, schema_ready: false, enabled: false, remaining_recovery_codes: 0 });
        }
        const user = await findUserByKey(req.user.sub);
        if (!user) return res.status(404).json({ error: '找不到帳號' });
        res.json({
            success: true,
            schema_ready: true,
            enabled: user.totp_enabled === true,
            confirmed_at: user.totp_confirmed_at || null,
            pending: Boolean(user.totp_secret) && user.totp_enabled !== true,
            remaining_recovery_codes: unusedRecoveryCodes(user).length
        });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_status_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 步驟 1：產生密鑰（此時尚未啟用）
app.post('/api/auth/2fa/setup', authenticateToken, async (req, res) => {
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }
        const user = await findUserByKey(req.user.sub);
        if (!user) return res.status(404).json({ error: '找不到帳號' });
        if (user.totp_enabled === true) {
            return res.status(400).json({ error: '此帳號已啟用兩步驟驗證，如需重新綁定請先停用' });
        }

        const secret = generateSecret();
        const { error } = await supabase
            .from('admin_users')
            .update({ totp_secret: secret, totp_enabled: false, totp_last_step: null })
            .eq('id', user.id);
        if (error) throw error;

        await logAudit(user.username, '2FA_SETUP_STARTED', user.id, {}, req.userAgent);
        res.json({
            success: true,
            secret,
            otpauth_uri: otpauthUri({ secret, account: user.username }),
            account: user.username,
            digits: 6,
            period: 30,
            hint: '在驗證器 App（Google／Microsoft Authenticator 等）選「手動輸入金鑰」，貼上這串密鑰，再輸入 App 顯示的 6 位數完成綁定。'
        });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_setup_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 步驟 2：輸入驗證器顯示的碼 → 正式啟用，並回傳一次性備援碼
app.post('/api/auth/2fa/enable', authenticateToken, async (req, res) => {
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }
        const user = await findUserByKey(req.user.sub);
        if (!user) return res.status(404).json({ error: '找不到帳號' });
        if (user.totp_enabled === true) {
            return res.status(400).json({ error: '此帳號已啟用兩步驟驗證' });
        }
        if (!user.totp_secret) {
            return res.status(400).json({ error: '請先產生密鑰（重新整理後再試一次）' });
        }

        const check = verifyTotp(user.totp_secret, req.body?.code, { lastUsedCounter: user.totp_last_step ?? null });
        if (!check.valid) {
            return res.status(400).json({
                error: check.reason === 'replayed' ? '這組驗證碼已經用過，請等下一組' : '驗證碼不正確，請確認手機時間是否正確後再試'
            });
        }

        const codes = generateRecoveryCodes(TFA_RECOVERY_CODE_COUNT);
        const { error } = await supabase
            .from('admin_users')
            .update({
                totp_enabled: true,
                totp_confirmed_at: new Date().toISOString(),
                totp_recovery_codes: codes.map((c) => hashRecoveryCode(c)),
                totp_last_step: check.counter
            })
            .eq('id', user.id);
        if (error) throw error;

        await logAudit(user.username, '2FA_ENABLED', user.id, {}, req.userAgent);
        res.json({
            success: true,
            recovery_codes: codes,
            warning: '這些備援碼只會顯示這一次。請立刻抄下來（或存進密碼管理器），手機遺失時要用它登入。每組只能用一次。'
        });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_enable_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 停用（需要密碼 + 一組驗證碼或備援碼）
app.post('/api/auth/2fa/disable', authenticateToken, async (req, res) => {
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }
        const user = await findUserByKey(req.user.sub);
        if (!user) return res.status(404).json({ error: '找不到帳號' });
        if (user.totp_enabled !== true) {
            return res.status(400).json({ error: '此帳號尚未啟用兩步驟驗證' });
        }
        if (!verifyPassword(user.password, req.body?.password || '')) {
            await logAudit(user.username, '2FA_DISABLE_FAILED', user.id, { reason: '密碼錯誤' }, req.userAgent);
            return res.status(401).json({ error: '密碼錯誤' });
        }

        const check = await verifySecondFactor(user, req.body?.code);
        if (!check.ok) {
            await logAudit(user.username, '2FA_DISABLE_FAILED', user.id, { reason: '驗證碼錯誤' }, req.userAgent);
            return res.status(401).json({ error: '驗證碼或備援碼錯誤' });
        }

        const { error } = await supabase
            .from('admin_users')
            .update({
                totp_enabled: false, totp_secret: null, totp_confirmed_at: null,
                totp_recovery_codes: null, totp_last_step: null
            })
            .eq('id', user.id);
        if (error) throw error;

        await logAudit(user.username, '2FA_DISABLED', user.id, { method: check.method }, req.userAgent);
        logErrorToDb(req, 'twofactor_disabled', new Error(`帳號「${user.username}」已停用兩步驟驗證`), {
            severity: 'warn', context: { method: check.method }
        }).catch(() => {});
        res.json({ success: true, message: '已停用兩步驟驗證，之後登入只需密碼。' });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_disable_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 登入第二段：帶中間權杖 + 驗證碼（或備援碼）換取正式權杖
app.post('/api/auth/login/2fa', async (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }

        let payload;
        try {
            payload = jwt.verify(String(req.body?.challenge_token || ''), JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ error: '登入流程已過期，請重新輸入帳號密碼' });
        }
        if (!payload || payload.stage !== '2fa') {
            return res.status(401).json({ error: '這個連結不是有效的登入流程，請重新登入' });
        }

        const lock = loginLockRemaining(payload.username, clientIp);
        if (lock.remaining > 0) {
            return res.status(429).json({ error: '嘗試次數過多，請稍後再試', retry_after_seconds: Math.ceil(lock.remaining / 1000) });
        }

        const user = await findUserByKey(payload.sub);
        if (!user) return res.status(401).json({ error: '登入流程已失效，請重新登入' });
        if (user.is_active === false) {
            await logAudit(user.username, 'LOGIN_DENIED_INACTIVE', user.id, { ip: clientIp }, req.userAgent);
            return res.status(403).json({ error: '此帳號已停用，請聯繫管理員' });
        }
        if (user.totp_enabled !== true) {
            return res.status(400).json({ error: '此帳號已停用兩步驟驗證，請重新登入' });
        }

        const check = await verifySecondFactor(user, req.body?.code);
        if (!check.ok) {
            const { count, distinctIps } = recordLoginFailure(user.username, clientIp);
            await logAudit(user.username, 'LOGIN_2FA_FAILED', user.id, { ip: clientIp, attempts: count }, req.userAgent);
            if (count >= LOGIN_ACCOUNT_MAX_FAILURES && distinctIps >= LOGIN_ACCOUNT_MIN_IPS) {
                logErrorToDb(req, 'login_lockout', new Error(
                    `帳號「${user.username}」兩步驟驗證連續失敗 ${count} 次，且來自 ${distinctIps} 個不同 IP，已暫時鎖定 15 分鐘`), {
                    severity: 'warn', context: { ip: clientIp }
                }).catch(() => {});
            }
            return res.status(401).json({
                error: check.reason === 'replayed' ? '這組驗證碼已經用過，請等下一組' : '驗證碼或備援碼錯誤'
            });
        }

        const updates = {};
        if (check.method === 'totp') updates.totp_last_step = check.counter;
        if (check.method === 'recovery_code') updates.totp_recovery_codes = check.updatedCodes;
        if (await columnExists('admin_users', 'last_login_at')) updates.last_login_at = new Date().toISOString();
        const { error: upErr } = await supabase.from('admin_users').update(updates).eq('id', user.id);
        if (upErr) throw upErr;

        clearLoginFailures(user.username, clientIp);

        let remaining = unusedRecoveryCodes(user).length;
        if (check.method === 'recovery_code') {
            remaining = (check.updatedCodes || []).filter((e) => e && !e.used_at).length;
            await logAudit(user.username, '2FA_RECOVERY_CODE_USED', user.id, { remaining }, req.userAgent);
            logErrorToDb(req, 'twofactor_recovery_code_used', new Error(
                `帳號「${user.username}」使用備援碼登入（剩餘 ${remaining} 組）`), {
                severity: remaining <= 2 ? 'warn' : 'info', context: { remaining }
            }).catch(() => {});
        }

        const token = jwt.sign(
            { sub: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '12h' }
        );
        await logAudit(user.username, 'LOGIN_SUCCESS', user.id, { ip: clientIp, method: `2fa:${check.method}` }, req.userAgent);

        let alerts = null;
        if (SUPER_ADMIN_ROLES.has(user.role)) alerts = await errorLogAlertSummary();

        res.json({
            message: '登入成功',
            token,
            used_recovery_code: check.method === 'recovery_code',
            remaining_recovery_codes: remaining,
            user: { id: user.id, username: user.username, role: user.role },
            alerts
        });
    } catch (err) {
        await logErrorToDb(req, 'login_2fa_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// 管理端救援：上級可為下級重設兩步驟驗證（手機遺失時的唯一補救路徑）
app.post('/api/admin/users/:id/reset-2fa', requireAdmin, async (req, res) => {
    const operator = req.currentUser;
    try {
        if (!(await twoFactorSchemaReady())) {
            return res.status(503).json({ error: TFA_MIGRATION_HINT, migration_required: true });
        }
        const target = await findUserByKey(req.params.id);
        if (!target) return res.status(404).json({ error: '找不到該帳號' });

        // canManageUser 回傳 boolean（必須嚴格高於對方且不能是自己）
        if (!canManageUser(operator, target)) {
            return res.status(403).json({ error: '權限不足：只能重設權限低於你的帳號的兩步驟驗證' });
        }

        if (target.totp_enabled !== true) {
            return res.status(400).json({ error: '該帳號並未啟用兩步驟驗證' });
        }

        const { error } = await supabase
            .from('admin_users')
            .update({
                totp_enabled: false, totp_secret: null, totp_confirmed_at: null,
                totp_recovery_codes: null, totp_last_step: null
            })
            .eq('id', target.id);
        if (error) throw error;

        await logAudit(operator.username, '2FA_RESET_BY_ADMIN', target.id, { target: target.username }, req.userAgent);
        logErrorToDb(req, 'twofactor_reset_by_admin', new Error(
            `管理員「${operator.username}」重設了「${target.username}」的兩步驟驗證`), {
            severity: 'warn', context: { operator: operator.username, target: target.username }
        }).catch(() => {});

        res.json({ success: true, message: `已重設「${target.username}」的兩步驟驗證，請對方盡快重新綁定。` });
    } catch (err) {
        await logErrorToDb(req, 'twofactor_reset_error', err);
        res.status(500).json({ error: GENERIC_DB_ERROR });
    }
});

// ==========================================
// 營運儀表板 API（v3.0.0，管理員以上）
// ==========================================
// 設計取捨：
//   - 只回「聚合後的數字」：沒有任何帳號、email 或單筆報名內容（一般使用者一律 403）。
//   - 每個區塊各自 try／catch：某張表還沒建（例如 migration 還沒跑）只標記 unavailable，
//     不讓一個區塊壞掉就整個儀表板 500。
//   - 結果快取 60 秒（?fresh=1 可強制重算）：管理員在畫面上按來按去不必每次全表掃描。
//   - timings 是量出來的秒數，直接回給前端顯示（不是宣稱的效能）。
};
