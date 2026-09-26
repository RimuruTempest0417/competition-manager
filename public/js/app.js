let allCompetitions = [];
// v2.19.0：賽事狀態篩選（空字串＝全部）
let currentStateFilter = '';
const CM_STATE_FILTERS = [
    { value: '', label: '全部' },
    { value: 'registration_open', label: '🔥 報名中' },
    { value: 'registration_upcoming', label: '🕒 尚未開放' },
    { value: 'registration_closed', label: '🔒 報名已截止' },
    { value: 'ongoing', label: '🏃 進行中' },
    { value: 'finished', label: '🏁 已結束' }
];
let currentUser = null;
let guideActiveSection = null;   // v3.6.0：使用說明目前選取的段落
let guideSearchTimer = 0;        // 搜尋輸入的節流計時器
let currentBase64Screenshot = '';
let currentPosterItem = null;
let currentView = 'list';                                        // 'list' | 'calendar'
let regCounts = {};                                             // 各賽事報名人數（v2.9.0；v2.20.0 起＝佔名額人數）
let regWaitlistCounts = {};                                     // 各賽事候補人數（v2.20.0）
let staffCounts = {};                                           // 各賽事工作人員人數（v2.27.0，公開的聚合數字）
let myRegistrations = [];                                       // 我的報名（v2.9.0）
let currentRegisterItem = null;                                 // 正在報名的賽事
let currentTeamComp = null;                                     // 隊伍編排視窗對應的賽事
let loginMode = 'login';                                        // 'login' | 'register'
let CM_META = { categories: [], maxTags: 10, maxTagLength: 24 }; // 由 GET /api/meta 取得

// 下拉選單開關邏輯
function toggleNavDropdown() {
    const dropdown = document.getElementById('navDropdown');
    if (dropdown) dropdown.classList.toggle('hidden');
}

function closeNavDropdown() {
    const dropdown = document.getElementById('navDropdown');
    if (dropdown) dropdown.classList.add('hidden');
}

// 點擊選單外部自動關閉下拉視窗
window.addEventListener('click', function (e) {
    const menu = document.getElementById('mainNavMenu');
    const dropdown = document.getElementById('navDropdown');
    if (menu && !menu.contains(e.target) && dropdown && !dropdown.classList.contains('hidden')) {
        dropdown.classList.add('hidden');
    }
});

function openChangePasswordModal() {
    closeNavDropdown();
    const modal = document.getElementById('changePasswordModal');
    if (modal) modal.classList.remove('hidden');
}

function closeChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    if (modal) modal.classList.add('hidden');
    const form = document.getElementById('changePasswordForm');
    if (form) form.reset();
}

async function submitChangePassword(e) {
    e.preventDefault();
    const oldPassword = document.getElementById('oldPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmNewPassword = document.getElementById('confirmNewPassword').value;

    if (newPassword !== confirmNewPassword) {
        alert('兩次輸入的新密碼不一致！');
        return;
    }

    const alphaNumericRegex = /^[a-zA-Z0-9]+$/;
    if (!alphaNumericRegex.test(newPassword)) {
        alert('新密碼格式錯誤：只能包含英文字母與數字！');
        return;
    }

    try {
        const res = await customFetch('/api/auth/change-password', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });

        if (!res.ok) {
            let errMsg = '修改失敗';
            try {
                const errJson = await res.json();
                errMsg = errJson.error || errJson.message || errMsg;
            } catch (e) { }
            throw new Error(errMsg);
        }

        const data = await res.json();
        alert('✅ ' + (data.message || '密碼修改成功'));
        closeChangePasswordModal();
    } catch (err) {
        alert('修改失敗：' + err.message);
    }
}

/* ---------- v2.14.0：未處理錯誤日誌提示（僅超級管理員以上） ---------- */
const ERROR_ALERT_DISMISS_KEY = 'cm-error-alert-dismissed-at';
let lastErrorSummary = null;

function canSeeErrorLogs() {
    return Boolean(currentUser && ['super_admin', 'web_owner'].includes(currentUser.role));
}

function updateErrorLogMenuLabel(count) {
    const btn = document.getElementById('btn-error-logs');
    if (!btn) return;
    btn.textContent = count > 0 ? `🚨 錯誤日誌 (${count})` : '🚨 錯誤日誌';
}

function renderErrorAlert(summary) {
    lastErrorSummary = summary || null;
    const banner = document.getElementById('errorAlertBanner');
    const titleEl = document.getElementById('errorAlertTitle');
    const detailEl = document.getElementById('errorAlertDetail');
    if (!banner || !titleEl || !detailEl) return;

    const count = summary && summary.unresolved_errors ? summary.unresolved_errors : 0;
    updateErrorLogMenuLabel(count);

    if (!summary || !summary.may_need_attention) {
        banner.classList.add('hidden');
        return;
    }
    // 按過「稍後再看」之後，要等到有更新的錯誤（latest_at 改變）才會再提示
    const dismissedAt = localStorage.getItem(ERROR_ALERT_DISMISS_KEY) || '';
    if (summary.latest_at && dismissedAt === String(summary.latest_at)) {
        banner.classList.add('hidden');
        return;
    }

    titleEl.textContent = `有 ${count} 筆未處理的錯誤日誌`;
    const parts = [];
    if (summary.last_24h) parts.push(`近 24 小時新增 ${summary.last_24h} 筆`);
    if (summary.unresolved_total > count) parts.push(`未處理共 ${summary.unresolved_total} 筆（含警告／資訊）`);
    if (summary.latest_at) parts.push(`最新：${new Date(summary.latest_at).toLocaleString()}`);
    detailEl.textContent = parts.join('　·　');
    banner.classList.remove('hidden');
}

async function refreshErrorAlert() {
    if (!canSeeErrorLogs()) { renderErrorAlert(null); return; }
    try {
        const res = await customFetch('/api/admin/error-logs/summary');
        if (!res.ok) return;
        renderErrorAlert(await res.json());
    } catch (err) {
        // 提示只是輔助資訊，失敗不影響任何主要功能
        console.warn('讀取錯誤日誌統計失敗：', err.message);
    }
}

function dismissErrorAlert() {
    const banner = document.getElementById('errorAlertBanner');
    if (banner) banner.classList.add('hidden');
    if (lastErrorSummary && lastErrorSummary.latest_at) {
        localStorage.setItem(ERROR_ALERT_DISMISS_KEY, String(lastErrorSummary.latest_at));
    }
}

function handleLogout() {
    // v2.19.0：先請後端留一筆「登出」稽核紀錄（原本純前端清權杖，稽核日誌的「登出」永遠是空的）。
    // 用最原始的 fetch 且不理會結果：稽核失敗不該讓使用者登不掉。
    // v3.5.0：權杖在 HttpOnly cookie 裡（JS 讀不到也不需要）；直接請伺服器清掉那個 cookie。
    // 同源請求會自動帶 cookie，不用再手動塞 Authorization。
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    pendingTwoFactor = null;
    setLoginStep('credentials');
    currentUser = null;
    localStorage.removeItem('competition_user');
    localStorage.removeItem('auth_token');
    closeNavDropdown();
    updateUIByRole();
    renderErrorAlert(null);   // v2.14.0：登出後不留下前一位使用者的錯誤提示
}

/* v3.5.0：cookie 才是登入狀態的唯一權威。
   為什麼不能只看 localStorage：權杖在 HttpOnly cookie，JS 看不到；
   而 cookie 可能已過期或被伺服器清掉——所以開站時一定要問一次伺服器。
   順手的好處：角色一律以伺服器最新資料為準（localStorage 被改也騙不到權限）。 */
async function verifySession() {
    if (!currentUser) return;
    try {
        const res = await fetch('/api/auth/me', { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
        if (!res.ok) throw new Error('session invalid');
        const data = await res.json();
        if (data && data.user) {
            currentUser = data.user;
            localStorage.setItem('competition_user', JSON.stringify(currentUser));
            updateUIByRole();
        }
    } catch (e) {
        // 401＝cookie 過期／被清掉 → 回到訪客狀態（不彈訊息，開站時很常見）
        currentUser = null;
        localStorage.removeItem('competition_user');
        updateUIByRole();
    }
}

function getRoleEmoji(role, username = '') {
    if (String(username).toLowerCase() === 'test') return '🧪';

    switch (role) {
        case 'web_owner': return '🧑‍💼';
        case 'super_admin': return '🧑🏻‍💼';
        case 'admin': return '💼';
        case 'test': return '🧪';
        case 'user': return '🙋';
        default: return '👤';
    }
}

function getRoleLabel(role, username = '') {
    if (String(username).toLowerCase() === 'test') return '測試帳號';

    switch (role) {
        case 'web_owner': return 'Web Owner';
        case 'super_admin': return '超級管理員';
        case 'admin': return '一般管理員';
        case 'test': return '測試帳號';
        case 'user': return '普通用戶';
        default: return '一般使用者';
    }
}

// v2.12.0：把後端回傳的錯誤訊息取出來（原本前端只顯示「操作失敗」，看不到原因）
async function apiResult(res) {
    let data = null;
    try {
        data = await res.json();
    } catch (e) {
        data = null;
    }
    if (!res.ok) {
        throw new Error((data && (data.error || data.message)) || `請求失敗（HTTP ${res.status}）`);
    }
    return data || {};
}

function getRoleBadge(role, username = '') {
    const badgeClass = role === 'web_owner' ? 'bg-amber-100 text-amber-800 font-bold' :
        role === 'super_admin' ? 'bg-indigo-100 text-indigo-700 font-medium' :
            role === 'user' ? 'bg-emerald-100 text-emerald-700 font-medium' :
                'bg-slate-100 text-slate-600';
    const roleLabel = getRoleLabel(role, username);
    return `<span class="${badgeClass} text-[10px] px-2 py-0.5 rounded">${getRoleEmoji(role, username)} ${roleLabel}</span>`;
}

function canDeleteAdmin(targetAdmin) {
    if (!currentUser) return false;
    if (targetAdmin.username === currentUser.username) return false;
    if (targetAdmin.role === 'web_owner') return false;

    if (currentUser.role === 'web_owner') return true;
    if (currentUser.role === 'super_admin') {
        return targetAdmin.role === 'admin';
    }
    return false;
}

function parseUserAgentBadge(ua) {
    if (!ua) return '<span class="bg-slate-100 text-slate-500 text-[10px] px-1.5 py-0.5 rounded">💻 未知裝置</span>';
    if (ua.includes('iPhone')) return '<span class="bg-purple-100 text-purple-700 text-[10px] px-1.5 py-0.5 rounded font-medium">📱 iPhone</span>';
    if (ua.includes('iPad')) return '<span class="bg-indigo-100 text-indigo-700 text-[10px] px-1.5 py-0.5 rounded font-medium">📱 iPad</span>';
    if (ua.includes('Macintosh') || ua.includes('Mac OS')) return '<span class="bg-slate-200 text-slate-700 text-[10px] px-1.5 py-0.5 rounded font-medium">💻 macOS</span>';
    if (ua.includes('Windows')) return '<span class="bg-blue-100 text-blue-700 text-[10px] px-1.5 py-0.5 rounded font-medium">💻 Windows</span>';
    if (ua.includes('Android')) return '<span class="bg-emerald-100 text-emerald-700 text-[10px] px-1.5 py-0.5 rounded font-medium">🤖 Android</span>';
    return '<span class="bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded">🌐 Browser</span>';
}

function initTimeSelects() {
    const hourOptions = '<option value="">時</option>' + Array.from({ length: 24 }, (_, i) => {
        const val = String(i).padStart(2, '0');
        return `<option value="${val}">${val} 時</option>`;
    }).join('');

    const minuteOptions = '<option value="">分</option>' + Array.from({ length: 60 }, (_, i) => {
        const val = String(i).padStart(2, '0');
        return `<option value="${val}">${val} 分</option>`;
    }).join('');

    document.getElementById('start_hour').innerHTML = hourOptions;
    document.getElementById('end_hour').innerHTML = hourOptions;
    document.getElementById('start_minute').innerHTML = minuteOptions;
    document.getElementById('end_minute').innerHTML = minuteOptions;
}

function getSelectedTime(hourId, minuteId) {
    const h = document.getElementById(hourId).value;
    const m = document.getElementById(minuteId).value;
    if (!h && !m) return '';
    return `${h || '00'}:${m || '00'}`;
}

function setSelectedTime(timeStr, hourId, minuteId) {
    if (!timeStr) {
        document.getElementById(hourId).value = '';
        document.getElementById(minuteId).value = '';
        return;
    }
    const parts = timeStr.split(':');
    if (parts.length >= 2) {
        document.getElementById(hourId).value = parts[0].padStart(2, '0');
        document.getElementById(minuteId).value = parts[1].padStart(2, '0');
    }
}

function format24HourTime(timeStr) {
    if (!timeStr) return '';
    const parts = timeStr.split(':');
    if (parts.length < 2) return timeStr;
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
}

// 只做「倒數幾天」；進行中／已結束交給狀態徽章（後端判定），避免同一張卡片兩個徽章講同一件事
function getBadgeStatus(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(String(dateStr))) return '';

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [startYear, startMonth, startDay] = String(dateStr).slice(0, 10).split('-').map(Number);
    const start = new Date(startYear, startMonth - 1, startDay);

    const diffDays = Math.round((start - today) / (1000 * 60 * 60 * 24));

    if (diffDays > 0) {
        return `<span class="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full font-medium">⏳ 倒數 ${diffDays} 天</span>`;
    }
    return '';
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeHtmlPreserveQuotes(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function openPosterModal(id) {
    const item = allCompetitions.find(c => c.id === id);
    if (!item) return;
    currentPosterItem = item;

    document.getElementById('posterModal').classList.remove('hidden');
    renderPosterCanvas(item);
    syncPosterSource(item);
}

// v2.10.0：若管理員手動上傳過海報，分享視窗改顯示該海報（取代自動生成款式）
function syncPosterSource(item) {
    const image = document.getElementById('posterImage');
    const canvas = document.getElementById('posterCanvas');
    const hint = document.getElementById('posterSourceHint');
    if (!image || !canvas) return;

    const hasCustom = !!(item && item.poster_updated_at);
    if (hasCustom) {
        image.src = `/api/competitions/${item.id}/poster?v=${Date.parse(item.poster_updated_at) || Date.now()}`;
        image.classList.remove('hidden');
        canvas.classList.add('hidden');
        if (hint) hint.innerText = '🖼️ 此海報由發佈者手動上傳';
    } else {
        image.removeAttribute('src');
        image.classList.add('hidden');
        canvas.classList.remove('hidden');
        if (hint) hint.innerText = '自動生成海報（發佈者未上傳自訂海報）';
    }
}

function closePosterModal() {
    document.getElementById('posterModal').classList.add('hidden');
    currentPosterItem = null;
}

function renderPosterCanvas(item) {
    const canvas = document.getElementById('posterCanvas');
    const ctx = canvas.getContext('2d');

    const width = 600;
    const height = 800;
    canvas.width = width;
    canvas.height = height;

    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#1e293b');
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(0, 0, width, 12);

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('🏆 比賽管理系統 官方宣傳海報', 40, 50);

    const statusText = item.is_registration_open ? '🔥 開放報名中' : '已截止';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = item.is_registration_open ? '#ef4444' : '#64748b';
    ctx.fillRect(40, 70, 100, 26);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(statusText, 50, 88);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px sans-serif';
    const nameLines = wrapCanvasText(ctx, item.name || '未命名比賽', width - 80);
    let startY = 140;
    nameLines.forEach(line => {
        ctx.fillText(line, 40, startY);
        startY += 38;
    });

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, startY + 10);
    ctx.lineTo(width - 40, startY + 10);
    ctx.stroke();

    let infoY = startY + 45;
    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#cbd5e1';

    let dateStr = item.date ? `${item.date} ${item.time ? format24HourTime(item.time) : ''}` : '未定';
    if (item.end_date) {
        dateStr += ` ~ ${item.end_date} ${item.end_time ? format24HourTime(item.end_time) : ''}`;
    }
    ctx.fillText(`📅 時間：${dateStr}`, 40, infoY);
    infoY += 32;

    ctx.fillText(`📍 地點：${item.location || '未定'}`, 40, infoY);
    infoY += 40;

    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#334155';
    const descHeight = height - infoY - 80;
    ctx.fillRect(40, infoY, width - 80, descHeight);
    ctx.strokeRect(40, infoY, width - 80, descHeight);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('📝 比賽簡介 / 備註：', 55, infoY + 30);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px sans-serif';
    const descText = item.description || '尚無詳細簡介內容。';
    const descLines = wrapCanvasText(ctx, descText, width - 110);
    let descY = infoY + 60;
    for (let i = 0; i < descLines.length && descY < infoY + descHeight - 20; i++) {
        ctx.fillText(descLines[i], 55, descY);
        descY += 24;
    }

    ctx.fillStyle = '#64748b';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('關注系統獲取最新賽事資訊', width / 2, height - 30);
    ctx.textAlign = 'left';
}

function wrapCanvasText(ctx, text, maxWidth) {
    const words = text.split('');
    const lines = [];
    let currentLine = '';

    for (let i = 0; i < words.length; i++) {
        const char = words[i];
        if (char === '\n') {
            lines.push(currentLine);
            currentLine = '';
            continue;
        }
        const testLine = currentLine + char;
        if (ctx.measureText(testLine).width > maxWidth && i > 0) {
            lines.push(currentLine);
            currentLine = char;
        } else {
            currentLine = testLine;
        }
    }
    lines.push(currentLine);
    return lines;
}

function downloadPosterImage() {
    const canvas = document.getElementById('posterCanvas');
    const link = document.createElement('a');
    link.download = currentPosterItem ? `${currentPosterItem.name}_海報.png` : 'competition_poster.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
}

async function copyPosterImage() {
    const canvas = document.getElementById('posterCanvas');
    try {
        canvas.toBlob(async (blob) => {
            if (!blob) return alert('❌ 生成圖片失敗');
            if (navigator.clipboard && window.ClipboardItem) {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                alert('✅ 海報圖片已成功複製到剪貼簿！');
            } else {
                alert('⚠️ 您的瀏覽器不支援直接複製圖片，請點擊「下載海報」。');
            }
        }, 'image/png');
    } catch (err) {
        alert('❌ 複製失敗：' + err.message);
    }
}

/* ---------- v3.6.0：使用說明與管理員操作清單 ----------
 * 內容來自 public/js/guide.js（前端與 Node 測試共用同一份），這裡只負責畫。
 * 依身分過濾在 guide.js 就做完了：一般使用者根本不會拿到管理員段落，不是畫出來再藏起來。 */
function currentGuideRole() {
    return (currentUser && currentUser.role) ? currentUser.role : 'guest';
}

function openGuideModal() {
    const modal = document.getElementById('guideModal');
    if (!modal) return;
    const search = document.getElementById('guideSearch');
    if (search) search.value = '';
    guideActiveSection = null;
    modal.classList.remove('hidden');
    renderGuide();
}

function closeGuideModal() {
    document.getElementById('guideModal')?.classList.add('hidden');
}

function formatGuideStep(text) {
    // 說明內容裡的 **強調** 轉成粗體（內容是自家靜態文字，不含使用者輸入）
    return String(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderGuide() {
    const nav = document.getElementById('guideNav');
    const body = document.getElementById('guideBody');
    if (!nav || !body || typeof CMGuide === 'undefined') return;

    const role = currentGuideRole();
    const query = (document.getElementById('guideSearch')?.value || '').trim();
    const sections = CMGuide.searchSections(CMGuide.sectionsFor(role), query);
    const checklist = CMGuide.checklistFor(role);
    const showChecklist = Boolean(checklist) && !query;

    const roleNote = document.getElementById('guideRoleNote');
    if (roleNote) roleNote.textContent = `目前身分：${getRoleLabel(role)}`;

    let navHtml = '';
    CMGuide.groupSections(sections).forEach((group) => {
        navHtml += `<p class="cm-guide-nav-group text-slate-400">${group.name}</p>`;
        group.sections.forEach((section) => {
            navHtml += `<button type="button" class="cm-guide-nav-item text-slate-700 hover:bg-slate-50" data-guide-section="${section.id}">${section.icon} ${section.title}</button>`;
        });
    });
    if (showChecklist) {
        navHtml += '<p class="cm-guide-nav-group text-slate-400">管理員</p>'
            + `<button type="button" class="cm-guide-nav-item text-slate-700 hover:bg-slate-50" data-guide-section="__checklist">✅ ${checklist.title}</button>`;
    }
    if (!navHtml) navHtml = '<p class="cm-guide-nav-group text-slate-400">沒有符合的說明</p>';
    nav.innerHTML = navHtml;

    // 目前選取的段落：搜尋後若原本那段不在結果裡，就回到第一段
    const available = sections.map((section) => section.id).concat(showChecklist ? ['__checklist'] : []);
    if (guideActiveSection && !available.includes(guideActiveSection)) guideActiveSection = null;
    const active = guideActiveSection || available[0] || null;
    guideActiveSection = active;

    nav.querySelectorAll('[data-guide-section]').forEach((btn) => {
        btn.classList.toggle('bg-slate-100', btn.dataset.guideSection === active);
    });

    if (active === '__checklist') {
        body.innerHTML = `
            <h4 class="cm-guide-title text-slate-800">✅ ${checklist.title}</h4>
            <p class="cm-guide-intro text-slate-600">${checklist.intro}</p>
            <ol class="cm-guide-steps text-slate-700">
                ${checklist.items.map((item) => `<li><strong>${item.title}</strong><br><span class="cm-guide-where text-slate-500">📍 ${item.where}</span><br><span class="cm-guide-detail text-slate-600">${item.detail}</span></li>`).join('')}
            </ol>`;
        return;
    }

    const section = sections.find((item) => item.id === active);
    if (!section) {
        body.innerHTML = '<p class="cm-guide-empty bg-slate-50 text-slate-500">找不到符合的說明，換個關鍵字試試（例如：候補、成績、推播）。</p>';
        return;
    }
    body.innerHTML = `
        <h4 class="cm-guide-title text-slate-800">${section.icon} ${section.title}</h4>
        <p class="cm-guide-intro text-slate-600">${section.intro}</p>
        <ol class="cm-guide-steps text-slate-700">
            ${section.steps.map((step) => `<li>${formatGuideStep(step)}</li>`).join('')}
        </ol>
        ${section.tip ? `<p class="cm-guide-tip bg-slate-50 text-slate-600">💡 ${formatGuideStep(section.tip)}</p>` : ''}`;
}

function openBugReportModal() {
    document.getElementById('bugReportModal').classList.remove('hidden');
}

function closeBugReportModal() {
    document.getElementById('bugReportModal').classList.add('hidden');
    document.getElementById('bugReportForm').reset();
    document.getElementById('screenshotPreviewContainer').classList.add('hidden');
    document.getElementById('screenshotPreview').src = '';
    currentBase64Screenshot = '';
}

function previewScreenshot(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        alert('請選擇有效的圖片檔案');
        event.target.value = '';
        return;
    }

    if (file.size > 10 * 1024 * 1024) {
        alert('截圖檔案過大，請選擇 10MB 以下的圖片');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
        currentBase64Screenshot = e.target.result;
        document.getElementById('screenshotPreview').src = currentBase64Screenshot;
        document.getElementById('screenshotPreviewContainer').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
}

async function submitBugReport(e) {
    e.preventDefault();
    const type = document.getElementById('bugType').value;
    const description = document.getElementById('bugDescription').value;
    const contact = document.getElementById('reporterContact').value;

    const payload = {
        error_type: type,
        message: description,
        stack_trace: `Contact: ${contact || 'None'}`,
        path: window.location.pathname + window.location.search,
        screenshot: currentBase64Screenshot
    };

    try {
        const res = await customFetch('/api/logs/error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error('回報失敗');
        alert('✅ 感謝你的回報！問題已成功提交。');
        closeBugReportModal();
    } catch (err) {
        alert('回報提交失敗：' + err.message);
    }
}

// 全域錯誤自動回報系統
async function reportErrorToBackend(errorData) {
    try {
        await fetch('/api/logs/error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error_type: errorData.type || 'client_issue',
                message: errorData.message || 'Client Exception',
                stack_trace: errorData.stack || '',
                path: window.location.pathname + window.location.search
            })
        });
    } catch (e) {
        // 靜默處理
    }
}

window.addEventListener('error', (event) => {
    if (event.target && (event.target.tagName === 'IMG' || event.target.tagName === 'SCRIPT')) return;
    reportErrorToBackend({
        type: 'js_runtime_issue',
        message: event.message || 'Script Exec Issue',
        stack: event.error ? event.error.stack : `Line: ${event.lineno}:${event.colno}`
    });
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportErrorToBackend({
        type: 'promise_rejection',
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : ''
    });
});

async function customFetch(url, options = {}) {
    try {
        // v3.5.0：權杖改由 HttpOnly cookie 自動帶上（同源請求），前端不再持有權杖
        const headers = new Headers(options.headers || {});
        headers.set('Content-Type', headers.get('Content-Type') || 'application/json');

        const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });

        // v2.12.0：401（或訊息明講登入逾期）才視為登入失效；
        // 403 只是「權限不足」，不該把使用者踢下線（原本任何 403 都會清 token 並重新載入）
        if (response.status === 401 || response.status === 403) {
            let payload = null;
            try { payload = await response.clone().json(); } catch (e) { payload = null; }
            const message = (payload && (payload.error || payload.message)) || '';
            const sessionExpired = response.status === 401 || /Token 無效|已過期|重新登入/.test(message);

            if (currentUser && sessionExpired) {
                localStorage.removeItem('auth_token');   // 清掉舊版遺留的權杖
                localStorage.removeItem('competition_user');
                alert('登入狀態已失效，請重新登入');
                window.location.reload();
            }
        }
        return response;
    } catch (networkError) {
        reportErrorToBackend({
            type: 'network_failure',
            message: networkError.message || 'Network Error',
            stack: `Endpoint: ${url}`
        });
        throw networkError;
    }
}

/* ==========================================
   主題切換（跟隨系統 / 淺色 / 深色）
   - 三態循環：system → light → dark → system
   - 偏好存於 localStorage 的 cm-theme（純 UI 設定，不參與任何授權判斷；
     後端授權只認 JWT）。
   - 實際套用與首次繪製由 /js/theme-init.js 於 <head> 完成，此處只負責
     按鈕文字與切換行為。
   ========================================== */
const THEME_ORDER = ['system', 'light', 'dark'];
const THEME_LABELS = { system: '跟隨系統', light: '淺色', dark: '深色' };
const THEME_ICONS = { system: '🌗', light: '☀️', dark: '🌙' };

function getStoredTheme() {
    try {
        const t = localStorage.getItem('cm-theme');
        return (t === 'light' || t === 'dark') ? t : 'system';
    } catch (e) {
        return 'system';
    }
}

function updateThemeButton(theme) {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    btn.textContent = `${THEME_ICONS[theme]} 主題：${THEME_LABELS[theme]}`;
    btn.title = '點一下切換：跟隨系統 → 淺色 → 深色';
}

function applyTheme(theme) {
    try {
        if (theme === 'system') {
            document.documentElement.removeAttribute('data-theme');
            localStorage.removeItem('cm-theme');
        } else {
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem('cm-theme', theme);
        }
    } catch (e) {
        // localStorage 不可用時仍套用本次切換（只是不會記住）
        if (theme === 'system') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', theme);
        }
    }
    if (window.CMTheme && window.CMTheme.syncThemeColorMeta) {
        window.CMTheme.syncThemeColorMeta(theme);
    }
    updateThemeButton(theme);
}

function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(getStoredTheme()) + 1) % THEME_ORDER.length];
    applyTheme(next);
}

