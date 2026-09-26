/* v3.6.0：使用說明內容的單元測試
 *
 * 說明文件最容易出的三種問題，這裡都用測試擋住：
 *   ① 結構壞掉（沒有步驟、段落 id 重複、角色名稱打錯 → 介面會靜默少一段）
 *   ② 權限過寬（一般使用者看到管理員說明，或反之；「藏起來」不等於看不到）
 *   ③ 內容說謊（寫了系統沒有的功能，例如現場簽到——目前只有列印名單人工勾選）
 */
const test = require('node:test');
const assert = require('node:assert');
const CMGuide = require('../public/js/guide');

const VALID_ROLES = ['guest', 'user', 'test', 'admin', 'super_admin', 'web_owner'];

test('使用說明：結構完整、內容充實', () => {
    const sections = CMGuide.GUIDE_SECTIONS;
    assert.ok(sections.length >= 12, `段落數應有 12 段以上（實際 ${sections.length}）`);

    const ids = sections.map((s) => s.id);
    assert.strictEqual(new Set(ids).size, ids.length, '段落 id 不可重複');

    for (const s of sections) {
        assert.ok(s.title && s.title.length >= 4, `段落 ${s.id} 要有標題`);
        assert.ok(s.intro && s.intro.length >= 10, `段落 ${s.id} 要有開頭說明`);
        assert.ok(Array.isArray(s.steps) && s.steps.length >= 3, `段落 ${s.id} 至少要有 3 個步驟`);
        assert.ok(s.steps.every((st) => typeof st === 'string' && st.trim().length >= 8),
            `段落 ${s.id} 的每個步驟都要是完整的句子`);
        assert.ok(s.icon, `段落 ${s.id} 要有圖示`);
        assert.ok(s.group, `段落 ${s.id} 要有分組名稱`);
        assert.ok(Array.isArray(s.roles) && s.roles.length > 0, `段落 ${s.id} 要指定可見角色`);
        assert.ok(s.roles.every((r) => VALID_ROLES.includes(r)),
            `段落 ${s.id} 的角色名稱必須是 ${VALID_ROLES.join('／')}（打錯字會讓該段永遠不顯示）`);
    }

    const totalSteps = sections.reduce((n, s) => n + s.steps.length, 0);
    assert.ok(totalSteps >= 60, `全部步驟應該有 60 條以上（實際 ${totalSteps}）——太薄就沒有說明價值`);
});

test('使用說明：管理員操作清單完整且可執行', () => {
    const list = CMGuide.ADMIN_CHECKLIST;
    assert.ok(list.items.length >= 10, `操作清單至少 10 步（實際 ${list.items.length}）`);

    list.items.forEach((item, i) => {
        assert.strictEqual(item.step, i + 1, `第 ${i + 1} 步的編號要連續`);
        assert.ok(item.title && item.title.length >= 4, `第 ${item.step} 步要有標題`);
        assert.ok(item.where && item.where.length >= 2, `第 ${item.step} 步要寫「在哪裡做」`);
        assert.ok(item.detail && item.detail.length >= 8, `第 ${item.step} 步要有說明`);
    });

    const joined = list.items.map((i) => `${i.title}${i.where}${i.detail}`).join(' ');
    assert.match(joined, /成績/, '操作清單要有賽後成績的步驟');
    assert.match(joined, /報名/, '操作清單要有報名相關步驟');
    assert.match(joined, /列印|名單/, '操作清單要有現場要用的名單');
});

test('使用說明：依身分給對應內容（不是藏起來，是根本不會回傳）', () => {
    const guest = CMGuide.sectionsFor('guest').map((s) => s.id);
    const user = CMGuide.sectionsFor('user').map((s) => s.id);
    const admin = CMGuide.sectionsFor('admin').map((s) => s.id);
    const superAdmin = CMGuide.sectionsFor('super_admin').map((s) => s.id);

    assert.ok(guest.includes('home') && guest.includes('register') && guest.includes('notify'),
        '訪客要看得到：看懂列表、怎麼報名、通知設定');
    assert.ok(!guest.includes('comp-manage'), '訪客不該拿到「建立與編輯賽事」的說明');
    assert.ok(!guest.includes('myregs'), '訪客沒有「我的報名」這種功能');
    assert.ok(user.includes('myregs'), '登入後才有我的報名');
    assert.ok(!user.includes('comp-manage'), '一般使用者不該拿到管理員說明');
    assert.ok(admin.includes('comp-manage') && admin.includes('reg-review') && admin.includes('results'),
        '管理員要拿到賽事、審核、成績的說明');
    assert.ok(!admin.includes('backup'), '備份與還原只有超級管理員以上，admin 不該看到');
    assert.ok(superAdmin.includes('backup'), '超級管理員要看得到備份說明');
    assert.ok(admin.length > user.length && superAdmin.length > admin.length,
        '可見段落數要隨權限遞增');

    // 未登入／未知角色一律當訪客處理，不能回傳全部
    assert.deepStrictEqual(CMGuide.sectionsFor(undefined).map((s) => s.id), guest, '未指定角色時比照訪客');
    assert.deepStrictEqual(CMGuide.sectionsFor('nonsense').map((s) => s.id), guest, '未知角色不可拿到管理員內容');

    // 操作清單也一樣
    assert.strictEqual(CMGuide.checklistFor('guest'), null, '訪客不該拿到管理員操作清單');
    assert.strictEqual(CMGuide.checklistFor('user'), null, '一般使用者不該拿到管理員操作清單');
    assert.ok(CMGuide.checklistFor('admin'), '管理員要看得到操作清單');
    assert.ok(CMGuide.checklistFor('web_owner'), '最高權限也要看得到操作清單');
});

