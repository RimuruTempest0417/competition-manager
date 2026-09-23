/* ============================================================
   主題初始化 (Theme init)
   - 必須在 <head> 同步執行，且早於第一次繪製，否則「強制深色」
     的使用者會先看到淺色畫面再切換（FOUC）。
   - CSP 為 script-src 'self'，不可使用 inline script，故獨立成檔。
   - 依 localStorage 的 cm-theme 決定 <html> 的 data-theme：
       無值 / system → 移除屬性（由 CSS media query 跟隨裝置系統）
       light / dark  → 設為對應值（覆寫裝置系統設定）
   - cm-theme 屬純 UI 偏好，不參與任何授權判斷（後端授權只看 JWT）。
   ============================================================ */
(function () {
    'use strict';

    var THEME_KEY = 'cm-theme';
    var LIGHT_COLOR = '#f1f5f9';
    var DARK_COLOR = '#0f172a';

    function readTheme() {
        try {
            var v = localStorage.getItem(THEME_KEY);
            return (v === 'light' || v === 'dark') ? v : 'system';
        } catch (e) {
            // 隱私模式等 localStorage 不可用時，一律跟隨系統
            return 'system';
        }
    }

    // 手機瀏覽器工具列配色：跟隨系統時交給 HTML 的 media meta，
    // 手動強制時才動態建立一個無 media 的 meta（置於最後 → 優先權最高）。
    function syncThemeColorMeta(theme) {
        var existing = document.getElementById('themeColorMeta');
        if (theme === 'system') {
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
            return;
        }
        if (!existing) {
            existing = document.createElement('meta');
            existing.id = 'themeColorMeta';
            existing.setAttribute('name', 'theme-color');
            document.head.appendChild(existing);
        }
        existing.setAttribute('content', theme === 'dark' ? DARK_COLOR : LIGHT_COLOR);
    }

    var theme = readTheme();

    if (theme === 'system') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', theme);
    }
    syncThemeColorMeta(theme);

    // 供 app.js 的切換按鈕共用，避免常數重複定義
    window.CMTheme = {
        KEY: THEME_KEY,
        LIGHT_COLOR: LIGHT_COLOR,
        DARK_COLOR: DARK_COLOR,
        readTheme: readTheme,
        syncThemeColorMeta: syncThemeColorMeta
    };
})();
