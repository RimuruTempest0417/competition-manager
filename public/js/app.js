let allCompetitions = [];
let currentUser = null;
let currentBase64Screenshot = '';
let currentPosterItem = null;
let currentView = 'list';                                        // 'list' | 'calendar'
let regCounts = {};                                             // 各賽事報名人數（v2.9.0）
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

function handleLogout() {
    currentUser = null;
    localStorage.removeItem('competition_user');
    localStorage.removeItem('auth_token');
    closeNavDropdown();
    updateUIByRole();
}

function renderRoleSelectOptions() {
    const selectEl = document.getElementById('newAdminRole');
    if (!selectEl) return;

    if (currentUser?.role === 'web_owner') {
        selectEl.innerHTML = `
            <option value="admin">一般管理員 (admin)</option>
            <option value="super_admin">超級管理員 (super_admin)</option>
        `;
    } else {
        selectEl.innerHTML = `
            <option value="admin">一般管理員 (admin)</option>
        `;
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

function getBadgeStatus(dateStr, endDateStr) {
    if (!dateStr) return '';

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [startYear, startMonth, startDay] = dateStr.split('-').map(Number);
    const start = new Date(startYear, startMonth - 1, startDay);

    let end = start;
    if (endDateStr) {
        const [endYear, endMonth, endDay] = endDateStr.split('-').map(Number);
        end = new Date(endYear, endMonth - 1, endDay);
    }

    const diffTime = start - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays > 0) {
        return `<span class="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full font-medium">⏳ 倒數 ${diffDays} 天</span>`;
    } else if (today >= start && today <= end) {
        return '<span class="bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-medium">🔥 進行中</span>';
    }
    return '<span class="bg-slate-100 text-slate-500 text-xs px-2 py-0.5 rounded-full">已結束</span>';
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
        const token = localStorage.getItem('auth_token');
        const headers = new Headers(options.headers || {});
        headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
        if (token) headers.set('Authorization', `Bearer ${token}`);

        const response = await fetch(url, { ...options, headers });
        if ((response.status === 401 || response.status === 403) && token) {
            localStorage.removeItem('auth_token');
            localStorage.removeItem('competition_user');
            alert('登入狀態已失效，請重新登入');
            window.location.reload();
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
    initTimeSelects();
    updateThemeButton(getStoredTheme());
    renderTagPreview();

    // 綁定靜態按鈕事件
    document.getElementById('themeToggleBtn')?.addEventListener('click', cycleTheme);
    document.getElementById('navMenuBtn')?.addEventListener('click', toggleNavDropdown);
    document.getElementById('menuBugReport')?.addEventListener('click', () => { openBugReportModal(); closeNavDropdown(); });
    document.getElementById('auditLogBtn')?.addEventListener('click', () => { openAuditLogModal(); closeNavDropdown(); });
    document.getElementById('btn-error-logs')?.addEventListener('click', () => { openErrorLogsModal(); closeNavDropdown(); });
    document.getElementById('adminMgmtBtn')?.addEventListener('click', () => { openAdminModal(); closeNavDropdown(); });
    document.getElementById('changePwdBtn')?.addEventListener('click', () => { openChangePasswordModal(); closeNavDropdown(); });
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
        return loginMode === 'register' ? performRegister() : performLogin();
    });
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
        if (!btn || btn.dataset.action !== 'cancel-reg') return;
        cancelRegistration(Number(btn.dataset.id));
    });

    document.getElementById('cancelEditBtn')?.addEventListener('click', clearTeamFormFields);
    document.getElementById('closeTeamModalBtn')?.addEventListener('click', closeTeamModal);
    document.getElementById('closeTeamModalBtn2')?.addEventListener('click', closeTeamModal);
    document.getElementById('createTeamBtn')?.addEventListener('click', createTeam);
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

    document.getElementById('closeAuditModalBtn')?.addEventListener('click', closeAuditLogModal);
    document.getElementById('closeAuditModalBtn2')?.addEventListener('click', closeAuditLogModal);

    document.getElementById('closeErrorModalBtn')?.addEventListener('click', closeErrorLogsModal);
    document.getElementById('closeErrorModalBtn2')?.addEventListener('click', closeErrorLogsModal);

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
        } else if (action === 'copy-comp') {
            copyCompetition(id);
        } else if (action === 'edit-comp') {
            startEdit(id);
        } else if (action === 'delete-comp') {
            deleteCompetition(id);
        }
    });

    document.getElementById('adminList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.action === 'delete-admin') {
            deleteAdmin(btn.dataset.username);
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

    const savedUser = localStorage.getItem('competition_user');
    const token = localStorage.getItem('auth_token');
    if (savedUser && token) {
        currentUser = JSON.parse(savedUser);
    } else {
        currentUser = null;
        localStorage.removeItem('competition_user');
        localStorage.removeItem('auth_token');
    }
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
});

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

    if (!currentUser) {
        authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200";
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
        } else {
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-blue-100 text-blue-700 border border-blue-300";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.add('hidden');
            btnErrorLogs?.classList.add('hidden');
            adminMgmtBtn?.classList.add('hidden');
            mainTrashBtn?.classList.remove('hidden');
            csvToolBtn?.classList.remove('hidden');
        }
    }
    renderCurrentView(allCompetitions);
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