document.addEventListener('DOMContentLoaded', async () => {
    loadAppVersion();
    initTimeSelects();
    updateThemeButton(getStoredTheme());
    renderTagPreview();

    // 綁定靜態按鈕事件
    document.getElementById('themeToggleBtn')?.addEventListener('click', cycleTheme);
    document.getElementById('navMenuBtn')?.addEventListener('click', toggleNavDropdown);
    document.getElementById('menuBugReport')?.addEventListener('click', () => { openBugReportModal(); closeNavDropdown(); });
    // v3.6.0：使用說明（所有人；內容依身分不同）
    document.getElementById('guideBtn')?.addEventListener('click', () => { openGuideModal(); closeNavDropdown(); });
    document.getElementById('closeGuideModalBtn')?.addEventListener('click', closeGuideModal);
    document.getElementById('guideSearch')?.addEventListener('input', () => {
        window.clearTimeout(guideSearchTimer);
        guideSearchTimer = window.setTimeout(renderGuide, 120);
    });
    document.getElementById('guideNav')?.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-guide-section]');
        if (!btn) return;
        guideActiveSection = btn.dataset.guideSection;
        renderGuide();
    });
    document.getElementById('auditLogBtn')?.addEventListener('click', () => { openAuditLogModal(); closeNavDropdown(); });
    // v2.19.0：賽事狀態篩選列與報名時間預覽
    bindStateFilterBar();
    bindFormStatePreview();

    // v2.19.0：賽事狀態是後端依「當下時間」即時判定的，分頁放久了一定會過期
    // （例如報名剛截止、賽事剛開賽）。回到頁面時若資料超過 2 分鐘就自動重新載入。
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!currentUser) return;
        if (Date.now() - lastCompetitionsLoadAt < 2 * 60 * 1000) return;
        fetchCompetitions();
    });
    // v2.18.0：資料備份與還原（放在這裡而不是 bindErrorLogControls：那個函式只在開啟錯誤日誌視窗時才會跑）
    document.getElementById('backupBtn')?.addEventListener('click', () => { openBackupModal(); closeNavDropdown(); });
    document.getElementById('closeBackupModalBtn')?.addEventListener('click', closeBackupModal);
    document.getElementById('closeBackupModalBtn2')?.addEventListener('click', closeBackupModal);
    document.getElementById('backupDownloadBtn')?.addEventListener('click', downloadBackup);
    document.getElementById('backupCheckBtn')?.addEventListener('click', () => runRestoreFromFile(false));
    document.getElementById('backupRestoreBtn')?.addEventListener('click', () => runRestoreFromFile(true));
    // v2.16.0：稽核日誌篩選／分頁／匯出／清理
    document.getElementById('auditSearchBtn')?.addEventListener('click', () => loadAuditLogs(readAuditFiltersFromUi()));
    document.getElementById('auditSearchInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); loadAuditLogs(readAuditFiltersFromUi()); }
    });
    document.getElementById('auditActionSelect')?.addEventListener('change', () => loadAuditLogs(readAuditFiltersFromUi()));
    document.getElementById('auditClearBtn')?.addEventListener('click', () => {
        document.getElementById('auditSearchInput').value = '';
        document.getElementById('auditActionSelect').value = '';
        document.getElementById('auditDateFrom').value = '';
        document.getElementById('auditDateTo').value = '';
        loadAuditLogs({ q: '', action: '', from: '', to: '', offset: 0 });
    });
    document.getElementById('auditExportBtn')?.addEventListener('click', exportAuditLogs);
    document.getElementById('auditPrevBtn')?.addEventListener('click', () => loadAuditLogs({ offset: Math.max(0, auditQuery.offset - AUDIT_PAGE_SIZE) }));
    document.getElementById('auditNextBtn')?.addEventListener('click', () => loadAuditLogs({ offset: auditQuery.offset + AUDIT_PAGE_SIZE }));
    document.getElementById('auditCleanupBtn')?.addEventListener('click', () => {
        document.getElementById('auditCleanupPanel').classList.toggle('hidden');
        document.getElementById('auditCleanupResult').textContent = '';
        document.getElementById('auditCleanupRunBtn').disabled = true;
    });
    document.getElementById('auditCleanupPreviewBtn')?.addEventListener('click', () => auditCleanup(true));
    document.getElementById('auditCleanupRunBtn')?.addEventListener('click', () => auditCleanup(false));
    document.getElementById('auditCleanupCancelBtn')?.addEventListener('click', () => {
        document.getElementById('auditCleanupPanel').classList.add('hidden');
    });
    document.getElementById('btn-error-logs')?.addEventListener('click', () => { openErrorLogsModal(); closeNavDropdown(); });
    document.getElementById('adminMgmtBtn')?.addEventListener('click', () => { openAdminModal(); closeNavDropdown(); });
    document.getElementById('pushLogsBtn')?.addEventListener('click', () => { openPushLogsModal(); closeNavDropdown(); });
    document.getElementById('pushSettingsBtn')?.addEventListener('click', () => { openPushSettingsModal(); closeNavDropdown(); });
    // v2.26.0：公告中心
    document.getElementById('announcementsBtn')?.addEventListener('click', () => { openAnnouncementModal(); closeNavDropdown(); });
    document.getElementById('closeAnnouncementBtn')?.addEventListener('click', closeAnnouncementModal);
    document.getElementById('closeAnnouncementBtn2')?.addEventListener('click', closeAnnouncementModal);
    // v3.0.0：營運儀表板
    document.getElementById('opsStatsBtn')?.addEventListener('click', openOpsStatsModal);
    initResultsUi();   // v3.1.0：成績表與成績登錄
    bindPrintModalEvents();   // v3.2.0：列印版
    document.getElementById('closeOpsStatsBtn')?.addEventListener('click', closeOpsStatsModal);
    document.getElementById('opsStatsRefreshBtn')?.addEventListener('click', () => loadOpsStats(true));
    document.getElementById('opsStatsRange')?.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-ops-days]');
        if (!btn) return;
        opsStatsDays = Number(btn.dataset.opsDays) || 14;
        renderOpsRangeButtons();
        loadOpsStats();
    });
    document.getElementById('saveAnnounceCatsBtn')?.addEventListener('click', saveAnnounceCategories);
    document.getElementById('markAllAnnounceReadBtn')?.addEventListener('click', markAllAnnouncementsRead);
    document.getElementById('toggleAnnounceFormBtn')?.addEventListener('click', () => {
        const form = document.getElementById('announceForm');
        if (form.classList.contains('hidden')) openAnnounceForm(null);
        else closeAnnounceForm();
    });
    document.getElementById('cancelAnnounceFormBtn')?.addEventListener('click', closeAnnounceForm);
    document.getElementById('announceForm')?.addEventListener('submit', submitAnnouncementForm);
    document.getElementById('announceAudience')?.addEventListener('change', syncAnnounceCategoryPickVisibility);
    // 點公告卡片即標記已讀；管理端列表用事件代理處理編輯／上下架
    document.getElementById('announceList')?.addEventListener('click', (e) => {
        const card = e.target.closest('[data-announce-id]');
        if (card) markAnnouncementsRead([Number(card.dataset.announceId)], '已標記已讀');
    });
    document.getElementById('announceAdminList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        if (btn.dataset.action === 'edit') openAnnounceForm((cmAnnounceAdminState.list || []).find((a) => String(a.id) === String(id)));
        else if (btn.dataset.action === 'toggle') toggleAnnouncementActive(id, btn.dataset.active === '1');
    });
    // 推播紀錄的「重送」
    document.getElementById('pushLogsList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-resend-id]');
        if (btn) resendPushLog(btn.dataset.resendId);
    });
    // v2.27.0：工作人員指派
    document.getElementById('closeStaffModalBtn')?.addEventListener('click', closeStaffModal);
    // v3.6.1：錯誤日誌的截圖檢視
    document.getElementById('closeLogScreenshotBtn')?.addEventListener('click', closeLogScreenshotModal);
    document.getElementById('logScreenshotModal')?.addEventListener('click', (e) => { if (e.target.id === 'logScreenshotModal') closeLogScreenshotModal(); });
    document.getElementById('staffModal')?.addEventListener('click', (e) => { if (e.target.id === 'staffModal') closeStaffModal(); });
    document.getElementById('staffAssignBtn')?.addEventListener('click', assignStaff);
    document.getElementById('staffList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-staff-remove]');
        if (btn) removeStaff(btn.dataset.staffRemove);
    });
    document.getElementById('staffNote')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') assignStaff(); });
    document.getElementById('closePushSettingsBtn')?.addEventListener('click', closePushSettingsModal);
    document.getElementById('closePushSettingsBtn2')?.addEventListener('click', closePushSettingsModal);
    document.getElementById('savePushSettingsBtn')?.addEventListener('click', savePushSettings);
    document.getElementById('changePwdBtn')?.addEventListener('click', () => { openChangePasswordModal(); closeNavDropdown(); });
    // v2.15.0：兩步驟驗證設定
    document.getElementById('twoFactorBtn')?.addEventListener('click', () => { openTwoFactorModal(); });
    document.getElementById('closeTwoFactorModalBtn')?.addEventListener('click', closeTwoFactorModal);
    document.getElementById('twoFactorStartBtn')?.addEventListener('click', startTwoFactorSetup);
    document.getElementById('twoFactorEnableBtn')?.addEventListener('click', enableTwoFactor);
    document.getElementById('twoFactorDisableBtn')?.addEventListener('click', disableTwoFactor);
    document.getElementById('twoFactorRecoveryDoneBtn')?.addEventListener('click', () => {
        document.getElementById('twoFactorRecoverySection')?.classList.add('hidden');
        document.getElementById('twoFactorRecoveryList').innerHTML = '';
        setTwoFactorMessage('備援碼已從畫面移除。如果還沒抄下來，可以停用後重新啟用再產生一次。', 'info');
    });
    document.getElementById('twoFactorEnableCode')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') enableTwoFactor();
    });
    document.getElementById('twoFactorCopyBtn')?.addEventListener('click', async () => {
        const secret = document.getElementById('twoFactorSecret')?.textContent || '';
        try {
            await navigator.clipboard.writeText(secret);
            setTwoFactorMessage('密鑰已複製到剪貼簿。', 'success');
        } catch (err) {
            setTwoFactorMessage('無法自動複製，請長按上方密鑰手動複製。', 'error');
        }
    });
    document.getElementById('errorAlertOpenBtn')?.addEventListener('click', () => { openErrorLogsModal(); });
    document.getElementById('errorAlertDismissBtn')?.addEventListener('click', dismissErrorAlert);
    document.getElementById('authBtn')?.addEventListener('click', () => { toggleAuth(); closeNavDropdown(); });
    document.getElementById('logoutBtn')?.addEventListener('click', () => { handleLogout(); closeNavDropdown(); });

    document.getElementById('competitionForm')?.addEventListener('submit', handleFormSubmit);
    document.getElementById('cancelEditBtn')?.addEventListener('click', resetForm);

    document.getElementById('searchInput')?.addEventListener('input', filterCompetitions);
    document.getElementById('filterDateInput')?.addEventListener('change', filterCompetitions);
    document.getElementById('filterCategory')?.addEventListener('change', filterCompetitions);
    document.getElementById('filterTag')?.addEventListener('change', filterCompetitions);
    document.getElementById('clearFilterBtn')?.addEventListener('click', clearFilter);
    document.getElementById('mainTrashBtn')?.addEventListener('click', openTrashModal);

    // 檢視模式切換（列表 / 日曆）
    document.getElementById('viewListBtn')?.addEventListener('click', () => setView('list'));
    document.getElementById('viewCalendarBtn')?.addEventListener('click', () => setView('calendar'));

    // 標籤輸入即時預覽
    document.getElementById('tags')?.addEventListener('input', renderTagPreview);

    document.getElementById('closeChangePwdModalBtn')?.addEventListener('click', closeChangePasswordModal);
    document.getElementById('cancelChangePwdBtn')?.addEventListener('click', closeChangePasswordModal);
    document.getElementById('changePasswordForm')?.addEventListener('submit', submitChangePassword);

    document.getElementById('closePosterModalBtn')?.addEventListener('click', closePosterModal);
    document.getElementById('closePosterBtn2')?.addEventListener('click', closePosterModal);
    document.getElementById('copyPosterBtn')?.addEventListener('click', copyPosterImage);
    document.getElementById('downloadPosterBtn')?.addEventListener('click', downloadPosterImage);

    document.getElementById('closeBugModalBtn')?.addEventListener('click', closeBugReportModal);
    document.getElementById('cancelBugBtn')?.addEventListener('click', closeBugReportModal);
    document.getElementById('bugReportForm')?.addEventListener('submit', submitBugReport);
    document.getElementById('bugScreenshot')?.addEventListener('change', previewScreenshot);

    document.getElementById('cancelLoginBtn')?.addEventListener('click', closeLoginModal);
    // 同一個按鈕依模式執行「登入」或「註冊」
    document.getElementById('submitLoginBtn')?.addEventListener('click', () => {
        // v2.15.0：第二階段（兩步驟驗證）由同一個按鈕送出
        if (pendingTwoFactor) return submitTwoFactorLogin();
        return loginMode === 'register' ? performRegister() : performLogin();
    });
    document.getElementById('login2faCode')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitTwoFactorLogin();
    });
    document.getElementById('login2faUseRecovery')?.addEventListener('click', () => {
        loginTwoFactorRecoveryMode = !loginTwoFactorRecoveryMode;
        const btn = document.getElementById('login2faUseRecovery');
        const codeEl = document.getElementById('login2faCode');
        if (btn) btn.innerText = loginTwoFactorRecoveryMode ? '改用驗證碼' : '改用備援碼';
        if (codeEl) {
            codeEl.placeholder = loginTwoFactorRecoveryMode ? 'XXXX-XXXX-XXXX' : '123456';
            codeEl.classList.toggle('tracking-widest', !loginTwoFactorRecoveryMode);
            codeEl.value = '';
            codeEl.focus();
        }
    });
    document.getElementById('login2faBack')?.addEventListener('click', () => { setLoginStep('credentials'); });
    document.getElementById('toggleRegisterBtn')?.addEventListener('click', toggleLoginMode);
    document.getElementById('authBtn')?.addEventListener('click', () => { setLoginMode('login'); setLoginNotice(''); });
    document.getElementById('loginPassword')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') (loginMode === 'register' ? performRegister() : performLogin());
    });

    // 報名 / 我的報名 / 隊伍編排（v2.9.0）
    document.getElementById('closeRegisterModalBtn')?.addEventListener('click', closeRegisterModal);
    document.getElementById('closeRegisterModalBtn2')?.addEventListener('click', closeRegisterModal);
    document.getElementById('confirmRegisterBtn')?.addEventListener('click', confirmRegister);

    document.getElementById('myRegsBtn')?.addEventListener('click', openMyRegsModal);
    document.getElementById('closeMyRegsModalBtn')?.addEventListener('click', closeMyRegsModal);
    document.getElementById('closeMyRegsModalBtn2')?.addEventListener('click', closeMyRegsModal);
    document.getElementById('myRegsList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'show-checkin-qr') return openCheckinQrModal(btn.dataset.id);
        if (action === 'cancel-reg') return cancelRegistration(Number(btn.dataset.id));
        if (action === 'reg-ics') return downloadRegistrationIcs(Number(btn.dataset.id));
        if (action === 'reg-gcal') return openRegistrationGoogleCalendar(Number(btn.dataset.id));
    });

    document.getElementById('cancelEditBtn')?.addEventListener('click', clearTeamFormFields);
    document.getElementById('cancelEditBtn')?.addEventListener('click', clearPendingPoster);

    // v2.10.0：海報上傳與推播訂閱
    document.getElementById('posterFile')?.addEventListener('change', handlePosterFileChange);
    document.getElementById('posterRemoveBtn')?.addEventListener('click', handlePosterRemove);
    // v3.3.0（P1-6）：賽事規程 PDF 附件
    document.getElementById('docFile')?.addEventListener('change', handleDocFileChange);
    document.getElementById('docUploadBtn')?.addEventListener('click', uploadDoc);
    document.getElementById('docRemoveBtn')?.addEventListener('click', removeDoc);
    document.getElementById('cancelEditBtn')?.addEventListener('click', resetDocUi);
    // v2.24.0：週期性賽事
    document.getElementById('closeRecurrenceModalBtn')?.addEventListener('click', closeRecurrenceModal);
    document.getElementById('closeRecurrenceBtn')?.addEventListener('click', closeRecurrenceModal);
    document.getElementById('recurrenceSaveBtn')?.addEventListener('click', saveRecurrence);
    document.getElementById('recurrenceNextBtn')?.addEventListener('click', createNextOccurrenceNow);
    document.getElementById('recurrenceRule')?.addEventListener('change', () => updateRecurrenceHint());
    document.getElementById('pushSubscribeBtn')?.addEventListener('click', handlePushSubscribe);
    document.getElementById('pushUnsubscribeBtn')?.addEventListener('click', handlePushUnsubscribe);
    document.getElementById('pushTestBtn')?.addEventListener('click', handlePushTest);
    document.getElementById('notifyBtn')?.addEventListener('click', () => { refreshPushStatus(); });
    // v3.6.3：賽事公告（取消／延期／最新消息）
    document.getElementById('closeNoticeModalBtn')?.addEventListener('click', closeNoticeModal);
    document.getElementById('cancelCompBtn')?.addEventListener('click', saveCancelNotice);
    document.getElementById('reviveCompBtn')?.addEventListener('click', reviveCompetition);
    document.getElementById('postponeCompBtn')?.addEventListener('click', savePostponeNotice);
    document.getElementById('clearPostponeBtn')?.addEventListener('click', clearPostponeNotice);
    document.getElementById('saveNewsBtn')?.addEventListener('click', () => saveCompetitionNews(false));
    document.getElementById('clearNewsBtn')?.addEventListener('click', () => saveCompetitionNews(true));
    document.getElementById('closeTeamModalBtn')?.addEventListener('click', closeTeamModal);
    document.getElementById('closeTeamModalBtn2')?.addEventListener('click', closeTeamModal);
    document.getElementById('createTeamBtn')?.addEventListener('click', createTeam);
    document.getElementById('exportRegsCsvBtn')?.addEventListener('click', exportCompetitionRegistrationsCsv);
    document.getElementById('unassignedList')?.addEventListener('change', (e) => {
        const sel = e.target.closest('select');
        if (!sel || sel.dataset.action !== 'assign-select') return;
        assignTeamMember(Number(sel.dataset.id), Number(sel.value));
    });
    document.getElementById('teamList')?.addEventListener('change', (e) => {
        const sel = e.target.closest('select');
        if (!sel || sel.dataset.action !== 'move-member') return;
        assignTeamMember(Number(sel.dataset.id), Number(sel.value));
    });
    document.getElementById('teamList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.action === 'delete-team') deleteTeam(Number(btn.dataset.id));
        else if (btn.dataset.action === 'remove-member') removeTeamMember(Number(btn.dataset.id));
    });
    // v2.20.0：審核與候補（這些按鈕在彈窗內，不在 #mainContent 的事件委派範圍）
    // v3.6.2：現場報到（在彈窗內，所以要自己綁）
    document.getElementById('onsiteToggleBtn')?.addEventListener('click', () => toggleOnsiteForm());
    document.getElementById('onsiteCancelBtn')?.addEventListener('click', () => toggleOnsiteForm(false));
    document.getElementById('onsiteSubmitBtn')?.addEventListener('click', submitOnsiteRegistration);
    document.getElementById('attendanceReloadBtn')?.addEventListener('click', () => { if (currentTeamComp) loadTeams(currentTeamComp.id); });
    // v3.6.5：掃碼報到（按鈕／輸入報到碼／停止掃碼）
    // 收合面板：預設不佔高度（名單不會被擠下去），按了才展開
    document.getElementById('attendanceScanToggleBtn')?.addEventListener('click', () => {
        const wrap = document.getElementById('attendanceScanWrap');
        if (!wrap) return;
        const opening = wrap.classList.contains('hidden');
        wrap.classList.toggle('hidden', !opening);
        if (opening) {
            setScanHint(scanSupported() ? '' : '這台裝置的瀏覽器沒有掃碼功能（iPhone／Safari 都沒有）→ 請直接輸入 8 碼報到碼。');
            document.getElementById('attendanceCodeInput')?.focus();
        } else {
            stopCheckinScan();
        }
    });
    document.getElementById('attendanceScanBtn')?.addEventListener('click', () => {
        if (cmScanStream) stopCheckinScan(); else startCheckinScan();
    });
    document.getElementById('attendanceScanStopBtn')?.addEventListener('click', stopCheckinScan);
    document.getElementById('attendanceCodeBtn')?.addEventListener('click', () => {
        submitCheckinCode(document.getElementById('attendanceCodeInput')?.value || '');
    });
    document.getElementById('attendanceCodeInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitCheckinCode(e.target.value || '');
        }
    });
    document.getElementById('closeCheckinQrBtn')?.addEventListener('click', closeCheckinQrModal);
    document.getElementById('attendanceSearch')?.addEventListener('input', (e) => {
        attendanceQuery = e.target.value || '';
        renderAttendanceSection(lastTeamsData || {});
    });
    document.getElementById('attendanceList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.action === 'check-in') setAttendance(Number(btn.dataset.id), true);
        else if (btn.dataset.action === 'undo-check-in') setAttendance(Number(btn.dataset.id), false);
    });
    document.getElementById('promoteWaitlistBtn')?.addEventListener('click', promoteWaitlist);
    document.getElementById('pendingList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.dataset.action !== 'review-reg') return;
        reviewRegistration(btn.dataset.id, btn.dataset.verdict);
    });
    document.getElementById('waitlistList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled) return;
        if (btn.dataset.action === 'waitlist-move') moveWaitlist(btn.dataset.id, btn.dataset.dir);
        else if (btn.dataset.action === 'promote-reg') promoteWaitlistMember(btn.dataset.id, btn.dataset.username || '');
    });
    // v2.22.0：候補相關的新控制項。
    // 記取 v2.12.2 的教訓：<select> 一定要用 change 事件，click 不會觸發（也不會冒泡成我們要的結果）。
    document.getElementById('waitlistList')?.addEventListener('change', (e) => {
        // v2.23.0：勾選框（批次搬移）→ 更新「已選 N 筆」與可放的位置
        const box = e.target.closest('input[data-action="waitlist-select"]');
        if (box) {
            setWaitlistBatchBar(waitlistSelectedIds().length, waitlistIdsFromDom().length);
            return;
        }
        const sel = e.target.closest('select[data-action="waitlist-jump"]');
        if (!sel) return;
        jumpWaitlist(sel.dataset.id, sel.value);
    });
    // v2.23.0：批次搬移與「載入更早」
    document.getElementById('waitlistBatchMove')?.addEventListener('click', () => {
        const sel = document.getElementById('waitlistBatchTarget');
        moveSelectedWaitlist(sel ? sel.value : 1);
    });
    document.getElementById('waitlistBatchClear')?.addEventListener('click', () => {
        Array.from(document.querySelectorAll('#waitlistList input[data-action="waitlist-select"]'))
            .forEach((el) => { el.checked = false; });
        setWaitlistBatchBar(0, waitlistIdsFromDom().length);
    });
    document.getElementById('waitlistNotifyToggle')?.addEventListener('change', (e) => {
        toggleWaitlistNotify(e.target.checked);
    });
    document.getElementById('waitlistHistoryBtn')?.addEventListener('click', () => loadWaitlistHistory(true));
    document.getElementById('waitlistHistoryMore')?.addEventListener('click', () => loadWaitlistHistory(false));
    document.getElementById('waitlistHistoryClose')?.addEventListener('click', () => {
        document.getElementById('waitlistHistoryPanel')?.classList.add('hidden');
    });
    initWaitlistDrag();

    document.getElementById('closeAuditModalBtn')?.addEventListener('click', closeAuditLogModal);
    document.getElementById('closeAuditModalBtn2')?.addEventListener('click', closeAuditLogModal);

    document.getElementById('closeErrorModalBtn')?.addEventListener('click', closeErrorLogsModal);
    document.getElementById('closeErrorModalBtn2')?.addEventListener('click', closeErrorLogsModal);
    document.getElementById('closePushLogsBtn')?.addEventListener('click', closePushLogsModal);
    document.getElementById('closePushLogsBtn2')?.addEventListener('click', closePushLogsModal);

    document.getElementById('closeAdminModalBtn')?.addEventListener('click', closeAdminModal);
    document.getElementById('closeAdminModalBtn2')?.addEventListener('click', closeAdminModal);
    document.getElementById('addAdminForm')?.addEventListener('submit', handleAddAdmin);

    document.getElementById('closeTrashModalBtn')?.addEventListener('click', closeTrashModal);
    document.getElementById('closeTrashModalBtn2')?.addEventListener('click', closeTrashModal);

    // 通知設定
    document.getElementById('notifyBtn')?.addEventListener('click', openNotifyModal);
    document.getElementById('closeNotifyModalBtn')?.addEventListener('click', closeNotifyModal);
    document.getElementById('closeNotifyModalBtn2')?.addEventListener('click', closeNotifyModal);
    document.getElementById('notifyEnableBtn')?.addEventListener('click', notifyEnable);
    document.getElementById('notifyTestBtn')?.addEventListener('click', () => notifyTest(false));
    document.getElementById('notifyDisableBtn')?.addEventListener('click', notifyDisable);
    document.getElementById('notifyNewComp')?.addEventListener('change', (e) => {
        if (!window.CMNotify) return;
        const state = CMNotify.loadState();
        state.newCompetitions = e.target.checked;
        CMNotify.saveState(state);
    });

    // 訂閱清單的「取消」按鈕（Modal 不在 main 內，另外綁定）
    document.getElementById('notifySubList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || btn.dataset.action !== 'unsubscribe') return;
        if (window.CMNotify) CMNotify.setSubscribed(btn.dataset.id, null);
        refreshAfterSubscriptionChange();
    });

    // CSV 匯入 / 匯出
    document.getElementById('csvToolBtn')?.addEventListener('click', openCsvModal);
    document.getElementById('closeCsvModalBtn')?.addEventListener('click', closeCsvModal);
    document.getElementById('closeCsvModalBtn2')?.addEventListener('click', closeCsvModal);
    document.getElementById('csvExportBtn')?.addEventListener('click', csvExport);
    document.getElementById('csvTemplateBtn')?.addEventListener('click', csvDownloadTemplate);
    document.getElementById('csvFileInput')?.addEventListener('change', csvPickFile);
    document.getElementById('csvConfirmBtn')?.addEventListener('click', csvConfirmImport);

    // 事件委派：動態清單按鈕點擊處理（綁在 main 上，列表與日曆的當天清單共用同一組行為）
    document.getElementById('mainContent')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        if (action === 'copy-text') {
            copyToClipboard(btn.dataset.name, btn.dataset.date, btn.dataset.endDate, btn.dataset.location);
        } else if (action === 'share-poster') {
            openPosterModal(id);
        } else if (action === 'toggle-subscribe') {
            toggleSubscription(id);
        } else if (action === 'register-comp') {
            openRegisterModal(id);
        } else if (action === 'my-regs') {
            openMyRegsModal();
        } else if (action === 'manage-teams') {
            openTeamModal(id);
        } else if (action === 'manage-staff') {
            openStaffModal(id);
        } else if (action === 'manage-notice') {
            openNoticeModal(id);
        } else if (action === 'view-results') {
            openResultsModal(id);
        } else if (action === 'edit-results') {
            openResultsEditor(id);
        } else if (action === 'print-roster') {
            openPrintRoster(id);
        } else if (action === 'print-results') {
            openPrintResults(id);
        } else if (action === 'copy-comp') {
            copyCompetition(id);
        } else if (action === 'duplicate-comp') {
            duplicateCompetition(id);
        } else if (action === 'recurrence-comp') {
            openRecurrenceModal(id);
        } else if (action === 'edit-comp') {
            startEdit(id);
        } else if (action === 'delete-comp') {
            deleteCompetition(id);
        }
    });

    document.getElementById('trashList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        if (action === 'restore') {
            restoreCompetition(id);
        } else if (action === 'hard-delete') {
            permanentlyDeleteCompetition(id);
        }
    });

    localStorage.removeItem('auth_token');   // v3.5.0：舊版把權杖存在這裡，升級後一律清掉
    const savedUser = localStorage.getItem('competition_user');
    if (savedUser) {
        // 先樂觀套用（畫面不用等），真正的權威是 cookie → 立刻向伺服器確認一次
        try { currentUser = JSON.parse(savedUser); } catch (e) { currentUser = null; }
    } else {
        currentUser = null;
    }
    verifySession();
    // v2.14.0：已登入的超級管理員以上，載入時檢查是否有未處理錯誤
    if (canSeeErrorLogs()) refreshErrorAlert();
    else updateErrorLogMenuLabel(0);

    // 日曆初始化：當天清單沿用列表的卡片樣板，因此按鈕行為完全一致
    if (window.CMCalendar) {
        window.CMCalendar.init({
            renderDayList: (container, items) => renderCompetitionCards(items, container)
        });
    }

    let savedView = 'list';
    try {
        savedView = localStorage.getItem('cm-view') === 'calendar' ? 'calendar' : 'list';
    } catch (e) { /* 忽略 */ }
    setView(savedView);

    // 通知監看：載入時與每 5 分鐘檢查一次，切回分頁時也會檢查
    if (window.CMNotify) {
        notifyWatcher = CMNotify.startWatcher(() => allCompetitions, { intervalMs: 5 * 60 * 1000 });
    }

    updateUIByRole();
    await fetchMeta();          // 先取得分類清單，卡片才能顯示分類徽章
    await fetchRegistrationCounts();              // v2.9.0：報名人數與公開設定
    if (currentUser) await fetchMyRegistrations(); // v2.9.0：我的報名
    await fetchCompetitions();

    // v2.11.0：處理網址意圖（推播通知點擊 ?comp=ID、manifest 捷徑 ?view=...）
    await applyUrlIntent();
});

// 讓通知／分享連結能直達目標：?comp=<id> 會捲動並高亮該賽事；?view=myregs|notify 會開啟對應視窗
async function applyUrlIntent() {
    let params;
    try {
        params = new URLSearchParams(window.location.search);
    } catch (e) {
        return;
    }

    const view = params.get('view');
    if (view === 'notify') {
        if (window.refreshPushStatus) refreshPushStatus();
        document.getElementById('notifyModal')?.classList.remove('hidden');
    } else if (view === 'myregs') {
        await openMyRegsModal();
    }

    const announceId = params.get('announce');
    if (announceId && currentUser) {
        await openAnnouncementModal();
        const card = document.querySelector(`#announceList [data-announce-id="${CSS.escape(String(announceId))}"]`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('cm-flash');
            setTimeout(() => card.classList.remove('cm-flash'), 3200);
        }
    }

    const compId = params.get('comp');
    if (compId) {
        setView('list');   // 日曆模式下卡片不在畫面上，先切回列表
        focusCompetitionCard(compId);
    }

    // 清掉查詢字串，避免重新整理時重複觸發（保留路徑與雜湊）
    if (view || compId || announceId) {
        try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* 忽略 */ }
    }
}

function focusCompetitionCard(compId) {
    const card = document.querySelector(`#competitionList .cm-card[data-comp-id="${CSS.escape(String(compId))}"]`);
    if (!card) return false;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('cm-flash');
    setTimeout(() => card.classList.remove('cm-flash'), 3200);
    return true;
}

// 角色 → 選單／功能可見性（單一來源）
// 為什麼要這樣寫：過去每個角色分支各自列 classList.add('hidden')，
// 只要有分支漏寫（例如訪客分支忘了隱藏 CSV 按鈕），登出後就會殘留管理員功能。
const CM_MENU_PERMISSIONS = {
    guest:       { csvTool: false, trash: false, audit: false, errorLogs: false, adminMgmt: false, pushLogs: false, pushSettings: false, opsStats: false, create: false, myRegs: false, changePwd: false, twoFactor: false, backup: false, announce: false, guide: true },
    user:        { csvTool: false, trash: false, audit: false, errorLogs: false, adminMgmt: false, pushLogs: false, pushSettings: false, opsStats: false, create: false, myRegs: true,  changePwd: true,  twoFactor: false, backup: false, announce: true, guide: true },
    test:        { csvTool: false, trash: false, audit: false, errorLogs: false, adminMgmt: false, pushLogs: false, pushSettings: false, opsStats: false, create: true,  myRegs: true,  changePwd: true,  twoFactor: false, backup: false, announce: true, guide: true },
    admin:       { csvTool: true,  trash: true,  audit: false, errorLogs: false, adminMgmt: true,  pushLogs: true,  pushSettings: true,  opsStats: true,  create: true,  myRegs: true,  changePwd: true,  twoFactor: true,  backup: false, announce: true, guide: true },
    super_admin: { csvTool: true,  trash: true,  audit: true,  errorLogs: true,  adminMgmt: true,  pushLogs: true,  pushSettings: true,  opsStats: true,  create: true,  myRegs: true,  changePwd: true,  twoFactor: true,  backup: true, announce: true, guide: true },
    web_owner:   { csvTool: true,  trash: true,  audit: true,  errorLogs: true,  adminMgmt: true,  pushLogs: true,  pushSettings: true,  opsStats: true,  create: true,  myRegs: true,  changePwd: true,  twoFactor: true,  backup: true, announce: true, guide: true }
};

function applyMenuVisibility(role) {
    const perm = CM_MENU_PERMISSIONS[role] || CM_MENU_PERMISSIONS.admin;
    const map = [
        ['csvToolBtn', perm.csvTool],
        ['mainTrashBtn', perm.trash],
        ['auditLogBtn', perm.audit],
        ['btn-error-logs', perm.errorLogs],
        ['adminMgmtBtn', perm.adminMgmt],
        ['pushLogsBtn', perm.pushLogs],
        ['pushSettingsBtn', perm.pushSettings],
        ['createSection', perm.create],
        ['myRegsBtn', perm.myRegs],
        ['changePwdBtn', perm.changePwd],
        ['twoFactorBtn', perm.twoFactor],
        ['backupBtn', perm.backup],
        ['announcementsBtn', perm.announce],  // v2.26.0：公告中心（登入即可）
        ['opsStatsBtn', perm.opsStats],       // v3.0.0：營運儀表板（管理員以上）
        ['guideBtn', perm.guide]              // v3.6.0：使用說明（所有人，內容依身分）
    ];
    map.forEach(([id, visible]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !visible);
    });
}

