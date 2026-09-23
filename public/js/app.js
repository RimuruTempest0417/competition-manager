let allCompetitions = [];
let currentUser = null;
let currentBase64Screenshot = '';
let currentPosterItem = null;

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
        default: return '一般使用者';
    }
}

function getRoleBadge(role, username = '') {
    const badgeClass = role === 'web_owner' ? 'bg-amber-100 text-amber-800 font-bold' :
        role === 'super_admin' ? 'bg-indigo-100 text-indigo-700 font-medium' :
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

document.addEventListener('DOMContentLoaded', () => {
    initTimeSelects();
    updateThemeButton(getStoredTheme());

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
    document.getElementById('clearFilterBtn')?.addEventListener('click', clearFilter);
    document.getElementById('mainTrashBtn')?.addEventListener('click', openTrashModal);

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
    document.getElementById('submitLoginBtn')?.addEventListener('click', performLogin);

    document.getElementById('closeAuditModalBtn')?.addEventListener('click', closeAuditLogModal);
    document.getElementById('closeAuditModalBtn2')?.addEventListener('click', closeAuditLogModal);

    document.getElementById('closeErrorModalBtn')?.addEventListener('click', closeErrorLogsModal);
    document.getElementById('closeErrorModalBtn2')?.addEventListener('click', closeErrorLogsModal);

    document.getElementById('closeAdminModalBtn')?.addEventListener('click', closeAdminModal);
    document.getElementById('closeAdminModalBtn2')?.addEventListener('click', closeAdminModal);
    document.getElementById('addAdminForm')?.addEventListener('submit', handleAddAdmin);

    document.getElementById('closeTrashModalBtn')?.addEventListener('click', closeTrashModal);
    document.getElementById('closeTrashModalBtn2')?.addEventListener('click', closeTrashModal);

    // 事件委派：動態清單按鈕點擊處理
    document.getElementById('competitionList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        if (action === 'copy-text') {
            copyToClipboard(btn.dataset.name, btn.dataset.date, btn.dataset.endDate, btn.dataset.location);
        } else if (action === 'share-poster') {
            openPosterModal(id);
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
    updateUIByRole();
    fetchCompetitions();
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
    const changePwdBtn = document.getElementById('changePwdBtn');
    const authBtn = document.getElementById('authBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const menuDivider = document.getElementById('menuDivider');

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

        authBtn?.classList.remove('hidden');
        logoutBtn?.classList.add('hidden');
    } else {
        dropdownUserInfo?.classList.remove('hidden');
        if (dropdownUsername) dropdownUsername.innerText = currentUser.username || '使用者';
        createSection?.classList.remove('hidden');
        changePwdBtn?.classList.remove('hidden');
        menuDivider?.classList.remove('hidden');
        authBtn?.classList.add('hidden');
        logoutBtn?.classList.remove('hidden');

        if (currentUser.role === 'web_owner') {
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300 font-bold";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.remove('hidden');
            btnErrorLogs?.classList.remove('hidden');
            adminMgmtBtn?.classList.remove('hidden');
            mainTrashBtn?.classList.remove('hidden');
        } else if (currentUser.role === 'super_admin') {
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-300";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.remove('hidden');
            btnErrorLogs?.classList.remove('hidden');
            adminMgmtBtn?.classList.remove('hidden');
            mainTrashBtn?.classList.remove('hidden');
        } else if (currentUser.role === 'test') {
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-purple-100 text-purple-700 border border-purple-300";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.add('hidden');
            btnErrorLogs?.classList.add('hidden');
            adminMgmtBtn?.classList.add('hidden');
            mainTrashBtn?.classList.add('hidden');
        } else {
            authStatus.className = "text-sm font-medium px-3 py-1 rounded-full bg-blue-100 text-blue-700 border border-blue-300";
            authStatus.innerText = `${getRoleEmoji(currentUser.role, currentUser.username)} ${getRoleLabel(currentUser.role, currentUser.username)}: ${currentUser.username}`;
            auditLogBtn?.classList.add('hidden');
            btnErrorLogs?.classList.add('hidden');
            adminMgmtBtn?.classList.add('hidden');
            mainTrashBtn?.classList.remove('hidden');
        }
    }
    renderCompetitions(allCompetitions);
}

async function fetchCompetitions() {
    try {
        const res = await customFetch('/api/competitions');
        if (!res.ok) throw new Error('無法載入比賽資料');
        allCompetitions = await res.json();
        renderCompetitions(allCompetitions);
    } catch (err) {
        document.getElementById('competitionList').innerHTML = `<p class="text-red-500 text-center py-4">無法載入比賽資料</p>`;
    }
}

function filterCompetitions() {
    const query = document.getElementById('searchInput').value.toLowerCase().trim();
    const filterDate = document.getElementById('filterDateInput').value;

    const filtered = allCompetitions.filter(item => {
        const matchQuery = !query ||
            (item.name && item.name.toLowerCase().includes(query)) ||
            (item.location && item.location.toLowerCase().includes(query)) ||
            (item.description && item.description.toLowerCase().includes(query));

        const matchDate = !filterDate || item.date === filterDate || item.end_date === filterDate;
        return matchQuery && matchDate;
    });

    renderCompetitions(filtered);
}

function clearFilter() {
    document.getElementById('searchInput').value = '';
    document.getElementById('filterDateInput').value = '';
    renderCompetitions(allCompetitions);
}

function renderCompetitions(data) {
    const listEl = document.getElementById('competitionList');
    if (!data || data.length === 0) {
        listEl.innerHTML = `<p class="text-center text-slate-400 py-8">目前無符合條件的比賽資料</p>`;
        return;
    }

    listEl.innerHTML = data.map(item => `
        <div class="border border-slate-200 rounded-xl p-5 hover:border-slate-300 transition bg-white shadow-sm flex flex-col md:flex-row justify-between gap-4">
            <div class="space-y-2 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="text-base font-bold text-slate-800">${escapeHtml(item.name)}</h3>
                    ${item.publisher_name ? `<span class="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-medium" title="權限層級：${escapeHtml(getRoleLabel(item.publisher_role, item.publisher_name))}"><span>${getRoleEmoji(item.publisher_role, item.publisher_name)}</span> <span>${escapeHtml(item.publisher_name)}</span></span>` : ''}
                    ${item.is_registration_open ? '<span class="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full font-medium">🔥 報名中</span>' : '<span class="bg-slate-100 text-slate-500 text-xs px-2 py-0.5 rounded-full font-medium">已截止</span>'}
                    ${getBadgeStatus(item.date, item.end_date)}
                </div>
                
                <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    ${item.location ? `<span>📍 ${escapeHtml(item.location)}</span>` : ''}
                    ${item.date ? `<span>📅 開始：${escapeHtml(item.date)} ${item.time ? format24HourTime(escapeHtml(item.time)) : ''}</span>` : ''}
                    ${item.end_date ? `<span>📅 結束：${escapeHtml(item.end_date)} ${item.end_time ? format24HourTime(escapeHtml(item.end_time)) : ''}</span>` : ''}
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

                ${currentUser ? `
                    <button data-action="copy-comp" data-id="${item.id}" class="text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded transition">複製發佈</button>
                    <button data-action="edit-comp" data-id="${item.id}" class="text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded transition">編輯</button>
                    <button data-action="delete-comp" data-id="${item.id}" class="text-xs text-red-600 hover:text-red-800 bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded transition">刪除</button>
                ` : ''}
            </div>
        </div>
    `).join('');
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
        is_registration_open: document.getElementById('is_registration_open').checked
    };

    const url = editingId ? `/api/competitions/${editingId}` : '/api/competitions';
    const method = editingId ? 'PUT' : 'POST';

    try {
        const res = await customFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error('儲存失敗');

        resetForm();
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
