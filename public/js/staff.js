/* v2.27.0：賽事工作人員的角色與驗證規則（UMD，前後端共用）
 *
 * 唯一真實來源：後端驗證、前端下拉選單與卡片顯示都走這一份，
 * 避免選單出現後端不認的角色（存不進去）或後端接受前端沒有的角色（顯示不出來）。
 *
 * 規則：
 *   ① 角色固定五種：裁判／記錄／攝影／醫護／其他。
 *   ② 同一場、同一人只有一個角色（改角色＝更新，不會多一列）。
 *   ③ 備註最多 200 字；帳號 id 必須是正整數。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CMStaff = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const STAFF_ROLES = [
        { id: 'referee', label: '裁判', emoji: '⚖️' },
        { id: 'recorder', label: '記錄', emoji: '📝' },
        { id: 'photographer', label: '攝影', emoji: '📷' },
        { id: 'medical', label: '醫護', emoji: '🚑' },
        { id: 'other', label: '其他', emoji: '🙋' }
    ];
    const DEFAULT_ROLE = 'other';
    const NOTE_MAX = 200;

    const roleById = (id) => STAFF_ROLES.find((r) => r.id === id) || null;

    /* 角色碼是否有效（前後端都先問這個） */
    function isValidRole(role) {
        return !!roleById(String(role == null ? '' : role).trim());
    }

    /* 正規化角色：無效或沒帶 → 預設角色（呼叫端要驗證時改用 isValidRole） */
    function normalizeRole(role) {
        const id = String(role == null ? '' : role).trim();
        return isValidRole(id) ? id : DEFAULT_ROLE;
    }

    function roleLabel(role) {
        const found = roleById(String(role == null ? '' : role).trim());
        return found ? found.label : String(role == null ? '' : role).trim();
    }

    function roleEmoji(role) {
        const found = roleById(String(role == null ? '' : role).trim());
        return found ? found.emoji : '🙋';
    }

    function trim(value) {
        return String(value == null ? '' : value).trim();
    }

    /* 指派工作人員的輸入驗證：回 { value, error }（error 有值就不要寫入） */
    function normalizeStaffInput(body, options) {
        const opts = options || {};
        const raw = body || {};

        const userId = Number(raw.user_id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return { error: '要指派的帳號編號不對（user_id 要是正整數）' };
        }

        if (raw.role !== undefined && raw.role !== null && trim(raw.role) !== '' && !isValidRole(raw.role)) {
            return { error: '角色不對，只接受：' + STAFF_ROLES.map((r) => `${r.id}（${r.label}）`).join('／') };
        }

        const note = trim(raw.note);
        if (note.length > NOTE_MAX) {
            return { error: `備註最多 ${NOTE_MAX} 字（目前 ${note.length} 字）` };
        }

        return {
            value: {
                user_id: userId,
                role: normalizeRole(raw.role),
                note: note || (opts.noteWhenEmpty === undefined ? null : opts.noteWhenEmpty)
            }
        };
    }

    /* 一場賽事的工作人員統計（卡片徽章與面板標題用） */
    function staffSummary(list) {
        const rows = Array.isArray(list) ? list : [];
        const byRole = {};
        STAFF_ROLES.forEach((r) => { byRole[r.id] = 0; });
        rows.forEach((row) => {
            const role = normalizeRole(row && row.role);
            byRole[role] = (byRole[role] || 0) + 1;
        });
        return {
            total: rows.length,
            by_role: byRole,
            roles: STAFF_ROLES.map((r) => Object.assign({}, r, { count: byRole[r.id] || 0 }))
        };
    }

    /* 顯示順序：角色順序（裁判→記錄→攝影→醫護→其他）→ 帳號名稱；結果固定，不隨查詢順序變動 */
    function staffSort(list) {
        const rows = Array.isArray(list) ? list.slice() : [];
        const order = (role) => {
            const idx = STAFF_ROLES.findIndex((r) => r.id === normalizeRole(role));
            return idx === -1 ? STAFF_ROLES.length : idx;
        };
        return rows.sort((a, b) => {
            const diff = order(a && a.role) - order(b && b.role);
            if (diff !== 0) return diff;
            const nameA = trim(a && a.username);
            const nameB = trim(b && b.username);
            if (nameA !== nameB) return nameA < nameB ? -1 : 1;
            return Number(a && a.id) - Number(b && b.id);
        });
    }

    /* 一行顯示文字：「⚖️ 裁判 王小明（第三場地）」 */
    function staffLine(row) {
        const r = row || {};
        const note = trim(r.note);
        const role = normalizeRole(r.role);          // 不認識的角色一律顯示成「其他」，不要留空白
        const name = trim(r.username) || `帳號 #${r.user_id}`;
        return `${roleEmoji(role)} ${roleLabel(role)} ${name}${note ? `（${note}）` : ''}`;
    }

    return {
        STAFF_ROLES,
        DEFAULT_ROLE,
        NOTE_MAX,
        isValidRole,
        normalizeRole,
        roleLabel,
        roleEmoji,
        normalizeStaffInput,
        staffSummary,
        staffSort,
        staffLine
    };
}));