function clientRegistrationState(item) {
    if (!item) return { open: false, reason: '找不到該賽事' };
    if (!item.is_registration_open) return { open: false, reason: '未開放報名' };

    const today = todayString();
    if (item.registration_deadline && today > String(item.registration_deadline).slice(0, 10)) {
        return { open: false, reason: '報名已截止' };
    }
    if (item.date && today > String(item.date).slice(0, 10)) {
        return { open: false, reason: '已結束' };
    }

    const max = Number(item.max_registrations) || 0;
    const count = Number(regCounts[String(item.id)]) || 0;
    if (max > 0 && count >= max) return { open: false, reason: '已額滿' };

    return { open: true, reason: '' };
}

// 是否為管理員以上（與後端 ADMIN_ROLES 一致：test 帳號不具管理權）
function isAdminUser() {
    return !!currentUser && ['admin', 'super_admin', 'web_owner'].includes(currentUser.role);
}

function isMyRegistration(id) {
    return myRegistrations.some((r) => String(r.competition_id) === String(id));
}

function regStatusBadgeHtml(item) {
    const state = clientRegistrationState(item);
    if (state.open) {
        return '<span class="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full font-medium">🔥 報名中</span>';
    }
    return `<span class="bg-slate-100 text-slate-500 text-xs px-2 py-0.5 rounded-full font-medium">${escapeHtml(state.reason)}</span>`;
}

function regMetaHtml(item) {
    const parts = [];
    const count = Number(regCounts[String(item.id)]) || 0;
    if (count > 0) parts.push(`<span class="text-emerald-600 font-medium">👥 ${count} 人已報名</span>`);
    if (Number(item.max_registrations) > 0) parts.push(`<span>名額 ${item.max_registrations} 人</span>`);
    if (item.is_team_event && Number(item.team_size) > 0) parts.push(`<span>每隊上限 ${item.team_size} 人</span>`);
    if (item.registration_deadline) {
        const open = clientRegistrationState(item).open;
        parts.push(`<span class="${open ? '' : 'text-red-500'}">⏰ 報名截止 ${escapeHtml(String(item.registration_deadline).slice(0, 10))}</span>`);
    }
    return parts.join('');
}

