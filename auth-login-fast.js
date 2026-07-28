// Starts the current authserver slider flow before document_idle so the
// server-required verification delay overlaps with page rendering.
(function initNjuAuthLoginFastPath(global) {
    'use strict';

    const AUTH_LOGIN_PATH = '/authserver/login';
    const SETTINGS_KEYS = ['nju_enabled', 'nju_user', 'nju_pass', 'nju_auto_click'];
    const timings = {};
    const snapshot = { phase: 'starting', sliderDetected: false };

    function now() {
        return global.performance?.now?.() || Date.now();
    }

    function mark(name) {
        timings[name] = now();
    }

    function isSliderCaptchaPage() {
        const sliderContainer = global.document.getElementById('sliderCaptchaDiv');
        if (!sliderContainer) return false;
        return Array.from(global.document.scripts).some(script => /captchaSwitch\s*=\s*["']2["']/.test(script.textContent || ''));
    }

    function waitForSliderCaptchaPage() {
        if (isSliderCaptchaPage()) return Promise.resolve(true);
        return new Promise(resolve => {
            let settled = false;
            const finish = isSlider => {
                if (settled) return;
                settled = true;
                observer.disconnect();
                resolve(isSlider);
            };
            const observer = new global.MutationObserver(() => {
                if (isSliderCaptchaPage()) finish(true);
            });
            observer.observe(global.document, { childList: true, subtree: true });
            global.document.addEventListener('DOMContentLoaded', () => finish(isSliderCaptchaPage()), { once: true });
        });
    }

    async function checkAuthserverNeedsCaptcha(username) {
        const endpoint = new URL(`/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(username)}`, global.location.origin);
        const response = await global.fetch(endpoint.href, {
            method: 'GET',
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (!response.ok) throw new Error(`验证码状态检查失败 (${response.status})`);
        const result = await response.json();
        return Boolean(result?.isNeed);
    }

    async function start() {
        mark('started');
        if (global.location.pathname !== AUTH_LOGIN_PATH) return { kind: 'ignored' };

        const settings = await global.chrome.storage.local.get(SETTINGS_KEYS);
        const username = String(settings.nju_user || '').trim();
        if (settings.nju_enabled === false || settings.nju_auto_click === false || !username || !settings.nju_pass) {
            snapshot.phase = 'skipped';
            return { kind: 'skipped' };
        }

        snapshot.phase = 'checking';
        mark('checking');
        const needsCaptchaPromise = checkAuthserverNeedsCaptcha(username)
            .then(needsCaptcha => ({ ok: true, needsCaptcha }))
            .catch(error => ({ ok: false, error }));
        const isSlider = await waitForSliderCaptchaPage();
        mark('sliderReady');
        if (!isSlider) {
            snapshot.phase = 'not-slider';
            return { kind: 'not-slider' };
        }

        snapshot.sliderDetected = true;
        const captchaCheck = await needsCaptchaPromise;
        if (!captchaCheck.ok) throw captchaCheck.error;
        const needsCaptcha = captchaCheck.needsCaptcha;
        mark('checked');
        if (!needsCaptcha) {
            snapshot.phase = 'ready';
            return { kind: 'no-captcha', username, timings: { ...timings } };
        }

        const sliderRuntime = global.NjuAuthSliderCaptcha;
        if (!sliderRuntime?.solve) throw new Error('滑块认证运行时未加载');

        snapshot.phase = 'opening';
        mark('solving');
        const sliderResult = await sliderRuntime.solve({
            attempts: 3,
            onStatus: state => {
                snapshot.phase = state.phase;
                mark(state.phase);
            }
        });
        mark('solved');
        snapshot.phase = sliderResult.ok ? 'ready' : 'failed';
        return { kind: 'slider', username, sliderResult, timings: { ...timings } };
    }

    const resultPromise = start().catch(error => {
        snapshot.phase = 'error';
        return { kind: 'error', error: error?.message || '快速登录初始化失败', timings: { ...timings } };
    });

    global.NjuAuthLoginFastPath = {
        getResult() {
            return resultPromise;
        },
        getSnapshot() {
            return { ...snapshot };
        }
    };
})(window);