function updateUIByRole() {
    const authStatus = document.getElementById('authStatus');
    const dropdownUserInfo = document.getElementById('dropdownUserInfo');
    const dropdownUsername = document.getElementById('dropdownUsername');
    const createSection = document.getElementById('createSection');
    const auditLogBtn = document.getElementById('auditLogBtn');
    const btnErrorLogs = document.getElementById('btn-error-logs');
    const adminMgmtBtn = document.getElementById('adminMgmtBtn');
    const mainTrashBtn = document.getElementById('mainTrashBtn');
    const csvToolBtn = document.getElementById('csvToolBtn');
    const changePwdBtn = document.getElementById('changePwdBtn');
    const authBtn = document.getElementById('authBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const menuDivider = document.getElementById('menuDivider');
    const myRegsBtn = document.getElementById('myRegsBtn');

    // 先依角色統一套用選單可見性（避免任何角色殘留上一輪登入的功能）
    applyMenuVisibility(currentUser ? currentUser.role : 'guest');
    // v3.6.0：使用說明若正開著，身分改變要立刻重畫（登出後不能還看得到管理員段落）
    if (document.getElementById('guideModal') && !document.getElementById('guideModal').classList.contains('hidden')) renderGuide();

    if (!currentUser) {
        authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200 cm-auth-pill";
        authStatus.innerText = `${getRoleEmoji('guest')} 普通訪客`;

        dropdownUserInfo?.classList.add('hidden');
        createSection?.classList.add('hidden');
        auditLogBtn?.classList.add('hidden');
        btnErrorLogs?.classList.add('hidden');
        adminMgmtBtn?.classList.add('hidden');
        mainTrashBtn?.classList.add('hidden');
        changePwdBtn?.classList.add('hidden');
        menuDivider?.classList.add('hidden');
        myRegsBtn?.classList.add('hidden');

        authBtn?.classList.remove('hidden');
        logoutBtn?.classList.add('hidden');
    } else {
        dropdownUserInfo?.classList.remove('hidden');
        if (dropdownUsername) dropdownUsername.innerText = currentUser.username || '使用者';
        createSection?.classList.remove('hidden');
        changePwdBtn?.classList.remove('hidden');
        menuDivider?.classList.remove('hidden');
        myRegsBtn?.classList.remove('hidden');
        authBtn?.classList.add('hidden');
        logoutBtn?.classList.remove('hidden');

        // 登入後補載「我的報名」（v2.9.0）
        if (currentUser && !myRegistrations.length) fetchMyRegistrations();

        if (currentUser.role === 'web_owner') {
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300 font-bold";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.remove('hidden');
            btnErrorLogs?.classList.remove('hidden');
            adminMgmtBtn?.classList.remove('hidden');
            mainTrashBtn?.classList.remove('hidden');
            csvToolBtn?.classList.remove('hidden');
        } else if (currentUser.role === 'super_admin') {
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-300";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.remove('hidden');
            btnErrorLogs?.classList.remove('hidden');
            adminMgmtBtn?.classList.remove('hidden');
            mainTrashBtn?.classList.remove('hidden');
            csvToolBtn?.classList.remove('hidden');
        } else if (currentUser.role === 'test') {
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-purple-100 text-purple-700 border border-purple-300";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.add('hidden');
            btnErrorLogs?.classList.add('hidden');
            adminMgmtBtn?.classList.add('hidden');
            mainTrashBtn?.classList.add('hidden');
            csvToolBtn?.classList.add('hidden');
        } else if (currentUser.role === 'user') {
            // 普通用戶：可瀏覽、報名、管理自己的報名與密碼；不可發佈或管理賽事
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-300";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            createSection?.classList.add('hidden');
            auditLogBtn?.classList.add('hidden');
            btnErrorLogs?.classList.add('hidden');
            adminMgmtBtn?.classList.add('hidden');
            mainTrashBtn?.classList.add('hidden');
            csvToolBtn?.classList.add('hidden');
        } else if (currentUser.role === 'admin') {
            // 管理員：可發佈、管理賽事、檢視與建立帳號（v2.12.0 起可管理使用者）
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-blue-100 text-blue-700 border border-blue-300";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.add('hidden');
            btnErrorLogs?.classList.add('hidden');
            adminMgmtBtn?.classList.remove('hidden');
            mainTrashBtn?.classList.remove('hidden');
            csvToolBtn?.classList.remove('hidden');
        } else {
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-blue-100 text-blue-700 border border-blue-300";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.add('hidden');
            btnErrorLogs?.classList.add('hidden');
            adminMgmtBtn?.classList.add('hidden');
            mainTrashBtn?.classList.remove('hidden');
            csvToolBtn?.classList.remove('hidden');
        }
        // className 會被上面的分支整串覆蓋，這裡補回手機版排版用的標記 class
        authStatus.classList.add('cm-auth-pill');
        // 最後再以權限表為準覆蓋一次：任何角色分支漏寫都不會讓功能殘留
        applyMenuVisibility(currentUser.role);
    }
    renderCurrentView(allCompetitions);
    // v2.26.0：登入狀態變了就更新公告未讀徽章（訪客會順手隱藏）
    refreshAnnounceBadge();
}

/* ==========================================
   報名參加與隊伍編排（v2.9.0）
   - 報名一律需要登入（普通用戶 user 角色即可）；訪客點「報名」會先開啟登入視窗。
   - 組隊比賽需填隊伍名稱，管理員以上可再編排隊伍。
   - 開放與否由後端 registrationState 權威判斷，前端僅同步顯示（多擋一次是為了體驗）。
   ========================================== */

function todayString(d) {
    const now = d instanceof Date ? d : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/* 賽事狀態（v2.19.0）：一律採用**後端算好的狀態**（/api/competitions 帶 state／state_label／
   can_register／registration_reason）。後端是唯一真實來源，前端不再自己算一套——
   兩套邏輯遲早會不一致（畫面說可以報名、送出卻被拒）。只有在舊回應沒有 state 欄位時才退回本機推算。 */
function clientRegistrationState(item) {
    if (!item) return { open: false, reason: '找不到該賽事', state: 'missing', label: '找不到該賽事', tone: 'slate' };
    if (item.state) {
        return {
            open: !!item.can_register,
            reason: item.registration_reason || '',
            state: item.state,
            label: item.state_label || '',
            tone: item.state_tone || 'slate',
            detail: item.state_detail || '',
            // v2.20.0：額滿但有候補／需審核時，按鈕與提示要跟著變
            waitlist: !!item.is_waitlist,
            waitlist_position: item.waitlist_position || null,
            needs_approval: !!item.needs_approval
        };
    }
    return localRegistrationState(item);
}

/* 相容舊回應／離線的降級推算（規則與 public/js/competition-state.js 相同） */
function localRegistrationState(item) {
    if (!item) return { open: false, reason: '找不到該賽事', state: 'missing', label: '找不到該賽事', tone: 'slate' };
    const st = window.CMCompetitionState
        ? window.CMCompetitionState.evaluate(Object.assign({}, item, {
            // 後端算出來的報名人數優先，沒有才用本機快取
            registered_count: undefined
        }), new Date(), { registeredCount: Number(regCounts[String(item.id)]) || 0 })
        : null;

    if (st) {
        return { open: !!st.can_register, reason: st.can_register ? '' : st.reason, state: st.state, label: st.label, tone: st.tone, detail: st.detail };
    }

    // 連共用模組都載不到時的極簡推算（不應發生；僅為避免整頁壞掉）
    if (!item.is_registration_open) return { open: false, reason: '未開放報名', state: 'registration_closed', label: '未開放報名', tone: 'slate' };
    return { open: true, reason: '', state: 'registration_open', label: '報名中', tone: 'green' };
}

// 是否為管理員以上（與後端 ADMIN_ROLES 一致：test 帳號不具管理權）
function isAdminUser() {
    return !!currentUser && ['admin', 'super_admin', 'web_owner'].includes(currentUser.role);
}

function isMyRegistration(id) {
    return myRegistrations.some((r) => String(r.competition_id) === String(id));
}

// 狀態徽章：文字與色調都由後端狀態決定（v2.19.0）
const CM_STATE_BADGE_EMOJI = {
    registration_open: '🔥',
    registration_upcoming: '🕒',
    registration_closed: '🔒',
    ongoing: '🏃',
    finished: '🏁',
    unscheduled: '📅',
    cancelled: '⛔',
    postponed: '🕒',
    deleted: '🗑️',
    missing: '❓'
};

function regStatusBadgeHtml(item) {
    const st = clientRegistrationState(item);
    const toneClass = {
        green: 'bg-emerald-100 text-emerald-700',
        amber: 'bg-amber-100 text-amber-700',
        blue: 'bg-blue-100 text-blue-700',
        slate: 'bg-slate-100 text-slate-500',
        red: 'bg-red-100 text-red-700'
    }[st.tone] || 'bg-slate-100 text-slate-500';

    const label = st.label || (st.open ? '報名中' : st.reason);
    const emoji = CM_STATE_BADGE_EMOJI[st.state] || '';
    const full = item.is_full ? '（已額滿）' : '';
    const title = st.reason ? ` title="${escapeHtml(st.reason)}"` : '';

    return `<span class="${toneClass} text-xs px-2 py-0.5 rounded-full font-medium"${title}>${emoji} ${escapeHtml(label)}${full}</span>`;
}

function regMetaHtml(item) {
    const parts = [];
    const count = Number(regCounts[String(item.id)]) || 0;
    const max = Number(item.max_registrations) || 0;
    if (max > 0) {
        const left = Math.max(0, max - count);
        parts.push(`<span class="text-slate-600">👥 ${count} / ${max} 人</span>`);
        parts.push(left > 0
            ? `<span class="text-emerald-600 font-medium">剩 ${left} 個名額</span>`
            : '<span class="text-red-500 font-medium">🔒 名額已滿</span>');
    } else if (count > 0) {
        parts.push(`<span class="text-emerald-600 font-medium">👥 ${count} 人已報名</span>`);
    }
    if (item.is_team_event && Number(item.team_size) > 0) parts.push(`<span>每隊上限 ${item.team_size} 人</span>`);
    // v2.20.0：需審核／額滿可候補（讓使用者一眼看出報名之後會怎樣）
    if (item.needs_approval && item.can_register) parts.push('<span class="text-amber-600 font-medium">⏳ 報名需審核</span>');
    if (item.is_waitlist) {
        parts.push(`<span class="text-blue-600 font-medium">🕒 額滿，報名排候補${Number(regWaitlistCounts[String(item.id)]) > 0 ? `（已有 ${Number(regWaitlistCounts[String(item.id)])} 人候補）` : ''}</span>`);
    }
    // v2.19.0：截止時間優先顯示新的 registration_end_at（可精確到分），舊資料才用 registration_deadline
    const regEnd = item.registration_end_at || item.registration_deadline;
    if (regEnd) {
        const open = clientRegistrationState(item).open;
        const text = window.CMCompetitionState
            ? window.CMCompetitionState.fmtDateTime(window.CMCompetitionState.parseTimestamp(regEnd))
            : String(regEnd).slice(0, 16).replace('T', ' ');
        parts.push(`<span class="${open ? '' : 'text-red-500'}">⏰ 報名截止 ${escapeHtml(text)}</span>`);
    }
    return parts.join('');
}

function registrationButtonHtml(item) {
    if (isMyRegistration(item.id)) {
        return '<button data-action="my-regs" class="text-xs text-emerald-700 bg-emerald-100 hover:bg-emerald-200 font-medium px-2.5 py-1 rounded transition">✅ 已報名</button>';
    }
    const state = clientRegistrationState(item);
    if (state.open) {
        const label = state.waitlist ? '📝 報名（排候補）' : '📝 報名';
        return `<button data-action="register-comp" data-id="${item.id}" class="text-xs text-white bg-blue-600 hover:bg-blue-700 font-medium px-2.5 py-1 rounded transition">${label}</button>`;
    }
    return `<button data-action="register-comp" data-id="${item.id}" class="text-xs text-slate-500 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded transition">🔒 ${escapeHtml(state.reason)}</button>`;
}


/* ---------- v2.19.0：賽事狀態機的介面工具 ---------- */

/* datetime-local 的值（'2026-10-01T23:59'，不帶時區）→ 帶本地時區的 ISO 字串。
   為什麼要帶時區：資料庫欄位可能是 timestamp 或 timestamptz。帶 '+08:00' 的寫法兩種都對
   （timestamptz 存正確的瞬間；timestamp 取當地牆上時間），不帶時區會依伺服器時區解讀而位移。 */
function localInputToIso(value) {
    if (!value) return null;
    const dt = new Date(value);
    if (isNaN(dt.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const offsetMin = -dt.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/* ISO 時間戳 → datetime-local 的值（取本地時間，秒以下截掉） */
function isoToLocalInput(value) {
    if (!value) return '';
    const dt = window.CMCompetitionState
        ? window.CMCompetitionState.parseTimestamp(value)
        : new Date(value);
    if (!dt || isNaN(dt.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

/* 表單裡的即時狀態預覽：用與後端**同一份**規則（public/js/competition-state.js）算，
   所以「預覽顯示什麼」與「儲存後後端判定什麼」不會不一致。 */
function updateFormStatePreview() {
    const textEl = document.getElementById('formStatePreviewText');
    if (!textEl) return;
    if (!window.CMCompetitionState) { textEl.textContent = '—'; return; }

    const draft = {
        name: document.getElementById('name')?.value || '',
        date: document.getElementById('date')?.value || '',
        time: getSelectedTime('start_hour', 'start_minute'),
        end_date: document.getElementById('end_date')?.value || '',
        end_time: getSelectedTime('end_hour', 'end_minute'),
        is_registration_open: !!document.getElementById('is_registration_open')?.checked,
        registration_start_at: localInputToIso(document.getElementById('registration_start_at')?.value),
        registration_end_at: localInputToIso(document.getElementById('registration_end_at')?.value),
        max_registrations: Number(document.getElementById('max_registrations')?.value) || 0,
        // v2.20.0：審核與候補會影響「送出後會變成什麼狀態」
        requires_approval: !!document.getElementById('requires_approval')?.checked,
        waitlist_enabled: !!document.getElementById('waitlist_enabled')?.checked
    };

    const editingId = document.getElementById('editingId')?.value;
    const registeredCount = editingId ? (Number(regCounts[String(editingId)]) || 0) : 0;
    const st = window.CMCompetitionState.evaluate(draft, new Date(), { registeredCount });

    const extras = [];
    if (st.needs_approval) extras.push('需審核');
    if (st.waitlist) extras.push('額滿排候補');
    textEl.textContent = `${st.label}${st.full ? '（已額滿）' : ''}${extras.length ? '｜' + extras.join('、') : ''}`;
    textEl.className = 'font-semibold ' + ({
        green: 'text-emerald-600', amber: 'text-amber-600', blue: 'text-blue-600', slate: 'text-slate-500'
    }[st.tone] || 'text-slate-500');
    const detailEl = document.getElementById('formStateDetail');
    if (detailEl) detailEl.textContent = st.can_register ? st.detail : (st.reason || st.detail);
}

function bindFormStatePreview() {
    ['date', 'end_date', 'is_registration_open', 'registration_start_at', 'registration_end_at', 'max_registrations', 'requires_approval', 'waitlist_enabled']
        .forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', updateFormStatePreview);
            el.addEventListener('input', updateFormStatePreview);
        });
    ['start_hour', 'start_minute', 'end_hour', 'end_minute'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', updateFormStatePreview);
    });
}

/* ---------- 登入 / 註冊視窗 ---------- */
function setLoginNotice(message, type) {
    const el = document.getElementById('loginNotice');
    if (!el) return;
    if (!message) { el.classList.add('hidden'); el.textContent = ''; return; }

    const cls = type === 'error' ? 'bg-red-50 border-red-200 text-red-700'
        : type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
            : 'bg-blue-50 border-blue-200 text-blue-700';
    el.className = 'text-xs p-2.5 rounded-lg border ' + cls;
    el.textContent = message;
    el.classList.remove('hidden');
}

function setLoginMode(mode) {
    loginMode = mode === 'register' ? 'register' : 'login';
    const isRegister = loginMode === 'register';

    const title = document.getElementById('loginModalTitle');
    if (title) title.innerText = isRegister ? '註冊新帳號 Register' : '登入 Login';
    document.getElementById('registerFields')?.classList.toggle('hidden', !isRegister);
    const submit = document.getElementById('submitLoginBtn');
    if (submit) submit.innerText = isRegister ? '註冊並登入' : '登入';
    const hint = document.getElementById('loginModeHint');
    if (hint) hint.innerText = isRegister ? '已經有帳號？' : '還沒有帳號？';
    const toggle = document.getElementById('toggleRegisterBtn');
    if (toggle) toggle.innerText = isRegister ? '登入' : '註冊新帳號';

    const needCode = !!(CM_META.registration && CM_META.registration.codeRequired);
    document.getElementById('registerCodeWrap')?.classList.toggle('hidden', !isRegister || !needCode);

    setLoginNotice('');
}

function toggleLoginMode() {
    setLoginMode(loginMode === 'register' ? 'login' : 'register');
}

function openLoginModal(message) {
    closeNavDropdown();
    setLoginMode('login');
    const userEl = document.getElementById('loginUsername');
    const passEl = document.getElementById('loginPassword');
    const pass2El = document.getElementById('registerPassword2');
    if (userEl) userEl.value = '';
    if (passEl) passEl.value = '';
    if (pass2El) pass2El.value = '';
    setLoginNotice(message || '', 'info');
    document.getElementById('loginModal')?.classList.remove('hidden');
    userEl?.focus();
}

async function performRegister() {
    const username = (document.getElementById('loginUsername').value || '').trim();
    const password = document.getElementById('loginPassword').value || '';
    const password2 = document.getElementById('registerPassword2').value || '';
    const codeEl = document.getElementById('registerCode');

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        return setLoginNotice('帳號格式錯誤：請用 3~20 個英文字母、數字或底線', 'error');
    }
    if (!/^[a-zA-Z0-9]{6,64}$/.test(password)) {
        return setLoginNotice('密碼格式錯誤：請用 6~64 個英文字母或數字', 'error');
    }
    if (password !== password2) return setLoginNotice('兩次輸入的密碼不一致', 'error');

    const btn = document.getElementById('submitLoginBtn');
    if (btn) btn.disabled = true;

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, registration_code: codeEl ? codeEl.value.trim() : '' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '註冊失敗');

        // v3.5.0：權杖已由伺服器放進 HttpOnly cookie，前端只留顯示用的帳號資訊
        localStorage.removeItem('auth_token');
        localStorage.setItem('competition_user', JSON.stringify(data.user));
        currentUser = data.user;

        closeLoginModal();
        await fetchMyRegistrations();
        updateUIByRole();
        alert(`註冊成功，歡迎 ${data.user.username}！你現在可以報名參加比賽了。`);
    } catch (err) {
        setLoginNotice(err.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* ---------- 報名 ---------- */
function setRegisterMsg(message, type) {
    const el = document.getElementById('registerMsg');
    if (!el) return;
    if (!message) { el.classList.add('hidden'); el.textContent = ''; return; }

    el.className = 'text-xs p-2.5 rounded-lg border ' + (type === 'error'
        ? 'bg-red-50 border-red-200 text-red-700'
        : 'bg-emerald-50 border-emerald-200 text-emerald-700');
    el.textContent = message;
    el.classList.remove('hidden');
}

async function fetchRegistrationCounts() {
    try {
        const [countsRes, cfgRes] = await Promise.all([
            fetch('/api/registration-counts'),
            fetch('/api/public-config')
        ]);

        if (countsRes.ok) {
            const data = await countsRes.json();
            regCounts = data.counts || {};
            regWaitlistCounts = data.waitlist || {};   // v2.20.0：候補人數（公開的聚合數字）
            staffCounts = data.staff || {};            // v2.27.0：工作人員人數（沒 migration 時是空的）
        }
        if (cfgRes.ok) {
            const cfg = await cfgRes.json();
            CM_META.registration = { codeRequired: !!cfg.requireRegistrationCode };
        }
    } catch (e) {
        regCounts = {};            // 未執行 migration 或離線時不影響瀏覽
        regWaitlistCounts = {};
        staffCounts = {};
    }
}

function clearTeamFormFields() {
    const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setChecked = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };

    setChecked('is_team_event', false);
    setValue('team_size', '');
    setValue('max_registrations', '');
    setValue('registration_start_at', '');
    setValue('registration_end_at', '');
    // v2.20.0：審核與候補預設關閉（與舊版行為相同）
    setChecked('requires_approval', false);
    setChecked('waitlist_enabled', false);
}

let myRegsError = null;   // { kind, message }：讓「我的報名」能顯示真正的原因，而不是靜默空白

async function fetchMyRegistrations() {
    myRegsError = null;
    if (!currentUser) { myRegistrations = []; return; }
    try {
        const res = await customFetch('/api/my/registrations');
        if (res.ok) {
            const data = await res.json();
            myRegistrations = Array.isArray(data) ? data : [];
            return;
        }
        myRegistrations = [];
        const body = await res.json().catch(() => ({}));
        if (res.status === 401) {
            myRegsError = { kind: 'auth', message: '登入狀態已過期，請重新登入後再查看報名紀錄。' };
        } else if (res.status === 503) {
            // 後端明確告知需要執行資料庫遷移時，把原文帶出來（管理員看得懂怎麼修）
            myRegsError = { kind: 'schema', message: body.error || '資料庫尚未完成報名相關設定。' };
        } else {
            myRegsError = { kind: 'error', message: body.error || `讀取報名紀錄失敗（HTTP ${res.status}）` };
        }
    } catch (e) {
        myRegistrations = [];
        myRegsError = { kind: 'offline', message: '目前無法連線到伺服器，請稍後再試。' };
    }
}

function openRegisterModal(id) {
    const item = allCompetitions.find((c) => String(c.id) === String(id));
    if (!item) return;

    // 需求：訪客點「報名」必須先登入
    if (!currentUser) {
        openLoginModal('請先登入或註冊帳號，才能報名參加比賽。');
        return;
    }

    currentRegisterItem = item;
    const state = clientRegistrationState(item);
    const count = Number(regCounts[String(item.id)]) || 0;

    const info = document.getElementById('registerCompInfo');
    if (info) {
        info.innerHTML = `
            <p class="font-bold text-slate-800">${escapeHtml(item.name)}</p>
            <p class="mt-1">📅 ${escapeHtml(item.date || '')}${item.time ? ' ' + escapeHtml(item.time) : ''}${item.end_date ? ' ~ ' + escapeHtml(item.end_date) : ''}</p>
            ${item.location ? `<p>📍 ${escapeHtml(item.location)}</p>` : ''}
            <p>🙋 報名者：${escapeHtml(currentUser.username)}</p>
            ${item.is_team_event ? '<p class="text-indigo-700 font-medium mt-1">👥 此為組隊比賽，請填寫隊伍名稱（管理員會再依此編排）</p>' : ''}
            ${count > 0 ? `<p class="mt-1 text-emerald-600">目前已報名 ${count} 人</p>` : ''}
            ${state.open ? '' : `<p class="text-red-600 font-medium mt-1">🔒 ${escapeHtml(state.reason)}</p>`}
        `;
    }

    // v2.20.0：先告訴使用者「送出之後會變成什麼狀態」，不要送出後才發現只是候補
    const hint = document.getElementById('registerHint');
    if (hint) {
        const bits = [];
        if (state.waitlist) bits.push(`🕒 名額已滿，送出後會排入候補${state.waitlist_position ? `（第 ${state.waitlist_position} 位）` : ''}；有人取消時會自動遞補並通知你。`);
        if (state.needs_approval) bits.push('⏳ 此賽事報名需審核：送出後狀態是「待審核」，主辦單位核准才算報名成功。');
        hint.classList.toggle('hidden', bits.length === 0);
        hint.className = bits.length
            ? 'text-xs p-2.5 rounded-lg border ' + (state.waitlist ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-amber-50 border-amber-200 text-amber-900')
            : 'hidden text-xs p-2.5 rounded-lg border';
        hint.innerText = bits.join('\n');
    }

    document.getElementById('registerTeamWrap')?.classList.toggle('hidden', !item.is_team_event);
    const teamInput = document.getElementById('registerTeamName');
    if (teamInput) teamInput.value = '';
    const noteEl = document.getElementById('registerNote');
    if (noteEl) noteEl.value = '';

    setRegisterMsg('');
    const confirmBtn = document.getElementById('confirmRegisterBtn');
    if (confirmBtn) {
        confirmBtn.disabled = !state.open;
        confirmBtn.innerText = state.open ? '確認報名' : '無法報名';
    }
    document.getElementById('registerModal')?.classList.remove('hidden');
}

function closeRegisterModal() {
    document.getElementById('registerModal')?.classList.add('hidden');
    currentRegisterItem = null;
}

async function confirmRegister() {
    const item = currentRegisterItem;
    if (!item) return;

    const teamName = (document.getElementById('registerTeamName').value || '').trim();
    const note = (document.getElementById('registerNote').value || '').trim();

    if (item.is_team_event && !teamName) return setRegisterMsg('此為組隊比賽，請填寫隊伍名稱', 'error');

    const btn = document.getElementById('confirmRegisterBtn');
    if (btn) btn.disabled = true;

    try {
        const res = await customFetch(`/api/competitions/${item.id}/register`, {
            method: 'POST',
            body: JSON.stringify({ team_name: teamName, note })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '報名失敗');

        closeRegisterModal();
        await Promise.all([fetchRegistrationCounts(), fetchMyRegistrations()]);
        updateUIByRole();
        alert(data.message || '報名成功！');
    } catch (err) {
        setRegisterMsg(err.message, 'error');
        if (btn) btn.disabled = false;
    }
}

/* ---------- 我的報名 ---------- */
function findMyRegistration(regId) {
    return myRegistrations.find((r) => String(r.id) === String(regId)) || null;
}

// 行程檔（.ics）：純前端產生，不依賴外部服務；iOS／Android／Outlook 都能直接匯入
function buildIcsContent(comp) {
    const stamp = (dateStr, timeStr) =>
        String(dateStr).replace(/-/g, '') + 'T' + String(timeStr || '09:00').replace(':', '') + '00';
    const start = stamp(comp.date, comp.time || '09:00');
    let end;
    if (comp.end_date) {
        end = stamp(comp.end_date, comp.end_time || '18:00');
    } else {
        const d = new Date(`${comp.date}T${comp.time || '09:00'}:00`);
        d.setHours(d.getHours() + 2);
        const p = (n) => String(n).padStart(2, '0');
        end = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
    }
    const esc = (s) => String(s == null ? '' : s)
        .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
        'PRODID:-//competition-manager//zh-TW//v2.11.0',
        'BEGIN:VEVENT',
        `UID:cm-competition-${comp.id}@competition-manager`,
        `DTSTAMP:${now}`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${esc(comp.name)}`,
        comp.location ? `LOCATION:${esc(comp.location)}` : '',
        comp.description ? `DESCRIPTION:${esc(comp.description)}` : '',
        'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:提醒：明天的比賽', 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR'
    ];
    return lines.filter(Boolean).join('\r\n');
}

function downloadRegistrationIcs(regId) {
    const reg = findMyRegistration(regId);
    const comp = reg && reg.competitions;
    if (!comp || !comp.date) return alert('這筆報名沒有可加入行事曆的日期資訊。');
    const safeName = String(comp.name || 'competition').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    downloadCsvBlob(`${safeName}.ics`, new Blob([buildIcsContent(comp)], { type: 'text/calendar;charset=utf-8' }));
}

function openRegistrationGoogleCalendar(regId) {
    const reg = findMyRegistration(regId);
    const comp = reg && reg.competitions;
    if (!comp || !comp.date) return alert('這筆報名沒有可加入行事曆的日期資訊。');
    const pad = (n) => String(n).padStart(2, '0');
    const startStamp = String(comp.date).replace(/-/g, '') + 'T' + String(comp.time || '09:00').replace(':', '') + '00';
    let endStamp;
    if (comp.end_date) {
        endStamp = String(comp.end_date).replace(/-/g, '') + 'T' + String(comp.end_time || '18:00').replace(':', '') + '00';
    } else {
        const d = new Date(`${comp.date}T${comp.time || '09:00'}:00`);
        d.setHours(d.getHours() + 2);
        endStamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    }
    const params = new URLSearchParams({
        action: 'TEMPLATE',
        text: comp.name || '比賽',
        dates: `${startStamp}/${endStamp}`,
        details: comp.description ? String(comp.description).slice(0, 900) : '比賽報名紀錄（來自比賽管理系統）',
        location: comp.location || ''
    });
    window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, '_blank', 'noopener');
}

function setMyRegsStatus(kind, message) {
    const box = document.getElementById('myRegsStatus');
    if (!box) return;
    if (!message) { box.classList.add('hidden'); box.textContent = ''; return; }
    box.className = 'text-xs p-2.5 rounded-lg border ' +
        (kind === 'schema'
            ? 'bg-amber-50 border-amber-300 text-amber-900'
            : kind === 'auth'
                ? 'bg-blue-50 border-blue-200 text-blue-800'
                : 'bg-red-50 border-red-200 text-red-700');
    box.textContent = message;
    box.classList.remove('hidden');
}

/* v2.20.0：我的報名狀態徽章（待審核／已核准／候補第 N 位／未錄取） */
function myRegStatusBadge(r) {
    const CM = window.CMCompetitionState;
    const label = r.status_label || (CM ? CM.REG_STATUS_LABELS[r.status] : '') || '';
    if (!label) return '';
    const tone = (CM ? CM.REG_STATUS_TONES[r.status] : '') || 'slate';
    const cls = {
        amber: 'bg-amber-100 text-amber-700',
        green: 'bg-emerald-100 text-emerald-700',
        blue: 'bg-blue-100 text-blue-700',
        rose: 'bg-rose-50 text-rose-700 border border-rose-200',
        slate: 'bg-slate-100 text-slate-500'
    }[tone] || 'bg-slate-100 text-slate-500';
    const extra = r.status === 'waitlisted' && r.waitlist_position ? `第 ${r.waitlist_position} 位` : '';
    return `<span class="ml-1 align-middle text-xs font-medium px-2 py-0.5 rounded-full ${cls}">${escapeHtml(label)}${extra ? ' ' + extra : ''}</span>`;
}

/* ---------- v3.6.5：掃碼報到與報到碼 ----------
 *
 * 為什麼要有兩條路：BarcodeDetector 這個瀏覽器 API 只有 Android 的 Chrome 有，
 * iPhone（Safari 與 iOS 的 Chrome）完全沒有——所以「手打 8 碼」不是備援，是另一條主要路徑。
 * 沒有掃碼能力的裝置**不會**看到一個按了沒反應的按鈕，而是直接被告知要用哪一種方式。
 */
let cmScanStream = null;
let cmScanTimer = null;

function scanSupported() {
    return typeof window.BarcodeDetector === 'function'
        && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function setScanHint(message) {
    const hint = document.getElementById('attendanceScanHint');
    if (!hint) return;
    hint.innerText = message || '';
    hint.classList.toggle('hidden', !message);
}

/* 送出報到碼。QR 內容會是 CM1:XXXXXXXX，所以先去掉前綴再驗 8 碼 */
async function submitCheckinCode(rawCode) {
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^CM1?/, '');
    if (code.length !== 8) {
        setTeamMsg('報到碼是 8 碼英數字（QR 內容也接受）：請確認後再試', 'error');
        return false;
    }
    try {
        const res = await customFetch('/api/registrations/attendance-by-code', {
            method: 'POST',
            body: JSON.stringify({ code })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '簽到失敗');
        setTeamMsg(data.message || '已簽到', 'success');
        setScanHint('');
        const input = document.getElementById('attendanceCodeInput');
        if (input) input.value = '';
        if (currentTeamComp) await loadTeams(currentTeamComp.id);   // 名單立刻更新（已簽到幾人）
        return true;
    } catch (err) {
        setTeamMsg(err.message || '簽到失敗', 'error');
        return false;
    }
}

function stopCheckinScan() {
    if (cmScanTimer) { clearTimeout(cmScanTimer); cmScanTimer = null; }
    if (cmScanStream) {
        try { cmScanStream.getTracks().forEach((track) => track.stop()); } catch (err) { /* 忽略 */ }
        cmScanStream = null;
    }
    const box = document.getElementById('attendanceScanBox');
    const video = document.getElementById('attendanceScanVideo');
    if (video) video.srcObject = null;
    if (box) box.classList.add('hidden');
}

async function startCheckinScan() {
    if (!scanSupported()) {
        setScanHint('這台裝置的瀏覽器沒有掃碼功能（iPhone／Safari 都沒有）→ 請直接輸入 8 碼報到碼，或請對方把手機給你手動核對。');
        return;
    }
    try {
        cmScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (err) {
        setScanHint(`拿不到相機權限（${err && err.name ? err.name : '未知'}）：請允許相機後再試，或改用輸入報到碼。`);
        return;
    }
    const video = document.getElementById('attendanceScanVideo');
    const box = document.getElementById('attendanceScanBox');
    if (!video || !box) return;
    video.srcObject = cmScanStream;
    try { await video.play(); } catch (err) { /* 某些瀏覽器要使用者手勢，忽略 */ }
    box.classList.remove('hidden');
    setScanHint('把鏡頭對準選手的 QR，不需要按快門。');

    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    const tick = async () => {
        if (!cmScanStream) return;
        try {
            const found = await detector.detect(video);
            if (found && found.length) {
                const raw = found[0].rawValue || '';
                stopCheckinScan();
                await submitCheckinCode(raw);
                return;
            }
        } catch (err) { /* 單一格畫面失敗就繼續掃 */ }
        cmScanTimer = setTimeout(tick, 350);
    };
    tick();
}

function openCheckinQrModal(id) {
    const r = (myRegistrations || []).find((x) => String(x.id) === String(id));
    if (!r) return;
    const comp = r.competitions || {};
    const code = r.checkin_code || '';
    const label = document.getElementById('checkinQrComp');
    if (label) label.innerText = `${comp.name || ''}${comp.date ? `｜${comp.date}${comp.time ? ' ' + comp.time : ''}` : ''}`;
    const codeEl = document.getElementById('checkinQrCode');
    if (codeEl) codeEl.innerText = code || '—';
    const box = document.getElementById('checkinQrBox');
    if (box) {
        if (code && window.CMQr) {
            try {
                box.innerHTML = CMQr.svg(`CM1:${code}`, { scale: 6, margin: 3, alt: `${comp.name || '賽事'} 報到碼 ${code}` });
            } catch (err) {
                box.innerHTML = '<p class="text-xs text-red-600">QR 產生失敗，請直接把下方 8 碼報到碼給工作人員</p>';
            }
        } else {
            box.innerHTML = `<p class="text-xs text-slate-500">${code
                ? '這個瀏覽器載不到 QR 模組，請直接把下方 8 碼報到碼給工作人員。'
                : '這筆報名目前沒有報到碼（只有正取會有；候補請先遞補為正取）。'}</p>`;
        }
    }
    document.getElementById('checkinQrModal')?.classList.remove('hidden');
}

function closeCheckinQrModal() {
    document.getElementById('checkinQrModal')?.classList.add('hidden');
}

function renderMyRegs() {
    const list = document.getElementById('myRegsList');
    if (!list) return;

    if (myRegsError) {
        setMyRegsStatus(myRegsError.kind, myRegsError.message);
    } else {
        setMyRegsStatus(null, null);
    }

    if (!myRegistrations.length) {
        list.innerHTML = `<p class="text-center text-slate-400 py-6 text-sm">${myRegsError ? '暫時無法顯示報名紀錄' : '目前沒有報名紀錄'}</p>`;
        return;
    }

    list.innerHTML = myRegistrations.map((r) => {
        const comp = r.competitions || {};
        return `
        <div class="border border-slate-200 rounded-lg p-3 flex justify-between items-start gap-3">
            <div class="min-w-0">
                <p class="text-sm font-bold text-slate-800">${escapeHtml(comp.name || '(賽事已刪除)')}
                    ${myRegStatusBadge(r)}</p>
                <p class="text-xs text-slate-500 mt-0.5">📅 ${escapeHtml(comp.date || '')}${comp.time ? ' ' + escapeHtml(comp.time) : ''}${comp.location ? ' ｜ 📍 ' + escapeHtml(comp.location) : ''}</p>
                ${comp.is_team_event && r.team_name ? `<p class="text-xs text-indigo-600 mt-0.5">👥 隊伍：${escapeHtml(r.team_name)}</p>` : ''}
                ${r.note ? `<p class="text-xs text-slate-500 mt-0.5">📝 ${escapeHtml(r.note)}</p>` : ''}
                ${r.checkin_code ? `<div class="mt-1.5">
                    <button type="button" data-action="show-checkin-qr" data-id="${r.id}"
                        class="text-xs text-emerald-700 hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded transition">📷 報到碼 / QR（現場出示）</button>
                </div>` : ''}
                ${myResultHtml(r.competition_id)}
                <p class="text-xs text-slate-400 mt-0.5">報名時間：${escapeHtml(String(r.created_at || '').slice(0, 16).replace('T', ' '))}</p>
            </div>
            <div class="flex flex-col items-end gap-1.5 shrink-0">
                ${comp.date ? `
                <button data-action="reg-ics" data-id="${r.id}"
                    class="text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded transition">📅 行程檔</button>
                <button data-action="reg-gcal" data-id="${r.id}"
                    class="text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded transition">🗓️ 日曆</button>` : ''}
                ${r.can_cancel === false ? '' : `<button data-action="cancel-reg" data-id="${r.id}"
                    class="text-xs text-red-600 hover:text-red-800 bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded transition">取消報名</button>`}
            </div>
        </div>`;
    }).join('');
}

async function openMyRegsModal() {
    if (!currentUser) return openLoginModal('請先登入才能查看你的報名紀錄。');

    closeNavDropdown();
    setMyRegsStatus(null, null);
    const list = document.getElementById('myRegsList');
    if (list) list.innerHTML = '<p class="text-center text-slate-400 py-6 text-sm">載入中…</p>';
    document.getElementById('myRegsModal')?.classList.remove('hidden');

    await Promise.all([fetchMyRegistrations(), fetchMyResults()]);
    renderMyRegs();
}

function closeMyRegsModal() {
    document.getElementById('myRegsModal')?.classList.add('hidden');
}

async function cancelRegistration(regId) {
    if (!regId) return;
    if (!confirm('確定要取消這筆報名嗎？取消後可重新報名（若仍開放）。')) return;

    try {
        const res = await customFetch(`/api/registrations/${regId}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '取消失敗');

        await Promise.all([fetchRegistrationCounts(), fetchMyRegistrations()]);
        renderMyRegs();
        if (currentTeamComp) await loadTeams(currentTeamComp.id);
        updateUIByRole();
        alert(data.message || '已取消報名');
    } catch (err) {
        alert('操作失敗：' + err.message);
    }
}

/* ---------- 報名名單與隊伍編排（管理員以上） ---------- */
function setTeamMsg(message, type) {
    const el = document.getElementById('teamMsg');
    if (!el) return;
    if (!message) { el.classList.add('hidden'); el.textContent = ''; return; }

    el.className = 'text-xs p-2.5 rounded-lg border ' + (type === 'error'
        ? 'bg-red-50 border-red-200 text-red-700'
        : 'bg-emerald-50 border-emerald-200 text-emerald-700');
    el.textContent = message;
    el.classList.remove('hidden');
}

// 管理員匯出單場賽事的報名名單（含隊伍），方便現場報到與計分
async function exportCompetitionRegistrationsCsv() {
    const comp = currentTeamComp;
    if (!comp) return;
    if (!isAdminUser()) return alert('匯出報名名單僅限管理員以上使用。');
    const btn = document.getElementById('exportRegsCsvBtn');
    try {
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 匯出中...'; }
        const res = await customFetch(`/api/competitions/${comp.id}/registrations`);
        if (!res.ok) throw new Error('讀取報名名單失敗');
        const payload = await res.json();
        const list = Array.isArray(payload) ? payload : (payload.registrations || []);
        if (!list.length) {
            setTeamMsg('這場賽事目前沒有報名資料。', 'error');
            return;
        }
        // v2.22.0：匯出時帶上狀態與候補順位——現場報到／計分時才看得出誰已核准、誰在候補第幾位
        const rows = list.map((r) => ({
            姓名: r.username || '',
            隊伍: r.team_name || '',
            狀態: r.status_label || (window.CMCompetitionState
                ? CMCompetitionState.REG_STATUS_LABELS[CMCompetitionState.normalizeRegStatus(r.status)]
                : (r.status || '')) || '',
            候補順位: Number(r.waitlist_position) > 0 ? r.waitlist_position : '',
            簽到: r.attended_at ? `已簽到 ${String(r.attended_at).slice(11, 16)}` : '未簽到',
            現場代報名: r.onsite ? '是' : '',
            備註: r.note || '',
            報名時間: String(r.created_at || '').slice(0, 16).replace('T', ' ')
        }));
        const csv = window.CMCSV
            ? CMCSV.stringify(rows, { bom: true })
            : rows.map((r) => Object.values(r).join(',')).join('\n');
        const safeName = String(comp.name || 'competition').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
        downloadCsvBlob(`${safeName}-報名名單.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        setTeamMsg(`已匯出 ${rows.length} 筆報名資料（檔案已下載）`, 'success');
    } catch (err) {
        setTeamMsg(err.message || '匯出失敗', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '⬇️ 匯出報名名單 (CSV)'; }
    }
}

async function openTeamModal(id) {
    const item = allCompetitions.find((c) => String(c.id) === String(id));
    if (!item) return;
    if (!currentUser) return openLoginModal('請先登入。');
    if (!isAdminUser()) {
        return alert('權限不足：只有管理員以上可以檢視報名名單與編排隊伍');
    }

    currentTeamComp = item;
    const title = document.getElementById('teamModalComp');
    if (title) title.innerText = `${item.name}｜${item.date || '未定日期'}${item.is_team_event ? '｜👥 組隊比賽' : '｜個人賽'}`;

    const canDelete = ['super_admin', 'web_owner'].includes(currentUser.role);
    const hint = document.getElementById('teamRoleHint');
    if (hint) {
        hint.className = 'text-xs p-2.5 rounded-lg border ' + (canDelete
            ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
            : 'bg-slate-50 border-slate-200 text-slate-600');
        hint.innerText = canDelete
            ? '你的權限：可建立隊伍、編排隊員，並可刪除隊伍與移除隊員（超級管理員以上）。'
            : '你的權限：可建立隊伍與編排隊員；刪除隊伍與移除隊員需超級管理員以上。';
    }

    setTeamMsg('');
    document.getElementById('teamModal')?.classList.remove('hidden');
    await loadTeams(item.id);
}

function closeTeamModal() {
    document.getElementById('teamModal')?.classList.add('hidden');
    currentTeamComp = null;
}

async function loadTeams(compId) {
    const unassignedEl = document.getElementById('unassignedList');
    const teamEl = document.getElementById('teamList');
    if (unassignedEl) unassignedEl.innerHTML = '<p class="text-xs text-slate-400">載入中…</p>';
    if (teamEl) teamEl.innerHTML = '';

    try {
        const res = await customFetch(`/api/competitions/${compId}/teams`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '載入報名名單失敗');
        renderTeams(data);
    } catch (err) {
        if (unassignedEl) unassignedEl.innerHTML = `<p class="text-xs text-red-600">${escapeHtml(err.message)}</p>`;
    }
}

function renderTeams(data) {
    const teams = data.teams || [];
    const unassigned = data.unassigned || [];
    const canDelete = !!data.canDelete;

    // ---------- v3.6.2：現場報到 ----------
    lastTeamsData = data;
    renderAttendanceSection(data);

    // ---------- v2.20.0：報名審核與候補 ----------
    renderReviewSection(data);

    const unassignedCountEl = document.getElementById('unassignedCount');
    const teamCountEl = document.getElementById('teamCount');
    if (unassignedCountEl) unassignedCountEl.innerText = String(unassigned.length);
    if (teamCountEl) teamCountEl.innerText = String(teams.length);

    const unassignedEl = document.getElementById('unassignedList');
    if (unassignedEl) {
        unassignedEl.innerHTML = unassigned.length === 0
            ? '<p class="text-xs text-slate-400">所有報名者都已編排完成 🎉</p>'
            : unassigned.map((r) => `
                <div class="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <p class="text-xs text-slate-700 truncate">🙋 ${escapeHtml(r.username)}${r.team_name ? ` <span class="text-slate-400">（自填：${escapeHtml(r.team_name)}）</span>` : ''}</p>
                    ${teams.length ? `<select data-action="assign-select" data-id="${r.id}"
                        class="text-xs border border-slate-300 rounded px-2 py-1 shrink-0">
                        <option value="">編入隊伍…</option>
                        ${teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}
                    </select>` : ''}
                </div>`).join('');
    }

    const teamEl = document.getElementById('teamList');
    if (teamEl) {
        teamEl.innerHTML = teams.length === 0
            ? '<p class="text-xs text-slate-400">還沒有任何隊伍，請先建立隊伍。</p>'
            : teams.map((t) => `
                <div class="border border-slate-200 rounded-lg">
                    <div class="flex items-center justify-between gap-2 bg-slate-50 px-3 py-2 rounded-t-lg">
                        <p class="text-sm font-bold text-slate-800">👥 ${escapeHtml(t.name)}
                            <span class="text-xs font-normal text-slate-500">（${t.members.length} 人）</span></p>
                        ${canDelete ? `<button data-action="delete-team" data-id="${t.id}"
                            class="text-xs text-red-600 hover:text-red-800 bg-red-50 hover:bg-red-100 px-2 py-1 rounded transition shrink-0">刪除隊伍</button>` : ''}
                    </div>
                    ${t.note ? `<p class="text-xs text-slate-500 px-3 pt-2">📝 ${escapeHtml(t.note)}</p>` : ''}
                    <div class="p-3 space-y-1.5">
                        ${t.members.length === 0 ? '<p class="text-xs text-slate-400">尚無隊員</p>' : t.members.map((m) => `
                            <div class="flex items-center justify-between gap-2">
                                <p class="text-xs text-slate-700 truncate">🙋 ${escapeHtml(m.username)}</p>
                                <div class="flex items-center gap-1 shrink-0">
                                    ${teams.length > 1 ? `<select data-action="move-member" data-id="${m.id}"
                                        class="text-xs border border-slate-300 rounded px-1.5 py-0.5">
                                        <option value="">移動至…</option>
                                        ${teams.filter((x) => String(x.id) !== String(t.id)).map((x) => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('')}
                                    </select>` : ''}
                                    ${canDelete ? `<button data-action="remove-member" data-id="${m.id}"
                                        class="text-xs text-red-600 hover:text-red-800 px-2 py-0.5 rounded hover:bg-red-50 transition">移出</button>` : ''}
                                </div>
                            </div>`).join('')}
                    </div>
                </div>`).join('');
    }
}

/* v3.6.2：現場報到（Roadmap 8.7 ⑤）
 *
 * 使用者定的方式：先由管理員在名單上勾選簽到（方案 C），所以這裡就是一張可搜尋的名單＋簽到鈕。
 * 現場名單只放「正取」——候補還沒拿到資格，簽到會讓名額對不上帳（後端也會擋）。
 * 另外提供「現場代報名」，讓沒線上報名的人當場加進來（名額上限仍然有效）。 */
let attendanceQuery = '';
let lastTeamsData = null;

function toggleOnsiteForm(show) {
    const form = document.getElementById('onsiteForm');
    if (!form) return;
    const willShow = typeof show === 'boolean' ? show : form.classList.contains('hidden');
    form.classList.toggle('hidden', !willShow);
    if (willShow) document.getElementById('onsiteName')?.focus();
}

function renderAttendanceSection(data) {
    const section = document.getElementById('attendanceSection');
    const listEl = document.getElementById('attendanceList');
    const summaryEl = document.getElementById('attendanceSummary');
    const hintEl = document.getElementById('attendanceHint');
    if (!section || !listEl) return;

    // 資料庫還沒跑 v3.6.2 migration → 整塊不出現（而不是顯示一個按了會失敗的介面）
    if (data.attendance_schema_ready === false) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');

    const approved = Array.isArray(data.approved) ? data.approved : [];
    const stats = data.attendance || { expected: approved.length, attended: 0, onsite: 0 };
    const missing = Math.max(0, stats.expected - stats.attended);
    if (summaryEl) {
        summaryEl.innerText = `已簽到 ${stats.attended}／應到 ${stats.expected}`
            + (stats.onsite ? `｜現場代報名 ${stats.onsite}` : '')
            + `｜未到 ${missing}`;
    }
    if (hintEl) {
        hintEl.classList.toggle('hidden', missing <= 0);
        hintEl.innerText = missing > 0 ? `還有 ${missing} 位正取尚未簽到（候補要簽到請先遞補為正取）` : '';
    }

    const q = attendanceQuery.trim().toLowerCase();
    const rows = q ? approved.filter((r) => String(r.username || '').toLowerCase().includes(q)) : approved;
    if (!rows.length) {
        listEl.innerHTML = `<p class="text-xs text-slate-500">${approved.length
            ? '沒有符合搜尋的參加者。'
            : '這場還沒有正取報名者，可用「➕ 現場代報名」臨時加人。'}</p>`;
        return;
    }
    listEl.innerHTML = rows.map((r) => {
        const checked = Boolean(r.attended_at);
        const time = checked ? String(r.attended_at).slice(11, 16) : '';
        return `
            <div class="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${checked ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200'}">
                <p class="text-xs text-slate-700 truncate">
                    ${checked ? '✅' : '⬜'} ${escapeHtml(r.username)}
                    ${r.onsite ? '<span class="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-1 ml-1">現場</span>' : ''}
                    ${r.team_name ? `<span class="text-[11px] text-slate-400 ml-1">（${escapeHtml(r.team_name)}）</span>` : ''}
                    ${checked ? `<span class="text-[11px] text-slate-500 ml-1">${time} ${escapeHtml(r.attended_by || '')}</span>` : ''}
                </p>
                <button data-action="${checked ? 'undo-check-in' : 'check-in'}" data-id="${r.id}"
                    class="text-xs shrink-0 px-2.5 py-1 rounded-lg border transition ${checked
                        ? 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                        : 'bg-blue-600 hover:bg-blue-700 text-white border-blue-600'}">
                    ${checked ? '取消簽到' : '簽到'}
                </button>
            </div>`;
    }).join('');
}

async function setAttendance(id, attended) {
    try {
        const res = await customFetch(`/api/registrations/${id}/attendance`, {
            method: 'POST',
            body: JSON.stringify({ attended })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '更新簽到狀態失敗');
        setTeamMsg(data.message || '已更新簽到狀態', 'success');
        if (currentTeamComp) await loadTeams(currentTeamComp.id);
    } catch (err) {
        setTeamMsg(err.message || '更新簽到狀態失敗', 'error');
    }
}

async function submitOnsiteRegistration() {
    if (!currentTeamComp) return;
    const nameEl = document.getElementById('onsiteName');
    const noteEl = document.getElementById('onsiteNote');
    const name = (nameEl && nameEl.value ? nameEl.value : '').trim();
    if (!name) return setTeamMsg('請填寫參加者姓名或帳號。', 'error');
    const btn = document.getElementById('onsiteSubmitBtn');
    try {
        if (btn) { btn.disabled = true; btn.textContent = '送出中…'; }
        const res = await customFetch(`/api/competitions/${currentTeamComp.id}/onsite-registration`, {
            method: 'POST',
            body: JSON.stringify({ username: name, note: (noteEl && noteEl.value ? noteEl.value : '').trim() })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '現場代報名失敗');
        if (nameEl) nameEl.value = '';
        if (noteEl) noteEl.value = '';
        toggleOnsiteForm(false);
        setTeamMsg(data.message || '已完成現場代報名', 'success');
        await loadTeams(currentTeamComp.id);
    } catch (err) {
        setTeamMsg(err.message || '現場代報名失敗', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '送出報名'; }
    }
}

/* v2.20.0：審核區塊（待審核名單＋候補順位＋遞補按鈕） */
function renderReviewSection(data) {
    const comp = currentTeamComp || {};
    const counts = data.counts || { confirmed: 0, pending: 0, waitlisted: 0, rejected: 0, slots: 0 };
    const schemaReady = data.schema_ready !== false;
    const max = Number(comp.max_registrations) || 0;

    const summaryEl = document.getElementById('reviewSummary');
    if (summaryEl) {
        if (!schemaReady) {
            summaryEl.className = 'text-xs p-2.5 rounded-lg border bg-amber-50 border-amber-200 text-amber-900';
            summaryEl.innerText = '⚠️ 資料庫尚未執行 v2.20.0 migration：報名審核與候補功能目前停用（報名一律直接核准）。';
        } else {
            const bits = [
                `佔名額 ${counts.slots}${max > 0 ? ` / ${max}` : '（不限）'} 人`,
                `已核准 ${counts.confirmed}`,
                `待審核 ${counts.pending}`,
                `候補 ${counts.waitlisted}`
            ];
            if (counts.rejected) bits.push(`未錄取 ${counts.rejected}`);
            bits.push(comp.requires_approval ? '⏳ 本賽事需審核' : '不需審核');
            bits.push(comp.waitlist_enabled ? '🕒 開放候補（取消自動遞補）' : '未開放候補');
            summaryEl.className = 'text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2';
            summaryEl.innerText = bits.join('｜');
        }
    }

    const pending = data.pending || [];
    const pendingSection = document.getElementById('pendingSection');
    const pendingList = document.getElementById('pendingList');
    const pendingCountEl = document.getElementById('pendingCount');
    if (pendingCountEl) pendingCountEl.innerText = String(pending.length);
    if (pendingSection) pendingSection.classList.toggle('hidden', !pending.length || !schemaReady);
    if (pendingList) {
        pendingList.innerHTML = pending.map((r) => `
            <div class="flex items-center justify-between gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <p class="text-xs text-slate-700 truncate">🙋 ${escapeHtml(r.username)}${r.team_name ? ` <span class="text-slate-400">（自填：${escapeHtml(r.team_name)}）</span>` : ''}
                    <span class="text-slate-400">｜${escapeHtml(String(r.created_at || '').slice(0, 10))} 報名</span></p>
                <div class="flex items-center gap-1 shrink-0">
                    <button data-action="review-reg" data-id="${r.id}" data-verdict="approve"
                        class="text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-medium px-2.5 py-1 rounded transition">✅ 核准</button>
                    <button data-action="review-reg" data-id="${r.id}" data-verdict="reject"
                        class="text-xs bg-rose-600 hover:bg-rose-700 text-white font-medium px-2.5 py-1 rounded transition">❌ 拒絕</button>
                </div>
            </div>`).join('');
    }

    const waitlisted = data.waitlisted || [];
    const waitlistSection = document.getElementById('waitlistSection');
    const waitlistList = document.getElementById('waitlistList');
    const waitlistCountEl = document.getElementById('waitlistCount');
    const reorderable = schemaReady && data.canReorderWaitlist !== false;
    if (waitlistCountEl) waitlistCountEl.innerText = String(waitlisted.length);
    if (waitlistSection) waitlistSection.classList.toggle('hidden', !waitlisted.length || !schemaReady);
    // v2.21.0：順位目前是手動排的還是自動排的（有任一筆帶 waitlist_order 就是手動排過）
    const manualOrdered = waitlisted.some((r) => Number(r.waitlist_order) > 0);
    const orderNoteEl = document.getElementById('waitlistOrderNote');
    if (orderNoteEl) {
        orderNoteEl.innerText = reorderable
            ? (manualOrdered ? '順位：管理員手動排定（新報名的人一律排到最後）' : '順位：依報名時間自動排序（可用 ⬆️⬇️ 手動調整）')
            : '順位：依報名時間自動排序（執行 v2.21.0 migration 後可手動調整）';
    }
    // v2.22.0：遞補通知開關（沒有 waitlist_notify 欄位時顯示為停用並說明）
    const notifyToggle = document.getElementById('waitlistNotifyToggle');
    const notifyNote = document.getElementById('waitlistNotifyNote');
    if (notifyToggle) {
        const notifyReady = data.notify_schema_ready !== false;
        notifyToggle.disabled = !notifyReady;
        notifyToggle.checked = data.notify_on_promote !== false;
        if (notifyNote) {
            notifyNote.innerText = !notifyReady
                ? '遞補通知設定需要先執行 v2.22.0 migration（目前一律通知）'
                : (notifyToggle.checked ? '遞補時推播通知對方' : '遞補時不通知（遞補仍然生效，只是不推播）');
        }
    }

    // v2.21.0：名額已滿時不能遞補（後端也會擋，前端先講清楚避免白按）
    const canPromote = max === 0 || counts.slots < max;
    if (waitlistList) {
        // v2.22.0：拖拉排序要知道這份名單現在可不可以手動排（pointerdown 時會檢查）
        waitlistList.dataset.reorderable = reorderable ? '1' : '0';
        // v2.23.0：重繪＝重新開始（勾選狀態不會留著，避免管理員對著舊勾選按下去）
        setWaitlistBatchBar(0, waitlisted.length);
        waitlistList.innerHTML = waitlisted.map((r, i) => `
            <div data-waitlist-id="${r.id}" class="flex items-center justify-between gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                <div class="flex items-center gap-1 flex-1 min-w-0">
                    ${reorderable ? `<input type="checkbox" data-action="waitlist-select" data-id="${r.id}"
                        class="w-4 h-4 shrink-0" title="勾選後可以一次搬多筆">` : ''}
                <p class="text-xs text-slate-700 truncate flex-1">
                    ${reorderable ? `<span data-waitlist-handle="1" class="cm-drag-handle text-slate-400 mr-1" title="按住拖曳就能調整順位">⠿</span>` : ''}
                    <span class="font-bold text-blue-700">第 ${r.waitlist_position} 位</span>　🙋 ${escapeHtml(r.username)}
                    <span class="text-slate-400">｜${escapeHtml(String(r.created_at || '').slice(0, 16).replace('T', ' '))}</span></p>
                </div>
                <div class="flex items-center justify-end gap-1 shrink-0 flex-wrap">
                    ${reorderable ? `
                    <select data-action="waitlist-jump" data-id="${r.id}" title="搬到指定順位"
                        class="text-[11px] bg-white border border-blue-200 text-blue-700 rounded px-1 py-1">
                        ${waitlisted.map((_, k) => `<option value="${k + 1}" ${k === i ? 'selected' : ''}>第 ${k + 1} 位</option>`).join('')}
                    </select>
                    <button data-action="waitlist-move" data-id="${r.id}" data-dir="up" ${i === 0 ? 'disabled' : ''}
                        class="text-xs px-2 py-1 rounded transition ${i === 0 ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white border border-blue-200 text-blue-700 hover:bg-blue-100'}"
                        title="往前一位">↑</button>
                    <button data-action="waitlist-move" data-id="${r.id}" data-dir="down" ${i === waitlisted.length - 1 ? 'disabled' : ''}
                        class="text-xs px-2 py-1 rounded transition ${i === waitlisted.length - 1 ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white border border-blue-200 text-blue-700 hover:bg-blue-100'}"
                        title="往後一位">↓</button>` : ''}
                    <button data-action="promote-reg" data-id="${r.id}" data-username="${escapeHtml(r.username)}" ${canPromote ? '' : 'disabled'}
                        class="${canPromote
                            ? 'text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-medium px-2.5 py-1 rounded transition'
                            : 'text-xs bg-slate-100 text-slate-400 font-medium px-2.5 py-1 rounded transition cursor-not-allowed'}"
                        title="${canPromote ? '跳過前面的人，直接遞補這一位' : '名額已滿：請先取消或拒絕其他報名'}">⬆️ 遞補</button>
                </div>
            </div>`).join('');
    }

    const promoteBtn = document.getElementById('promoteWaitlistBtn');
    if (promoteBtn) {
        const usable = schemaReady && waitlisted.length > 0 && canPromote;
        promoteBtn.disabled = !usable;
        promoteBtn.className = usable
            ? 'text-xs bg-blue-600 hover:bg-blue-700 text-white font-medium px-3 py-1.5 rounded-lg transition shrink-0'
            : 'text-xs bg-slate-100 text-slate-400 font-medium px-3 py-1.5 rounded-lg transition shrink-0 cursor-not-allowed';
        promoteBtn.title = usable ? '' : (max > 0 && counts.slots >= max ? '名額已滿：請先取消或拒絕其他報名' : '目前沒有可遞補的候補');
    }
}

/* 審核一筆報名（管理員以上） */
async function reviewRegistration(id, verdict) {
    if (!isAdminUser()) return alert('權限不足：只有管理員以上可以審核報名');
    let note = '';
    if (verdict === 'reject') {
        note = window.prompt('拒絕原因（選填，會顯示在稽核日誌）', '') || '';
    } else if (!window.confirm('確定要核准這筆報名嗎？')) {
        return;
    }

    try {
        const res = await customFetch(`/api/registrations/${id}/review`, {
            method: 'POST',
            body: JSON.stringify({ action: verdict === 'reject' ? 'reject' : 'approve', note })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '審核失敗');
        setTeamMsg(`${data.message}${data.notified ? `（已推播通知 ${data.notified} 個裝置）` : '（對方沒有推播訂閱，未通知）'}`, 'success');
        if (currentTeamComp) await loadTeams(currentTeamComp.id);
        await fetchMyRegistrations().catch(() => {});
    } catch (err) {
        setTeamMsg(err.message, 'error');
    }
}

/* 手動遞補下一位候補（管理員以上） */
async function promoteWaitlist() {
    const comp = currentTeamComp;
    if (!comp) return;
    if (!isAdminUser()) return alert('權限不足：只有管理員以上可以遞補候補');
    if (!window.confirm('確定要遞補下一位候補嗎？（會立即通知對方）')) return;

    try {
        const res = await customFetch(`/api/competitions/${comp.id}/registrations/promote`, { method: 'POST', body: JSON.stringify({}) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '遞補失敗');
        setTeamMsg(`${data.message}（狀態：${data.status_label}）${data.notified ? `，已推播通知 ${data.notified} 個裝置` : '，對方沒有推播訂閱'}`, 'success');
        await loadTeams(comp.id);
    } catch (err) {
        setTeamMsg(err.message, 'error');
    }
}

/* v2.21.0：指定遞補某人（不照順位） */
async function promoteWaitlistMember(id, username) {
    if (!isAdminUser()) return alert('權限不足：只有管理員以上可以遞補候補');
    if (!window.confirm(`確定要指定遞補「${username}」嗎？\n\n這會跳過排在前面的候補（名額不足時會被拒絕）。`)) return;

    try {
        const res = await customFetch(`/api/registrations/${id}/promote`, { method: 'POST', body: JSON.stringify({}) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '遞補失敗');
        setTeamMsg(`${data.message}（狀態：${data.status_label}）${data.notified ? `，已推播通知 ${data.notified} 個裝置` : '，對方沒有推播訂閱'}`, 'success');
        if (currentTeamComp) await loadTeams(currentTeamComp.id);
        await fetchMyRegistrations().catch(() => {});
    } catch (err) {
        setTeamMsg(err.message, 'error');
    }
}

/* v2.22.0：候補順位的四條路（↑、↓、移到第 N 位、拖拉）都走這一支送出，
   差別只在「怎麼算出新的順序」。送出的一定是完整順序，後端會驗證名單是否一致。 */
async function sendWaitlistOrder(ids, okMsg) {
    const comp = currentTeamComp;
    if (!comp) return;
    if (!isAdminUser()) return alert('權限不足：只有管理員以上可以調整候補順位');

    try {
        const res = await customFetch(`/api/competitions/${comp.id}/waitlist/reorder`, {
            method: 'POST',
            body: JSON.stringify({ order: ids })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '調整失敗');
        await loadTeams(comp.id);
        setTeamMsg(okMsg || '已更新候補順位（新報名的人一律排到最後）', 'success');
    } catch (err) {
        setTeamMsg(err.message, 'error');
        // 失敗最常見的原因是名單已經被別人改過 → 把畫面拉回真實狀態，避免管理員對著舊名單繼續操作
        await loadTeams(comp.id);
    }
}

/* 畫面上目前的候補順序（DOM 順序就是後端算出來的順位） */
function waitlistIdsFromDom() {
    return Array.from(document.querySelectorAll('#waitlistList [data-waitlist-id]'))
        .map((el) => el.getAttribute('data-waitlist-id'));
}

/* v2.21.0：與隔壁那筆對調 */
async function moveWaitlist(id, dir) {
    const ids = waitlistIdsFromDom();
    const from = ids.indexOf(String(id));
    const to = dir === 'up' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= ids.length) return;
    return sendWaitlistOrder(CMCompetitionState.moveInQueue(ids, id, to), '已更新候補順位（新報名的人一律排到最後）');
}

/* v2.22.0：一次搬到指定順位（下拉選單；想搬多遠就搬多遠，不用連按 ↑／↓） */
async function jumpWaitlist(id, position) {
    const ids = waitlistIdsFromDom();
    const next = CMCompetitionState.moveInQueue(ids, id, Number(position) - 1);
    if (!next) return;
    if (next.join(',') === ids.join(',')) {
        setTeamMsg('這一筆已經在那個順位了', 'success');
        return;
    }
    return sendWaitlistOrder(next, `已更新候補順位（這一筆搬到第 ${position} 位）`);
}

/* v2.23.0：批次搬移——勾選多筆後一次搬到指定位置（搬完相對順序不變） */
function waitlistSelectedIds() {
    return Array.from(document.querySelectorAll('#waitlistList input[data-action="waitlist-select"]:checked'))
        .map((el) => el.getAttribute('data-id'));
}

/* 勾選數量與「搬到第幾位」的選項：一次搬 N 筆時，最晚只能放到「人數 − N + 1」 */
function setWaitlistBatchBar(count, total) {
    const bar = document.getElementById('waitlistBatchBar');
    const countEl = document.getElementById('waitlistSelectedCount');
    const target = document.getElementById('waitlistBatchTarget');
    if (countEl) countEl.innerText = String(count);
    if (bar) bar.classList.toggle('hidden', !count);
    if (!target) return;
    const last = Math.max(1, (Number(total) || 0) - (Number(count) || 0) + 1);
    const keep = target.value;
    target.innerHTML = Array.from({ length: last }, (_, i) => `<option value="${i + 1}">第 ${i + 1} 位</option>`).join('');
    if (keep && Number(keep) <= last) target.value = keep;
}

async function moveSelectedWaitlist(target) {
    const ids = waitlistIdsFromDom();
    const selected = waitlistSelectedIds();
    if (!selected.length) return setTeamMsg('請先勾選要搬動的候補者', 'error');
    const next = CMCompetitionState.moveGroup(ids, selected, Number(target) || 1);
    if (!next) return setTeamMsg('名單已變動，請重新整理後再選一次', 'error');
    return sendWaitlistOrder(next, `已把選取的 ${selected.length} 筆一起搬到第 ${target} 位`);
}

/* v2.22.0：遞補時要不要通知（每個賽事自己決定；關掉時遞補照常生效，只是不推播） */
async function toggleWaitlistNotify(checked) {
    const comp = currentTeamComp;
    if (!comp) return;
    if (!isAdminUser()) return alert('權限不足：只有管理員以上可以調整遞補通知設定');

    try {
        const res = await customFetch(`/api/competitions/${comp.id}/waitlist/notify`, {
            method: 'POST',
            body: JSON.stringify({ notify: !!checked })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '設定失敗');
        setTeamMsg(data.message || '已更新遞補通知設定', 'success');
        await loadTeams(comp.id);
    } catch (err) {
        setTeamMsg(err.message, 'error');
        await loadTeams(comp.id);   // 失敗時把勾選狀態還原成資料庫的實際值
    }
}

/* v2.22.0：候補與審核的異動紀錄（調整順位、遞補、審核、取消都在這裡） */
const waitlistHistoryState = { offset: 0, loaded: 0 };

const waitlistHistoryRowHtml = (l) => `
    <div class="text-[11px] text-slate-600 border-b border-slate-100 py-1">
        <span class="text-slate-400">${escapeHtml(String(l.at || '').slice(0, 16).replace('T', ' '))}</span>
        ｜<span class="font-medium text-slate-700">${escapeHtml(l.action_label || l.action || '')}</span>
        <span class="text-slate-400">（${escapeHtml(l.user || '系統')}）</span>
        <div class="truncate" title="${escapeHtml(l.details || '')}">${escapeHtml(l.details || '')}</div>
    </div>`;

async function loadWaitlistHistory(reset) {
    const comp = currentTeamComp;
    if (!comp) return;
    const panel = document.getElementById('waitlistHistoryPanel');
    const list = document.getElementById('waitlistHistoryList');
    const moreBtn = document.getElementById('waitlistHistoryMore');
    const note = document.getElementById('waitlistHistoryNote');
    if (!panel || !list) return;

    const isReset = reset !== false;
    const offset = isReset ? 0 : waitlistHistoryState.offset;
    try {
        const res = await customFetch(`/api/competitions/${comp.id}/waitlist/history?limit=30&offset=${offset}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '讀取異動紀錄失敗');

        const logs = data.logs || [];
        const html = logs.map(waitlistHistoryRowHtml).join('');
        if (isReset) {
            list.innerHTML = html || '<p class="text-[11px] text-slate-500">目前沒有候補相關的異動紀錄（調整順位、遞補、審核、取消報名都會記在這裡）。</p>';
            waitlistHistoryState.loaded = logs.length;
        } else {
            list.insertAdjacentHTML('beforeend', html);
            waitlistHistoryState.loaded += logs.length;
        }
        waitlistHistoryState.offset = offset + logs.length;

        if (note) {
            note.innerText = data.capped
                ? `已顯示 ${waitlistHistoryState.loaded} 筆（達 500 筆上限，更早的紀錄請到稽核日誌頁篩選）`
                : (data.has_more ? `已顯示 ${waitlistHistoryState.loaded} 筆` : `已顯示全部 ${waitlistHistoryState.loaded} 筆`);
        }
        if (moreBtn) moreBtn.classList.toggle('hidden', !data.has_more);
        panel.classList.remove('hidden');
    } catch (err) {
        setTeamMsg(err.message, 'error');
    }
}

/* v2.22.0：拖拉排序（pointer 事件，手機也能用；不用 HTML5 drag and drop 也不用外部套件）
   - 只有拖曳把手（⠿）會啟動，避免跟「點列選取」「捲動」衝突
   - 拖動時只動畫面，放開才送出一次 API（成敗都靠後端驗證） */
const waitlistDrag = { row: null, moved: false };

function initWaitlistDrag() {
    const list = document.getElementById('waitlistList');
    if (!list) return;

    list.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest('[data-waitlist-handle]');
        if (!handle) return;
        if (!isAdminUser()) return;
        if (list.dataset.reorderable !== '1') return;
        const row = handle.closest('[data-waitlist-id]');
        if (!row) return;
        waitlistDrag.row = row;
        waitlistDrag.moved = false;
        row.classList.add('cm-dragging');
        if (e.cancelable) e.preventDefault();
    });

    document.addEventListener('pointermove', (e) => {
        if (!waitlistDrag.row) return;
        if (e.cancelable) e.preventDefault();
        const rows = Array.from(list.querySelectorAll('[data-waitlist-id]'));
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const over = el && el.closest ? el.closest('#waitlistList [data-waitlist-id]') : null;
        if (over && over !== waitlistDrag.row) {
            const overIdx = rows.indexOf(over);
            const dragIdx = rows.indexOf(waitlistDrag.row);
            if (overIdx < dragIdx) list.insertBefore(waitlistDrag.row, over);
            else list.insertBefore(waitlistDrag.row, over.nextSibling);
            waitlistDrag.moved = true;
        }
    }, { passive: false });

    const finish = async () => {
        if (!waitlistDrag.row) return;
        const row = waitlistDrag.row;
        const moved = waitlistDrag.moved;
        waitlistDrag.row = null;
        waitlistDrag.moved = false;
        row.classList.remove('cm-dragging');
        if (!moved) return;   // 只是按一下把手就不送 API
        const ids = Array.from(list.querySelectorAll('[data-waitlist-id]')).map((el) => el.getAttribute('data-waitlist-id'));
        await sendWaitlistOrder(ids, '已用拖拉調整候補順位');
    };
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
}

async function createTeam() {
    const comp = currentTeamComp;
    if (!comp) return;

    const name = (document.getElementById('newTeamName').value || '').trim();
    const note = (document.getElementById('newTeamNote').value || '').trim();
    if (!name) return setTeamMsg('請輸入隊伍名稱', 'error');

    try {
        const res = await customFetch(`/api/competitions/${comp.id}/teams`, {
            method: 'POST',
            body: JSON.stringify({ name, note })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '建立隊伍失敗');

        document.getElementById('newTeamName').value = '';
        document.getElementById('newTeamNote').value = '';
        setTeamMsg(data.message || '隊伍已建立', 'success');
        await loadTeams(comp.id);
    } catch (err) {
        setTeamMsg(err.message, 'error');
    }
}

async function assignTeamMember(regId, teamId) {
    if (!regId || !teamId) return;
    try {
        const res = await customFetch(`/api/teams/${teamId}/members`, {
            method: 'POST',
            body: JSON.stringify({ registrationId: regId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '編排失敗');
        setTeamMsg(data.message || '已編排', 'success');
        if (currentTeamComp) await loadTeams(currentTeamComp.id);
    } catch (err) {
        setTeamMsg(err.message, 'error');
        if (currentTeamComp) await loadTeams(currentTeamComp.id);
    }
}

async function removeTeamMember(regId) {
    const comp = currentTeamComp;
    if (!comp || !regId) return;
    if (!confirm('確定要將這位報名者移出隊伍嗎？')) return;

    try {
        const res = await customFetch(`/api/teams/${comp.id}/members/${regId}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '移除失敗');
        setTeamMsg(data.message || '已移出隊伍', 'success');
        await loadTeams(comp.id);
    } catch (err) {
        setTeamMsg(err.message, 'error');
    }
}

async function deleteTeam(teamId) {
    const comp = currentTeamComp;
    if (!comp || !teamId) return;
    if (!confirm('確定要刪除這個隊伍嗎？隊員會回到未編排狀態（報名紀錄保留）。')) return;

    try {
        const res = await customFetch(`/api/teams/${teamId}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '刪除失敗');
        setTeamMsg(data.message || '隊伍已刪除', 'success');
        await loadTeams(comp.id);
    } catch (err) {
        setTeamMsg(err.message, 'error');
    }
}

/* ==========================================
   通知設定 (v2.8.0)
   - 純本機提醒：設定與訂閱只存在這台裝置的 localStorage。
   - 實際判斷邏輯在 public/js/notify.js（純函式，另有單元測試）。
   ========================================== */
let pendingSubscribeId = null;
let notifyWatcher = null;

function isSubscribed(id) {
    return !!(window.CMNotify && CMNotify.isSubscribed(id));
}

// iOS Safari 的推播指引（必須「加入主畫面」後以 App 方式開啟）
function renderIosPushInstructions() {
    const hint = document.getElementById('pushIosHint');
    if (!hint) return;
    hint.innerHTML = `
        <p class="font-bold">📲 iPhone / iPad 需要多一個步驟</p>
        <p>Safari 分頁不支援推播，請把本站加入主畫面後，從主畫面開啟：</p>
        <ol class="list-decimal ml-4 space-y-0.5">
            <li>用 <b>Safari</b> 開啟本站</li>
            <li>點畫面下方（或上方）的「<b>分享</b>」圖示 <span aria-hidden="true">⬆️</span></li>
            <li>選擇「<b>加入主畫面</b>」，名稱按「新增」</li>
            <li>回主畫面點開剛新增的圖示（<b>比賽管理</b>）</li>
            <li>在選單 → 🔔 通知設定 → 點「📲 開啟推播訂閱」</li>
        </ol>
        <p class="text-[11px]">※ 需 iOS 16.4 以上；加入主畫面後推播才能像 App 一樣在關閉網頁時送達。</p>`;
    hint.classList.remove('hidden');
}

async function refreshPushStatus() {
    const el = document.getElementById('pushStatus');
    if (!el) return;
    const notes = window.CMNotify;
    const hint = document.getElementById('pushIosHint');
    const state = (notes && notes.pushSupportState)
        ? notes.pushSupportState()
        : { level: (notes && notes.pushSupported && notes.pushSupported()) ? 'ok' : 'unsupported', canSubscribe: !!(notes && notes.pushSupported && notes.pushSupported()) };

    const showIosHint = state.level === 'ios-needs-homescreen';
    if (showIosHint) renderIosPushInstructions();
    else hint?.classList.add('hidden');

    if (state.level === 'ios-needs-homescreen') {
        el.className = 'text-xs p-2.5 rounded-lg border bg-amber-50 border-amber-300 text-amber-900';
        el.innerText = 'iOS 需先「加入主畫面」再從主畫面開啟，才能開啟推播訂閱（詳見下方步驟）。';
        document.getElementById('pushSubscribeBtn')?.setAttribute('disabled', 'disabled');
        document.getElementById('pushUnsubscribeBtn')?.setAttribute('disabled', 'disabled');
        document.getElementById('pushTestBtn')?.removeAttribute('disabled');
        return;
    }

    if (state.level === 'denied') {
        el.className = 'text-xs p-2.5 rounded-lg border bg-red-50 border-red-200 text-red-700';
        el.innerText = '通知權限已被拒絕：請到瀏覽器／系統設定把本站的通知改為「允許」後再試。';
        ['pushSubscribeBtn', 'pushUnsubscribeBtn'].forEach((id) => document.getElementById(id)?.setAttribute('disabled', 'disabled'));
        document.getElementById('pushTestBtn')?.removeAttribute('disabled');
        return;
    }

    if (!state.canSubscribe) {
        el.className = 'text-xs p-2.5 rounded-lg border bg-slate-50 border-slate-200 text-slate-500';
        el.innerText = '此瀏覽器不支援推播訂閱（需要 HTTPS 與支援 Push 的瀏覽器）。';
        ['pushSubscribeBtn', 'pushTestBtn', 'pushUnsubscribeBtn'].forEach((id) => {
            document.getElementById(id)?.setAttribute('disabled', 'disabled');
        });
        return;
    }
    ['pushSubscribeBtn', 'pushTestBtn', 'pushUnsubscribeBtn'].forEach((id) => {
        document.getElementById(id)?.removeAttribute('disabled');
    });
    try {
        const subscription = await notes.currentSubscription();
        if (subscription) {
            el.className = 'text-xs p-2.5 rounded-lg border bg-emerald-50 border-emerald-200 text-emerald-700';
            el.innerText = '✅ 已開啟推播訂閱：即使完全關閉網頁，也能收到新賽事與開賽提醒。';
        } else {
            el.className = 'text-xs p-2.5 rounded-lg border bg-slate-50 border-slate-200 text-slate-600';
            el.innerText = '尚未開啟推播訂閱（未開啟時，提醒只在網頁開啟時跳出）。';
        }
    } catch (err) {
        el.className = 'text-xs p-2.5 rounded-lg border bg-amber-50 border-amber-200 text-amber-700';
        el.innerText = '無法取得推播狀態：' + err.message;
    }
}

async function handlePushSubscribe() {
    const notes = window.CMNotify;
    if (!notes) return;
    try {
        await notes.subscribe();
        await refreshPushStatus();
        notifyWatcher && notifyWatcher.tick();
        alert('已開啟推播訂閱！之後即使關閉網頁，也能收到新賽事與開賽提醒。');
    } catch (err) {
        alert('訂閱失敗：' + err.message);
    }
}

async function handlePushUnsubscribe() {
    const notes = window.CMNotify;
    if (!notes) return;
    if (!confirm('確定要關閉這台裝置的推播訂閱嗎？')) return;
    try {
        const result = await notes.unsubscribe();
        await refreshPushStatus();
        alert(result.removed ? '已關閉推播訂閱' : '這台裝置目前沒有推播訂閱');
    } catch (err) {
        alert('關閉失敗：' + err.message);
    }
}

async function handlePushTest() {
    const notes = window.CMNotify;
    if (!notes) return;
    try {
        const data = await notes.testPush();
        alert(data.message || '測試推播已送出');
    } catch (err) {
        alert('測試失敗：' + err.message);
    }
}

/* ==========================================
   v2.10.0：海報上傳（發佈者手動上傳，取代自動生成）
   ========================================== */
let pendingPoster = null;

// 前端先縮圖（最長邊 1600px、JPEG 0.85），避免上傳過大檔案
function resizeImageFile(file) {
    return new Promise((resolve, reject) => {
        if (!file) return reject(new Error('沒有選擇檔案'));
        if (!/^image\/(jpeg|png|webp)$/.test(file.type || '')) {
            return reject(new Error('只支援 JPG、PNG 或 WebP 圖片'));
        }
        if (file.size > 8 * 1024 * 1024) return reject(new Error('原始圖片過大（上限 8MB）'));

        const reader = new FileReader();
        reader.onerror = () => reject(new Error('讀取檔案失敗'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('無法解讀圖片內容'));
            img.onload = () => {
                const limit = 1600;
                const scale = Math.min(1, limit / Math.max(img.width, img.height));
                const width = Math.max(1, Math.round(img.width * scale));
                const height = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

                // v3.0.0：另外產生列表／預覽用的縮圖（最寬 480px）。
                // 縮圖只是「讓列表少載很多」，所以失敗就當作沒有縮圖，不要讓整個上傳失敗。
                let thumbDataUrl = null;
                let thumbWidth = 0;
                let thumbHeight = 0;
                try {
                    const thumbLimit = 480;
                    const tScale = Math.min(1, thumbLimit / Math.max(width, height));
                    thumbWidth = Math.max(1, Math.round(width * tScale));
                    thumbHeight = Math.max(1, Math.round(height * tScale));
                    const tCanvas = document.createElement('canvas');
                    tCanvas.width = thumbWidth;
                    tCanvas.height = thumbHeight;
                    const tCtx = tCanvas.getContext('2d');
                    tCtx.fillStyle = '#ffffff';
                    tCtx.fillRect(0, 0, thumbWidth, thumbHeight);
                    tCtx.drawImage(img, 0, 0, thumbWidth, thumbHeight);
                    thumbDataUrl = tCanvas.toDataURL('image/jpeg', 0.72);
                } catch (err) {
                    thumbDataUrl = null;
                }

                const bytes = Math.round(((dataUrl.length - 22) * 3) / 4);
                const thumbBytes = thumbDataUrl ? Math.round(((thumbDataUrl.length - 22) * 3) / 4) : 0;
                resolve({ dataUrl, width, height, bytes, thumbDataUrl, thumbWidth, thumbHeight, thumbBytes });
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function setPosterHint(message, type) {
    const el = document.getElementById('posterHint');
    if (!el) return;
    el.classList.remove('text-red-600', 'text-emerald-700');
    if (!message) {
        el.textContent = '支援 JPG／PNG／WebP，會自動縮圖後上傳（上限 3MB）。未上傳時，分享海報會用自動生成的款式。';
        return;
    }
    el.textContent = message;
    el.classList.add(type === 'error' ? 'text-red-600' : 'text-emerald-700');
}

function showCurrentPoster(item) {
    const preview = document.getElementById('posterPreview');
    const removeBtn = document.getElementById('posterRemoveBtn');
    if (!preview) return;
    const has = !!(item && item.poster_updated_at);
    if (has) {
        preview.src = `/api/competitions/${item.id}/poster?v=${Date.parse(item.poster_updated_at) || Date.now()}`;
        preview.classList.remove('hidden');
        removeBtn?.classList.remove('hidden');
        setPosterHint('目前已使用手動上傳的海報，重新選擇檔案即可取代。', 'ok');
    } else {
        preview.removeAttribute('src');
        preview.classList.add('hidden');
        removeBtn?.classList.add('hidden');
        setPosterHint(null);
    }
}

function clearPendingPoster() {
    pendingPoster = null;
    const file = document.getElementById('posterFile');
    if (file) file.value = '';
    const preview = document.getElementById('posterPreview');
    if (preview) {
        preview.removeAttribute('src');
        preview.classList.add('hidden');
    }
    document.getElementById('posterRemoveBtn')?.classList.add('hidden');
    setPosterHint(null);
}

async function handlePosterFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    setPosterHint('圖片處理中…');
    try {
        const result = await resizeImageFile(file);
        if (result.bytes > 3 * 1024 * 1024) throw new Error('縮圖後仍超過 3MB，請改用較小的圖片');
        pendingPoster = result;
        const preview = document.getElementById('posterPreview');
        if (preview) {
            preview.src = result.dataUrl;
            preview.classList.remove('hidden');
        }
        document.getElementById('posterRemoveBtn')?.classList.remove('hidden');
        const thumbNote = result.thumbDataUrl
            ? `，另存列表縮圖 ${result.thumbWidth}×${result.thumbHeight}（約 ${Math.round(result.thumbBytes / 1024)}KB）`
            : '';
        setPosterHint(`已選擇 ${file.name}（縮圖後 ${result.width}×${result.height}，約 ${Math.round(result.bytes / 1024)}KB${thumbNote}），儲存賽事時會一併上傳。`, 'ok');
    } catch (err) {
        pendingPoster = null;
        setPosterHint(err.message, 'error');
        event.target.value = '';
    }
}

async function uploadPoster(competitionId, dataUrl, thumbDataUrl) {
    // v3.0.0：連同縮圖一起上傳（沒有縮圖時只送原圖，後端會自動清掉舊縮圖）
    const res = await customFetch(`/api/competitions/${competitionId}/poster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(thumbDataUrl ? { dataUrl, thumbDataUrl } : { dataUrl })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '海報上傳失敗');
    return data;
}

/* ---------- v3.3.0（P1-6）：賽事規程 PDF 附件 ----------
   規則與海報一致：檔案以 base64 送到後端存進資料庫、由同源 API 提供，
   CSP 不用放寬，也不需要外部物件儲存。差別是規程「公開給所有人看」，
   而且不跟表單一起儲存——選好檔案按「上傳規程」就立刻生效，
   管理員不必為了換一份規程再存一次賽事資料。 */
const DOC_MAX_BYTES = 3 * 1024 * 1024;
let pendingDocFile = null;

function setDocHint(message, type) {
    const el = document.getElementById('docHint');
    if (!el) return;
    el.classList.remove('text-red-600', 'text-emerald-700');
    if (!message) {
        el.textContent = 'PDF 檔，上限 3MB。上傳後賽事卡片會出現「📘 規程」按鈕，任何人都能打開（現場與家長都看得到）。';
        return;
    }
    el.textContent = message;
    el.classList.add(type === 'error' ? 'text-red-600' : 'text-emerald-700');
}

function resetDocUi() {
    pendingDocFile = null;
    const file = document.getElementById('docFile');
    if (file) file.value = '';
    const label = document.getElementById('docLabel');
    if (label) label.value = '';
    document.getElementById('docUploadBtn')?.classList.add('hidden');
    document.getElementById('docRemoveBtn')?.classList.add('hidden');
    setDocHint('賽事發佈後，可在這裡上傳規程 PDF。');
}

function showCurrentDoc(item) {
    if (!item) return resetDocUi();
    pendingDocFile = null;
    const file = document.getElementById('docFile');
    if (file) file.value = '';
    const label = document.getElementById('docLabel');
    if (label) label.value = item.doc_label || '';
    document.getElementById('docUploadBtn')?.classList.add('hidden');
    if (item.doc_url) {
        document.getElementById('docRemoveBtn')?.classList.remove('hidden');
        const kb = Math.round((Number(item.doc_bytes) || 0) / 1024);
        setDocHint(`目前附件：「${item.doc_label || '賽事規程'}」（${kb}KB）。重新選擇檔案即可取代。`, 'ok');
    } else {
        document.getElementById('docRemoveBtn')?.classList.add('hidden');
        setDocHint(null);
    }
}

function handleDocFileChange(event) {
    const file = event.target.files && event.target.files[0];
    const uploadBtn = document.getElementById('docUploadBtn');
    if (!file) {
        pendingDocFile = null;
        uploadBtn?.classList.add('hidden');
        return;
    }
    const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!looksPdf) {
        pendingDocFile = null;
        event.target.value = '';
        uploadBtn?.classList.add('hidden');
        setDocHint('請選擇 PDF 檔（.pdf）', 'error');
        return;
    }
    if (file.size > DOC_MAX_BYTES) {
        const mb = (file.size / 1024 / 1024).toFixed(1);
        pendingDocFile = null;
        event.target.value = '';
        uploadBtn?.classList.add('hidden');
        setDocHint(`檔案 ${mb}MB 超過 3MB 上限，請先壓縮再上傳`, 'error');
        return;
    }
    pendingDocFile = file;
    uploadBtn?.classList.remove('hidden');
    setDocHint(`已選擇 ${file.name}（${Math.round(file.size / 1024)}KB），按「上傳規程」送出。`, 'ok');
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('讀取檔案失敗'));
        reader.readAsDataURL(file);
    });
}

async function uploadDoc() {
    const editingId = document.getElementById('editingId').value;
    if (!editingId) return alert('請先發佈賽事，再上傳規程');
    if (!pendingDocFile) return alert('請先選擇 PDF 檔');
    const btn = document.getElementById('docUploadBtn');
    const labelInput = document.getElementById('docLabel');
    if (btn) { btn.disabled = true; btn.textContent = '上傳中…'; }
    try {
        const dataUrl = await readFileAsDataUrl(pendingDocFile);
        const res = await customFetch(`/api/competitions/${editingId}/doc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl, label: labelInput ? labelInput.value.trim() : '' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '規程上傳失敗');
        await fetchCompetitions();
        showCurrentDoc(allCompetitions.find((c) => String(c.id) === String(editingId)));
        setDocHint(data.message || '規程已上傳', 'ok');
    } catch (err) {
        setDocHint(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '上傳規程'; }
    }
}

async function removeDoc() {
    const editingId = document.getElementById('editingId').value;
    if (!editingId) return;
    if (!confirm('確定要移除這場賽事的規程附件嗎？')) return;
    try {
        const res = await customFetch(`/api/competitions/${editingId}/doc`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '移除失敗');
        await fetchCompetitions();
        showCurrentDoc(allCompetitions.find((c) => String(c.id) === String(editingId)));
        alert(data.message || '已移除規程附件');
    } catch (err) {
        setDocHint(err.message, 'error');
    }
}

async function handlePosterRemove() {
    const editingId = document.getElementById('editingId').value;
    const item = allCompetitions.find((c) => String(c.id) === String(editingId));

    // 只是取消這次選擇（尚未儲存）
    if (pendingPoster || !editingId || !(item && item.poster_updated_at)) {
        clearPendingPoster();
        if (item && item.poster_updated_at) showCurrentPoster(item);
        else setPosterHint('已取消選擇的海報。');
        return;
    }

    if (!confirm('確定要移除此賽事的手動海報嗎？（分享將改回自動生成海報）')) return;
    try {
        const res = await customFetch(`/api/competitions/${editingId}/poster`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '移除失敗');
        if (item) delete item.poster_updated_at;
        clearPendingPoster();
        fetchCompetitions();
        alert(data.message || '已移除手動海報');
    } catch (err) {
        setPosterHint(err.message, 'error');
    }
}

function openNotifyModal() {
    closeNavDropdown();
    renderNotifyModal();
    document.getElementById('notifyModal')?.classList.remove('hidden');
}

function closeNotifyModal() {
    document.getElementById('notifyModal')?.classList.add('hidden');
    pendingSubscribeId = null;
}

function renderNotifyModal() {
    if (!window.CMNotify) return;

    const state = CMNotify.loadState();
    const perm = CMNotify.permissionState();

    const statusEl = document.getElementById('notifyStatus');
    if (statusEl) {
        const map = {
            granted: ['bg-emerald-50 border-emerald-200 text-emerald-700', '✅ 通知已啟用，賽事提醒會以系統通知顯示。'],
            denied: ['bg-red-50 border-red-200 text-red-700', '🚫 通知權限被封鎖。請點網址列左側的鎖頭圖示 → 將「通知」改為允許，再重新載入頁面。'],
            default: ['bg-blue-50 border-blue-200 text-blue-700', 'ℹ️ 尚未開啟通知。按「啟用」後，瀏覽器會詢問是否允許。'],
            unsupported: ['bg-slate-100 border-slate-200 text-slate-600', '⚠️ 此瀏覽器不支援通知功能。'],
            error: ['bg-amber-50 border-amber-200 text-amber-700', '⚠️ 無法取得通知權限，請稍後再試。']
        };
        const entry = map[perm] || map.default;
        statusEl.className = 'text-xs p-3 rounded-lg border ' + entry[0];
        statusEl.textContent = entry[1];
    }

    const checkbox = document.getElementById('notifyNewComp');
    if (checkbox) checkbox.checked = !!state.newCompetitions;

    const subs = CMNotify.subscriptionList(state);
    const countEl = document.getElementById('notifySubCount');
    if (countEl) countEl.textContent = String(subs.length);

    const listEl = document.getElementById('notifySubList');
    if (listEl) {
        listEl.innerHTML = subs.length === 0
            ? '<p class="text-xs text-slate-400">尚未訂閱任何賽事。在比賽卡片上按「🔕 訂閱提醒」即可加入。</p>'
            : subs.map((s) => `
                <div class="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <div class="min-w-0">
                        <p class="text-xs font-medium text-slate-700 truncate">${escapeHtml(s.name)}</p>
                        <p class="text-xs text-slate-500">${escapeHtml(s.date || '')}${s.time ? ' ' + escapeHtml(s.time) : ''}</p>
                    </div>
                    <button data-action="unsubscribe" data-id="${escapeHtml(String(s.id))}"
                        class="text-xs text-red-600 hover:text-red-800 bg-red-50 hover:bg-red-100 px-2 py-1 rounded transition shrink-0">取消</button>
                </div>`).join('');
    }
}

async function notifyEnable() {
    if (!window.CMNotify) return;

    const perm = await CMNotify.requestPermission();

    if (perm === 'granted') {
        const state = CMNotify.loadState();
        state.enabled = true;
        CMNotify.saveState(state);

        // 若使用者是從卡片點訂閱而被導到這裡，啟用後直接完成該筆訂閱
        if (pendingSubscribeId) {
            const item = allCompetitions.find((c) => c.id === pendingSubscribeId);
            if (item) CMNotify.setSubscribed(pendingSubscribeId, item);
            pendingSubscribeId = null;
            filterCompetitions();
        }

        renderNotifyModal();
        await notifyTest(true);
    } else {
        renderNotifyModal();
    }
}

async function notifyTest(fromEnable) {
    if (!window.CMNotify) return;

    if (CMNotify.permissionState() !== 'granted') {
        alert('請先按「啟用」並在瀏覽器允許通知，才能傳送測試通知。');
        return;
    }

    try {
        await CMNotify.show('🔔 測試通知', '如果你看到這則通知，表示賽事提醒功能正常運作。', '/', 'cm-test');
        if (!fromEnable) {
            alert('已送出測試通知。若沒看到，請檢查系統的「專注模式」或瀏覽器的通知設定。');
        }
    } catch (err) {
        alert('無法顯示通知：' + err.message);
    }
}

function notifyDisable() {
    if (!window.CMNotify) return;
    const state = CMNotify.loadState();
    state.enabled = false;
    CMNotify.saveState(state);
    renderNotifyModal();
}

function toggleSubscription(id) {
    if (!window.CMNotify) return alert('此瀏覽器不支援通知功能');

    const item = allCompetitions.find((c) => c.id === id);
    if (!item) return;

    if (CMNotify.isSubscribed(id)) {
        CMNotify.setSubscribed(id, null);
        refreshAfterSubscriptionChange();
        return;
    }

    // 尚未啟用通知時先開啟設定視窗，避免使用者以為訂閱了卻收不到任何提醒
    if (!CMNotify.loadState().enabled || CMNotify.permissionState() !== 'granted') {
        pendingSubscribeId = id;
        openNotifyModal();
        return;
    }

    CMNotify.setSubscribed(id, item);
    refreshAfterSubscriptionChange();
}

function refreshAfterSubscriptionChange() {
    const modal = document.getElementById('notifyModal');
    if (modal && !modal.classList.contains('hidden')) renderNotifyModal();
    filterCompetitions();
}

/* ==========================================
   CSV 匯入 / 匯出 (v2.8.0)
   - 解析與驗證規則與後端共用同一份 public/js/csv.js。
   - 前端先預檢並顯示預覽，後端再權威驗證一次才寫入。
   - 下載一律用 Blob + <a download>，不使用 inline 事件屬性（維持 CSP）。
   ========================================== */
let pendingCsvRecords = [];

function resetCsvUi() {
    pendingCsvRecords = [];
    ['csvPreview', 'csvResult', 'csvConfirmBtn'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    const input = document.getElementById('csvFileInput');
    if (input) input.value = '';
}

function openCsvModal() {
    // 雙重防護：選單按鈕本身已依角色隱藏，這裡再擋一次，避免任何殘留狀態下被開啟
    if (!isAdminUser()) return alert('匯入／匯出 CSV 僅限管理員以上使用。');
    closeNavDropdown();
    resetCsvUi();
    document.getElementById('csvModal')?.classList.remove('hidden');
}

function closeCsvModal() {
    document.getElementById('csvModal')?.classList.add('hidden');
    resetCsvUi();
}

function showCsvResult(type, message) {
    const box = document.getElementById('csvResult');
    if (!box) return;
    box.className = 'text-xs p-3 rounded-lg border ' +
        (type === 'success'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
            : 'bg-red-50 border-red-200 text-red-700');
    box.textContent = message;
    box.classList.remove('hidden');
}

function downloadCsvBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function csvExport() {
    if (!isAdminUser()) return alert('匯出賽事資料僅限管理員以上使用。');
    const btn = document.getElementById('csvExportBtn');
    try {
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 匯出中...'; }
        const res = await customFetch('/api/competitions/export.csv');
        if (!res.ok) {
            const errJson = await res.json().catch(() => ({}));
            throw new Error(errJson.error || '匯出失敗');
        }
        const today = new Date().toISOString().slice(0, 10);
        downloadCsvBlob(`competitions-${today}.csv`, await res.blob());
        showCsvResult('success', `已開始下載 competitions-${today}.csv（含全部未刪除賽事）`);
    } catch (err) {
        showCsvResult('error', err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '⬇️ 匯出全部賽事 (CSV)'; }
    }
}

function csvDownloadTemplate() {
    if (!isAdminUser()) return alert('匯入／匯出 CSV 僅限管理員以上使用。');
    const { rows } = CMCSV.templateRows();
    downloadCsvBlob('competitions-template.csv', new Blob([CMCSV.stringify(rows, { bom: true })], { type: 'text/csv;charset=utf-8' }));
    showCsvResult('success', '已下載匯入範本（含表頭與一列示範資料）');
}

async function csvPickFile(event) {
    if (!isAdminUser()) {
        if (event && event.target) event.target.value = '';
        return alert('匯入賽事資料僅限管理員以上使用。');
    }
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    pendingCsvRecords = [];
    document.getElementById('csvConfirmBtn')?.classList.add('hidden');

    try {
        const text = await file.text();

        if (text.indexOf('\uFFFD') !== -1) {
            showCsvResult('error', '檔案編碼可能不是 UTF-8（出現無法解讀的字元）。請在 Excel 另存新檔時選擇「CSV UTF-8」。');
        }

        const parsed = CMCSV.parse(text);
        const { headerMap, records } = CMCSV.recordsFromParsed(parsed);

        if (records.length === 0) return showCsvResult('error', '檔案中找不到任何資料列');
        if (headerMap.name === undefined) return showCsvResult('error', '找不到「名稱」欄位，請確認表頭（可先下載範本參考）');
        if (records.length > CMCSV.MAX_IMPORT_ROWS) {
            return showCsvResult('error', `單次最多匯入 ${CMCSV.MAX_IMPORT_ROWS} 筆，本檔有 ${records.length} 筆，請分批處理`);
        }

        // 用與後端相同的規則預檢，讓使用者在送出前就看到問題列
        const checked = records.map((record, i) => ({
            index: i + 1,
            result: CMCSV.normalizeRecord(record, {
                categories: CM_META.categories,
                maxTags: CM_META.maxTags,
                maxTagLength: CM_META.maxTagLength
            })
        }));

        pendingCsvRecords = records;
        renderCsvPreview(checked, file.name, parsed.delimiter);
    } catch (err) {
        showCsvResult('error', '讀取檔案失敗：' + err.message);
    }
}

function renderCsvPreview(checked, fileName, delimiter) {
    const box = document.getElementById('csvPreview');
    if (!box) return;

    const okCount = checked.filter((c) => c.result.ok).length;
    const badCount = checked.length - okCount;
    const delimLabel = delimiter === '\t' ? 'Tab' : delimiter;

    const rows = checked.slice(0, 12).map(({ index, result }) => {
        const v = result.value;
        const cat = v.category ? getCategoryById(v.category) : null;
        return `<tr class="border-b border-slate-100">
            <td class="px-2 py-1.5 text-slate-400">${index}</td>
            <td class="px-2 py-1.5 font-medium text-slate-800 whitespace-nowrap">${escapeHtml(v.name || '')}</td>
            <td class="px-2 py-1.5 whitespace-nowrap">${cat ? escapeHtml(cat.emoji + ' ' + cat.label) : '<span class="text-slate-400">未分類</span>'}</td>
            <td class="px-2 py-1.5 text-slate-600 whitespace-nowrap">${escapeHtml(v.tags.join(', '))}</td>
            <td class="px-2 py-1.5 text-slate-600 whitespace-nowrap">${escapeHtml(v.date || '')}${v.time ? ' ' + escapeHtml(v.time) : ''}</td>
            <td class="px-2 py-1.5">${result.ok ? '✅' : '❌ ' + escapeHtml(result.errors.join('；'))}</td>
        </tr>`;
    }).join('');

    box.innerHTML = `
        <div class="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-2 text-xs">
            <p class="font-bold text-slate-700 break-all">${escapeHtml(fileName)}</p>
            <p class="text-slate-600 mt-1">
                共 ${checked.length} 筆｜可匯入 <span class="text-emerald-600 font-bold">${okCount}</span> 筆
                ${badCount ? `｜格式有誤 <span class="text-red-600 font-bold">${badCount}</span> 筆（將被跳過）` : ''}
                ｜分隔符：${escapeHtml(delimLabel)}
            </p>
        </div>
        <div class="overflow-x-auto">
            <table class="w-full text-xs">
                <thead>
                    <tr class="text-left text-slate-500 border-b border-slate-200">
                        <th class="px-2 py-1">#</th><th class="px-2 py-1">名稱</th><th class="px-2 py-1">分類</th>
                        <th class="px-2 py-1">標籤</th><th class="px-2 py-1">開始</th><th class="px-2 py-1">狀態</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        ${checked.length > 12 ? `<p class="text-xs text-slate-400 mt-2">僅預覽前 12 筆，匯入時會處理全部 ${checked.length} 筆。</p>` : ''}
    `;
    box.classList.remove('hidden');

    const confirmBtn = document.getElementById('csvConfirmBtn');
    if (confirmBtn) {
        confirmBtn.textContent = `✅ 確認匯入 ${okCount} 筆`;
        confirmBtn.classList.toggle('hidden', okCount === 0);
    }
}

function renderCsvImportResult(data) {
    const box = document.getElementById('csvResult');
    if (!box) return;

    const list = (arr, render) => arr.slice(0, 8).map(render).join('') +
        (arr.length > 8 ? `<li class="text-slate-400">…另有 ${arr.length - 8} 筆</li>` : '');

    box.className = 'text-xs p-3 rounded-lg border bg-slate-50 border-slate-200 text-slate-700 space-y-2';
    box.innerHTML = `
        <p class="font-bold text-slate-800">
            ✅ 匯入完成：新增 <span class="text-emerald-600">${data.created}</span> 筆
            ${data.skipped.length ? `｜跳過重複 <span class="text-amber-600">${data.skipped.length}</span> 筆` : ''}
            ${data.failed.length ? `｜格式有誤 <span class="text-red-600">${data.failed.length}</span> 筆` : ''}
            （共 ${data.total} 筆）
        </p>
        ${data.skipped.length ? `<div>
            <p class="font-semibold text-amber-700">跳過的重複資料：</p>
            <ul class="list-disc pl-5">${list(data.skipped, (s) => `<li>第 ${s.index} 筆：${escapeHtml(s.name || '')}</li>`)}</ul>
        </div>` : ''}
        ${data.failed.length ? `<div>
            <p class="font-semibold text-red-700">未匯入的資料：</p>
            <ul class="list-disc pl-5">${list(data.failed, (f) => `<li>第 ${f.index} 筆：${escapeHtml(f.reason)}</li>`)}</ul>
        </div>` : ''}
        ${(data.warnings && data.warnings.length) ? `<div>
            <p class="font-semibold text-slate-600">提醒：</p>
            <ul class="list-disc pl-5">${list(data.warnings, (w) => `<li>${escapeHtml(w)}</li>`)}</ul>
        </div>` : ''}
    `;
    box.classList.remove('hidden');
}

async function csvConfirmImport() {
    if (pendingCsvRecords.length === 0) return;

    const btn = document.getElementById('csvConfirmBtn');
    try {
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 匯入中...'; }

        const res = await customFetch('/api/competitions/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: pendingCsvRecords })
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) throw new Error(data.error || '匯入失敗');

        renderCsvImportResult(data);
        document.getElementById('csvPreview')?.classList.add('hidden');
        btn?.classList.add('hidden');
        pendingCsvRecords = [];

        fetchCompetitions();
    } catch (err) {
        showCsvResult('error', err.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 分類清單由後端 /api/meta 提供（單一真實來源，避免前後端各寫一份）
async function fetchMeta() {
    try {
        const res = await customFetch('/api/meta');
        if (res.ok) {
            const meta = await res.json();
            CM_META.categories = meta.categories || [];
            CM_META.maxTags = meta.maxTags || 10;
            CM_META.maxTagLength = meta.maxTagLength || 24;
        }
    } catch (e) {
        // 取不到時仍可正常使用，只是分類選項變少（不影響其他功能）
    }

    const optionsHtml = CM_META.categories
        .map((c) => `<option value="${escapeHtml(c.id)}">${c.emoji} ${escapeHtml(c.label)}</option>`)
        .join('');

    const formSel = document.getElementById('category');
    if (formSel) formSel.innerHTML = '<option value="">— 未分類 —</option>' + optionsHtml;

    const filterSel = document.getElementById('filterCategory');
    if (filterSel) {
        const keep = filterSel.value;
        filterSel.innerHTML = '<option value="">全部分類</option>' + optionsHtml;
        filterSel.value = keep;
    }
}

// 標籤篩選選項由現有資料歸納（僅列出實際出現過的標籤）
function populateTagFilter() {
    const sel = document.getElementById('filterTag');
    if (!sel) return;

    const keep = sel.value;
    const all = new Set();
    allCompetitions.forEach((c) => {
        if (Array.isArray(c.tags)) c.tags.forEach((t) => all.add(t));
    });

    const sorted = Array.from(all).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    sel.innerHTML = '<option value="">全部標籤</option>' +
        sorted.map((t) => `<option value="${escapeHtml(t)}"># ${escapeHtml(t)}</option>`).join('');

    if (keep && sorted.some((t) => t.toLowerCase() === keep.toLowerCase())) sel.value = keep;
}

// 與後端 normalizeTags 相同的規則：去空白、去 #、去重（忽略大小寫）、限量
function parseTagInput(value) {
    const maxTags = CM_META.maxTags || 10;
    const maxLen = CM_META.maxTagLength || 24;
    const seen = new Set();
    const out = [];

    String(value || '').split(/[,，、;；\n\t]+/).forEach((raw) => {
        const t = raw.trim().replace(/^#+/, '').slice(0, maxLen);
        if (!t) return;
        const key = t.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        if (out.length < maxTags) out.push(t);
    });

    return out;
}

function renderTagPreview() {
    const input = document.getElementById('tags');
    const box = document.getElementById('tagPreview');
    if (!input || !box) return;

    const tags = parseTagInput(input.value);
    box.innerHTML = tags.length
        ? tags.map((t) => `<span class="tag-chip"># ${escapeHtml(t)}</span>`).join('') +
          `<span class="text-xs text-slate-400 self-center">共 ${tags.length} 個</span>`
        : '';
}

let lastCompetitionsLoadAt = 0;   // v2.19.0：回到頁面時判斷資料是否夠新

async function fetchCompetitions() {
    try {
        const res = await customFetch('/api/competitions');
        if (!res.ok) throw new Error('無法載入比賽資料');
        allCompetitions = await res.json();
        lastCompetitionsLoadAt = Date.now();
        populateTagFilter();
        // 用 filterCompetitions：會一併更新狀態篩選列，且保留使用者當下的搜尋／狀態條件
        filterCompetitions();

        // 資料到齊後再檢查一次通知（第一次只建立基準，不會灌通知）
        if (notifyWatcher) notifyWatcher.tick();
    } catch (err) {
        document.getElementById('competitionList').innerHTML = `<p class="text-red-500 text-center py-4">無法載入比賽資料</p>`;
    }
}

function getCategoryById(id) {
    if (!id) return null;
    return CM_META.categories.find((c) => c.id === id) || null;
}

function categoryBadgeHtml(item) {
    const cat = getCategoryById(item.category);
    if (!cat) return '';
    return `<span class="cat-chip cat-chip-${cat.color}" title="分類：${escapeHtml(cat.label)}">${cat.emoji} ${escapeHtml(cat.label)}</span>`;
}

function tagsBadgeHtml(item) {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    if (tags.length === 0) return '';
    return tags.map((t) => `<span class="tag-chip"># ${escapeHtml(t)}</span>`).join('');
}

function currentFilters() {
    return {
        state: currentStateFilter,
        query: (document.getElementById('searchInput')?.value || '').toLowerCase().trim(),
        date: document.getElementById('filterDateInput')?.value || '',
        category: document.getElementById('filterCategory')?.value || '',
        tag: document.getElementById('filterTag')?.value || ''
    };
}

function matchesFilters(item, f) {
    // v2.19.0：狀態篩選用後端算好的 state（不在前端重算）
    const matchState = !f.state || (clientRegistrationState(item).state || '') === f.state;

    const matchQuery = !f.query ||
        (item.name && item.name.toLowerCase().includes(f.query)) ||
        (item.location && item.location.toLowerCase().includes(f.query)) ||
        (item.description && item.description.toLowerCase().includes(f.query));

    const matchDate = !f.date || item.date === f.date || item.end_date === f.date;
    const matchCategory = !f.category || item.category === f.category;
    const matchTag = !f.tag ||
        (Array.isArray(item.tags) && item.tags.some((t) => t.toLowerCase() === f.tag.toLowerCase()));

    return matchQuery && matchDate && matchCategory && matchTag && matchState;
}

/* 狀態篩選列（v2.19.0）：數字由目前載入的清單即時算出來，不需要額外 API */
function renderStateFilterBar(data) {
    const bar = document.getElementById('stateFilterBar');
    if (!bar) return;
    const list = Array.isArray(data) ? data : [];
    const counts = {};
    list.forEach((item) => {
        const s = clientRegistrationState(item).state || 'other';
        counts[s] = (counts[s] || 0) + 1;
    });

    bar.innerHTML = CM_STATE_FILTERS.map((f) => {
        const n = f.value ? (counts[f.value] || 0) : list.length;
        const active = currentStateFilter === f.value;
        return `<button type="button" data-state-filter="${f.value}" aria-pressed="${active}"
            class="cm-state-chip${active ? ' is-active' : ''}">${escapeHtml(f.label)} <span class="cm-state-count">${n}</span></button>`;
    }).join('');
}

function bindStateFilterBar() {
    const bar = document.getElementById('stateFilterBar');
    if (!bar || bar.dataset.bound === '1') return;
    bar.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-state-filter]');
        if (!btn) return;
        currentStateFilter = btn.getAttribute('data-state-filter') || '';
        filterCompetitions();
    });
    bar.dataset.bound = '1';
}

function filterCompetitions() {
    const f = currentFilters();
    renderStateFilterBar(allCompetitions);
    renderCurrentView(allCompetitions.filter((item) => matchesFilters(item, f)));
}

function clearFilter() {
    currentStateFilter = '';   // v2.19.0：狀態篩選也要一起清掉
    const search = document.getElementById('searchInput');
    const dateInput = document.getElementById('filterDateInput');
    const catInput = document.getElementById('filterCategory');
    const tagInput = document.getElementById('filterTag');
    if (search) search.value = '';
    if (dateInput) dateInput.value = '';
    if (catInput) catInput.value = '';
    if (tagInput) tagInput.value = '';
    renderCurrentView(allCompetitions);
}

// 列表與日曆共用同一份篩選結果，切換檢視不會遺失篩選條件
function renderCurrentView(data) {
    const listEl = document.getElementById('competitionList');
    const calEl = document.getElementById('calendarView');

    if (currentView === 'calendar') {
        listEl?.classList.add('hidden');
        calEl?.classList.remove('hidden');
        if (window.CMCalendar) window.CMCalendar.setData(data, CM_META.categories);
    } else {
        calEl?.classList.add('hidden');
        listEl?.classList.remove('hidden');
        renderCompetitions(data);
    }
}

function setView(view) {
    currentView = view === 'calendar' ? 'calendar' : 'list';
    try {
        localStorage.setItem('cm-view', currentView);
    } catch (e) { /* 無痕模式等情況：不記住即可 */ }

    const activeCls = 'text-xs px-3 py-1.5 font-medium bg-blue-600 text-white transition';
    const inactiveCls = 'text-xs px-3 py-1.5 font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 transition border-l border-slate-300';

    const listBtn = document.getElementById('viewListBtn');
    const calBtn = document.getElementById('viewCalendarBtn');
    if (listBtn) {
        listBtn.className = currentView === 'list' ? activeCls : inactiveCls;
        listBtn.setAttribute('aria-pressed', String(currentView === 'list'));
    }
    if (calBtn) {
        calBtn.className = currentView === 'calendar' ? activeCls : inactiveCls;
        calBtn.setAttribute('aria-pressed', String(currentView === 'calendar'));
    }

    filterCompetitions();
}

function renderCompetitions(data) {
    renderCompetitionCards(data, document.getElementById('competitionList'));
}

// 日曆的「當天清單」也共用這個函式，確保兩邊的操作按鈕行為完全一致
function renderCompetitionCards(data, targetEl) {
    if (!targetEl) return;
    if (!data || data.length === 0) {
        targetEl.innerHTML = `<p class="text-center text-slate-400 py-8">目前無符合條件的比賽資料</p>`;
        return;
    }

    targetEl.innerHTML = data.map(competitionCardHtml).join('');
}

/* ---------- v2.27.0：場地地圖連結＋工作人員指派 ---------- */

/* 卡片上的地圖連結：自訂連結優先，沒填就用地址自動產生（規則在 public/js/venue.js，與後端同一份） */
function mapLinkHtml(item) {
    const url = item.map_url || (window.CMVenue ? CMVenue.mapUrlFor(item) : '');
    if (!url) return '';
    const autoHint = item.map_url_auto ? '（用地址搜尋）' : '';
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="hover:text-blue-700 underline" title="在地圖上開啟${autoHint}">🗺️ 地圖${autoHint}</a>`;
}

/* 卡片上的工作人員徽章：有人才顯示（管理員另有動作按鈕可以進去指派） */
function staffChipHtml(item) {
    const count = staffCounts[String(item.id)] || 0;
    if (!count) return '';
    return `<button type="button" data-action="manage-staff" data-id="${item.id}" class="hover:text-blue-700 underline">🧑‍⚖️ 工作人員 ${count}</button>`;
}

const cmStaffState = { competitionId: null, staff: [], roles: [], schemaReady: true, users: null };

function canManageStaff() {
    return !!currentUser && ['admin', 'super_admin', 'web_owner'].includes(currentUser.role);
}

function staffSetStatus(message, isError) {
    const el = document.getElementById('staffStatus');
    if (!el) return;
    el.textContent = message;
    el.className = isError ? 'text-[11px] text-red-600' : 'text-[11px] text-emerald-700';
    el.classList.toggle('hidden', !message);
}

/* ---------- v3.6.3：賽事公告（取消／延期／最新消息，Roadmap 8.8⑥） ----------
 *
 * 為什麼不做成「改日期」就好：改日期會蓋掉原訂時間，事後看不出「延期過」；
 * 而且取消也不是日期算得出來的狀態。所以三個動作都獨立記錄，原訂時間一律保留。
 * 公告直接顯示在卡片上（不需訂閱推播），臨時變更才不會只剩推播的人看得到。 */
let noticeCompId = null;

function noticeSetStatus(message, isError) {
    const el = document.getElementById('noticeMsg');
    if (!el) return;
    el.textContent = message || '';
    el.className = isError
        ? 'text-xs p-2.5 rounded-lg border bg-red-50 border-red-200 text-red-700'
        : 'text-xs p-2.5 rounded-lg border bg-emerald-50 border-emerald-200 text-emerald-700';
    el.classList.toggle('hidden', !message);
}

function openNoticeModal(id) {
    const item = allCompetitions.find((c) => String(c.id) === String(id));
    if (!item) return;
    if (!isAdminUser()) return alert('權限不足：只有管理員以上可以發布賽事公告');
    noticeCompId = item.id;
    const label = document.getElementById('noticeModalComp');
    if (label) label.innerText = `｜${item.name}｜原訂 ${item.date || '日期未定'}${item.time ? ` ${item.time}` : ''}`;
    const reason = document.getElementById('cancelReasonInput');
    if (reason) reason.value = item.cancel_reason || '';
    const pDate = document.getElementById('postponeDateInput');
    if (pDate) pDate.value = item.postponed_date ? String(item.postponed_date).slice(0, 10) : '';
    const pTime = document.getElementById('postponeTimeInput');
    if (pTime) pTime.value = item.postponed_time ? String(item.postponed_time).slice(0, 5) : '';
    const news = document.getElementById('newsInput');
    if (news) news.value = item.news || '';
    const current = document.getElementById('noticeCurrent');
    if (current) {
        const notice = window.CMCompetitionState ? CMCompetitionState.competitionNotice(item) : { has_notice: false };
        current.innerText = notice.cancelled ? `目前狀態：⛔ 已取消${notice.cancel_reason ? `（${notice.cancel_reason}）` : ''}`
            : notice.postponed ? `目前狀態：🕒 已延期至 ${notice.postponed_label}（原訂 ${item.date || '未定'}）`
                : '目前狀態：正常（沒有取消或延期）';
    }
    document.getElementById('noticeMsg')?.classList.add('hidden');
    document.getElementById('noticeModal')?.classList.remove('hidden');
}

function closeNoticeModal() {
    document.getElementById('noticeModal')?.classList.add('hidden');
    noticeCompId = null;
}

async function submitNoticeAction(path, payload, okText) {
    if (!noticeCompId && noticeCompId !== 0) return;
    try {
        // v3.6.4：預設勾選「同時推播通知已報名者」；管理員可取消勾選（卡片公告仍會顯示）
        const notifyOn = document.getElementById('noticeNotifyInput')?.checked !== false;
        const res = await customFetch(`/api/competitions/${noticeCompId}/${path}`, {
            method: 'POST',
            body: JSON.stringify(Object.assign({ notify: notifyOn }, payload || {}))
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '操作失敗');
        noticeSetStatus(data.message || okText || '已更新', false);
        await fetchCompetitions();   // 重新載入列表：卡片上的公告要立刻更新
        return true;
    } catch (err) {
        noticeSetStatus(err.message || '操作失敗', true);
        return false;
    }
}

async function saveCancelNotice() {
    const reason = (document.getElementById('cancelReasonInput')?.value || '').trim();
    if (!reason) return noticeSetStatus('取消賽事請填寫原因（會顯示在卡片上讓大家看到）', true);
    const ok = await submitNoticeAction('cancel', { cancelled: true, reason }, '已取消賽事');
    if (ok) noticeSetStatus('已取消賽事，卡片上會顯示取消原因', false);
}

async function reviveCompetition() {
    const ok = await submitNoticeAction('cancel', { cancelled: false }, '已復原');
    if (ok) noticeSetStatus('已復原（卡片上的取消標示會消失）', false);
}

async function savePostponeNotice() {
    const date = document.getElementById('postponeDateInput')?.value || '';
    const time = document.getElementById('postponeTimeInput')?.value || '';
    if (!date) return noticeSetStatus('請選擇延期後的新日期', true);
    const ok = await submitNoticeAction('postpone', { postponed_date: date, postponed_time: time }, '已設定延期');
    if (ok) noticeSetStatus(`已延期至 ${date}${time ? ' ' + time : ''}（原訂時間保留）`, false);
}

async function clearPostponeNotice() {
    const ok = await submitNoticeAction('postpone', { postponed_date: null }, '已取消延期標記');
    if (ok) {
        const pDate = document.getElementById('postponeDateInput');
        if (pDate) pDate.value = '';
        const pTime = document.getElementById('postponeTimeInput');
        if (pTime) pTime.value = '';
        noticeSetStatus('已取消延期標記', false);
    }
}

async function saveCompetitionNews(clear) {
    const text = clear ? '' : (document.getElementById('newsInput')?.value || '').trim();
    if (!clear && !text) return noticeSetStatus('請輸入要公告的內容', true);
    const ok = await submitNoticeAction('news', { news: text }, clear ? '已清空消息' : '已更新最新消息');
    if (ok) {
        if (clear) {
            const news = document.getElementById('newsInput');
            if (news) news.value = '';
        }
        noticeSetStatus(clear ? '已清空最新消息' : '已更新最新消息（卡片上會直接顯示）', false);
    }
}

async function openStaffModal(id) {
    closeNavDropdown();
    cmStaffState.competitionId = id;
    const comp = allCompetitions.find((c) => c.id === id);
    document.getElementById('staffModalComp').textContent = comp ? `｜${comp.name}${comp.date ? `（${comp.date}）` : ''}` : '';
    document.getElementById('staffModal').classList.remove('hidden');
    document.getElementById('staffAdminBox').classList.toggle('hidden', !canManageStaff());
    document.getElementById('staffStatus').classList.add('hidden');
    document.getElementById('staffSummary').innerHTML = '';
    document.getElementById('staffList').innerHTML = '<p class="text-center text-slate-400 py-4 text-xs">載入中...</p>';
    if (canManageStaff() && cmStaffState.users === null) await loadStaffUserOptions();
    await loadCompetitionStaff(id);
}

function closeStaffModal() {
    document.getElementById('staffModal').classList.add('hidden');
    cmStaffState.competitionId = null;
}

/* 可指派的帳號（管理員以上才讀得到；停用中的帳號不列） */
async function loadStaffUserOptions() {
    const select = document.getElementById('staffUser');
    try {
        const data = await apiResult(await customFetch('/api/admin/users'));
        const users = (data.users || []).filter((u) => u.is_active !== false && u.role !== 'test');
        cmStaffState.users = users;
        select.innerHTML = users.length
            ? users.map((u) => `<option value="${escapeHtml(String(u.id))}">${escapeHtml(u.username)}（${escapeHtml(u.role_label || u.role)}）</option>`).join('')
            : '<option value="">沒有可指派的帳號</option>';
    } catch (err) {
        cmStaffState.users = [];
        select.innerHTML = '<option value="">讀取帳號清單失敗</option>';
    }
}

async function loadCompetitionStaff(id) {
    try {
        const data = await apiResult(await customFetch(`/api/competitions/${id}/staff`));
        if (cmStaffState.competitionId !== id) return;   // 使用者已經換別場了
        cmStaffState.staff = data.staff || [];
        cmStaffState.roles = data.roles || [];
        cmStaffState.schemaReady = data.schema_ready !== false;

        const hintEl = document.getElementById('staffHint');
        if (!cmStaffState.schemaReady) {
            hintEl.textContent = '⚠️ ' + (data.hint || '工作人員功能尚未啟用。');
            hintEl.classList.remove('hidden');
        } else {
            hintEl.classList.add('hidden');
        }
        renderStaffRoleOptions();
        renderStaffList();
    } catch (err) {
        document.getElementById('staffList').innerHTML = `<p class="text-red-500 text-center py-4 text-xs">載入失敗：${escapeHtml(err.message)}</p>`;
    }
}

function renderStaffRoleOptions() {
    const sel = document.getElementById('staffRole');
    const roles = cmStaffState.roles.length ? cmStaffState.roles : (window.CMStaff ? CMStaff.STAFF_ROLES : []);
    sel.innerHTML = roles.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(`${r.emoji || ''} ${r.label}`.trim())}</option>`).join('');
}

function renderStaffList() {
    const summary = window.CMStaff ? CMStaff.staffSummary(cmStaffState.staff) : { total: cmStaffState.staff.length, roles: [] };
    const chips = summary.roles.filter((r) => r.count > 0)
        .map((r) => `<span class="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">${escapeHtml(`${r.emoji} ${r.label}`)} ${r.count}</span>`)
        .join('');
    document.getElementById('staffSummary').innerHTML = chips || '<span class="text-[11px] text-slate-400">這場還沒有指派工作人員</span>';

    const listEl = document.getElementById('staffList');
    if (!cmStaffState.staff.length) {
        listEl.innerHTML = `<p class="text-center text-slate-400 py-3 text-xs">${cmStaffState.schemaReady ? '還沒有指派工作人員' : '功能尚未啟用（請先執行 migrations 內的 SQL）'}</p>`;
        return;
    }
    listEl.innerHTML = cmStaffState.staff.map((s) => `
        <div class="flex items-start justify-between gap-2 p-2.5 border border-slate-200 rounded-lg">
            <div class="min-w-0">
                <p class="text-sm text-slate-800">${escapeHtml(`${s.role_emoji || ''} ${s.role_label || s.role}`)}　<b>${escapeHtml(s.username || `帳號 #${s.user_id}（已刪除）`)}</b></p>
                ${s.note ? `<p class="text-[11px] text-slate-500">📝 ${escapeHtml(s.note)}</p>` : ''}
                ${s.assigned_by ? `<p class="text-[10px] text-slate-400">由 ${escapeHtml(s.assigned_by)} 指派</p>` : ''}
            </div>
            ${canManageStaff() ? `<button type="button" data-staff-remove="${escapeHtml(String(s.id))}" class="text-[11px] text-red-600 hover:text-red-800 shrink-0">移除</button>` : ''}
        </div>`).join('');
}

/* 指派：同一場同一人只有一個角色，再指派一次＝改角色 */
async function assignStaff() {
    const id = cmStaffState.competitionId;
    if (!id) return;
    const userId = document.getElementById('staffUser').value;
    const role = document.getElementById('staffRole').value;
    const note = document.getElementById('staffNote').value;
    if (!userId) return staffSetStatus('沒有可指派的帳號', true);

    staffSetStatus('指派中...', false);
    try {
        const data = await apiResult(await customFetch(`/api/competitions/${id}/staff`, {
            method: 'POST',
            body: JSON.stringify({ user_id: Number(userId), role, note })
        }));
        cmStaffState.staff = data.staff || [];
        renderStaffList();
        document.getElementById('staffNote').value = '';
        staffSetStatus(data.changed === 'updated'
            ? `已把 ${data.assigned.username} 的角色改成「${data.assigned.role_label}」`
            : `已指派 ${data.assigned.username} 為「${data.assigned.role_label}」`, false);
        await refreshStaffBadges();
    } catch (err) {
        staffSetStatus(err.message, true);
    }
}

async function removeStaff(staffId) {
    const row = cmStaffState.staff.find((s) => String(s.id) === String(staffId));
    const who = row ? `${row.username || `帳號 #${row.user_id}`}（${row.role_label}）` : `指派 #${staffId}`;
    if (!confirm(`確定要把 ${who} 從這場賽事的工作人員移除？`)) return;

    staffSetStatus('移除中...', false);
    try {
        const data = await apiResult(await customFetch(`/api/staff/${staffId}`, { method: 'DELETE' }));
        cmStaffState.staff = data.staff || [];
        renderStaffList();
        staffSetStatus(`已移除 ${data.removed.username}`, false);
        await refreshStaffBadges();
    } catch (err) {
        staffSetStatus(err.message, true);
    }
}

/* 指派異動後卡片上的「工作人員 N」要跟著更新 */
async function refreshStaffBadges() {
    await fetchRegistrationCounts();
    const keepOpen = cmStaffState.competitionId;
    await fetchCompetitions();
    if (keepOpen !== null) cmStaffState.competitionId = keepOpen;
}

/* ---------- v3.0.0：後台營運儀表板（管理員以上） ----------
 * 設計取捨：
 *   - 圖表是手寫 SVG（CSP 是 script-src 'self'，不裝任何前端套件）；幾何在 public/js/stats.js，
 *     與後端統計、測試用同一份數學，圖上的數字跟 API 的數字不會有兩套算法。
 *   - 顏色一律用「現有的 Tailwind 類別 + currentColor」：不新增色系（用不存在的 class 會靜默失效，
 *     這種坑 v2.27.0 踩過一次），也不寫 inline style（CSP style-src 'self' 會擋掉）。
 *   - 只呈現聚合數字：這裡不會出現任何帳號或個人資料。
 */
const OPS_STATS_RANGES = [7, 14, 30];
let opsStatsDays = 14;
let opsStatsLoading = false;

const OPS_TIMING_LABELS = {
    competitions: '賽事',
    registrations: '報名',
    users: '使用者',
    errors: '錯誤日誌',
    push: '推播',
    posters: '海報',
    staff: '工作人員'
};

function openOpsStatsModal() {
    const modal = document.getElementById('opsStatsModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    renderOpsRangeButtons();
    loadOpsStats();
}

function closeOpsStatsModal() {
    document.getElementById('opsStatsModal')?.classList.add('hidden');
}

function renderOpsRangeButtons() {
    const box = document.getElementById('opsStatsRange');
    if (!box) return;
    box.innerHTML = OPS_STATS_RANGES.map((d) => `
        <button type="button" data-ops-days="${d}"
            class="px-2.5 py-1 rounded-lg text-xs transition ${d === opsStatsDays
        ? 'bg-blue-600 text-white'
        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">${d} 天</button>`).join('');
}

/* 折線圖（趨勢）。values 為數字陣列，空資料回一句說明而不是畫出一條假線。 */
function opsLineChartHtml(values, options) {
    const opts = options || {};
    const width = 320;
    const height = 90;
    const list = Array.isArray(values) ? values : [];
    if (!list.length) return '<p class="text-[11px] text-slate-400 py-6 text-center">沒有資料</p>';
    const path = CMStats.linePath(list, { width, height });
    const points = CMStats.linePoints(list, { width, height });
    const toneClass = opts.tone === 'bad' ? 'text-red-500' : 'text-blue-600';
    return `
        <svg viewBox="0 0 ${width} ${height}" class="w-full h-24 ${toneClass}" role="img"
            aria-label="${escapeHtml(opts.label || '趨勢圖')}">
            <line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="currentColor" stroke-opacity="0.25" stroke-width="1"></line>
            <path d="${path}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
            ${points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="currentColor"></circle>`).join('')}
        </svg>`;
}

/* 長條圖（分類分佈）。沒有資料時不畫空圖。 */
function opsBarChartHtml(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '<p class="text-[11px] text-slate-400 py-6 text-center">沒有資料</p>';
    const width = 320;
    const height = 90;
    const bars = CMStats.barGeometry(list.map((i) => i.count), { width, height, gap: 6 });
    return `
        <svg viewBox="0 0 ${width} ${height}" class="w-full h-24 text-emerald-600" role="img" aria-label="賽事分類分佈">
            ${bars.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${Math.max(b.height, 1)}"
                rx="2" fill="currentColor" fill-opacity="${b.value > 0 ? '0.85' : '0.2'}"></rect>`).join('')}
            <line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="currentColor" stroke-opacity="0.25" stroke-width="1"></line>
        </svg>`;
}

function opsCardHtml(card) {
    const tones = { good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-700', plain: 'text-slate-800' };
    return `
        <div class="rounded-lg border border-slate-200 bg-white p-3">
            <p class="text-[11px] text-slate-500">${escapeHtml(card.label)}</p>
            <p class="text-lg font-bold ${tones[card.tone] || tones.plain}">${escapeHtml(String(card.value))}<span
                class="text-xs font-normal text-slate-500 ml-1">${escapeHtml(card.unit || '')}</span></p>
            ${card.hint ? `<p class="text-[10px] text-slate-400">${escapeHtml(card.hint)}</p>` : ''}
        </div>`;
}

function renderOpsStats(data) {
    // ── 數字卡 ──
    const cardsBox = document.getElementById('opsCards');
    if (cardsBox) {
        const errorTotal = CMStats.sum(Object.values(data.errors.by_severity || {}), (v) => v);
        cardsBox.innerHTML = [
            { label: '賽事總數', value: data.competitions.total, hint: `報名中 ${(data.competitions.by_state || {}).registration_open || 0} 場、已結束 ${(data.competitions.by_state || {}).finished || 0} 場` },
            { label: '報名總數', value: data.registrations.total, hint: `近 7 天新增 ${data.registrations.last7d} 筆` },
            { label: '候補中', value: data.registrations.waitlisted, hint: `待審核 ${data.registrations.pending} 筆、已核准 ${data.registrations.confirmed} 筆` },
            { label: '使用者', value: data.users.total, hint: `啟用 ${data.users.active}${data.users.active_last_30d === null ? '' : `、近 30 天登入 ${data.users.active_last_30d}`}` },
            {
                label: '近 30 天未處理錯誤',
                value: data.errors.open_recent_30d,
                tone: data.errors.open_recent_30d > 0 ? 'warn' : 'good',
                hint: `錯誤 ${(data.errors.by_severity || {}).error || 0}／警告 ${(data.errors.by_severity || {}).warn || 0}`
            },
            {
                label: '推播成功率',
                value: data.push.success_rate,
                unit: '%',
                tone: data.push.success_tone,
                hint: `失敗 ${data.push.failed} 筆（共 ${data.push.notifications} 次推播）`
            }
        ].map(opsCardHtml).join('');
    }

    // ── 趨勢圖 ──
    const regBox = document.getElementById('opsRegChart');
    if (regBox) regBox.innerHTML = opsLineChartHtml((data.registrations.trend || []).map((t) => t.count), { label: '報名趨勢' });
    const regLegend = document.getElementById('opsRegLegend');
    if (regLegend) {
        const trend = data.registrations.trend || [];
        const total = trend.reduce((a, d) => a + d.count, 0);
        regLegend.textContent = trend.length
            ? `近 ${data.trend_days} 天共 ${total} 筆（高峰 ${Math.max(...trend.map((t) => t.count))} 筆／日）`
            : '';
    }

    const errBox = document.getElementById('opsErrChart');
    if (errBox) {
        errBox.innerHTML = opsLineChartHtml((data.errors.trend || []).map((t) => t.count), { label: '錯誤趨勢', tone: 'bad' });
    }
    const errLegend = document.getElementById('opsErrLegend');
    if (errLegend) {
        const total = (data.errors.trend || []).reduce((a, d) => a + d.count, 0);
        const top = (data.errors.top_types || [])[0];
        errLegend.textContent = total
            ? `近 ${data.trend_days} 天 ${total} 筆${top ? `；最多：${top.key}（${top.count}）` : ''}`
            : `近 ${data.trend_days} 天沒有未處理錯誤`;
    }

    // ── 分類分佈 ──
    const catBox = document.getElementById('opsCatChart');
    const cats = data.competitions.by_category || [];
    if (catBox) catBox.innerHTML = opsBarChartHtml(cats);
    const catLegend = document.getElementById('opsCatLegend');
    if (catLegend) {
        catLegend.innerHTML = cats.map((c) => `<span>${escapeHtml(c.label)} ${c.count}</span>`).join('')
            + (data.competitions.by_category_other
                ? `<span class="text-slate-400">未分類／其他 ${data.competitions.by_category_other}</span>` : '');
    }

    // ── 效能現況 ──
    const perfBox = document.getElementById('opsPerfBox');
    if (perfBox) {
        const perf = data.perf || {};
        const posters = perf.posters || {};
        const paging = perf.paging || {};
        const timings = Object.entries(perf.timings || {})
            .map(([k, v]) => `${OPS_TIMING_LABELS[k] || k} ${v}ms`).join('、');
        perfBox.innerHTML = `
            <div class="rounded-lg border border-slate-200 p-3 space-y-1.5 text-[11px] text-slate-600">
                <p class="text-xs font-semibold text-slate-700">⚡ 效能現況</p>
                <p>海報：${posters.count} 張、原圖共 ${escapeHtml(posters.total_label || '0 B')}${posters.thumb_count
            ? `；其中 ${posters.thumb_count} 張有縮圖（${escapeHtml(posters.thumb_label || '')}），列表可少載約 ${escapeHtml(posters.thumb_saved_label || '')}`
            : '（尚無縮圖；重新上傳海報時會自動產生，舊海報不受影響）'}</p>
                <p>分頁：賽事列表單次上限 ${paging.competitions_max} 筆、報名名單 ${paging.registrations_max} 筆（沒帶 limit 的請求行為完全不變）</p>
                <p>這次查詢耗時：${escapeHtml(timings || '—')}，合計 ${perf.total_ms || 0} ms</p>
                <p>索引：${(perf.indexes || []).length} 個隨 migration 建立（${escapeHtml((perf.indexes || []).map((i) => i.table).filter((v, i, a) => a.indexOf(v) === i).join('、'))}）</p>
            </div>`;
    }

    // ── 其他資訊 ──
    const meta = document.getElementById('opsStatsMeta');
    if (meta) {
        const at = data.generated_at ? new Date(data.generated_at) : null;
        const time = at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString('zh-TW', { hour12: false }) : '';
        meta.textContent = `${time} 產生${data.cached ? '（快取）' : ''}，涵蓋近 ${data.trend_days} 天`;
    }

    const hint = document.getElementById('opsStatsHint');
    if (hint) {
        const list = data.unavailable_sections || [];
        if (list.length) {
            hint.classList.remove('hidden');
            hint.textContent = `以下區塊暫時讀不到（不影響其他數字）：${list.map((s) => `${s.section}（${s.reason}）`).join('；')}`;
        } else {
            hint.classList.add('hidden');
        }
    }
}

async function loadOpsStats(force) {
    if (opsStatsLoading) return;
    opsStatsLoading = true;
    const statusEl = document.getElementById('opsStatsStatus');
    if (statusEl) {
        statusEl.classList.remove('hidden');
        statusEl.className = 'text-[11px] text-slate-500';
        statusEl.textContent = '載入中…';
    }
    try {
        const res = await customFetch(`/api/admin/stats?days=${opsStatsDays}${force ? '&fresh=1' : ''}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `讀取統計失敗（HTTP ${res.status}）`);
        renderOpsStats(data);
        if (statusEl) statusEl.classList.add('hidden');
    } catch (err) {
        if (statusEl) {
            statusEl.classList.remove('hidden');
            statusEl.className = 'text-[11px] text-red-600';
            statusEl.textContent = err.message;
        }
    } finally {
        opsStatsLoading = false;
    }
}


/* ============================================================
 * v3.1.0：成績與結果（P1-3）
 * ------------------------------------------------------------
 * 前台：已公布的賽事多一顆「🏆 成績」→ 名次表（前三名領獎台）。
 * 後台：「🏆 成績登錄」→ 名單、成績、狀態、名次一次填完，
 *      可以一鍵依成績自動排名，確認後公布（可同時推播通知參賽者）。
 * 名次怎麼算、什麼狀態不能排名、公布前的檢查都走 CMResults（與後端同一份）。
 * ============================================================ */

const cmResultsState = {
    competitionId: null,
    name: '',
    entries: [],
    orphan: [],
    stats: null,
    checklist: null,
    published: false,
    publishedAt: null,
    publishedBy: null,
    summary: null,
    saving: false
};

function canManageResults() {
    return !!currentUser && ['admin', 'super_admin', 'web_owner'].includes(currentUser.role);
}

/* 卡片上的成績按鈕：已公布＝每個人都看得到；管理員多一顆登錄／修改與列印 */
function resultCardButtonsHtml(item) {
    const published = !!item.result_published_at;
    let html = '';
    if (published) {
        html += `<button data-action="view-results" data-id="${item.id}"
                    class="text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded transition">
                    🏆 成績</button>`;
        html += `<button data-action="print-results" data-id="${item.id}"
                    class="text-xs text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded transition">
                    🖨️ 列印成績</button>`;
    }
    if (canManageResults()) {
        html += `<button data-action="print-roster" data-id="${item.id}"
                    class="text-xs text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded transition">
                    🖨️ 列印名單</button>`;
    }
    if (canManageResults()) {
        html += `<button data-action="edit-results" data-id="${item.id}"
                    class="text-xs text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded transition">
                    ${published ? '✏️ 修改成績' : '🏆 成績登錄'}</button>`;
    }
    return html;
}

/* ---------- 前台：成績表 ---------- */

function resultsPodiumHtml(stats) {
    const podium = (stats && stats.podium) || [];
    if (!podium.length) return '';
    return `
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
            ${podium.map((p) => `
                <div class="border border-slate-200 rounded-lg p-3 bg-slate-50">
                    <p class="text-sm font-bold text-slate-800">${escapeHtml(p.medal)} ${escapeHtml(String(p.name))}</p>
                    <p class="text-xs text-slate-500 mt-0.5">${escapeHtml(CMResults.formatRank(p.rank))} · ${escapeHtml(String(p.score))}</p>
                </div>`).join('')}
        </div>`;
}

function resultsTableHtml(rows, highlightName) {
    if (!rows.length) return '<p class="text-sm text-slate-400 py-4 text-center">沒有成績紀錄</p>';
    return `
        <div class="overflow-x-auto">
            <table class="w-full text-sm">
                <thead>
                    <tr class="text-left text-xs text-slate-500 border-b border-slate-200">
                        <th class="py-2 pr-3">名次</th><th class="py-2 pr-3">姓名</th>
                        <th class="py-2 pr-3">成績</th><th class="py-2 pr-3">狀態</th><th class="py-2">備註</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map((r) => `
                        <tr class="border-b border-slate-100 ${highlightName && r.username === highlightName ? 'bg-blue-50' : ''}">
                            <td class="py-2 pr-3 font-medium text-slate-800">${escapeHtml(r.medal ? r.medal + ' ' : '')}${escapeHtml(CMResults.formatRank(r.rank))}</td>
                            <td class="py-2 pr-3 text-slate-700 cm-break">${escapeHtml(String(r.display_name || r.username || '（未具名）'))}${highlightName && r.username === highlightName ? ' <span class="text-xs text-blue-600">（你）</span>' : ''}</td>
                            <td class="py-2 pr-3 text-slate-700">${escapeHtml(CMResults.displayScoreOrStatus(r))}</td>
                            <td class="py-2 pr-3 text-slate-500 text-xs">${escapeHtml(CMResults.statusLabel(r.status))}</td>
                            <td class="py-2 text-xs text-slate-500 cm-break">${escapeHtml(r.note || '')}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
}

function resultsModalHtml(data) {
    if (!data.published) {
        return `<p class="text-sm text-slate-500 py-8 text-center">成績尚未公布${data.message ? `<br><span class="text-xs text-slate-400">${escapeHtml(data.message)}</span>` : ''}</p>`;
    }
    const rows = (data.results || []).slice().sort(CMResults.compareResults);
    const stats = data.stats || CMResults.summarize(rows);
    return `
        ${data.summary ? `<p class="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-lg p-2.5 mb-3 whitespace-pre-line">${escapeHtml(data.summary)}</p>` : ''}
        ${resultsPodiumHtml(stats)}
        <p class="text-xs text-slate-500 mb-3">
            共 ${stats.total} 筆成績｜完賽 ${stats.finished}｜已排名 ${stats.ranked}${stats.unranked ? `｜未排名 ${stats.unranked}` : ''}
            ${data.published_at ? `｜公布於 ${escapeHtml(String(data.published_at).slice(0, 16).replace('T', ' '))}${data.published_by ? '（' + escapeHtml(data.published_by) + '）' : ''}` : ''}
        </p>
        ${resultsTableHtml(rows, currentUser ? currentUser.username : null)}
        ${rows.length ? `<div class="mt-3 flex flex-wrap gap-2">
            <button id="resultsExportBtn" data-id="${data.competition ? data.competition.id : ''}"
                class="text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded transition">⬇️ 匯出成績 CSV</button>
            <button id="resultsPrintBtn" data-id="${data.competition ? data.competition.id : ''}"
                class="text-xs text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded transition">🖨️ 列印成績表</button>
        </div>` : ''}`;
}

async function openResultsModal(id) {
    const modal = document.getElementById('resultsModal');
    const body = document.getElementById('resultsModalBody');
    if (!modal || !body) return;
    body.innerHTML = '<p class="text-center text-slate-400 py-6 text-sm">載入中…</p>';
    modal.classList.remove('hidden');

    try {
        const res = await customFetch(`/api/competitions/${id}/results`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '讀取成績失敗');
        const title = document.getElementById('resultsModalTitle');
        if (title) title.textContent = `🏆 ${data.competition ? data.competition.name : ''} 成績`;

        body.innerHTML = resultsModalHtml(data);
        document.getElementById('resultsExportBtn')?.addEventListener('click', () => exportResultsCsv(id));
        document.getElementById('resultsPrintBtn')?.addEventListener('click', () => openPrintResults(id));
    } catch (err) {
        body.innerHTML = `<p class="text-sm text-red-600 py-4">❌ ${escapeHtml(err.message)}</p>`;
    }
}

async function exportResultsCsv(id) {
    try {
        const res = await customFetch(`/api/competitions/${id}/results`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '讀取成績失敗');
        if (!Array.isArray(data.results) || !data.results.length) return alert('這場賽事沒有可匯出的成績');
        const name = (data.competition && data.competition.name) || 'competition';
        downloadCsvBlob(`成績-${name}.csv`, new Blob([CMCSV.stringify(CMResults.csvRows(data.results), { bom: true })], { type: 'text/csv;charset=utf-8' }));
    } catch (err) {
        alert('❌ 匯出失敗：' + err.message);
    }
}

/* ---------- 我的成績（我的報名裡顯示名次） ---------- */

let myResults = [];

async function fetchMyResults() {
    if (!currentUser) { myResults = []; return; }
    try {
        const res = await customFetch('/api/my/results');
        if (!res.ok) { myResults = []; return; }
        const data = await res.json();
        myResults = Array.isArray(data) ? data : [];
    } catch (err) {
        myResults = [];
    }
}

/* 我的報名卡片上的一行成績（沒有公布就什麼都不顯示，不要寫「尚未公布」洗版） */
function myResultHtml(competitionId) {
    const hit = myResults.find((r) => String(r.competition_id) === String(competitionId));
    if (!hit) return '';
    const parts = [hit.rank ? `${hit.medal || ''} ${CMResults.formatRank(hit.rank)}` : CMResults.statusLabel(hit.status)];
    const score = CMResults.displayScoreOrStatus(hit);
    if (score && score !== '—') parts.push(score);
    return `<p class="text-xs text-emerald-700 mt-0.5">🏆 成績：${escapeHtml(parts.join(' · '))}</p>`;
}

/* ---------- 後台：成績登錄 ---------- */

function resultStatusOptionsHtml(selected) {
    const current = CMResults.normalizeStatus(selected);
    return CMResults.RESULT_STATUSES
        .map((s) => `<option value="${s.id}"${s.id === current ? ' selected' : ''}>${s.emoji} ${s.label}</option>`)
        .join('');
}

function resultsEditorRowsHtml() {
    const entries = cmResultsState.entries;
    if (!entries.length) {
        return '<p class="text-sm text-slate-400 py-4 text-center">這場賽事還沒有「已核准」的報名，先審核報名再來登錄成績</p>';
    }
    return `
        <div class="overflow-x-auto">
            <table class="w-full text-sm" id="resultsEditorTable">
                <thead>
                    <tr class="text-left text-xs text-slate-500 border-b border-slate-200">
                        <th class="py-2 pr-2">姓名</th>
                        <th class="py-2 pr-2 w-28">成績</th>
                        <th class="py-2 pr-2 w-32">狀態</th>
                        <th class="py-2 pr-2 w-20">名次</th>
                        <th class="py-2 w-40">備註</th>
                    </tr>
                </thead>
                <tbody>
                    ${entries.map((e) => `
                        <tr class="border-b border-slate-100" data-registration-id="${e.registration_id}">
                            <td class="py-1.5 pr-2 text-slate-700 cm-break">
                                ${escapeHtml(String(e.display_name || e.username || ''))}
                                ${e.existing ? '<span class="text-xs text-emerald-600">已登錄</span>' : '<span class="text-xs text-slate-400">未登錄</span>'}
                            </td>
                            <td class="py-1.5 pr-2">
                                <input data-field="score_text" value="${escapeHtml(e.score_text || '')}" maxlength="${CMResults.SCORE_MAX}"
                                    placeholder="12:34.5" class="w-24 border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400">
                            </td>
                            <td class="py-1.5 pr-2">
                                <select data-field="status" class="w-32 border border-slate-300 rounded px-2 py-1 text-sm">
                                    ${resultStatusOptionsHtml(e.status)}
                                </select>
                            </td>
                            <td class="py-1.5 pr-2">
                                <input data-field="rank" type="number" min="1" step="1" value="${e.rank === null || e.rank === undefined ? '' : e.rank}"
                                    class="w-16 border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400">
                            </td>
                            <td class="py-1.5">
                                <input data-field="note" value="${escapeHtml(e.note || '')}" maxlength="${CMResults.NOTE_MAX}"
                                    class="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400">
                            </td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
}

function resultsEditorStatusHtml() {
    const { stats, checklist, published } = cmResultsState;
    const lines = [];
    if (stats) {
        lines.push(`共 ${stats.total} 筆｜完賽 ${stats.finished}｜已排名 ${stats.ranked}${stats.unranked ? `｜未排名 ${stats.unranked}` : ''}`);
    }
    const notices = [];
    if (checklist) {
        if (checklist.missing_count) notices.push(`還有 ${checklist.missing_count} 位已核准參賽者沒有成績：${checklist.missing.slice(0, 5).map((m) => m.display_name).join('、')}${checklist.missing_count > 5 ? '…' : ''}`);
        if (checklist.duplicate_ranks.length) notices.push(`名次重複：${checklist.duplicate_ranks.map((d) => `第 ${d.rank} 名 ×${d.count}`).join('、')}（並列是正常的，僅提醒）`);
        if (checklist.rank_gaps.length) notices.push(`名次跳號：${checklist.rank_gaps.join('、')}`);
    }
    return `
        <p class="text-xs ${published ? 'text-emerald-700' : 'text-amber-700'}">
            ${published ? `✅ 已公布（${escapeHtml(String(cmResultsState.publishedAt || '').slice(0, 16).replace('T', ' '))}${cmResultsState.publishedBy ? '，' + escapeHtml(cmResultsState.publishedBy) : ''}）` : '📝 草稿狀態：前台還看不到，填好後按「公布結果」'}
        </p>
        ${lines.length ? `<p class="text-xs text-slate-500 mt-1">${escapeHtml(lines.join('｜'))}</p>` : ''}
        ${notices.length ? `<ul class="text-xs text-amber-700 mt-1 list-disc list-inside space-y-0.5">${notices.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : '<p class="text-xs text-emerald-600 mt-1">✅ 每位已核准參賽者都有成績</p>'}
        ${cmResultsState.orphan.length ? `<p class="text-xs text-slate-500 mt-1">另有 ${cmResultsState.orphan.length} 筆成績的報名已不在名單中（例如後來取消錄取），這些成績會保留但記得確認：${escapeHtml(cmResultsState.orphan.slice(0, 3).map((o) => o.display_name).join('、'))}</p>` : ''}`;
}

function resultsEditorError(message, isError) {
    const box = document.getElementById('resultsEditorError');
    if (!box) return;
    if (!message) { box.classList.add('hidden'); box.textContent = ''; return; }
    box.textContent = message;
    box.className = isError
        ? 'text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5 mb-3'
        : 'text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 mb-3';
}

function renderResultsEditor() {
    const body = document.getElementById('resultsEditorBody');
    if (!body) return;
    body.innerHTML = resultsEditorRowsHtml() + `<div id="resultsEditorStatus" class="mt-3 space-y-1">${resultsEditorStatusHtml()}</div>`;

    const summaryInput = document.getElementById('resultsSummaryInput');
    if (summaryInput) summaryInput.value = cmResultsState.summary || '';

    const publishBtn = document.getElementById('resultsPublishBtn');
    if (publishBtn) publishBtn.textContent = cmResultsState.published ? '🔁 重新公布（更新內容）' : '🏁 公布結果';
    const unpublishBtn = document.getElementById('resultsUnpublishBtn');
    if (unpublishBtn) unpublishBtn.classList.toggle('hidden', !cmResultsState.published);
}

async function openResultsEditor(id) {
    if (!canManageResults()) return;
    const modal = document.getElementById('resultsEditorModal');
    const body = document.getElementById('resultsEditorBody');
    if (!modal || !body) return;
    body.innerHTML = '<p class="text-center text-slate-400 py-6 text-sm">載入中…</p>';
    resultsEditorError(null);
    modal.classList.remove('hidden');

    try {
        const res = await customFetch(`/api/competitions/${id}/result-sheet`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '讀取成績表失敗');

        Object.assign(cmResultsState, {
            competitionId: data.competition ? data.competition.id : id,
            name: data.competition ? data.competition.name : '',
            entries: data.entries || [],
            orphan: data.orphan || [],
            stats: data.stats || null,
            checklist: data.checklist || null,
            published: !!data.published,
            publishedAt: data.published_at || null,
            publishedBy: data.published_by || null,
            summary: data.summary || null,
            saving: false
        });
        const title = document.getElementById('resultsEditorTitle');
        if (title) title.textContent = `🏆 ${cmResultsState.name} 成績登錄`;
        renderResultsEditor();
    } catch (err) {
        body.innerHTML = `<p class="text-sm text-red-600 py-4">❌ ${escapeHtml(err.message)}</p>`;
    }
}

/* 讀出畫面上每一列的輸入值（不猜、不填預設值——空白就是空白） */
function readResultsEditor() {
    const table = document.getElementById('resultsEditorTable');
    if (!table) return [];
    return Array.from(table.querySelectorAll('tr[data-registration-id]')).map((tr) => {
        const get = (field) => {
            const el = tr.querySelector(`[data-field="${field}"]`);
            return el ? el.value : '';
        };
        return {
            registration_id: Number(tr.dataset.registrationId),
            score_text: get('score_text').trim(),
            status: get('status'),
            rank: get('rank').trim(),
            note: get('note').trim()
        };
    });
}

async function saveResults(options) {
    const opts = options || {};
    if (!cmResultsState.competitionId || cmResultsState.saving) return;
    cmResultsState.saving = true;
    resultsEditorError(null);

    const payload = {
        results: readResultsEditor().filter((r) => r.score_text || r.rank || r.status !== 'finished' || r.note),
        auto_rank: !!opts.autoRank,
        order: opts.order === 'desc' ? 'desc' : 'asc'
    };

    try {
        const res = await customFetch(`/api/competitions/${cmResultsState.competitionId}/results`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '儲存失敗');

        cmResultsState.stats = data.stats || cmResultsState.stats;
        cmResultsState.checklist = data.checklist || cmResultsState.checklist;
        resultsEditorError(`✅ ${data.message}${data.auto_ranked ? '（已依成績自動排名）' : ''}`, false);
        await refreshResultsEditor();
        return data;
    } catch (err) {
        resultsEditorError('❌ ' + err.message, true);
    } finally {
        cmResultsState.saving = false;
    }
}

/* 重讀後端資料（儲存後要拿到最新的名次與檢查結果，不要用前端自己算的） */
async function refreshResultsEditor() {
    const res = await customFetch(`/api/competitions/${cmResultsState.competitionId}/result-sheet`);
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (!data || !data.entries) return;
    cmResultsState.entries = data.entries;
    cmResultsState.orphan = data.orphan || [];
    cmResultsState.stats = data.stats || null;
    cmResultsState.checklist = data.checklist || null;
    cmResultsState.published = !!data.published;
    cmResultsState.publishedAt = data.published_at || null;
    cmResultsState.publishedBy = data.published_by || null;
    renderResultsEditor();
}

async function saveResultsAndRank(order) {
    if (!cmResultsState.entries.length) return;
    await saveResults({ autoRank: true, order });
}

async function publishResultsFromEditor() {
    if (!cmResultsState.competitionId) return;
    const notifyBox = document.getElementById('resultsPublishNotify');
    const notify = !!(notifyBox && notifyBox.checked);
    const summaryInput = document.getElementById('resultsSummaryInput');
    const summary = summaryInput ? summaryInput.value.trim() : '';

    // 先把畫面上的輸入存起來，避免使用者以為「公布」會一起存卻沒存到
    const saved = await saveResults({});
    if (saved === undefined) return;

    const label = cmResultsState.published ? '重新公布' : '公布';
    const extra = notify ? '\n並推播通知所有有訂閱的參賽者。' : '';
    if (!confirm(`確定要${label}「${cmResultsState.name}」的成績嗎？\n${label}後所有訪客都看得到。${extra}`)) return;

    try {
        const res = await customFetch(`/api/competitions/${cmResultsState.competitionId}/results/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true, notify, summary })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '公布失敗');

        const pushNote = notify
            ? `，通知 ${data.notified ? data.notified.sent : 0} 位（失敗 ${data.notified ? data.notified.failed : 0} 位${data.notified && data.notified.skipped ? '：' + data.notified.skipped : ''}）`
            : '';
        resultsEditorError(`✅ ${data.message}${pushNote}`, false);
        await refreshResultsEditor();
        await fetchCompetitions();
    } catch (err) {
        resultsEditorError('❌ ' + err.message, true);
    }
}

async function unpublishResultsFromEditor() {
    if (!cmResultsState.competitionId) return;
    if (!confirm(`確定要取消公布「${cmResultsState.name}」的成績嗎？\n取消後前台立刻看不到（成績會保留成草稿）。`)) return;
    try {
        const res = await customFetch(`/api/competitions/${cmResultsState.competitionId}/results/unpublish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '取消失敗');
        resultsEditorError(`✅ ${data.message}`, false);
        await refreshResultsEditor();
        await fetchCompetitions();
    } catch (err) {
        resultsEditorError('❌ ' + err.message, true);
    }
}

/* ---------- v3.2.0（P1-7）：名單與成績的列印版 ---------- */

// 目前預覽中的列印資料：原始資料留住，切換選項時不必重新抓
let printState = { kind: null, comp: null, raw: [], model: null };

function printOptions() {
    const checked = (id, fallback) => {
        const el = document.getElementById(id);
        return el ? el.checked : fallback;
    };
    return {
        includeWaitlist: checked('printIncludeWaitlist', true),
        includePending: checked('printIncludePending', false),
        signColumn: checked('printSignColumn', true),
        orientation: checked('printLandscape', false) ? 'landscape' : 'portrait'
    };
}

function renderPrintPreview() {
    const wrap = document.getElementById('printScaleWrap');
    if (!wrap) return;
    if (!printState.model) {
        wrap.innerHTML = '<p class="text-center text-slate-500 py-10 text-sm">沒有可列印的資料</p>';
        return;
    }
    wrap.innerHTML = CMPrintDoc.toHtml(printState.model);
    const note = document.getElementById('printModalNote');
    if (note) note.textContent = CMPrintDoc.summaryText(printState.model);
}

function rebuildPrintModel() {
    if (!printState.comp) return;
    const opts = printOptions();
    printState.model = printState.kind === 'results'
        ? CMPrintDoc.resultModel(printState.comp, printState.raw, opts)
        : CMPrintDoc.rosterModel(printState.comp, printState.raw, opts);
    renderPrintPreview();
}

function openPrintModal(kind, comp, raw) {
    printState = { kind, comp, raw: raw || [], model: null };
    const modal = document.getElementById('printModal');
    const title = document.getElementById('printModalTitle');
    if (!modal) return;
    if (title) title.textContent = kind === 'results' ? '🖨️ 列印成績表' : '🖨️ 列印報名名單';
    // 待審核只有管理員需要，成績表沒有這個選項
    const pendingLabel = document.getElementById('printIncludePendingLabel');
    if (pendingLabel) pendingLabel.classList.toggle('hidden', kind !== 'roster');
    const waitLabel = document.getElementById('printIncludeWaitlistLabel');
    if (waitLabel) waitLabel.classList.toggle('hidden', kind !== 'roster');
    modal.classList.remove('hidden');
    rebuildPrintModel();
}

function closePrintModal() {
    document.getElementById('printModal')?.classList.add('hidden');
    printState = { kind: null, comp: null, raw: [], model: null };
}

/* 列印報名名單（管理員以上；名單含未審核資訊，所以不開放給一般使用者） */
async function openPrintRoster(id) {
    if (!canManageResults()) return alert('權限不足：只有管理員以上可以列印報名名單。');
    const item = allCompetitions.find((c) => String(c.id) === String(id));
    try {
        const res = await customFetch(`/api/competitions/${id}/registrations`);
        if (!res.ok) throw new Error('讀取報名名單失敗');
        const payload = await res.json();
        const list = Array.isArray(payload) ? payload : (payload.registrations || []);
        openPrintModal('roster', item || { id, name: '' }, list);
    } catch (err) {
        alert('❌ 列印名單失敗：' + err.message);
    }
}

/* 列印成績表：已公布時任何人都能印（與前台看得到的內容一致） */
async function openPrintResults(id) {
    const item = allCompetitions.find((c) => String(c.id) === String(id));
    try {
        const res = await customFetch(`/api/competitions/${id}/results`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '讀取成績失敗');
        if (!data.published) return alert('成績尚未公布，沒有可列印的成績表。');
        openPrintModal('results', data.competition || item || { id, name: '' }, data.results || []);
    } catch (err) {
        alert('❌ 列印成績失敗：' + err.message);
    }
}

function bindPrintModalEvents() {
    const modal = document.getElementById('printModal');
    if (!modal || modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';
    document.getElementById('printModalClose')?.addEventListener('click', closePrintModal);
    document.getElementById('printDoBtn')?.addEventListener('click', () => {
        if (!printState.model) return;
        window.print();
    });
    ['printIncludeWaitlist', 'printIncludePending', 'printSignColumn', 'printLandscape'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => rebuildPrintModel());
    });
}

function initResultsUi() {
    document.getElementById('resultsSaveBtn')?.addEventListener('click', () => saveResults({}));
    document.getElementById('resultsAutoRankAscBtn')?.addEventListener('click', () => saveResultsAndRank('asc'));
    document.getElementById('resultsAutoRankDescBtn')?.addEventListener('click', () => saveResultsAndRank('desc'));
    document.getElementById('resultsPublishBtn')?.addEventListener('click', publishResultsFromEditor);
    document.getElementById('resultsUnpublishBtn')?.addEventListener('click', unpublishResultsFromEditor);
    document.getElementById('resultsModalClose')?.addEventListener('click', () => document.getElementById('resultsModal')?.classList.add('hidden'));
    document.getElementById('resultsEditorClose')?.addEventListener('click', () => document.getElementById('resultsEditorModal')?.classList.add('hidden'));
}

/* v3.6.3：卡片的公告區（取消／延期／最新消息）——不依賴推播訂閱，人人看得到 */
function noticeBannerHtml(item) {
    if (!window.CMCompetitionState || !CMCompetitionState.competitionNotice) return '';
    const notice = CMCompetitionState.competitionNotice(item);
    if (!notice.has_notice) return '';
    const blocks = [];
    if (notice.cancelled) {
        blocks.push(`<p class="text-xs font-bold text-red-700">⛔ 賽事已取消${notice.cancel_reason ? `：${escapeHtml(notice.cancel_reason)}` : ''}</p>`);
    }
    if (notice.postponed) {
        blocks.push(`<p class="text-xs font-bold text-amber-700">🕒 賽事延期至 ${escapeHtml(notice.postponed_label)}`
            + ` <span class="font-normal">（原訂 ${escapeHtml(String(item.date || '日期未定'))}）</span></p>`);
    }
    if (notice.news) {
        // 用本地時區顯示（澳門 UTC+8）：直接切 ISO 字串會顯示 UTC 時間，差 8 小時
        let when = '';
        if (notice.news_updated_at) {
            const d = new Date(notice.news_updated_at);
            when = isNaN(d.getTime()) ? ''
                : `（${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 更新）`;
        }
        blocks.push(`<p class="text-xs text-slate-700">📣 ${escapeHtml(notice.news)}<span class="text-slate-500">${when}</span></p>`);
    }
    const tone = notice.cancelled ? 'bg-red-50 border-red-200'
        : (notice.postponed ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200');
    return `<div class="${tone} border rounded-lg px-3 py-2 space-y-1">${blocks.join('')}</div>`;
}

function competitionCardHtml(item) {
    return `
        <div class="cm-card border border-slate-200 rounded-xl p-5 hover:border-slate-300 transition bg-white shadow-sm flex flex-col md:flex-row justify-between gap-4" data-comp-id="${escapeHtml(String(item.id))}">
            <div class="cm-card-body space-y-2 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="text-base font-bold text-slate-800 cm-break">${escapeHtml(item.name)}</h3>
                    ${item.publisher_name ? `<span class="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-medium" title="權限層級：${escapeHtml(getRoleLabel(item.publisher_role, item.publisher_name))}"><span>${getRoleEmoji(item.publisher_role, item.publisher_name)}</span> <span>${escapeHtml(item.publisher_name)}</span></span>` : ''}
                    ${categoryBadgeHtml(item)}
                    ${regStatusBadgeHtml(item)}
                    ${item.is_team_event ? '<span class="bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded-full font-medium">👥 組隊比賽</span>' : ''}
                    ${item.poster_updated_at ? '<span class="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full font-medium">🖼️ 自訂海報</span>' : ''}
                    ${getBadgeStatus(item.date)}
                </div>

                ${noticeBannerHtml(item)}
                
                ${item.poster_thumb_url ? `
                    <button type="button" data-action="share-poster" data-id="${item.id}"
                        class="block w-full sm:w-52 text-left rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-300"
                        title="點一下看完整海報">
                        <img src="${escapeHtml(item.poster_thumb_url)}" alt="${escapeHtml(item.name)} 的海報"
                            loading="lazy" decoding="async"
                            class="w-full sm:w-52 h-28 object-cover rounded-lg border border-slate-200 bg-slate-50">
                    </button>` : ''}

                <div class="cm-meta-grid text-xs text-slate-500">
                    ${item.location ? `<span>📍 ${escapeHtml(item.location)}</span>` : ''}
                    ${mapLinkHtml(item)}
                    ${staffChipHtml(item)}
                    ${item.date ? `<span>📅 開始：${escapeHtml(item.date)} ${item.time ? format24HourTime(escapeHtml(item.time)) : ''}</span>` : ''}
                    ${item.end_date ? `<span>📅 結束：${escapeHtml(item.end_date)} ${item.end_time ? format24HourTime(escapeHtml(item.end_time)) : ''}</span>` : ''}
                </div>

                ${(Array.isArray(item.tags) && item.tags.length) ? `<div class="flex flex-wrap gap-1">${tagsBadgeHtml(item)}</div>` : ''}

                <div class="cm-meta-grid text-xs text-slate-500">
                    ${regMetaHtml(item)}
                </div>

                ${item.description ? `<p class="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-lg whitespace-pre-line border border-slate-100">${escapeHtml(item.description)}</p>` : ''}
            </div>

            <div class="cm-card-actions flex items-start gap-1.5 self-end md:self-start flex-wrap">
                <button data-action="copy-text" 
                        data-name="${escapeHtml(item.name)}" 
                        data-date="${item.date || ''}" 
                        data-end-date="${item.end_date || ''}" 
                        data-location="${escapeHtml(item.location || '')}"
                        class="text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded transition">
                    📋 複製文字
                </button>

                <button data-action="share-poster" data-id="${item.id}"
                        class="text-xs text-purple-700 hover:text-purple-900 bg-purple-50 hover:bg-purple-100 px-2.5 py-1 rounded transition font-medium">
                    🖼️ 分享海報
                </button>

                ${item.doc_url ? `
                <a href="${escapeHtml(item.doc_url)}" target="_blank" rel="noopener noreferrer"
                   title="${escapeHtml((item.doc_label || '賽事規程') + '（PDF，另開新視窗）')}"
                   class="text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 px-2.5 py-1 rounded transition font-medium">
                    📘 ${escapeHtml(item.doc_label || '規程')}
                </a>` : ''}

                ${registrationButtonHtml(item)}

                <button data-action="toggle-subscribe" data-id="${item.id}"
                        class="text-xs ${isSubscribed(item.id) ? 'text-emerald-700 bg-emerald-100 hover:bg-emerald-200 font-medium' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'} px-2.5 py-1 rounded transition">
                    ${isSubscribed(item.id) ? '🔔 已訂閱' : '🔕 訂閱提醒'}
                </button>

                ${resultCardButtonsHtml(item)}

                ${isAdminUser() ? `
                    <button data-action="copy-comp" data-id="${item.id}" class="text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded transition">複製發佈</button>
                    <button data-action="edit-comp" data-id="${item.id}" class="text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded transition">編輯</button>
                    <button data-action="manage-teams" data-id="${item.id}" class="text-xs text-emerald-700 hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded transition">👥 報名／隊伍</button>
                    <button data-action="manage-staff" data-id="${item.id}" class="text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded transition">🧑‍⚖️ 工作人員</button>
                    <button data-action="manage-notice" data-id="${item.id}" class="text-xs ${(item.cancelled_at || item.postponed_date || item.news) ? 'text-red-700 bg-red-50 hover:bg-red-100 font-medium' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'} px-2.5 py-1 rounded transition">📣 公告／取消</button>
                    <button data-action="duplicate-comp" data-id="${item.id}" class="text-xs text-purple-600 hover:text-purple-800 bg-purple-50 hover:bg-purple-100 px-2.5 py-1 rounded transition">📄 複製賽事</button>
                    <button data-action="recurrence-comp" data-id="${item.id}" class="text-xs ${item.recurrence ? 'text-amber-700 bg-amber-50 hover:bg-amber-100 font-medium' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'} px-2.5 py-1 rounded transition">🔁 ${item.recurrence ? recurrenceRuleLabel(item.recurrence) : '週期'}</button>
                    <button data-action="delete-comp" data-id="${item.id}" class="text-xs text-red-600 hover:text-red-800 bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded transition">刪除</button>
                ` : ''}
            </div>
        </div>
    `;
}

async function handleFormSubmit(e) {
    e.preventDefault();
    if (!currentUser) return alert('請先登入');

    const editingId = document.getElementById('editingId').value;
    const payload = {
        name: document.getElementById('name').value,
        location: document.getElementById('location').value,
        // v2.27.0：地圖連結（留空＝用地址自動產生；後端會驗格式，不安全的一律拒絕）
        map_url: (document.getElementById('mapUrl') || {}).value || '',
        date: document.getElementById('date').value,
        time: getSelectedTime('start_hour', 'start_minute'),
        end_date: document.getElementById('end_date').value,
        end_time: getSelectedTime('end_hour', 'end_minute'),
        description: document.getElementById('description').value,
        is_registration_open: document.getElementById('is_registration_open').checked,
        category: document.getElementById('category').value,
        tags: parseTagInput(document.getElementById('tags').value),
        // v2.9.0：組隊比賽與報名設定
        is_team_event: document.getElementById('is_team_event').checked,
        team_size: Number(document.getElementById('team_size').value) || 0,
        max_registrations: Number(document.getElementById('max_registrations').value) || 0,
        // v2.19.0：報名視窗改用 datetime-local（可精確到分）。帶時區位移的 ISO 字串同時相容
        // timestamp 與 timestamptz 兩種欄位型別；registration_deadline 仍寫入（舊資料／舊前端相容）。
        registration_start_at: localInputToIso(document.getElementById('registration_start_at').value),
        registration_end_at: localInputToIso(document.getElementById('registration_end_at').value),
        registration_deadline: (document.getElementById('registration_end_at').value || '').slice(0, 10) || null,
        // v2.20.0：報名審核與候補（資料庫尚未 migration 時後端不會帶，功能自動停用）
        requires_approval: !!document.getElementById('requires_approval').checked,
        waitlist_enabled: !!document.getElementById('waitlist_enabled').checked
    };

    const url = editingId ? `/api/competitions/${editingId}` : '/api/competitions';
    const method = editingId ? 'PUT' : 'POST';

    try {
        const res = await customFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            // 把後端訊息帶出來（例如資料庫尚未執行 migration 時的明確指示）
            const errJson = await res.json().catch(() => ({}));
            throw new Error(errJson.error || errJson.message || '儲存失敗');
        }

        const saved = await res.json().catch(() => ({}));
        const savedId = (saved && saved.id) || editingId;

        resetForm();
        clearTeamFormFields();

        // v2.10.0：有選海報就先上傳，再重新載入列表
        let posterError = '';
        if (pendingPoster && savedId) {
            try {
                await uploadPoster(savedId, pendingPoster.dataUrl, pendingPoster.thumbDataUrl);
            } catch (err) {
                posterError = err.message;
            }
        }
        clearPendingPoster();

        await fetchCompetitions();
        const saveWarning = (saved && saved.warning) ? `\n\n⚠️ ${saved.warning}` : '';
        alert(posterError
            ? `賽事已儲存，但海報上傳失敗：${posterError}${saveWarning}`
            : `${editingId ? '比賽更新成功！' : '賽事發佈成功！'}${saveWarning}`);
    } catch (err) {
        alert('操作失敗：' + err.message);
    }
}

function startEdit(id) {
    const item = allCompetitions.find(c => c.id === id);
    if (!item) return;

    pendingPoster = null;
    showCurrentPoster(item);
    showCurrentDoc(item);   // v3.3.0（P1-6）：規程附件

    document.getElementById('editingId').value = item.id;
    document.getElementById('name').value = item.name || '';
    document.getElementById('location').value = item.location || '';
    document.getElementById('mapUrl').value = item.map_url_custom || '';
    document.getElementById('date').value = item.date || '';
    setSelectedTime(item.time || '', 'start_hour', 'start_minute');
    document.getElementById('end_date').value = item.end_date || '';
    setSelectedTime(item.end_time || '', 'end_hour', 'end_minute');
    document.getElementById('description').value = item.description || '';
    document.getElementById('is_registration_open').checked = !!item.is_registration_open;
    document.getElementById('category').value = item.category || '';
    document.getElementById('tags').value = (Array.isArray(item.tags) ? item.tags : []).join(', ');
    document.getElementById('is_team_event').checked = !!item.is_team_event;
    document.getElementById('team_size').value = Number(item.team_size) > 0 ? item.team_size : '';
    document.getElementById('max_registrations').value = Number(item.max_registrations) > 0 ? item.max_registrations : '';
    // v2.19.0：優先帶出新的報名視窗；只有舊資料（registration_deadline，日期）時轉成當天 23:59
    const legacyEnd = item.registration_end_at
        || (item.registration_deadline ? `${String(item.registration_deadline).slice(0, 10)}T23:59` : '');
    document.getElementById('registration_start_at').value = isoToLocalInput(item.registration_start_at);
    document.getElementById('registration_end_at').value = isoToLocalInput(legacyEnd);
    // v2.20.0：審核與候補開關
    document.getElementById('requires_approval').checked = !!item.requires_approval;
    document.getElementById('waitlist_enabled').checked = !!item.waitlist_enabled;
    updateFormStatePreview();
    renderTagPreview();

    document.getElementById('formTitle').innerText = '✏️ 編輯比賽資料';
    document.getElementById('submitBtn').innerText = '儲存變更';
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function copyCompetition(id) {
    const item = allCompetitions.find(c => c.id === id);
    if (!item) return;

    clearPendingPoster();   // v2.10.0：海報不跟著複製

    document.getElementById('editingId').value = '';
    document.getElementById('name').value = `${item.name} (複製)`;
    document.getElementById('location').value = item.location || '';
    document.getElementById('mapUrl').value = item.map_url_custom || '';
    document.getElementById('date').value = item.date || '';
    setSelectedTime(item.time || '', 'start_hour', 'start_minute');
    document.getElementById('end_date').value = item.end_date || '';
    setSelectedTime(item.end_time || '', 'end_hour', 'end_minute');
    document.getElementById('description').value = item.description || '';
    document.getElementById('is_registration_open').checked = !!item.is_registration_open;
    document.getElementById('category').value = item.category || '';
    document.getElementById('tags').value = (Array.isArray(item.tags) ? item.tags : []).join(', ');
    document.getElementById('is_team_event').checked = !!item.is_team_event;
    document.getElementById('team_size').value = Number(item.team_size) > 0 ? item.team_size : '';
    document.getElementById('max_registrations').value = Number(item.max_registrations) > 0 ? item.max_registrations : '';
    // v2.19.0：優先帶出新的報名視窗；只有舊資料（registration_deadline，日期）時轉成當天 23:59
    const legacyEnd = item.registration_end_at
        || (item.registration_deadline ? `${String(item.registration_deadline).slice(0, 10)}T23:59` : '');
    document.getElementById('registration_start_at').value = isoToLocalInput(item.registration_start_at);
    document.getElementById('registration_end_at').value = isoToLocalInput(legacyEnd);
    updateFormStatePreview();
    renderTagPreview();

    document.getElementById('formTitle').innerText = '➕ 發佈新比賽 (複製內容)';
    document.getElementById('submitBtn').innerText = '發佈比賽';
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function copyToClipboard(name, date, endDate, location) {
    let dateStr = date || '未定';
    if (date && endDate) {
        dateStr = `${date} ~ ${endDate}`;
    }
    const textToCopy = `🏆 【${name}】\n📅 日期：${dateStr}\n📍 地點：${location || '未定'}\n\n👉 歡迎關注與報名！`;

    navigator.clipboard.writeText(textToCopy)
        .then(() => alert('✅ 比賽資訊已成功複製到剪貼簿！'))
        .catch(() => alert('❌ 複製失敗，請手動複製。'));
}

function resetForm() {
    updateFormStatePreview();
    document.getElementById('competitionForm').reset();
    document.getElementById('editingId').value = '';
    renderTagPreview();
    setSelectedTime('', 'start_hour', 'start_minute');
    setSelectedTime('', 'end_hour', 'end_minute');
    document.getElementById('formTitle').innerText = '➕ 發佈新比賽';
    document.getElementById('submitBtn').innerText = '發佈比賽';
    document.getElementById('cancelEditBtn').classList.add('hidden');
}

async function deleteCompetition(id) {
    if (!confirm('確定要刪除這筆比賽嗎？(資料將移至資源回收桶)')) return;

    try {
        const res = await customFetch(`/api/competitions/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('刪除失敗');
        fetchCompetitions();
    } catch (err) {
        alert(err.message);
    }
}

/* v2.25.0：頁面副標的版本號一律跟後端要（不要再寫死在 HTML，才不會又忘了改） */
async function loadAppVersion() {
    const el = document.getElementById('appSubtitle');
    if (!el) return;
    try {
        const res = await fetch('/api/version');
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.version && data.version !== 'unknown') {
            el.textContent = `發佈與管理各類賽事資訊 (v${data.version})`;
        }
    } catch (err) {
        /* 取不到就維持原文字（不顯示錯的版本號） */
    }
}

/* ── v2.24.0：複製賽事與週期性賽事 ── */
let recurrenceComp = null;

function recurrenceRuleLabel(rule) {
    const rules = window.CMCompetitionState && window.CMCompetitionState.RECURRENCE_RULES;
    return (rules && rules[rule]) || '';
}

const findCompetitionById = (id) => allCompetitions.find((c) => String(c.id) === String(id));

/* 複製賽事：設定照抄、報名與隊伍不搬（後端負責，這裡只負責問清楚與回報） */
async function duplicateCompetition(id) {
    const item = findCompetitionById(id);
    const name = item ? item.name : '這場賽事';
    if (!confirm(`要複製「${name}」嗎？\n\n會複製賽事的設定（日期、地點、分類、隊伍設定、報名時間、審核與候補），\n但不會複製報名紀錄與隊伍。`)) return;
    try {
        const res = await customFetch(`/api/competitions/${id}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '複製失敗');
        await fetchCompetitions();
        alert(`已複製成「${data.name}」\n\n別忘了改日期與報名時間。`);
    } catch (err) {
        alert(`複製失敗：${err.message}`);
    }
}

function updateRecurrenceHint(text) {
    const el = document.getElementById('recurrenceHint');
    if (!el) return;
    if (text) {
        el.textContent = text;
        return;
    }
    const rule = document.getElementById('recurrenceRule').value;
    el.textContent = rule
        ? `會用「${recurrenceRuleLabel(rule) || rule}」自動往後排：日期往後推一個週期，報名時間也一起挪。`
            + '每天一次的排程會在下一場前 30 天內建好，也可以按「立即建立下一場」馬上建。'
            + '同一個系列一次只保留一場還沒到的場次，不會一次開出好幾場。'
        : '沒有設定週期就不會自動建立任何場次；複製賽事（📄）是一次性的複製，兩者不衝突。';
}

function openRecurrenceModal(id) {
    const item = findCompetitionById(id);
    if (!item) return;
    recurrenceComp = item;
    document.getElementById('recurrenceCompName').textContent = `${item.name}（${item.date || '未填日期'}）`;
    document.getElementById('recurrenceRule').value = item.recurrence || '';
    document.getElementById('recurrenceUntil').value = String(item.recurrence_until || '').slice(0, 10);
    updateRecurrenceHint();
    document.getElementById('recurrenceModal').classList.remove('hidden');
}

function closeRecurrenceModal() {
    document.getElementById('recurrenceModal').classList.add('hidden');
    recurrenceComp = null;
}

async function saveRecurrence() {
    if (!recurrenceComp) return;
    const rule = document.getElementById('recurrenceRule').value;
    const until = document.getElementById('recurrenceUntil').value;
    const btn = document.getElementById('recurrenceSaveBtn');
    if (btn) btn.disabled = true;
    try {
        const res = await customFetch(`/api/competitions/${recurrenceComp.id}/recurrence`, {
            method: 'POST',
            body: JSON.stringify({ recurrence: rule || null, recurrence_until: until || null })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '儲存失敗');
        await fetchCompetitions();
        const synced = data.series_synced ? `（同系列 ${data.series_synced} 場一起同步）` : '';
        alert(rule ? `已設定週期：${recurrenceRuleLabel(rule)}${until ? `，重複到 ${until}` : '，一直重複'}${synced}` : '已取消週期設定');
        closeRecurrenceModal();
    } catch (err) {
        alert(`設定週期失敗：${err.message}`);
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* 立即建立下一場：後端說「還不用建」時（409）把原因顯示在視窗裡，不當成錯誤 */
async function createNextOccurrenceNow() {
    if (!recurrenceComp) return;
    const btn = document.getElementById('recurrenceNextBtn');
    if (btn) btn.disabled = true;
    try {
        const res = await customFetch(`/api/competitions/${recurrenceComp.id}/recurrence/next`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
            updateRecurrenceHint(`目前還不會建立下一場：${data.error}${data.date ? `（推算出的下一場是 ${data.date}）` : ''}`);
            return;
        }
        if (!res.ok) throw new Error(data.error || '建立失敗');
        await fetchCompetitions();
        alert(`已建立下一場：${data.name}（${data.date}）`);
        closeRecurrenceModal();
    } catch (err) {
        alert(`建立下一場失敗：${err.message}`);
    } finally {
        if (btn) btn.disabled = false;
    }
}

function toggleAuth() {
    if (currentUser) {
        handleLogout();
    } else {
        document.getElementById('loginModal').classList.remove('hidden');
    }
}

function closeLoginModal() {
    document.getElementById('loginModal').classList.add('hidden');
}

/* v2.15.0：兩步驟驗證的登入第二階段狀態（只存在記憶體，不落地） */
let pendingTwoFactor = null;
let loginTwoFactorRecoveryMode = false;

function setLoginStep(step) {
    const credentials = document.getElementById('loginCredentialsFields');
    const second = document.getElementById('login2faFields');
    const submit = document.getElementById('submitLoginBtn');
    const isSecond = step === '2fa';
    credentials?.classList.toggle('hidden', isSecond);
    second?.classList.toggle('hidden', !isSecond);
    document.getElementById('registerFields')?.classList.toggle('hidden', isSecond || !document.getElementById('registerFields')?.dataset.showing);
    if (submit) submit.innerText = isSecond ? '驗證' : (loginMode === 'register' ? '註冊並登入' : '登入');
    if (!isSecond) {
        pendingTwoFactor = null;
        loginTwoFactorRecoveryMode = false;
        const codeEl = document.getElementById('login2faCode');
        if (codeEl) codeEl.value = '';
        const useBtn = document.getElementById('login2faUseRecovery');
        if (useBtn) useBtn.innerText = '改用備援碼';
    }
}

function completeLogin(data) {
    currentUser = data.user;
    localStorage.removeItem('auth_token');   // v3.5.0：權杖在 cookie，不留任何一份在 JS 手上
    localStorage.setItem('competition_user', JSON.stringify(currentUser));
    setLoginStep('credentials');
    closeLoginModal();
    updateUIByRole();
    // v2.14.0：登入回應已附上未處理錯誤統計，直接顯示（沒有附帶資料時再自己查一次）
    if (data.alerts) renderErrorAlert(data.alerts);
    else refreshErrorAlert();
    // v2.15.0：用備援碼登入要提醒使用者補發新的備援碼
    if (data.used_recovery_code) {
        alert(`已用備援碼登入，剩下 ${data.remaining_recovery_codes} 組。\n建議到「🔐 兩步驟驗證」重新產生備援碼。`);
    }
}

async function performLogin() {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;

    try {
        const res = await customFetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (!res.ok) {
            const errJson = await res.json().catch(() => ({}));
            throw new Error(errJson.error || errJson.message || '登入失敗');
        }

        const data = await res.json();

        // v2.15.0：這個帳號啟用了兩步驟驗證 → 進入第二階段（此時還沒有登入憑證）
        if (data.requires_2fa) {
            pendingTwoFactor = data.challenge_token;
            const accountEl = document.getElementById('login2faAccount');
            if (accountEl) accountEl.textContent = data.username || username;
            setLoginStep('2fa');
            document.getElementById('login2faCode')?.focus();
            return;
        }

        completeLogin(data);
    } catch (err) {
        alert(err.message);
    }
}

/* v2.15.0：第二階段送出（驗證碼或備援碼） */
async function submitTwoFactorLogin() {
    const codeEl = document.getElementById('login2faCode');
    const code = (codeEl?.value || '').trim();
    if (!pendingTwoFactor) {
        alert('登入流程已失效，請重新輸入帳號密碼。');
        setLoginStep('credentials');
        return;
    }
    if (!code) {
        alert('請輸入驗證碼。');
        return;
    }

    try {
        const res = await customFetch('/api/auth/login/2fa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challenge_token: pendingTwoFactor, code })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || '驗證失敗，請重新輸入');
        }
        pendingTwoFactor = null;
        completeLogin(data);
    } catch (err) {
        alert(err.message);
        if (codeEl) codeEl.value = '';
    }
}

/* ---------- v2.15.0：兩步驟驗證設定視窗 ---------- */
function setTwoFactorMessage(text, kind = 'info') {
    const el = document.getElementById('twoFactorMessage');
    if (!el) return;
    if (!text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.className = 'text-xs p-2.5 rounded-lg border ' + (kind === 'error'
        ? 'bg-rose-50 border-rose-200 text-rose-700'
        : kind === 'success'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : 'bg-slate-50 border-slate-200 text-slate-600');
    el.textContent = text;
}

function renderTwoFactorStatus(info) {
    const statusEl = document.getElementById('twoFactorStatus');
    const setupSection = document.getElementById('twoFactorSetupSection');
    const enabledSection = document.getElementById('twoFactorEnabledSection');

    if (!info || info.schema_ready === false) {
        if (statusEl) {
            statusEl.className = 'text-xs p-2.5 rounded-lg border bg-amber-50 border-amber-200 text-amber-900 leading-relaxed';
            statusEl.textContent = '這項功能尚未啟用：需要先執行 migrations/2026-09-26-v2.15.0-admin-2fa.sql（在 Supabase SQL Editor 貼上執行一次即可，不影響其他功能）。';
        }
        setupSection?.classList.add('hidden');
        enabledSection?.classList.add('hidden');
        return;
    }

    if (statusEl) {
        statusEl.className = 'text-xs p-2.5 rounded-lg border ' + (info.enabled
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : 'bg-slate-50 border-slate-200 text-slate-600');
        statusEl.textContent = info.enabled
            ? `目前狀態：已啟用${info.confirmed_at ? `（綁定於 ${new Date(info.confirmed_at).toLocaleString()}）` : ''}`
            : '目前狀態：未啟用（登入只需要密碼）。建議管理員帳號啟用，避免密碼外洩就等於整個後台外洩。';
    }

    setupSection?.classList.toggle('hidden', info.enabled === true);
    enabledSection?.classList.toggle('hidden', info.enabled !== true);
    if (info.enabled) {
        const atEl = document.getElementById('twoFactorConfirmedAt');
        if (atEl) atEl.textContent = info.confirmed_at ? `綁定時間：${new Date(info.confirmed_at).toLocaleString()}` : '';
        const leftEl = document.getElementById('twoFactorRecoveryLeft');
        if (leftEl) leftEl.textContent = `尚未使用的備援碼：${info.remaining_recovery_codes} 組`;
    }
}

async function loadTwoFactorStatus() {
    try {
        const res = await customFetch('/api/auth/2fa/status');
        if (!res.ok) throw new Error('無法取得狀態');
        const info = await res.json();
        renderTwoFactorStatus(info);
    } catch (err) {
        setTwoFactorMessage(err.message, 'error');
    }
}

async function openTwoFactorModal() {
    closeNavDropdown();
    setTwoFactorMessage('');
    document.getElementById('twoFactorSetupDetail')?.classList.add('hidden');
    document.getElementById('twoFactorRecoverySection')?.classList.add('hidden');
    document.getElementById('twoFactorModal')?.classList.remove('hidden');
    await loadTwoFactorStatus();
}

async function startTwoFactorSetup() {
    setTwoFactorMessage('');
    try {
        const res = await customFetch('/api/auth/2fa/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '無法產生密鑰');
        document.getElementById('twoFactorSecret').textContent = data.secret;
        document.getElementById('twoFactorUri').textContent = data.otpauth_uri;
        document.getElementById('twoFactorSetupDetail')?.classList.remove('hidden');
        document.getElementById('twoFactorEnableCode')?.focus();
        setTwoFactorMessage(data.hint || '', 'info');
    } catch (err) {
        setTwoFactorMessage(err.message, 'error');
    }
}

async function enableTwoFactor() {
    const code = (document.getElementById('twoFactorEnableCode')?.value || '').trim();
    if (!code) return setTwoFactorMessage('請輸入 App 顯示的驗證碼。', 'error');
    setTwoFactorMessage('');
    try {
        const res = await customFetch('/api/auth/2fa/enable', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '啟用失敗');

        const list = document.getElementById('twoFactorRecoveryList');
        if (list) {
            list.innerHTML = '';
            for (const c of data.recovery_codes || []) {
                const span = document.createElement('span');
                span.className = 'bg-slate-100 border border-slate-200 rounded px-2 py-1';
                span.textContent = c;
                list.appendChild(span);
            }
        }
        document.getElementById('twoFactorRecoverySection')?.classList.remove('hidden');
        document.getElementById('twoFactorSetupDetail')?.classList.add('hidden');
        setTwoFactorMessage(data.warning || '已啟用兩步驟驗證。', 'success');
        await loadTwoFactorStatus();
    } catch (err) {
        setTwoFactorMessage(err.message, 'error');
    }
}

async function disableTwoFactor() {
    const password = document.getElementById('twoFactorDisablePassword')?.value || '';
    const code = (document.getElementById('twoFactorDisableCode')?.value || '').trim();
    if (!password || !code) return setTwoFactorMessage('停用需要你的密碼，以及一組驗證碼或備援碼。', 'error');
    setTwoFactorMessage('');
    try {
        const res = await customFetch('/api/auth/2fa/disable', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password, code })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '停用失敗');
        document.getElementById('twoFactorDisablePassword').value = '';
        document.getElementById('twoFactorDisableCode').value = '';
        document.getElementById('twoFactorEnableCode').value = '';
        setTwoFactorMessage(data.message || '已停用兩步驟驗證。', 'success');
        await loadTwoFactorStatus();
    } catch (err) {
        setTwoFactorMessage(err.message, 'error');
    }
}

function closeTwoFactorModal() {
    document.getElementById('twoFactorModal')?.classList.add('hidden');
    document.getElementById('twoFactorRecoverySection')?.classList.add('hidden');
    document.getElementById('twoFactorRecoveryList').innerHTML = '';
    setTwoFactorMessage('');
}

function getActionBadgeStyle(action) {
    switch (action) {
        case 'LOGIN_SUCCESS': return 'bg-blue-100 text-blue-700 border-blue-300';
        case 'LOGIN_FAILED': return 'bg-red-100 text-red-700 border-red-300 font-bold';
        case 'CHANGE_PASSWORD': return 'bg-emerald-100 text-emerald-700 border-emerald-300 font-bold';
        case 'PERMANENT_DELETE_COMPETITION': return 'bg-rose-100 text-rose-700 border-rose-300';
        case 'DELETE_COMPETITION': return 'bg-amber-100 text-amber-700 border-amber-300';
        case 'RESTORE_COMPETITION': return 'bg-emerald-100 text-emerald-700 border-emerald-300';
        default: return 'bg-slate-100 text-slate-700 border-slate-300';
    }
}

/* v2.18.0：資料備份與還原
   - 下載備份：走自家 API（權杖在標頭，所以不能用 window.open，要用 fetch + Blob）
   - 還原：一定要先「檢查」（dry-run，驗 checksum、列筆數），確認後才會真的寫入
   - 還原是 upsert（有就更新、沒有就新增），**不會刪除**備份中沒有的資料 */
let lastRestoreCheck = null;   // { signature, plan }：只允許還原「剛剛檢查過的同一個檔案」

function openBackupModal() {
    document.getElementById('backupModal').classList.remove('hidden');
    document.getElementById('backupStatus').classList.add('hidden');
    document.getElementById('backupResult').classList.add('hidden');
    document.getElementById('backupRestoreBtn').disabled = true;
    lastRestoreCheck = null;
}

function closeBackupModal() {
    document.getElementById('backupModal').classList.add('hidden');
}

function setBackupStatus(text, tone = 'info') {
    const el = document.getElementById('backupStatus');
    const tones = {
        info: 'bg-slate-50 border-slate-200 text-slate-700',
        ok: 'bg-emerald-50 border-emerald-200 text-emerald-800',
        warn: 'bg-amber-50 border-amber-200 text-amber-900',
        error: 'bg-red-50 border-red-200 text-red-800'
    };
    el.className = `text-[11px] p-2.5 rounded-lg border whitespace-pre-wrap ${tones[tone] || tones.info}`;
    el.textContent = text;
    el.classList.remove('hidden');
}

async function downloadBackup() {
    const btn = document.getElementById('backupDownloadBtn');
    const includePosters = document.getElementById('backupIncludePosters').checked;
    const includeLogs = document.getElementById('backupIncludeLogs').checked;
    btn.disabled = true;
    try {
        setBackupStatus('正在產生備份…（資料量較大時需要幾秒）');
        const params = new URLSearchParams();
        if (includeLogs) params.set('include_logs', 'true');
        if (!includePosters) params.set('include_posters', 'false');

        const res = await customFetch('/api/admin/backup' + (params.toString() ? '?' + params.toString() : ''));
        if (!res.ok) throw new Error('備份失敗（HTTP ' + res.status + '）');
        const text = await res.text();
        const meta = JSON.parse(text).meta || {};

        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `cm-backup-${String(meta.generated_at || new Date().toISOString()).replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);

        const tableLines = Object.entries(meta.tables || {}).map(([name, info]) => `  • ${name}：${info.rows} 筆`);
        setBackupStatus(`✅ 已下載備份（共 ${meta.total_rows} 筆，checksum ${String(meta.checksum).slice(0, 12)}…）\n${tableLines.join('\n')}`, 'ok');
    } catch (err) {
        setBackupStatus('❌ ' + err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

async function readBackupFileText() {
    const input = document.getElementById('backupFileInput');
    const file = input.files && input.files[0];
    if (!file) throw new Error('請先選擇備份檔（.json）');
    return { name: file.name, text: await file.text() };
}

// dryRun=false 才會真的寫入；`text` 可直接傳入（瀏覽器檢查用同一個函式）
async function runRestoreFromText(text, dryRun, label = '') {
    let backup;
    try {
        backup = JSON.parse(text);
    } catch (err) {
        throw new Error('備份檔不是有效的 JSON');
    }
    const resultEl = document.getElementById('backupResult');
    const res = await customFetch('/api/admin/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dryRun ? { backup, dry_run: true } : { backup, confirm: 'RESTORE' })
    });
    const data = await apiResult(res);

    if (dryRun) {
        lastRestoreCheck = { signature: `${label}|${text.length}|${backup.meta && backup.meta.checksum}`, plan: data.plan };
        renderRestoreResult(data, true);
        document.getElementById('backupRestoreBtn').disabled = false;
        setBackupStatus(`🔍 檢查完成：將還原 ${(data.plan || []).length} 張表、共 ${data.would_restore} 筆。確認無誤請按「確認還原」。（尚未寫入任何資料）`, 'warn');
    } else {
        renderRestoreResult(data, false);
        document.getElementById('backupRestoreBtn').disabled = true;
        lastRestoreCheck = null;
        setBackupStatus(data.success ? `✅ ${data.message}` : `⚠️ ${data.message}`, data.success ? 'ok' : 'error');
    }
    return data;
}

function renderRestoreResult(data, dryRun) {
    const el = document.getElementById('backupResult');
    const rows = (data.plan || []).map((item) => `
        <tr class="border-b">
            <td class="py-1 pr-3 font-mono">${escapeHtml(item.table)}</td>
            <td class="py-1 pr-3 text-right">${item.rows}</td>
            <td class="py-1 pr-3 font-mono text-slate-500">${escapeHtml(item.conflict_key)}</td>
            ${dryRun ? '' : `<td class="py-1 text-right ${data.per_table && data.per_table[item.table] === item.rows ? 'text-emerald-700' : 'text-red-600'}">${data.per_table ? data.per_table[item.table] : 0}</td>`}
        </tr>`).join('');
    el.innerHTML = `
        <p class="font-bold text-slate-700">${dryRun ? '將還原的內容' : '還原結果'}</p>
        <table class="w-full text-slate-600">
            <thead><tr class="border-b text-slate-500">
                <th class="text-left py-1 pr-3">資料表</th><th class="text-right py-1 pr-3">筆數</th>
                <th class="text-left py-1 pr-3">主鍵</th>${dryRun ? '' : '<th class="text-right py-1">已還原</th>'}
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    el.classList.remove('hidden');
}

async function runRestoreFromFile(confirm) {
    try {
        const file = await readBackupFileText();
        if (confirm) {
            if (!lastRestoreCheck) throw new Error('請先按「先檢查（不寫入）」確認內容');
            if (!confirm('確定要還原這份備份嗎？\n\n還原會依主鍵更新或新增資料（不會刪除既有資料）。')) return;
        }
        await runRestoreFromText(file.text, !confirm, file.name);
    } catch (err) {
        setBackupStatus('❌ ' + err.message, 'error');
    }
}

/* v2.17.0：一鍵把目前未處理的錯誤日誌全部標記為已處理
   與 `npm run triage`（巡檢腳本）走同一個端點；標記後首頁提示橫幅會立即更新
   （只針對「下一批新錯誤」再提醒），這也是為什麼發版時跑一次巡檢就能把清單收乾淨。 */
async function resolveAllErrorLogs() {
    const unresolvedHere = (errorLogsCache || []).filter(l => !l.resolved).length;
    const tip = '這會把所有「未處理」的錯誤日誌標記為已處理（紀錄不會被刪除，取消勾選「只看未處理」仍可查看）。';
    if (!confirm(`${tip}\n\n目前這頁有 ${unresolvedHere} 筆未處理，要繼續嗎？`)) return;

    try {
        const res = await customFetch('/api/admin/error-logs/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all_unresolved: true })
        });
        const data = await apiResult(res);
        alert('✅ ' + (data.message || `已標記 ${data.resolved} 筆為已處理`));
        await fetchErrorLogs();
        await refreshErrorAlert();
    } catch (err) {
        alert('❌ 標記失敗：' + err.message);
    }
}

/* v2.16.0：稽核日誌強化——篩選（使用者／動作／時間）、分頁、CSV 匯出、保留天數清理。
   以前只能看最近 100 筆，出事後要查「某人某段時間做了什麼」幾乎不可能。 */
const AUDIT_PAGE_SIZE = 100;
let auditQuery = { q: '', action: '', from: '', to: '', offset: 0 };

function auditBuildQuery(extra = {}) {
    const q = Object.assign({}, auditQuery, extra);
    const params = new URLSearchParams();
    params.set('limit', String(AUDIT_PAGE_SIZE));
    params.set('offset', String(q.offset || 0));
    if (q.q) params.set('q', q.q);
    if (q.action) params.set('action', q.action);
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);
    return params;
}

function readAuditFiltersFromUi() {
    return {
        q: document.getElementById('auditSearchInput').value.trim(),
        action: document.getElementById('auditActionSelect').value,
        from: document.getElementById('auditDateFrom').value,
        to: document.getElementById('auditDateTo').value,
        offset: 0
    };
}

function renderAuditActionOptions(actions) {
    const select = document.getElementById('auditActionSelect');
    if (!select || select.dataset.filled === '1') return;
    const current = select.value;
    for (const item of actions || []) {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label && item.label !== item.value ? `${item.label}（${item.value}）` : item.value;
        select.appendChild(option);
    }
    select.dataset.filled = '1';
    select.value = current;
}

function renderAuditPage(data) {
    const listEl = document.getElementById('auditLogList');
    const summaryEl = document.getElementById('auditLogSummary');
    const pageInfoEl = document.getElementById('auditPageInfo');

    if (!data.logs || data.logs.length === 0) {
        listEl.innerHTML = '<p class="text-center text-slate-400 py-4">沒有符合條件的紀錄</p>';
    } else {
        listEl.innerHTML = data.logs.map(log => {
            let detailsText = '';
            if (log.details !== null && log.details !== undefined) {
                detailsText = typeof log.details === 'object' ? JSON.stringify(log.details) : String(log.details);
            }

            return `
                <div class="p-2.5 bg-slate-50 border border-slate-200 rounded flex flex-col gap-1">
                    <div class="flex justify-between items-start">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="text-[11px] px-2 py-0.5 rounded border font-mono ${getActionBadgeStyle(log.action)}">
                                ${escapeHtml(log.action || '')}
                            </span>
                            <span class="text-slate-600 font-medium text-xs">使用者: ${escapeHtml(log.user_id || '未知')}</span>
                            ${parseUserAgentBadge(log.user_agent)}
                        </div>
                        <span class="text-slate-400 text-[11px] whitespace-nowrap ml-2">${new Date(log.created_at).toLocaleString()}</span>
                    </div>
                    ${detailsText ? `<p class="text-slate-600 text-[11px] font-mono mt-0.5">詳情: ${escapeHtmlPreserveQuotes(detailsText)}</p>` : ''}
                    ${log.user_agent ? `<p class="text-[10px] font-mono text-slate-400 bg-slate-100 p-1 rounded break-all mt-0.5">UA: ${escapeHtml(log.user_agent)}</p>` : ''}
                </div>
            `;
        }).join('');
    }

    // 摘要：顯示目前範圍與總數（正式站拿得到精確總數；拿不到時用誠實的「至少」說法）
    const from = data.returned ? data.offset + 1 : 0;
    const to = data.offset + data.returned;
    let summary = `顯示第 ${from}–${to} 筆`;
    if (typeof data.total === 'number') summary += `，共 ${data.total} 筆`;
    else summary += data.has_more ? '（可能還有更多）' : '，已到底';
    if (data.search_window) {
        summary += `　·　關鍵字搜尋僅涵蓋最近 ${data.search_window} 筆內符合的 ${data.search_matches} 筆`;
    }
    if (data.filters && (data.filters.q || data.filters.action || data.filters.from || data.filters.to)) {
        const parts = [];
        if (data.filters.q) parts.push(`關鍵字「${data.filters.q}」`);
        if (data.filters.action) parts.push(`動作 ${data.filters.action}`);
        if (data.filters.from) parts.push(`從 ${String(data.filters.from).slice(0, 10)}`);
        if (data.filters.to) parts.push(`到 ${String(data.filters.to).slice(0, 10)}`);
        summary += `　·　條件：${parts.join('、')}`;
    }
    summaryEl.textContent = summary;

    auditQuery.offset = data.offset;
    pageInfoEl.textContent = `第 ${Math.floor(data.offset / AUDIT_PAGE_SIZE) + 1} 頁`;
    document.getElementById('auditPrevBtn').disabled = data.offset <= 0;
    document.getElementById('auditNextBtn').disabled = !data.has_more;
}

async function loadAuditLogs(extra = {}) {
    // 目前條件以伺服器回傳的 filters／offset 為準（分頁才不會用到舊條件）
    auditQuery = Object.assign({}, auditQuery, extra);
    const listEl = document.getElementById('auditLogList');
    listEl.innerHTML = '<p class="text-center text-slate-400 py-4">載入日誌中...</p>';
    try {
        const res = await customFetch('/api/audit-logs?' + auditBuildQuery(extra).toString());
        if (!res.ok) throw new Error('讀取日誌失敗');
        const data = await res.json();
        if (!data || data.success !== true) throw new Error(data && data.error ? data.error : '讀取日誌失敗');
        renderAuditActionOptions(data.actions);
        renderAuditPage(data);
    } catch (err) {
        document.getElementById('auditLogSummary').textContent = '';
        document.getElementById('auditPageInfo').textContent = '';
        listEl.innerHTML = `<p class="text-center text-red-500 py-4">無法載入日誌${err && err.message ? '：' + escapeHtml(err.message) : ''}</p>`;
    }
}

async function openAuditLogModal() {
    document.getElementById('auditLogModal').classList.remove('hidden');
    document.getElementById('auditCleanupPanel').classList.add('hidden');
    auditQuery = { q: '', action: '', from: '', to: '', offset: 0 };
    await loadAuditLogs();
}

async function exportAuditLogs() {
    const btn = document.getElementById('auditExportBtn');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '匯出中…';
    try {
        const params = auditBuildQuery({ offset: 0 });
        params.delete('limit');
        params.delete('offset');
        const res = await customFetch('/api/audit-logs/export?' + params.toString());
        if (!res.ok) throw new Error('匯出失敗');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        btn.textContent = '✅ 已匯出';
        setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (err) {
        btn.textContent = '匯出失敗';
        setTimeout(() => { btn.textContent = original; }, 2000);
    } finally {
        btn.disabled = false;
    }
}

async function auditCleanup(dryRun) {
    const days = Number.parseInt(document.getElementById('auditRetentionDays').value, 10);
    const resultEl = document.getElementById('auditCleanupResult');
    const runBtn = document.getElementById('auditCleanupRunBtn');
    if (dryRun && (!Number.isFinite(days) || days < 30)) {
        resultEl.textContent = '保留天數最少 30 天。';
        return;
    }
    try {
        const res = await customFetch('/api/audit-logs/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days, dry_run: dryRun === true })
        });
        const data = await res.json();
        if (!res.ok || data.success !== true) throw new Error(data && data.error ? data.error : '操作失敗');
        if (dryRun) {
            resultEl.textContent = `將刪除 ${data.would_delete} 筆（早於 ${new Date(data.cutoff).toLocaleDateString()}）。確認無誤請按「確認刪除」。`;
            runBtn.disabled = data.would_delete === 0;
            runBtn.dataset.days = String(days);
        } else {
            resultEl.textContent = `已刪除 ${data.deleted} 筆（保留最近 ${data.days} 天）。`;
            runBtn.disabled = true;
            await loadAuditLogs({ offset: 0 });
        }
    } catch (err) {
        resultEl.textContent = `操作失敗：${err && err.message ? err.message : '未知錯誤'}`;
    }
}

function closeAuditLogModal() {
    document.getElementById('auditLogModal').classList.add('hidden');
}

/* ==========================================
   錯誤日誌後台（v2.12.0）
   - 篩選：搜尋 / 等級 / 只看未處理
   - 標記已處理、匯出 CSV、清理舊日誌
   - 上方顯示「日誌系統本身」的寫入失敗狀態（原本只有 console 看不到）
   ========================================== */
let errorLogsCache = [];
let errorLogFilters = { q: '', severity: '', unresolved: false };

const ERROR_LOG_SEVERITY_STYLE = {
    error: { badge: 'bg-red-200 text-red-800', card: 'bg-red-50 border-red-200' },
    warn: { badge: 'bg-amber-200 text-amber-900', card: 'bg-amber-50 border-amber-200' },
    info: { badge: 'bg-slate-200 text-slate-700', card: 'bg-slate-50 border-slate-200' }
};

function errorLogQueryString() {
    const params = new URLSearchParams();
    if (errorLogFilters.q) params.set('q', errorLogFilters.q);
    if (errorLogFilters.severity) params.set('severity', errorLogFilters.severity);
    if (errorLogFilters.unresolved) params.set('resolved', 'false');
    params.set('limit', '200');
    return params.toString();
}

async function openErrorLogsModal() {
    document.getElementById('errorLogsModal').classList.remove('hidden');
    bindErrorLogControls();
    await fetchErrorLogs();
    loadErrorLogHealth();
}

function bindErrorLogControls() {
    const modal = document.getElementById('errorLogsModal');
    if (!modal || modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';

    document.getElementById('errorLogRefreshBtn')?.addEventListener('click', () => fetchErrorLogs());
    document.getElementById('errorLogExportBtn')?.addEventListener('click', exportErrorLogsCsv);
    document.getElementById('errorLogCleanupBtn')?.addEventListener('click', cleanupErrorLogs);
    // v2.17.0：一次把目前未處理的錯誤日誌全部標記為已處理（巡檢腳本也用同一個端點）
    document.getElementById('errorLogResolveAllBtn')?.addEventListener('click', resolveAllErrorLogs);
    document.getElementById('errorLogSeverity')?.addEventListener('change', (e) => {
        errorLogFilters.severity = e.target.value;
        fetchErrorLogs();
    });
    document.getElementById('errorLogUnresolved')?.addEventListener('change', (e) => {
        errorLogFilters.unresolved = e.target.checked;
        fetchErrorLogs();
    });

    let searchTimer = null;
    document.getElementById('errorLogSearch')?.addEventListener('input', (e) => {
        errorLogFilters.q = e.target.value.trim();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => fetchErrorLogs(), 350);
    });

    document.getElementById('errorLogList')?.addEventListener('click', handleErrorLogAction);
}

async function loadErrorLogHealth() {
    const box = document.getElementById('errorLogHealth');
    if (!box) return;
    try {
        const res = await customFetch('/api/admin/error-logs/health');
        const data = await apiResult(res);
        const failures = data.recent_write_failures || [];

        if (!data.supabase_configured || failures.length) {
            box.innerHTML = `⚠️ <b>錯誤日誌系統本身有問題</b>：` +
                (data.supabase_configured ? '' : '資料庫未設定；') +
                (failures.length ? `最近有 ${failures.length} 筆「寫入日誌失敗」：<span class="font-mono">${escapeHtml(failures[0].error || '')}</span>` : '') +
                `<br>請先修好日誌寫入，否則新的錯誤不會被記錄。`;
            box.classList.remove('hidden');
        } else {
            box.classList.add('hidden');
        }
    } catch (err) {
        box.classList.add('hidden');
    }
}

async function fetchErrorLogs() {
    const listEl = document.getElementById('errorLogList');
    if (!listEl) return;
    listEl.innerHTML = '<p class="text-center text-slate-400 py-4">載入錯誤日誌中...</p>';

    try {
        const res = await customFetch('/api/admin/error-logs?' + errorLogQueryString());
        const result = await apiResult(res);
        const logs = result.logs || [];
        errorLogsCache = logs;

        const summaryEl = document.getElementById('errorLogSummary');
        if (summaryEl) {
            const unresolved = logs.filter(l => !l.resolved).length;
            summaryEl.textContent = `顯示 ${logs.length} / 共 ${result.total || logs.length} 筆，其中未處理 ${unresolved} 筆` +
                (result.schema && result.schema.resolved === false ? '（資料庫尚未執行 v2.12.0 migration，無法標記處理狀態）' : '');
        }

        if (logs.length === 0) {
            listEl.innerHTML = '<p class="text-center text-emerald-600 py-4 font-sans font-medium">🎉 沒有符合條件的錯誤紀錄！</p>';
            return;
        }

        listEl.innerHTML = logs.map(l => {
            // v3.6.1：列表不再帶截圖本體，後端用 stack_trace 的標記算出 has_screenshot
            const hasScreenshot = l.has_screenshot === true
                || (typeof l.screenshot === 'string' && l.screenshot.startsWith('data:image/'));
            const sev = ERROR_LOG_SEVERITY_STYLE[l.severity] || ERROR_LOG_SEVERITY_STYLE.error;
            const sevLabel = l.severity === 'warn' ? '警告' : (l.severity === 'info' ? '資訊' : '錯誤');
            return `
            <div class="p-3 ${sev.card} border rounded-lg space-y-1 ${l.resolved ? 'opacity-60' : ''}">
                <div class="flex justify-between items-center flex-wrap gap-1">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="${sev.badge} text-[10px] px-2 py-0.5 rounded font-bold">${escapeHtml(sevLabel)}</span>
                        <span class="bg-slate-200 text-slate-700 text-[10px] px-2 py-0.5 rounded font-bold">${escapeHtml(l.error_type)}</span>
                        ${l.resolved ? `<span class="bg-emerald-100 text-emerald-700 text-[10px] px-2 py-0.5 rounded font-bold">✓ 已處理${l.resolved_by ? '：' + escapeHtml(String(l.resolved_by)) : ''}</span>` : ''}
                        ${parseUserAgentBadge(l.user_agent)}
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="text-slate-400 text-[10px]">${new Date(l.created_at).toLocaleString()}</span>
                        <button data-action="${l.resolved ? 'reopen-log' : 'resolve-log'}" data-id="${l.id}"
                            class="text-[10px] px-1.5 py-0.5 rounded ${l.resolved ? 'bg-slate-100 hover:bg-slate-200 text-slate-600' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800'} transition font-sans">
                            ${l.resolved ? '標記未處理' : '標記已處理'}
                        </button>
                    </div>
                </div>
                <p class="text-red-700 font-semibold text-xs">${escapeHtml(l.message)}</p>
                ${l.path ? `<p class="text-slate-500 text-[11px]">路徑: ${escapeHtml(l.path)}</p>` : ''}
                ${l.user_agent ? `<p class="text-[10px] font-mono text-slate-500 bg-white/60 p-1 rounded border border-red-100 break-all">UA: ${escapeHtml(l.user_agent)}</p>` : ''}
                ${l.stack_trace ? `<pre class="text-[10px] text-slate-600 bg-white p-2 rounded border border-slate-200 overflow-x-auto mt-1">${escapeHtml(l.stack_trace)}</pre>` : ''}
                
                ${hasScreenshot ? `
                    <div class="mt-2 pt-2 border-t border-red-200 flex items-center gap-2 flex-wrap">
                        <span class="text-[11px] font-semibold text-slate-600">📷 這筆有夾帶截圖</span>
                        <button data-action="view-log-screenshot" data-id="${l.id}"
                            class="text-[11px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition">
                            🖼️ 檢視截圖
                        </button>
                    </div>
                ` : ''}
            </div>
        `}).join('');
    } catch (err) {
        listEl.innerHTML = `<p class="text-red-500 text-center py-4 font-sans">無法載入錯誤日誌：${escapeHtml(err.message)}</p>`;
    }
}

/* v3.6.1：截圖不再隨列表下載，按下才單獨拿那一筆（端點只有超級管理員以上） */
async function openLogScreenshot(id) {
    const modal = document.getElementById('logScreenshotModal');
    const img = document.getElementById('logScreenshotImg');
    const status = document.getElementById('logScreenshotStatus');
    if (!modal || !img || !status) return;

    img.removeAttribute('src');
    img.classList.add('hidden');
    status.textContent = '載入中…';
    status.classList.remove('hidden');
    modal.classList.remove('hidden');

    try {
        const res = await customFetch(`/api/admin/error-logs/${encodeURIComponent(id)}/screenshot`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!data.screenshot) {
            status.textContent = '這筆日誌沒有可顯示的截圖（可能已超過上限被丟棄，或不是圖片格式）。';
            return;
        }
        img.src = data.screenshot;
        img.classList.remove('hidden');
        status.classList.add('hidden');
    } catch (err) {
        status.textContent = '讀取截圖失敗：' + err.message;
    }
}

function closeLogScreenshotModal() {
    const modal = document.getElementById('logScreenshotModal');
    const img = document.getElementById('logScreenshotImg');
    if (img) img.removeAttribute('src');   // 順手釋放記憶體
    modal?.classList.add('hidden');
}

async function handleErrorLogAction(ev) {
    const viewBtn = ev.target.closest('[data-action="view-log-screenshot"]');
    if (viewBtn) { await openLogScreenshot(viewBtn.dataset.id); return; }

    const el = ev.target.closest('[data-action="resolve-log"], [data-action="reopen-log"]');
    if (!el) return;

    const resolved = el.dataset.action === 'resolve-log';
    try {
        const res = await customFetch(`/api/admin/error-logs/${encodeURIComponent(el.dataset.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolved })
        });
        await apiResult(res);
        await fetchErrorLogs();
    } catch (err) {
        alert('❌ 更新失敗：' + err.message);
    }
}

async function exportErrorLogsCsv() {
    if (!errorLogsCache.length) {
        alert('目前沒有可匯出的日誌（請先載入）');
        return;
    }

    const rows = [['時間', '等級', '類型', '訊息', '路徑', '已處理', '裝置', '詳細內容']];
    errorLogsCache.forEach(l => {
        rows.push([
            new Date(l.created_at).toLocaleString(),
            l.severity === 'warn' ? '警告' : (l.severity === 'info' ? '資訊' : '錯誤'),
            l.error_type,
            l.message,
            l.path || '',
            l.resolved ? '是' : '否',
            l.user_agent || '',
            (l.stack_trace || '').slice(0, 2000)
        ]);
    });

    const csv = window.CMCSV
        ? CMCSV.stringify(rows, { bom: true })
        : rows.map(r => r.map(v => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');

    downloadCsvBlob(`error-logs-${todayString()}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
}

async function cleanupErrorLogs() {
    const days = prompt('要刪除幾天的「舊」錯誤日誌？（例如 30 表示只保留最近 30 天）', '30');
    if (days === null) return;
    const n = parseInt(days, 10);
    if (!n || n < 1) {
        alert('請輸入大於 0 的天數');
        return;
    }
    if (!confirm(`確定要刪除 ${n} 天以前的所有錯誤日誌嗎？此動作無法復原。`)) return;

    try {
        const res = await customFetch('/api/admin/error-logs/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days: n })
        });
        const data = await apiResult(res);
        alert('✅ ' + (data.message || `已清理 ${data.removed} 筆`));
        await fetchErrorLogs();
    } catch (err) {
        alert('❌ 清理失敗：' + err.message);
    }
}

function closeErrorLogsModal() {
    document.getElementById('errorLogsModal').classList.add('hidden');
}

/* ==========================================
   推播發送紀錄（v2.12.0，管理員以上）
   ========================================== */
async function openPushLogsModal() {
    document.getElementById('pushLogsModal').classList.remove('hidden');
    const listEl = document.getElementById('pushLogsList');
    listEl.innerHTML = '<p class="text-center text-slate-400 py-4">載入推播紀錄中...</p>';

    try {
        const res = await customFetch('/api/admin/push-logs');
        const data = await apiResult(res);
        const logs = data.logs || [];

        if (!logs.length) {
            listEl.innerHTML = '<p class="text-center text-slate-400 py-4">目前還沒有推播發送紀錄（每日排程發送後會出現在這裡）</p>';
            return;
        }

        const kindLabel = (k) => ({
            reminder: '開賽前提醒',
            new: '新賽事通知',
            review_result: '報名審核結果',
            promote: '候補遞補通知',
            announcement: '站內公告'
        }[k] || k);

        const hintEl = document.getElementById('pushLogsHint');
        if (data.detail_ready === false) {
            hintEl.textContent = '⚠️ ' + (data.hint || '推播失敗明細尚未啟用。');
            hintEl.classList.remove('hidden');
        } else {
            hintEl.classList.add('hidden');
        }

        listEl.innerHTML = logs.map((l) => {
            const sent = Number(l.sent_count) || 0;
            const failed = Number(l.failed_count) || 0;
            const resent = Number(l.resend_count) || 0;
            return `
            <div class="p-2.5 bg-slate-50 border ${failed ? 'border-rose-200' : 'border-slate-200'} rounded space-y-1">
                <div class="flex justify-between items-center gap-2 flex-wrap">
                    <span class="bg-indigo-100 text-indigo-700 text-[10px] px-2 py-0.5 rounded font-bold">${escapeHtml(kindLabel(l.kind))}</span>
                    <span class="text-slate-400 text-[10px]">${l.sent_at ? escapeHtml(new Date(l.sent_at).toLocaleString()) : '—'}</span>
                </div>
                <p class="text-slate-600 text-[11px]">
                    ${l.competition_id ? `賽事 #${escapeHtml(String(l.competition_id))}　` : ''}成功發送 <b>${sent}</b> 則${failed ? `　<span class="text-rose-700 font-bold">失敗 ${failed} 則</span>` : ''}
                </p>
                ${failed && l.error_detail ? `<p class="text-rose-700 text-[10px] break-all">原因：${escapeHtml(String(l.error_detail))}</p>` : ''}
                ${l.payload && l.payload.title ? `<p class="text-slate-500 text-[10px]">內容：${escapeHtml(String(l.payload.title))}</p>` : ''}
                ${resent ? `<p class="text-emerald-700 text-[10px]">已重送 ${resent} 次（最後一次 ${l.resend_at ? escapeHtml(new Date(l.resend_at).toLocaleString()) : '—'}，成功 ${Number(l.resend_sent_count) || 0} 則）</p>` : ''}
                ${l.payload ? `<div class="flex justify-end"><button type="button" data-resend-id="${escapeHtml(String(l.id))}" class="text-[11px] text-blue-600 hover:text-blue-800">重送給原本的對象</button></div>` : ''}
            </div>`;
        }).join('');
    } catch (err) {
        listEl.innerHTML = `<p class="text-red-500 text-center py-4">載入失敗：${escapeHtml(err.message)}</p>`;
    }
}

/* 手動重送：不受推播設定的自動通知開關影響（是管理員的明確指令） */
async function resendPushLog(id) {
    if (!confirm(`重送這筆推播（紀錄 #${id}）給原本的對象？\n\n手動重送不受「推播設定」的自動開關影響。`)) return;
    const statusEl = document.getElementById('pushLogsStatus');
    statusEl.className = 'text-[11px] text-slate-500';
    statusEl.textContent = '重送中...';
    statusEl.classList.remove('hidden');
    try {
        const data = await apiResult(await customFetch(`/api/admin/push-logs/${id}/resend`, { method: 'POST' }));
        statusEl.className = 'text-[11px] text-emerald-700';
        statusEl.textContent = `✅ 重送完成：成功 ${data.sent} 則、失敗 ${data.failed} 則`
            + (data.deactivated ? `、清除失效訂閱 ${data.deactivated} 個` : '')
            + ((data.errors && data.errors.length) ? `（${data.errors[0]}）` : '');
        await openPushLogsModal();   // 回讀一次，確認畫面與資料庫一致
    } catch (err) {
        statusEl.className = 'text-[11px] text-red-600';
        statusEl.textContent = '❌ 重送失敗：' + err.message;
    }
}

function closePushLogsModal() {
    document.getElementById('pushLogsModal').classList.add('hidden');
}

async function openAdminModal() {
    document.getElementById('adminModal').classList.remove('hidden');
    bindAdminListEvents();
    // 這個 modal 每次打開都會呼叫本函式；重整按鈕只在第一次綁，避免重複綁定送多次請求
    const refreshBtn = document.getElementById('refreshAdminListBtn');
    if (refreshBtn && refreshBtn.dataset.bound !== '1') {
        refreshBtn.dataset.bound = '1';
        refreshBtn.addEventListener('click', () => fetchAdminList());
    }
    renderRoleSelectOptions();
    fetchAdminList();
}

function closeAdminModal() {
    document.getElementById('adminModal').classList.add('hidden');
}

/* ==========================================
   推播設定（v2.25.0，管理員以上）
   - 每日摘要：開關、發送時間（澳門時間）、要包含哪幾種事件
   - 即時通知：報名審核結果、候補遞補（關掉只是不通知，流程照常）
   ========================================== */
const CM_PUSH_SETTING_FIELDS = [
    ['pushDigestEnabled', 'digest_enabled'],
    ['pushDigestKindNew', 'digest_kind_new'],
    ['pushDigestKindReminder', 'digest_kind_reminder'],
    ['pushEventReview', 'event_review'],
    ['pushEventPromote', 'event_promote'],
    ['pushEventAnnounce', 'event_announce'],  // v2.26.0：公告發布通知
    ['pushEventResult', 'event_result'],      // v3.1.0：成績公布通知
    ['pushEventNotice', 'event_notice']       // v3.6.4：賽事公告（取消／延期／最新消息）
];

async function openPushSettingsModal() {
    document.getElementById('pushSettingsModal').classList.remove('hidden');
    document.getElementById('pushSettingsStatus').classList.add('hidden');
    await loadPushSettings();
}

function closePushSettingsModal() {
    document.getElementById('pushSettingsModal').classList.add('hidden');
}

async function loadPushSettings() {
    const hintEl = document.getElementById('pushSettingsHint');
    try {
        const data = await apiResult(await customFetch('/api/push/settings'));
        const s = data.settings || {};
        CM_PUSH_SETTING_FIELDS.forEach(([id, key]) => {
            const el = document.getElementById(id);
            if (el) el.checked = s[key] !== false;
        });
        const timeEl = document.getElementById('pushDigestTime');
        if (timeEl) timeEl.value = s.digest_time || '09:00';

        if (data.schema_ready === false) {
            hintEl.textContent = '⚠️ ' + (data.hint || '推播設定目前讀不到，系統會先用預設值運作。');
            hintEl.classList.remove('hidden');
        } else {
            hintEl.classList.add('hidden');
        }
    } catch (err) {
        hintEl.textContent = '❌ 讀取設定失敗：' + err.message;
        hintEl.classList.remove('hidden');
    }
}

async function savePushSettings() {
    const statusEl = document.getElementById('pushSettingsStatus');
    const timeEl = document.getElementById('pushDigestTime');
    const payload = { digest_time: (timeEl && timeEl.value) || '09:00' };
    CM_PUSH_SETTING_FIELDS.forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) payload[key] = el.checked;
    });

    statusEl.classList.add('hidden');
    try {
        const data = await apiResult(await customFetch('/api/push/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }));
        const changes = data.changes || [];
        statusEl.textContent = changes.length
            ? '✅ 設定已儲存：' + changes.join('、')
            : '✅ 設定已儲存（這次沒有變動）';
        statusEl.classList.remove('hidden');
        await loadPushSettings();   // 回讀一次，確認畫面與資料庫一致
    } catch (err) {
        alert('❌ 儲存失敗：' + err.message);
    }
}

/* ==========================================
   公告中心／訊息中心（v2.26.0）
   - 所有登入使用者：看自己的公告、標記已讀、訂閱分類（未讀數顯示在選單徽章）
   - 管理員以上：發布、修改、上下架，並看到每則的已讀人數
   - 「誰看得到」由後端的共用純函式決定（public/js/announcements.js），前端只呈現，
     避免前後端各寫一套造成「列表看得到、點進去說無權」
   ========================================== */
let cmAnnounceState = { announcements: [], all_categories: [], my_categories: [], schema_ready: true, unread_count: 0 };
let cmAnnounceAdminState = { list: [], total_users: null, schema_ready: true };

function canManageAnnouncements() {
    return !!currentUser && ['admin', 'super_admin', 'web_owner'].includes(currentUser.role);
}

/* 未讀徽章：讀不到就安靜地隱藏，不要因為公告功能壞掉嚇到使用者 */
async function refreshAnnounceBadge() {
    const badge = document.getElementById('announceBadge');
    if (!badge) return;
    if (!currentUser) {
        badge.classList.add('hidden');
        return;
    }
    try {
        const data = await apiResult(await customFetch('/api/my/announcements'));
        const count = Number(data.unread_count) || 0;
        cmAnnounceState.unread_count = count;
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.classList.toggle('hidden', count === 0);
    } catch (err) {
        badge.classList.add('hidden');
    }
}

function updateAnnounceBadge() {
    const badge = document.getElementById('announceBadge');
    if (!badge || !currentUser) return;
    const count = Number(cmAnnounceState.unread_count) || 0;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count === 0);
}

async function openAnnouncementModal() {
    document.getElementById('announcementModal').classList.remove('hidden');
    document.getElementById('announceStatus').classList.add('hidden');
    document.getElementById('announceAdminBox').classList.toggle('hidden', !canManageAnnouncements());
    closeAnnounceForm();
    await loadAnnouncements();
}

function closeAnnouncementModal() {
    document.getElementById('announcementModal').classList.add('hidden');
    closeAnnounceForm();
}

function announceSetStatus(msg, isError) {
    const el = document.getElementById('announceStatus');
    el.textContent = msg;
    el.className = isError ? 'text-[11px] text-red-600' : 'text-[11px] text-emerald-700';
    el.classList.remove('hidden');
}

async function loadAnnouncements() {
    const hintEl = document.getElementById('announceHint');
    const listEl = document.getElementById('announceList');
    listEl.innerHTML = '<p class="text-center text-slate-400 py-4">載入公告中...</p>';
    try {
        const data = await apiResult(await customFetch('/api/my/announcements'));
        cmAnnounceState.announcements = data.announcements || [];
        cmAnnounceState.all_categories = data.all_categories || [];
        cmAnnounceState.my_categories = data.my_categories || [];
        cmAnnounceState.unread_count = Number(data.unread_count) || 0;
        cmAnnounceState.schema_ready = data.schema_ready !== false;

        if (!cmAnnounceState.schema_ready) {
            hintEl.textContent = '⚠️ ' + (data.hint || '站內公告尚未啟用。');
            hintEl.classList.remove('hidden');
        } else {
            hintEl.classList.add('hidden');
        }

        renderAnnounceCategories();
        renderAnnouncementList();
        updateAnnounceBadge();

        if (canManageAnnouncements() && cmAnnounceState.schema_ready) await loadAdminAnnouncements();
    } catch (err) {
        listEl.innerHTML = `<p class="text-red-500 text-center py-4">載入失敗：${escapeHtml(err.message)}</p>`;
    }
}

/* 我的訂閱分類 + 發布表單的分類選項 */
function renderAnnounceCategories() {
    const mine = new Set(cmAnnounceState.my_categories || []);
    const options = (cmAnnounceState.all_categories || []).map((c) => `
        <label class="flex items-center gap-1.5">
            <input type="checkbox" value="${escapeHtml(String(c.id))}" class="w-3.5 h-3.5 accent-blue-600"${mine.has(c.id) ? ' checked' : ''}>
            <span>${escapeHtml(c.label || c.id)}</span>
        </label>
    `).join('');

    const myBox = document.getElementById('announceCategoryList');
    if (myBox) myBox.innerHTML = options || '<span class="text-slate-400">沒有可訂閱的分類</span>';

    const pickBox = document.getElementById('announceCategoryPick');
    if (pickBox) pickBox.innerHTML = options || '<span class="text-slate-400">沒有分類可選</span>';
    syncAnnounceCategoryPickVisibility();
}

function syncAnnounceCategoryPickVisibility() {
    const pick = document.getElementById('announceCategoryPick');
    const audience = document.getElementById('announceAudience');
    if (pick && audience) pick.classList.toggle('hidden', audience.value !== 'category');
}

function renderAnnouncementList() {
    const listEl = document.getElementById('announceList');
    const list = cmAnnounceState.announcements || [];
    if (!list.length) {
        listEl.innerHTML = `<p class="text-center text-slate-400 py-4">${cmAnnounceState.schema_ready ? '目前沒有公告' : '站內公告尚未啟用'}</p>`;
        return;
    }
    listEl.innerHTML = list.map((a) => `
        <div class="p-2.5 border rounded space-y-1 ${a.read ? 'bg-slate-50 border-slate-200' : 'bg-white border-blue-300 cm-announce-unread'}"
            data-announce-id="${escapeHtml(String(a.id))}" title="${escapeHtml(a.read ? '' : '點一下標記為已讀')}">
            <div class="flex justify-between items-start gap-2">
                <div class="flex items-center gap-1.5 flex-wrap">
                    ${a.is_pinned ? '<span class="bg-rose-100 text-rose-700 text-[10px] px-1.5 py-0.5 rounded font-bold">置頂</span>' : ''}
                    ${a.read ? '' : '<span class="bg-blue-100 text-blue-700 text-[10px] px-1.5 py-0.5 rounded font-bold">未讀</span>'}
                    <span class="bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded">${escapeHtml(a.audience_label || '')}</span>
                </div>
                <span class="text-slate-400 text-[10px] shrink-0">${a.publish_at ? escapeHtml(new Date(a.publish_at).toLocaleString()) : ''}</span>
            </div>
            <p class="font-semibold text-slate-800">${escapeHtml(a.title || '')}</p>
            <p class="text-slate-600 whitespace-pre-wrap">${escapeHtml(a.body || '')}</p>
        </div>
    `).join('');
}

async function markAnnouncementsRead(ids, message) {
    const targets = (ids || []).filter((n) => Number.isInteger(n) && n > 0);
    if (!targets.length) return;
    try {
        await apiResult(await customFetch('/api/my/announcements/read-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: targets })
        }));
        const set = new Set(targets.map(String));
        cmAnnounceState.announcements = (cmAnnounceState.announcements || []).map((a) =>
            set.has(String(a.id)) ? Object.assign({}, a, { read: true }) : a);
        cmAnnounceState.unread_count = cmAnnounceState.announcements.filter((a) => !a.read).length;
        renderAnnouncementList();
        updateAnnounceBadge();
        if (message) announceSetStatus(message);
    } catch (err) {
        announceSetStatus('❌ 標記已讀失敗：' + err.message, true);
    }
}

function markAllAnnouncementsRead() {
    const unread = (cmAnnounceState.announcements || []).filter((a) => !a.read).map((a) => Number(a.id));
    if (!unread.length) {
        announceSetStatus('所有公告都已經讀過了。');
        return;
    }
    markAnnouncementsRead(unread, `已標記 ${unread.length} 則公告為已讀`);
}

async function saveAnnounceCategories() {
    const statusEl = document.getElementById('announceCatStatus');
    const picked = Array.from(document.querySelectorAll('#announceCategoryList input[type="checkbox"]:checked'))
        .map((el) => el.value);
    statusEl.textContent = '儲存中...';
    try {
        const data = await apiResult(await customFetch('/api/my/announce-categories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ categories: picked })
        }));
        statusEl.textContent = '✅ ' + (data.message || '已儲存');
        // 訂閱改了，看得到的公告也可能跟著變，重新讀一次確認畫面與資料庫一致
        await loadAnnouncements();
    } catch (err) {
        statusEl.textContent = '❌ ' + err.message;
    }
}

/* ---------- 管理員以上：發布與管理 ---------- */

function toLocalInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function openAnnounceForm(ann) {
    const form = document.getElementById('announceForm');
    if (!form) return;
    form.classList.remove('hidden');
    document.getElementById('announceEditingId').value = ann ? String(ann.id) : '';
    document.getElementById('announceTitle').value = ann ? (ann.title || '') : '';
    document.getElementById('announceBody').value = ann ? (ann.body || '') : '';
    document.getElementById('announceAudience').value = (ann && ann.audience) || 'all';
    document.getElementById('announcePublishAt').value = ann ? toLocalInputValue(ann.publish_at) : '';
    document.getElementById('announceExpiresAt').value = ann ? toLocalInputValue(ann.expires_at) : '';
    document.getElementById('announcePinned').checked = !!(ann && ann.is_pinned);
    document.getElementById('announceNotifyPush').checked = !ann;   // 編輯既有公告時預設不再推播一次
    document.getElementById('submitAnnounceBtn').textContent = ann ? '儲存變更' : '發布公告';

    const cats = new Set((ann && Array.isArray(ann.categories)) ? ann.categories : []);
    document.querySelectorAll('#announceCategoryPick input[type="checkbox"]').forEach((el) => {
        el.checked = cats.has(el.value);
    });
    syncAnnounceCategoryPickVisibility();
}

function closeAnnounceForm() {
    const form = document.getElementById('announceForm');
    if (!form) return;
    form.classList.add('hidden');
    document.getElementById('announceEditingId').value = '';
}

async function submitAnnouncementForm(event) {
    event.preventDefault();
    const id = document.getElementById('announceEditingId').value;
    const audience = document.getElementById('announceAudience').value;
    const categories = audience === 'category'
        ? Array.from(document.querySelectorAll('#announceCategoryPick input[type="checkbox"]:checked')).map((el) => el.value)
        : [];
    const payload = {
        title: document.getElementById('announceTitle').value,
        body: document.getElementById('announceBody').value,
        audience,
        categories,
        publish_at: fromLocalInputValue(document.getElementById('announcePublishAt').value),
        expires_at: fromLocalInputValue(document.getElementById('announceExpiresAt').value),
        is_pinned: document.getElementById('announcePinned').checked,
        notify_push: document.getElementById('announceNotifyPush').checked
    };

    const submitBtn = document.getElementById('submitAnnounceBtn');
    submitBtn.disabled = true;
    try {
        const data = await apiResult(await customFetch(id ? `/api/admin/announcements/${id}` : '/api/admin/announcements', {
            method: id ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }));
        let msg = id ? '✅ 公告已更新' : '✅ 公告已發布';
        if (data.push) {
            if (data.push.skipped) msg += `（推播：${data.push.skipped}）`;
            else msg += `（推播成功 ${data.push.sent} 則${data.push.failed ? `、失敗 ${data.push.failed} 則` : ''}）`;
        } else if (data.changes && data.changes.length) {
            msg += '：' + data.changes.join('、');
        }
        closeAnnounceForm();
        await loadAnnouncements();
        announceSetStatus(msg);
    } catch (err) {
        alert('❌ 儲存失敗：' + err.message);
    } finally {
        submitBtn.disabled = false;
    }
}

async function loadAdminAnnouncements() {
    const el = document.getElementById('announceAdminList');
    try {
        const data = await apiResult(await customFetch('/api/admin/announcements'));
        cmAnnounceAdminState.list = data.announcements || [];
        cmAnnounceAdminState.total_users = data.total_users;
        cmAnnounceAdminState.schema_ready = data.schema_ready !== false;
        renderAdminAnnouncementList();
    } catch (err) {
        el.innerHTML = `<p class="text-red-500">讀取管理清單失敗：${escapeHtml(err.message)}</p>`;
    }
}

function renderAdminAnnouncementList() {
    const el = document.getElementById('announceAdminList');
    const list = cmAnnounceAdminState.list || [];
    if (!list.length) {
        el.innerHTML = '<p class="text-slate-400">還沒有任何公告</p>';
        return;
    }
    const total = cmAnnounceAdminState.total_users;
    const totalText = (total === null || total === undefined) ? '' : `/${total}`;
    el.innerHTML = list.map((a) => `
        <div class="p-2.5 border border-slate-200 rounded space-y-1 bg-white">
            <div class="flex justify-between items-start gap-2">
                <div class="flex items-center gap-1.5 flex-wrap">
                    ${a.is_live
                        ? '<span class="bg-emerald-100 text-emerald-700 text-[10px] px-1.5 py-0.5 rounded font-bold">上架中</span>'
                        : '<span class="bg-slate-100 text-slate-500 text-[10px] px-1.5 py-0.5 rounded">未上架</span>'}
                    ${a.is_pinned ? '<span class="bg-rose-100 text-rose-700 text-[10px] px-1.5 py-0.5 rounded font-bold">置頂</span>' : ''}
                    <span class="bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded">${escapeHtml(a.audience_label || '')}</span>
                </div>
                <span class="text-slate-400 text-[10px] shrink-0">已讀 ${Number(a.read_count) || 0}${totalText}</span>
            </div>
            <p class="font-semibold text-slate-800">${escapeHtml(a.title || '')}</p>
            <p class="text-slate-500 text-[10px]">發布：${a.publish_at ? escapeHtml(new Date(a.publish_at).toLocaleString()) : '—'}　結束：${a.expires_at ? escapeHtml(new Date(a.expires_at).toLocaleString()) : '—'}</p>
            <div class="flex justify-end gap-3 pt-0.5">
                <button type="button" class="text-[11px] text-blue-600 hover:text-blue-800" data-action="edit" data-id="${escapeHtml(String(a.id))}">編輯</button>
                <button type="button" class="text-[11px] ${a.is_active === false ? 'text-emerald-600 hover:text-emerald-900' : 'text-amber-600 hover:text-amber-900'}"
                    data-action="toggle" data-id="${escapeHtml(String(a.id))}" data-active="${a.is_active === false ? '1' : '0'}">${a.is_active === false ? '重新上架' : '下架'}</button>
            </div>
        </div>
    `).join('');
}

async function toggleAnnouncementActive(id, active) {
    const label = active ? '重新上架' : '下架';
    if (!confirm(`確定要${label}這則公告嗎？${active ? '' : '（下架後使用者就看不到了，資料仍保留）'}`)) return;
    try {
        const data = await apiResult(await customFetch(`/api/admin/announcements/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: active })
        }));
        await loadAnnouncements();
        announceSetStatus(`✅ 公告已${label}${data.changes && data.changes.length ? '：' + data.changes.join('、') : ''}`);
    } catch (err) {
        alert(`❌ ${label}失敗：` + err.message);
    }
}

/* ==========================================
   使用者管理（v2.12.0）
   - 管理員以上可檢視與建立帳號（只能建立「權限低於自己」的角色）
   - 只有網站擁有者可調整他人角色
   - 可管理（改密碼／改帳號名／停用／刪除）的對象一律須為「權限低於自己」
   ========================================== */
let adminMgmtState = { users: [], can_create: [], can_edit_roles: false, my_role: null, schema_ready: true };

function renderRoleSelectOptions() {
    const selectEl = document.getElementById('newAdminRole');
    const hint = document.getElementById('adminRoleHint');
    const warn = document.getElementById('adminSchemaWarn');
    const options = adminMgmtState.can_create || [];

    if (selectEl) {
        if (!options.length) {
            selectEl.innerHTML = '<option value="">（無可建立的角色）</option>';
            selectEl.disabled = true;
        } else {
            selectEl.disabled = false;
            const prev = selectEl.value;
            selectEl.innerHTML = options
                .map(r => `<option value="${r}">${getRoleLabel(r)}（${r}）</option>`)
                .join('');
            if (options.includes(prev)) selectEl.value = prev;
        }
    }

    if (hint) {
        const myRole = adminMgmtState.my_role || (currentUser && currentUser.role) || 'guest';
        const list = options.length ? options.map(r => `<b>${escapeHtml(getRoleLabel(r))}</b>`).join('、') : '（無）';
        hint.innerHTML = `你目前是 <b>${escapeHtml(getRoleLabel(myRole))}</b>，可建立：${list}。` +
            (adminMgmtState.can_edit_roles
                ? '你是網站擁有者，可調整任何人的角色。'
                : '角色調整僅限網站擁有者。');
    }

    if (warn) {
        if (adminMgmtState.schema_ready === false) {
            warn.textContent = '⚠️ 資料庫尚未執行 v2.12.0 migration，「停用帳號／最後登入時間／日誌標記」暫不可用；請通知網站擁有者執行 migrations/2026-09-25-v2.12.0-user-management.sql。';
            warn.classList.remove('hidden');
        } else {
            warn.classList.add('hidden');
        }
    }
}

async function fetchAdminList() {
    const listEl = document.getElementById('adminList');
    if (!listEl) return;
    listEl.innerHTML = '<p class="text-slate-400 text-xs py-2">載入帳號清單中...</p>';

    try {
        const res = await customFetch('/api/admin/users');
        const data = await apiResult(res);

        adminMgmtState = {
            users: data.users || [],
            can_create: data.can_create || [],
            can_edit_roles: !!data.can_edit_roles,
            my_role: data.my_role || null,
            schema_ready: data.schema_ready !== false
        };

        renderRoleSelectOptions();
        renderAdminList();
    } catch (err) {
        listEl.innerHTML = `<p class="text-red-500 text-xs py-2">載入失敗：${escapeHtml(err.message)}</p>`;
    }
}

function renderAdminList() {
    const listEl = document.getElementById('adminList');
    if (!listEl) return;
    const users = adminMgmtState.users;

    if (!users || users.length === 0) {
        listEl.innerHTML = '<p class="text-slate-400 text-xs py-2">目前沒有帳號</p>';
        return;
    }

    const allRoles = ['user', 'test', 'admin', 'super_admin', 'web_owner'];

    listEl.innerHTML = users.map(u => {
        const roleSelect = u.can_change_role
            ? `<select data-action="change-role" data-id="${u.id}" data-username="${escapeHtml(u.username)}"
                    title="調整角色（僅網站擁有者）"
                    class="text-[11px] px-1.5 py-1 border border-slate-300 rounded bg-white">
                    ${allRoles.map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${getRoleLabel(r)}</option>`).join('')}
               </select>`
            : '';

        const buttons = u.can_manage
            ? `
                <button data-action="reset-password" data-id="${u.id}" data-username="${escapeHtml(u.username)}"
                    class="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 transition">重設密碼</button>
                <button data-action="rename-user" data-id="${u.id}" data-username="${escapeHtml(u.username)}"
                    class="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 transition">改帳號名</button>
                <button data-action="toggle-active" data-id="${u.id}" data-username="${escapeHtml(u.username)}" data-active="${u.is_active}"
                    class="text-[11px] px-1.5 py-0.5 rounded ${u.is_active ? 'bg-amber-100 hover:bg-amber-200 text-amber-800' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800'} transition">
                    ${u.is_active ? '停用' : '啟用'}
                </button>
                <button data-action="delete-admin" data-id="${u.id}" data-username="${escapeHtml(u.username)}"
                    class="text-[11px] px-1.5 py-0.5 rounded bg-red-100 hover:bg-red-200 text-red-700 transition">刪除</button>
                ${u.two_factor_enabled ? `
                <button data-action="reset-2fa" data-id="${u.id}" data-username="${escapeHtml(u.username)}"
                    class="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-800 transition">重設 2FA</button>` : ''}
              `
            : '';

        const lastLogin = u.last_login_at
            ? `最後登入 ${new Date(u.last_login_at).toLocaleDateString()}`
            : '尚未登入紀錄';

        return `
            <div class="p-2.5 bg-slate-50 border border-slate-200 rounded text-xs space-y-1.5">
                <div class="flex items-center justify-between gap-2 flex-wrap">
                    <div class="flex items-center gap-1.5 flex-wrap min-w-0">
                        <span class="font-bold text-slate-700 break-all">${escapeHtml(u.username)}</span>
                        ${getRoleBadge(u.role, u.username)}
                        ${u.is_active ? '' : '<span class="bg-red-100 text-red-700 text-[10px] px-1.5 py-0.5 rounded">已停用</span>'}
                        ${u.two_factor_enabled ? '<span class="bg-emerald-100 text-emerald-800 text-[10px] px-1.5 py-0.5 rounded" title="已啟用兩步驟驗證">🔐 2FA</span>' : ''}
                        ${u.is_self ? '<span class="bg-blue-100 text-blue-700 text-[10px] px-1.5 py-0.5 rounded">你自己</span>' : ''}
                    </div>
                    <span class="text-[10px] text-slate-400">${escapeHtml(lastLogin)}</span>
                </div>
                ${(roleSelect || buttons) ? `<div class="flex items-center gap-1.5 flex-wrap">${roleSelect}${buttons}</div>` : ''}
            </div>
        `;
    }).join('');
}

async function handleAddAdmin(e) {
    e.preventDefault();
    const username = document.getElementById('newAdminUser').value.trim();
    const password = document.getElementById('newAdminPass').value;
    const role = document.getElementById('newAdminRole').value;

    try {
        const res = await customFetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role })
        });
        const data = await apiResult(res);

        alert('✅ ' + (data.message || '帳號建立成功！'));
        document.getElementById('newAdminUser').value = '';
        document.getElementById('newAdminPass').value = '';
        await fetchAdminList();
    } catch (err) {
        alert('❌ 建立失敗：' + err.message);
    }
}

async function patchAdminUser(id, body) {
    const res = await customFetch(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return apiResult(res);
}

// 正在刪除中的帳號（防連點與重複監聽器造成的一次點擊送兩次請求）
let deleteAdminPending = new Set();

async function deleteAdmin(idOrName, label) {
    const name = label || idOrName;
    const key = String(idOrName);
    if (deleteAdminPending.has(key)) return;
    if (!confirm(`確定要刪除帳號「${name}」嗎？此動作無法復原。`)) return;
    deleteAdminPending.add(key);

    try {
        const res = await customFetch(`/api/admin/users/${encodeURIComponent(idOrName)}`, { method: 'DELETE' });
        const data = await apiResult(res);
        alert('✅ ' + (data.message || '帳號已刪除'));
        await fetchAdminList();
    } catch (err) {
        alert('❌ 刪除失敗：' + err.message);
    } finally {
        deleteAdminPending.delete(key);
    }
}

async function handleAdminListAction(ev) {
    const el = ev.target.closest('[data-action]');
    if (!el) return;


    // 下拉選單必須等 change（使用者真的選了）才處理：
    // click 會在使用者才剛點開選單、還沒挑選時就以「目前（舊）角色」觸發，
    // 造成彈出「確定要把 X 的角色改為 <原本角色>？」而且真正選完反而沒送出。
    if (el.tagName === 'SELECT' && ev.type !== 'change') return;

    const action = el.dataset.action;
    const id = el.dataset.id;
    const username = el.dataset.username || '';

    try {
        if (action === 'change-role') {
            const role = el.value;
            if (!confirm(`確定要把「${username}」的角色改為 ${getRoleLabel(role)}？`)) {
                await fetchAdminList();
                return;
            }
            const data = await patchAdminUser(id, { role });
            alert('✅ ' + (data.message || '角色已更新'));
            await fetchAdminList();
            return;
        }

        if (action === 'reset-password') {
            const pw = prompt(`為「${username}」設定新密碼（6～64 個英文字母或數字）：`);
            if (pw === null || pw === '') return;
            const data = await patchAdminUser(id, { password: pw });
            alert('✅ ' + (data.message || '密碼已重設'));
            return;
        }

        if (action === 'reset-2fa') {
            if (!confirm(`確定要重設「${username}」的兩步驟驗證？\n\n對方之後登入只需要密碼，請通知他盡快重新綁定。`)) return;
            const res = await customFetch(`/api/admin/users/${id}/reset-2fa`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '重設失敗');
            alert('✅ ' + (data.message || '已重設兩步驟驗證'));
            await fetchAdminList();
            return;
        }

        if (action === 'rename-user') {
            const nu = prompt(`「${username}」的新帳號名稱（3～20 個英文字母、數字或底線）：`, username);
            if (nu === null || nu.trim() === '' || nu.trim() === username) return;
            const data = await patchAdminUser(id, { username: nu.trim() });
            alert('✅ ' + (data.message || '帳號名稱已更新'));
            await fetchAdminList();
            return;
        }

        if (action === 'toggle-active') {
            const wantActive = el.dataset.active !== 'true';
            if (!confirm(`確定要${wantActive ? '啟用' : '停用'}「${username}」嗎？`)) return;
            const data = await patchAdminUser(id, { is_active: wantActive });
            alert('✅ ' + (data.message || '已更新帳號狀態'));
            await fetchAdminList();
            return;
        }

        if (action === 'delete-admin') {
            await deleteAdmin(id, username);
        }
    } catch (err) {
        alert('❌ 操作失敗：' + err.message);
        await fetchAdminList();
    }
}

function bindAdminListEvents() {
    const listEl = document.getElementById('adminList');
    if (!listEl || listEl.dataset.bound === '1') return;
    listEl.dataset.bound = '1';
    listEl.addEventListener('click', handleAdminListAction);
    listEl.addEventListener('change', (ev) => {
        const el = ev.target.closest('[data-action="change-role"]');
        if (el) handleAdminListAction(ev);
    });
}

async function openTrashModal() {
    document.getElementById('trashModal').classList.remove('hidden');
    fetchTrashList();
}

function closeTrashModal() {
    document.getElementById('trashModal').classList.add('hidden');
}

async function fetchTrashList() {
    const listEl = document.getElementById('trashList');
    listEl.innerHTML = '<p class="text-center text-slate-400 py-4">載入回收桶中...</p>';

    try {
        const res = await customFetch('/api/competitions/trash');
        if (!res.ok) throw new Error('無法讀取回收桶資料');
        const items = await res.json();

        if (!items || items.length === 0) {
            listEl.innerHTML = '<p class="text-center text-slate-400 py-8">回收桶目前是空的 🧹</p>';
            return;
        }

        listEl.innerHTML = items.map(item => `
            <div class="border border-slate-200 rounded-lg p-3.5 bg-slate-50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div>
                    <h4 class="text-sm font-bold text-slate-700">${escapeHtml(item.name)}</h4>
                    ${item.deleted_at ? `<p class="text-xs text-slate-400 mt-0.5">刪除時間：${new Date(item.deleted_at).toLocaleString()}</p>` : ''}
                </div>
                <div class="flex items-center gap-2 self-end sm:self-center">
                    <button data-action="restore" data-id="${item.id}" class="text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 px-3 py-1 rounded transition font-medium">
                        ↺ 還原賽事
                    </button>
                    ${(currentUser?.role === 'web_owner' || currentUser?.role === 'super_admin') ? `
                        <button data-action="hard-delete" data-id="${item.id}" class="text-xs bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 px-3 py-1 rounded transition font-medium">
                            ❌ 永久刪除
                        </button>
                    ` : ''}
                </div>
            </div>
        `).join('');
    } catch (err) {
        listEl.innerHTML = `<p class="text-red-500 text-center py-4">載入失敗：${escapeHtml(err.message)}</p>`;
    }
}

async function restoreCompetition(id) {
    try {
        const res = await customFetch(`/api/competitions/${id}/restore`, { method: 'PUT' });
        if (!res.ok) throw new Error('還原失敗');
        alert('✅ 賽事已成功還原！');
        fetchTrashList();
        fetchCompetitions();
    } catch (err) {
        alert(err.message);
    }
}

async function permanentlyDeleteCompetition(id) {
    if (!confirm('⚠️ 警告：確定要「永久刪除」此賽事嗎？此操作將無法復原！')) return;

    try {
        const res = await customFetch(`/api/competitions/${id}/hard-delete`, { method: 'DELETE' });
        if (!res.ok) throw new Error('永久刪除失敗');
        alert('✅ 賽事已永久刪除');
        fetchTrashList();
    } catch (err) {
        alert(err.message);
    }
}