function registrationButtonHtml(item) {
    if (isMyRegistration(item.id)) {
        return '<button data-action="my-regs" class="text-xs text-emerald-700 bg-emerald-100 hover:bg-emerald-200 font-medium px-2.5 py-1 rounded transition">✅ 已報名</button>';
    }
    const state = clientRegistrationState(item);
    if (state.open) {
        return `<button data-action="register-comp" data-id="${item.id}" class="text-xs text-white bg-blue-600 hover:bg-blue-700 font-medium px-2.5 py-1 rounded transition">📝 報名</button>`;
    }
    return `<button data-action="register-comp" data-id="${item.id}" class="text-xs text-slate-500 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded transition">🔒 ${escapeHtml(state.reason)}</button>`;
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

        localStorage.setItem('auth_token', data.token);
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
        }
        if (cfgRes.ok) {
            const cfg = await cfgRes.json();
            CM_META.registration = { codeRequired: !!cfg.requireRegistrationCode };
        }
    } catch (e) {
        regCounts = {};   // 未執行 migration 或離線時不影響瀏覽
    }
}

function clearTeamFormFields() {
    const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setChecked = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };

    setChecked('is_team_event', false);
    setValue('team_size', '');
    setValue('max_registrations', '');
    setValue('registration_deadline', '');
}

async function fetchMyRegistrations() {
    if (!currentUser) { myRegistrations = []; return; }
    try {
        const res = await customFetch('/api/my/registrations');
        myRegistrations = res.ok ? await res.json() : [];
    } catch (e) {
        myRegistrations = [];
    }
}

