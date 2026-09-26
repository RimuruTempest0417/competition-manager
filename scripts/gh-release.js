#!/usr/bin/env node
/* 建立 GitHub Release（每版發佈用）
 *
 * 用法：node scripts/gh-release.js v3.5.0 docs/release-v3.5.0.md "標題後半"
 *
 * 為什麼要有這支：以前每版都臨時寫一個 gh-release-vX.js 放在暫存目錄，會被 24 小時清掃刪掉、
 * 也無法重用（token 處理方式每次重寫容易出錯）。這支固定做四件事：
 *   1. 從 macOS Keychain 取 GitHub 憑證（**不落地、不印出**）
 *   2. 確認 tag 真的存在（避免發到錯的 commit）
 *   3. 建立 Release
 *   4. 讀回確認（發佈成功不等於發對，要讀一次才知道）
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const REPO = 'RimuruTempest0417/competition-manager';
const [tag, bodyFile, nameTail] = process.argv.slice(2);

if (!tag || !bodyFile) {
    console.error('用法：node scripts/gh-release.js <tag> <bodyFile> [標題後半]');
    process.exit(1);
}
if (!fs.existsSync(bodyFile)) {
    console.error(`找不到 Release 內容檔：${bodyFile}`);
    process.exit(1);
}

/* 憑證：優先環境變數（CI 用），否則從 Keychain 取（本機用）。不寫入任何檔案、不輸出。 */
function token() {
    if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
    try {
        return execFileSync('security', ['find-internet-password', '-s', 'github.com', '-w'], { encoding: 'utf8' }).trim();
    } catch (e) {
        console.error('取不到 GitHub 憑證：請設 GH_TOKEN，或確認 Keychain 有 github.com 的項目');
        process.exit(1);
    }
}

const AUTH = 'Bearer ' + token();   // 串接寫法：避免憑證字串出現在任何輸出裡
const headers = {
    Authorization: AUTH,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'hermes-release'
};

(async () => {
    // 1) tag 必須存在，且順便取得它指向的 commit
    const tagRes = await fetch(`https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`, { headers });
    if (tagRes.status >= 300) {
        console.error(`❌ tag ${tag} 不存在於 GitHub（先 push tag 再發 Release），HTTP ${tagRes.status}`);
        process.exit(1);
    }
    const tagJson = await tagRes.json();
    console.log(`✅ tag ${tag} 存在（commit ${String(tagJson.object && tagJson.object.sha).slice(0, 7)}）`);

    // 2) 建立 Release
    const body = fs.readFileSync(bodyFile, 'utf8');
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            tag_name: tag,
            name: nameTail ? `${tag} — ${nameTail}` : tag,
            body,
            draft: false,
            prerelease: false
        })
    });
    const created = await res.json();
    if (res.status >= 300) {
        console.error('❌ 建立 Release 失敗', res.status, JSON.stringify(created).slice(0, 500));
        process.exit(1);
    }
    console.log(`✅ 已建立 Release｜${created.html_url}`);

    // 3) 讀回確認（真的存在、內容對得上）
    const check = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers });
    const read = await check.json();
    const all = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers });
    const list = await all.json();
    const ok = check.status === 200
        && read.tag_name === tag
        && read.name === created.name
        && typeof read.body === 'string' && read.body.length > 200;
    console.log(`${ok ? '✅ 讀回確認通過' : '❌ 讀回確認不符'}`,
        `｜tag=${read.tag_name}｜名稱=${read.name}｜內容 ${read.body ? read.body.length : 0} 字元`,
        `｜目前共 ${Array.isArray(list) ? list.length : '?'} 個 Release`);
    process.exit(ok ? 0 : 1);
})();
