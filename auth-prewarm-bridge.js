// A visible auth page preempts the optional background-only SSO preparation.
(function initNjuAuthPrewarmBridge(global) {
    'use strict';

    const AUTH_LOGIN_PATH = '/authserver/login';
    const AUTH_LOGOUT_PATH = '/authserver/logout';
    const PREWARM_ENABLED_KEY = 'nju_auth_prewarm_enabled';

    function report(payload) {
        try {
            global.chrome.runtime.sendMessage({ action: 'authPrewarmPageEvent', ...payload }).catch(() => {});
        } catch {
            // The bridge must never affect a normal authserver login.
        }
    }

    async function start() {
        if (!global.chrome?.storage?.local || !global.chrome?.runtime) return;
        const settings = await global.chrome.storage.local.get([PREWARM_ENABLED_KEY]);
        if (settings[PREWARM_ENABLED_KEY] !== true) return;

        const path = global.location.pathname;
        if (path === AUTH_LOGOUT_PATH) {
            try {
                global.chrome.runtime.sendMessage({ action: 'authPrewarmLogout' }).catch(() => {});
            } catch {
                // Ignore unavailable runtime messaging.
            }
            return;
        }

        if (path === AUTH_LOGIN_PATH) report({ kind: 'page', path });
    }

    start().catch(() => {});
})(typeof globalThis !== 'undefined' ? globalThis : window);
