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

        // 檢查腳本一律不准下載檔案到使用者的電腦（有些檢查會按「匯出 CSV／備份」按鈕）。
        // 兩層保護：這裡先用 CDP 設定「拒絕下載」，頁面層另外攔 <a download>（見 guardDownloads）。
        for (const [method, params] of [
            ['Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: false }],
            ['Page.setDownloadBehavior', { behavior: 'deny' }]
        ]) {
            try { await this.send(method, params); } catch (err) { /* 舊版 Chrome 不支援就跳過 */ }
        }
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

    /* 在頁面裡把「下載」攔下來：<a download> 的 click 不做事（Blob 還是建立得起來，所以
       「匯出內容」的檢查照樣能驗），真正做到「不把檔案寫到使用者的電腦」。
       每個檢查在 login 前呼叫一次即可（換頁面要重新注入）。 */
    async guardDownloads() {
        return this.evaluate(`
            if (!window.__downloadGuardInstalled) {
                window.__downloadGuardInstalled = true;
                window.__downloads = [];
                const origClick = HTMLAnchorElement.prototype.click;
                HTMLAnchorElement.prototype.click = function () {
                    if (this.hasAttribute('download')) {
                        window.__downloads.push(this.getAttribute('download') || '(未命名)');
                        return;   // 不觸發下載
                    }
                    return origClick.apply(this, arguments);
                };
            }
            return true;
        `);
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

    /* 改變視窗大小（同一輪檢查裡要量手機與大螢幕兩種版面時用） */
    async setViewport(width, height, mobile = false) {
        this.width = width;
        this.height = height;
        this.mobile = mobile;
        await this.send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: 2, mobile
        });
        await new Promise((r) => setTimeout(r, 250));
        return true;
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

    /* 截圖：**預設完全不寫檔**（使用者 2026-09-26 指示：不要保留任何 screenshot）。
     * 需要親眼看畫面時才用 `CM_KEEP_SCREENSHOTS=1` 跑一次，看完自行刪掉；
     * 檢查本身不依賴截圖檔（判定都來自 evaluate 量到的數值），所以預設不寫不影響結果。 */
    async screenshot(file) {
        if (process.env.CM_KEEP_SCREENSHOTS !== '1') return null;
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
