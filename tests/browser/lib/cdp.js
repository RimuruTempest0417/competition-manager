/* 極簡 Chrome DevTools Protocol 驅動（v2.14.0）
 *
 * 為什麼要自己寫：專案刻意不引入前端套件（CSP 為 style-src 'self'、script-src 'self'），
 * 也不想為了測試安裝 puppeteer / playwright。Node 22 以後內建 WebSocket，
 * 直接用 CDP 驅動真正的 Chrome 就能做「真實瀏覽器」驗證，零額外依賴。
 *
 * 用法：
 *   const { Browser } = require('./lib/cdp');
 *   const browser = await Browser.launch({ width: 414, height: 896 });   // 手機尺寸
 *   await browser.goto('http://127.0.0.1:3299/');
 *   await browser.waitFor(`document.getElementById('x') !== null`);
 *   const text = await browser.evaluate(`document.title`);
 *   await browser.screenshot('/tmp/shot.png');
 *   await browser.close();
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME_PATH = process.env.CHROME_PATH
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
    constructor(options = {}) {
        this.port = options.port || 9500 + Math.floor(Math.random() * 400);
        this.width = options.width || 1280;
        this.height = options.height || 900;
        this.mobile = options.mobile !== false && this.width < 700;
        this.userDataDir = options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cdp-'));
        this.proc = null;
        this.ws = null;
        this.sessionId = null;
        this.pending = new Map();
        this.nextId = 1;
        this.consoleErrors = [];
        this.pageErrors = [];
        this.listeners = new Map();
    }

    static async launch(options = {}) {
        const browser = new Browser(options);
        await browser.start();
        return browser;
    }

    async start() {
        if (!fs.existsSync(CHROME_PATH)) {
            throw new Error(`找不到 Chrome：${CHROME_PATH}（可用 CHROME_PATH 環境變數指定）`);
        }
        const args = [
            '--headless=new',
            `--remote-debugging-port=${this.port}`,
            `--user-data-dir=${this.userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu',
            '--hide-scrollbars',
            '--disable-extensions',
            `--window-size=${this.width},${this.height}`,
            'about:blank'
        ];
        this.proc = spawn(CHROME_PATH, args, { stdio: 'ignore' });

        const version = await this.pollJson(`http://127.0.0.1:${this.port}/json/version`, 15000);
        await this.connect(version.webSocketDebuggerUrl);

        // 建立並接管一個分頁
        const target = await this.send('Target.createTarget', { url: 'about:blank' });
        const attached = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        this.sessionId = attached.sessionId;
        this.targetId = target.targetId;

        await this.send('Page.enable');
        await this.send('Runtime.enable');
        await this.send('Log.enable');
        await this.send('Emulation.setDeviceMetricsOverride', {
            width: this.width, height: this.height, deviceScaleFactor: 2, mobile: this.mobile
        });

        this.on('Runtime.consoleAPICalled', (p) => {
            if (p.type === 'error') this.consoleErrors.push((p.args || []).map((a) => a.value || a.description).join(' '));
        });
        this.on('Runtime.exceptionThrown', (p) => {
            this.pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
        });
        this.on('Log.entryAdded', (p) => {
            if (p.entry?.level === 'error' && !/favicon/.test(p.entry.text || '')) this.consoleErrors.push(p.entry.text);
        });
    }

    async pollJson(url, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const res = await fetch(url);
                if (res.ok) return await res.json();
            } catch (err) { /* 還沒起來 */ }
            await sleep(120);
        }
        throw new Error(`等不到 ${url}`);
    }

    connect(wsUrl) {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(wsUrl);
            this.ws.addEventListener('open', () => resolve());
            this.ws.addEventListener('error', (e) => reject(new Error(`CDP 連線失敗：${e.message || e}`)));
            this.ws.addEventListener('message', (event) => {
                let msg;
                try { msg = JSON.parse(event.data); } catch (err) { return; }
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve: res, reject: rej } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) rej(new Error(`${msg.error.message}（${msg.error.code}）`));
                    else res(msg.result);
                } else if (msg.method && this.listeners.has(msg.method)) {
                    for (const fn of this.listeners.get(msg.method)) fn(msg.params, msg.sessionId);
                }
            });
        });
    }

    on(method, fn) {
        if (!this.listeners) this.listeners = new Map();
        if (!this.listeners.has(method)) this.listeners.set(method, new Set());
        this.listeners.get(method).add(fn);
    }

    send(method, params = {}, useSession = true) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (useSession && this.sessionId) payload.sessionId = this.sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP 逾時：${method}`));
                }
            }, 20000);
        });
    }

    async goto(url, { waitMs = 300 } = {}) {
        await this.send('Page.navigate', { url });
        await sleep(waitMs);
        await this.waitFor(`document.readyState === 'complete'`, { timeout: 15000 });
    }

    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true
        });
        if (result.exceptionDetails) {
            throw new Error(`頁面執行錯誤：${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
        }
        return result.result.value;
    }

    async waitFor(expression, { timeout = 8000, interval = 100 } = {}) {
        const deadline = Date.now() + timeout;
        let lastErr = null;
        while (Date.now() < deadline) {
            try {
                if (await this.evaluate(`return Boolean(${expression});`)) return true;
            } catch (err) { lastErr = err; }
            await sleep(interval);
        }
        throw new Error(`等待逾時：${expression}${lastErr ? `（最後錯誤：${lastErr.message}）` : ''}`);
    }

    async screenshot(file) {
        const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        return file;
    }

    async close() {
        try { if (this.ws) await this.send('Browser.close', {}, false); } catch (err) { /* 已關閉 */ }
        try { if (this.ws) this.ws.close(); } catch (err) { /* 忽略 */ }
        if (this.proc && !this.proc.killed) {
            this.proc.kill('SIGKILL');
        }
        await sleep(150);
        try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
    }
}

module.exports = { Browser, CHROME_PATH, sleep };
