const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

// 以子行程載入 server.js，觀察 bootstrap 結果。
// 注意：server.js 使用 require('dotenv').config()，dotenv 不會覆蓋「已存在」的環境變數，
// 因此這裡預先塞入空字串，即可確保 .env 的真實值不會外洩進測試。
const BOOTSTRAP = "require('./server.js'); console.log('BOOTSTRAP_OK'); setTimeout(() => process.exit(0), 200);";

function boot(extraEnv) {
  return spawnSync(process.execPath, ['-e', BOOTSTRAP], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: '/tmp/does-not-exist',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      SUPABASE_KEY: '',
      JWT_SECRET: '',
      ...extraEnv
    },
    encoding: 'utf8'
  });
}

test('server should start without required environment variables (non-production)', () => {
  const result = boot({ NODE_ENV: 'development' });

  assert.equal(result.status, 0, result.stderr || result.stdout || 'server bootstrap failed');
  assert.match(result.stdout || '', /BOOTSTRAP_OK|Server running/i, 'server did not finish bootstrap');
});

test('server must refuse to start in production when JWT_SECRET is missing', () => {
  const result = boot({ NODE_ENV: 'production' });

  assert.notEqual(result.status, 0, 'production bootstrap must not succeed without JWT_SECRET');
  assert.doesNotMatch(result.stdout || '', /BOOTSTRAP_OK/, 'production bootstrap unexpectedly completed');
  assert.match(
    result.stderr || '',
    /JWT_SECRET is required for secure authentication/,
    'expected a fail-fast JWT_SECRET error on stderr'
  );
});