function openRegisterModal(id) {
    const item = allCompetitions.find((c) => c.id === id);
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
function renderMyRegs() {
    const list = document.getElementById('myRegsList');
    if (!list) return;

    if (!myRegistrations.length) {
        list.innerHTML = '<p class="text-center text-slate-400 py-6 text-sm">目前沒有報名紀錄</p>';
        return;
    }

    list.innerHTML = myRegistrations.map((r) => {
        const comp = r.competitions || {};
        return `
        <div class="border border-slate-200 rounded-lg p-3 flex justify-between items-start gap-3">
            <div class="min-w-0">
                <p class="text-sm font-bold text-slate-800">${escapeHtml(comp.name || '(賽事已刪除)')}</p>
                <p class="text-xs text-slate-500 mt-0.5">📅 ${escapeHtml(comp.date || '')}${comp.time ? ' ' + escapeHtml(comp.time) : ''}${comp.location ? ' ｜ 📍 ' + escapeHtml(comp.location) : ''}</p>
                ${comp.is_team_event && r.team_name ? `<p class="text-xs text-indigo-600 mt-0.5">👥 隊伍：${escapeHtml(r.team_name)}</p>` : ''}
                ${r.note ? `<p class="text-xs text-slate-500 mt-0.5">📝 ${escapeHtml(r.note)}</p>` : ''}
                <p class="text-xs text-slate-400 mt-0.5">報名時間：${escapeHtml(String(r.created_at || '').slice(0, 16).replace('T', ' '))}</p>
            </div>
            <button data-action="cancel-reg" data-id="${r.id}"
                class="text-xs text-red-600 hover:text-red-800 bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded transition shrink-0">取消報名</button>
        </div>`;
    }).join('');
}

async function openMyRegsModal() {
    if (!currentUser) return openLoginModal('請先登入才能查看你的報名紀錄。');

    closeNavDropdown();
    const list = document.getElementById('myRegsList');
    if (list) list.innerHTML = '<p class="text-center text-slate-400 py-6 text-sm">載入中…</p>';
    document.getElementById('myRegsModal')?.classList.remove('hidden');

    await fetchMyRegistrations();
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

async function openTeamModal(id) {
    const item = allCompetitions.find((c) => c.id === id);
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
    const { rows } = CMCSV.templateRows();
    downloadCsvBlob('competitions-template.csv', new Blob([CMCSV.stringify(rows, { bom: true })], { type: 'text/csv;charset=utf-8' }));
    showCsvResult('success', '已下載匯入範本（含表頭與一列示範資料）');
}

async function csvPickFile(event) {
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

async function fetchCompetitions() {
    try {
        const res = await customFetch('/api/competitions');
        if (!res.ok) throw new Error('無法載入比賽資料');
        allCompetitions = await res.json();
        populateTagFilter();
        renderCurrentView(allCompetitions);

        // 資料到齊後再檢查一次通知（第一次執行只建立基準，不會灌通知）
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
        query: (document.getElementById('searchInput')?.value || '').toLowerCase().trim(),
        date: document.getElementById('filterDateInput')?.value || '',
        category: document.getElementById('filterCategory')?.value || '',
        tag: document.getElementById('filterTag')?.value || ''
    };
}

function matchesFilters(item, f) {
    const matchQuery = !f.query ||
        (item.name && item.name.toLowerCase().includes(f.query)) ||
        (item.location && item.location.toLowerCase().includes(f.query)) ||
        (item.description && item.description.toLowerCase().includes(f.query));

    const matchDate = !f.date || item.date === f.date || item.end_date === f.date;
    const matchCategory = !f.category || item.category === f.category;
    const matchTag = !f.tag ||
        (Array.isArray(item.tags) && item.tags.some((t) => t.toLowerCase() === f.tag.toLowerCase()));

    return matchQuery && matchDate && matchCategory && matchTag;
}

function filterCompetitions() {
    const f = currentFilters();
    renderCurrentView(allCompetitions.filter((item) => matchesFilters(item, f)));
}

function clearFilter() {
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

function competitionCardHtml(item) {
    return `
        <div class="border border-slate-200 rounded-xl p-5 hover:border-slate-300 transition bg-white shadow-sm flex flex-col md:flex-row justify-between gap-4">
            <div class="space-y-2 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="text-base font-bold text-slate-800">${escapeHtml(item.name)}</h3>
                    ${item.publisher_name ? `<span class="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-medium" title="權限層級：${escapeHtml(getRoleLabel(item.publisher_role, item.publisher_name))}"><span>${getRoleEmoji(item.publisher_role, item.publisher_name)}</span> <span>${escapeHtml(item.publisher_name)}</span></span>` : ''}
                    ${categoryBadgeHtml(item)}
                    ${regStatusBadgeHtml(item)}
                    ${item.is_team_event ? '<span class="bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded-full font-medium">👥 組隊比賽</span>' : ''}
                    ${getBadgeStatus(item.date, item.end_date)}
                </div>
                
                <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    ${item.location ? `<span>📍 ${escapeHtml(item.location)}</span>` : ''}
                    ${item.date ? `<span>📅 開始：${escapeHtml(item.date)} ${item.time ? format24HourTime(escapeHtml(item.time)) : ''}</span>` : ''}
                    ${item.end_date ? `<span>📅 結束：${escapeHtml(item.end_date)} ${item.end_time ? format24HourTime(escapeHtml(item.end_time)) : ''}</span>` : ''}
                </div>

                ${(Array.isArray(item.tags) && item.tags.length) ? `<div class="flex flex-wrap gap-1">${tagsBadgeHtml(item)}</div>` : ''}

                <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    ${regMetaHtml(item)}
                </div>

                ${item.description ? `<p class="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-lg whitespace-pre-line border border-slate-100">${escapeHtml(item.description)}</p>` : ''}
            </div>

            <div class="flex items-start gap-1.5 self-end md:self-start flex-wrap">
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

                ${registrationButtonHtml(item)}

                <button data-action="toggle-subscribe" data-id="${item.id}"
                        class="text-xs ${isSubscribed(item.id) ? 'text-emerald-700 bg-emerald-100 hover:bg-emerald-200 font-medium' : 'text-slate-600 bg-slate-100 hover:bg-slate-200'} px-2.5 py-1 rounded transition">
                    ${isSubscribed(item.id) ? '🔔 已訂閱' : '🔕 訂閱提醒'}
                </button>

                ${isAdminUser() ? `
                    <button data-action="copy-comp" data-id="${item.id}" class="text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded transition">複製發佈</button>
                    <button data-action="edit-comp" data-id="${item.id}" class="text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded transition">編輯</button>
                    <button data-action="manage-teams" data-id="${item.id}" class="text-xs text-emerald-700 hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded transition">👥 報名／隊伍</button>
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
        registration_deadline: document.getElementById('registration_deadline').value || null
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

        resetForm();
        clearTeamFormFields();
        fetchCompetitions();
        alert(editingId ? '比賽更新成功！' : '賽事發佈成功！');
    } catch (err) {
        alert('操作失敗：' + err.message);
    }
}

function startEdit(id) {
    const item = allCompetitions.find(c => c.id === id);
    if (!item) return;

    document.getElementById('editingId').value = item.id;
    document.getElementById('name').value = item.name || '';
    document.getElementById('location').value = item.location || '';
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
    document.getElementById('registration_deadline').value = item.registration_deadline ? String(item.registration_deadline).slice(0, 10) : '';
    renderTagPreview();

    document.getElementById('formTitle').innerText = '✏️ 編輯比賽資料';
    document.getElementById('submitBtn').innerText = '儲存變更';
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function copyCompetition(id) {
    const item = allCompetitions.find(c => c.id === id);
    if (!item) return;

    document.getElementById('editingId').value = '';
    document.getElementById('name').value = `${item.name} (複製)`;
    document.getElementById('location').value = item.location || '';
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
    document.getElementById('registration_deadline').value = item.registration_deadline ? String(item.registration_deadline).slice(0, 10) : '';
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
        currentUser = data.user;
        localStorage.setItem('auth_token', data.token);
        localStorage.setItem('competition_user', JSON.stringify(currentUser));
        closeLoginModal();
        updateUIByRole();
    } catch (err) {
        alert(err.message);
    }
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

async function openAuditLogModal() {
    document.getElementById('auditLogModal').classList.remove('hidden');
    const listEl = document.getElementById('auditLogList');
    listEl.innerHTML = '<p class="text-center text-slate-400 py-4">載入日誌中...</p>';

    try {
        const res = await customFetch('/api/audit-logs');
        if (!res.ok) throw new Error('讀取日誌失敗');
        const logs = await res.json();

        if (!logs || logs.length === 0) {
            listEl.innerHTML = '<p class="text-center text-slate-400 py-4">目前尚無操作紀錄</p>';
            return;
        }

        listEl.innerHTML = logs.map(log => {
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
    } catch (err) {
        listEl.innerHTML = '<p class="text-red-500 text-center py-4">無法載入日誌</p>';
    }
}

function closeAuditLogModal() {
    document.getElementById('auditLogModal').classList.add('hidden');
}

async function openErrorLogsModal() {
    document.getElementById('errorLogsModal').classList.remove('hidden');
    const listEl = document.getElementById('errorLogList');
    listEl.innerHTML = '<p class="text-center text-slate-400 py-4">載入錯誤日誌中...</p>';

    try {
        const res = await customFetch('/api/admin/error-logs');
        if (!res.ok) throw new Error('無法讀取錯誤日誌');
        const result = await res.json();
        const logs = result.logs || [];

        if (logs.length === 0) {
            listEl.innerHTML = '<p class="text-center text-emerald-600 py-4 font-sans font-medium">🎉 目前沒有任何異常錯誤紀錄！</p>';
            return;
        }

        listEl.innerHTML = logs.map(l => {
            const hasScreenshot = l.screenshot && typeof l.screenshot === 'string' && l.screenshot.startsWith('data:image/');
            return `
            <div class="p-3 bg-red-50 border border-red-200 rounded-lg space-y-1">
                <div class="flex justify-between items-center flex-wrap gap-1">
                    <div class="flex items-center gap-1.5">
                        <span class="bg-red-200 text-red-800 text-[10px] px-2 py-0.5 rounded font-bold">${escapeHtml(l.error_type)}</span>
                        ${parseUserAgentBadge(l.user_agent)}
                    </div>
                    <span class="text-slate-400 text-[10px]">${new Date(l.created_at).toLocaleString()}</span>
                </div>
                <p class="text-red-700 font-semibold text-xs">${escapeHtml(l.message)}</p>
                ${l.path ? `<p class="text-slate-500 text-[11px]">路徑: ${escapeHtml(l.path)}</p>` : ''}
                ${l.user_agent ? `<p class="text-[10px] font-mono text-slate-500 bg-white/60 p-1 rounded border border-red-100 break-all">UA: ${escapeHtml(l.user_agent)}</p>` : ''}
                ${l.stack_trace ? `<pre class="text-[10px] text-slate-600 bg-white p-2 rounded border border-slate-200 overflow-x-auto mt-1">${escapeHtml(l.stack_trace)}</pre>` : ''}
                
                ${hasScreenshot ? `
                    <div class="mt-2 pt-2 border-t border-red-200">
                        <span class="text-[11px] font-semibold text-slate-600 block mb-1">📷 夾帶截圖：</span>
                        <a href="${l.screenshot}" target="_blank" rel="noopener noreferrer" title="點擊檢視原圖">
                            <img src="${l.screenshot}" alt="錯誤截圖" class="max-h-48 rounded border border-slate-300 hover:opacity-90 transition object-contain bg-slate-900/5 p-1">
                        </a>
                    </div>
                ` : ''}
            </div>
        `}).join('');
    } catch (err) {
        listEl.innerHTML = '<p class="text-red-500 text-center py-4 font-sans">無法載入錯誤日誌</p>';
    }
}

function closeErrorLogsModal() {
    document.getElementById('errorLogsModal').classList.add('hidden');
}

async function openAdminModal() {
    document.getElementById('adminModal').classList.remove('hidden');
    renderRoleSelectOptions();
    fetchAdminList();
}

function closeAdminModal() {
    document.getElementById('adminModal').classList.add('hidden');
}

async function fetchAdminList() {
    const listEl = document.getElementById('adminList');
    listEl.innerHTML = '<p class="text-slate-400 text-xs py-2">載入帳號清單中...</p>';

    try {
        const res = await customFetch('/api/admin/users');
        if (!res.ok) throw new Error('無法取得帳號資料');
        const users = await res.json();

        if (!users || users.length === 0) {
            listEl.innerHTML = '<p class="text-slate-400 text-xs py-2">目前沒有其他帳號</p>';
            return;
        }

        listEl.innerHTML = users.map(u => `
            <div class="flex items-center justify-between p-2 bg-slate-50 border border-slate-200 rounded text-xs">
                <div class="flex items-center gap-2">
                    <span class="font-bold text-slate-700">${escapeHtml(u.username)}</span>
                    ${getRoleBadge(u.role, u.username)}
                </div>
                ${canDeleteAdmin(u) ? `
                    <button data-action="delete-admin" data-username="${escapeHtml(u.username)}" class="text-red-600 hover:text-red-800 text-[11px] font-medium transition px-1.5 py-0.5 rounded hover:bg-red-50">
                        刪除
                    </button>
                ` : ''}
            </div>
        `).join('');
    } catch (err) {
        listEl.innerHTML = `<p class="text-red-500 text-xs py-2">載入失敗：${escapeHtml(err.message)}</p>`;
    }
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

        if (!res.ok) throw new Error('新增失敗');
        alert('✅ 新增管理員成功！');
        document.getElementById('newAdminUser').value = '';
        document.getElementById('newAdminPass').value = '';
        fetchAdminList();
    } catch (err) {
        alert('新增失敗：' + err.message);
    }
}

async function deleteAdmin(username) {
    if (!confirm(`確定要刪除管理員帳號「${username}」嗎？`)) return;

    try {
        const res = await customFetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('刪除失敗');
        alert('✅ 已成功刪除該帳號！');
        fetchAdminList();
    } catch (err) {
        alert('刪除失敗：' + err.message);
    }
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
