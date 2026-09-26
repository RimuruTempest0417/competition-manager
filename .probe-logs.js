
const { loadEnv, ownerToken, resolveSite, apiRequest } = require('./scripts/lib/cm-api');
(async () => {
  const env = loadEnv(__dirname);
  const site = resolveSite();
  const token = ownerToken(env);
  const r = await apiRequest(site, '/api/admin/error-logs?limit=200', { token });
  const logs = (r.body && r.body.logs) || [];
  const h = await apiRequest(site, '/api/admin/error-logs/health', { token });
  console.log(JSON.stringify({
    total: r.body && r.body.total,
    auto: logs.filter((l) => /node|curl/i.test(l.user_agent || '')).length,
    malformed: logs.filter((l) => l.error_type === 'malformed_json_body').length,
    unresolved: logs.filter((l) => !l.resolved).length,
    healthSelfTestSkipped: h.body && h.body.self_test_skipped,
    rlsReady: h.body && h.body.rls_ready
  }));
})();