test('使用說明：搜尋與分組', () => {
    const all = CMGuide.GUIDE_SECTIONS;
    assert.deepStrictEqual(CMGuide.searchSections(all, ''), all, '空字串要回全部');
    assert.deepStrictEqual(CMGuide.searchSections(all, '   '), all, '只有空白也要回全部');

    const waitlist = CMGuide.searchSections(all, '候補').map((s) => s.id);
    assert.ok(waitlist.length >= 1, '搜尋「候補」要找到相關段落');
    assert.ok(waitlist.includes('register') || waitlist.includes('reg-review'), '候補的說明要出現在報名或審核段落');

    const nothing = CMGuide.searchSections(all, '這個詞絕對不會出現在說明裡 zzz');
    assert.strictEqual(nothing.length, 0, '找不到時要回空陣列（介面才能顯示「找不到」）');

    const groups = CMGuide.groupSections(all);
    assert.ok(groups.length >= 3, '至少要有三種分組（所有人／一般使用者／管理員…）');
    assert.ok(groups.every((g) => g.sections.length > 0), '不該出現空的分組');
    assert.strictEqual(groups.reduce((n, g) => n + g.sections.length, 0), all.length, '分組後不能漏掉段落');
});

test('使用說明：現場報到要寫出真正的規則（v3.6.2 起是系統功能）', () => {
    const text = JSON.stringify(CMGuide.GUIDE_SECTIONS) + JSON.stringify(CMGuide.ADMIN_CHECKLIST);

    // v3.6.2 起現場報到是系統功能（管理員勾選簽到＋現場代報名），說明必須寫出真正的操作位置與限制
    const checkin = CMGuide.ADMIN_CHECKLIST.items.find((i) => /報到/.test(i.title));
    assert.ok(checkin, '操作清單要提到現場報到這一步（不然管理員會以為漏了）');
    assert.match(checkin.where + checkin.detail, /現場報到|簽到/,
        '現場報到要指出系統裡的位置與操作方式');
    assert.match(checkin.detail, /正取|候補/, '要說明只有正取能簽到（候補要先遞補）');

    const section = CMGuide.GUIDE_SECTIONS.find((sec) => sec.id === 'checkin-onsite');
    assert.ok(section, '要有專門的「現場報到與現場代報名」段落');
    const sectionText = section.intro + section.steps.join('') + (section.tip || '');
    assert.match(sectionText, /只有正取/, '要寫清楚名單只有正取');
    assert.match(sectionText, /取消簽到/, '要寫可以取消（勾錯是常態）');
    assert.match(sectionText, /現場代報名/, '要寫現場代報名');
    assert.match(sectionText, /名額上限/, '要提醒現場代報名仍守名額上限');
    // v3.6.5：掃碼報到已經上線 → 說明必須寫出「怎麼用」，也要誠實寫出「哪些裝置掃不了」
    assert.match(sectionText, /掃碼報到/, '要寫出掃碼報到怎麼用');
    assert.match(sectionText, /8 碼報到碼/, '要寫出沒有掃碼功能時改用手打 8 碼');
    assert.match(sectionText, /iPhone/, '要明講 iPhone／iPad 沒有掃碼 API，避免現場才發現');
    assert.ok(!/沒有 QR|尚未有系統功能/.test(sectionText), '掃碼已上線，不可以再說沒有這個功能');

    // 不要留下佔位文字
    for (const bad of ['TODO', 'XXX', '待補', '（略）', 'lorem']) {
        assert.ok(!text.includes(bad), `說明內容不該出現佔位文字「${bad}」`);
    }

    // 說明裡提到的功能名稱，要是系統真的有的選單項目（抽樣確保沒有寫到不存在的按鈕）
    for (const label of ['📝 我的報名', '🔔 通知設定', '🗑️ 資源回收桶', '💾 備份與還原', '📤 推播紀錄']) {
        assert.ok(text.includes(label), `說明應該提到實際存在的選單項目「${label}」`);
    }
});

test('使用說明：依角色的摘要（給介面與除錯用）', () => {
    const summary = CMGuide.statusSummary();
    assert.strictEqual(summary.sections, CMGuide.GUIDE_SECTIONS.length);
    assert.strictEqual(summary.checklistItems, CMGuide.ADMIN_CHECKLIST.items.length);
    assert.strictEqual(summary.byRole.guest.checklist, false);
    assert.strictEqual(summary.byRole.admin.checklist, true);
    assert.ok(summary.byRole.guest.sections < summary.byRole.admin.sections);
});
