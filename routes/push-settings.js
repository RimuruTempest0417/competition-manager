/* 推播設定（v3.4.0 起從 server.js 拆出）
 *
 * 內容原封不動搬過來（含原縮排）：require('./routes/push-settings')(app, ctx)
 * ctx 由 server.js 在掛載當下提供（清單見下方），套件由本檔自行 require。
 */

module.exports = function registerPushSettingsRoutes(app, ctx) {
    const { PUSH_SETTINGS_DEFAULTS, PUSH_SETTINGS_HINT, PUSH_SETTING_LABELS, formatPushSettingValue, logAudit, logErrorToDb, normalizePushSettingsInput, readPushSettings, requireAdmin, writePushSettings } = ctx;
app.get('/api/push/settings', requireAdmin, async (req, res) => {
    const { settings, ready } = await readPushSettings();
    res.json({ settings, schema_ready: ready, hint: ready ? null : PUSH_SETTINGS_HINT });
});
app.post('/api/push/settings', requireAdmin, async (req, res) => {
    const current = await readPushSettings();
    const normalized = normalizePushSettingsInput(req.body, current.settings);
    if (normalized.error) return res.status(400).json({ error: normalized.error });

    try {
        await writePushSettings(normalized.settings);
    } catch (err) {
        await logErrorToDb(req, 'save_push_settings_error', err);
        return res.status(503).json({ error: PUSH_SETTINGS_HINT });
    }

    const changes = [];
    for (const key of Object.keys(PUSH_SETTINGS_DEFAULTS)) {
        const field = {
            push_digest_enabled: 'digest_enabled',
            push_digest_time: 'digest_time',
            push_digest_kind_new: 'digest_kind_new',
            push_digest_kind_reminder: 'digest_kind_reminder',
            push_event_review: 'event_review',
            push_event_promote: 'event_promote',
            push_event_announce: 'event_announce',
            push_event_result: 'event_result'
        }[key];
        if (String(current.settings[field]) !== String(normalized.settings[field])) {
            changes.push(`${PUSH_SETTING_LABELS[field]}：${formatPushSettingValue(field, current.settings[field])} → ${formatPushSettingValue(field, normalized.settings[field])}`);
        }
    }

    await logAudit(req.currentUser.username, 'UPDATE_PUSH_SETTINGS', null,
        changes.length ? `更新推播設定：${changes.join('；')}` : '更新推播設定（沒有變更）', req.userAgent);

    res.json({ success: true, settings: normalized.settings, changes });
});
};
