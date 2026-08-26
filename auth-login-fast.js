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

    function injectAIOverlayStyle() {
        const doc = global.document;
        if (doc.getElementById('nju-auth-ai-overlay-style')) return;
        const style = doc.createElement('style');
        style.id = 'nju-auth-ai-overlay-style';
        style.textContent = `
            html[data-nju-ai-status] form#pwdFromId {
                position: relative !important;
                pointer-events: none !important;
            }
            /* Glassy Overlay Base */
            html[data-nju-ai-status] form#pwdFromId::before {
                content: "";
                position: absolute;
                inset: -20px -28px;
                z-index: 9998;
                background: rgba(12, 12, 15, 0.45);
                backdrop-filter: blur(16px) saturate(120%);
                -webkit-backdrop-filter: blur(16px) saturate(120%);
                border-radius: 16px;
                box-shadow: 
                    inset 0 0 0 1px rgba(255, 255, 255, 0.06),
                    inset 0 0 20px rgba(171, 142, 230, 0.08),
                    0 16px 40px rgba(0, 0, 0, 0.3);
            }
            /* Shimmering Text Layer */
            html[data-nju-ai-status] form#pwdFromId::after {
                content: var(--nju-ai-msg, "Automating...");
                position: absolute;
                inset: 0;
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
                font-size: 15px;
                font-weight: 600;
                letter-spacing: 1px;
                /* AI Shimmer Gradient */
                background: linear-gradient(
                    110deg,
                    #8e8e93 0%,
                    #ffffff 40%,
                    #d1bdfa 50%,
                    #ffffff 60%,
                    #8e8e93 100%
                );
                background-size: 200% auto;
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                animation: nju-ai-text-shimmer 2s linear infinite;
            }
            /* Pulsing Edge Animation for Loading */
            @keyframes nju-ai-pulse {
                0% { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06), inset 0 0 20px rgba(171, 142, 230, 0.05), 0 16px 40px rgba(0, 0, 0, 0.3); }
                50% { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15), inset 0 0 40px rgba(171, 142, 230, 0.25), 0 16px 40px rgba(0, 0, 0, 0.4); }
                100% { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06), inset 0 0 20px rgba(171, 142, 230, 0.05), 0 16px 40px rgba(0, 0, 0, 0.3); }
            }
            html[data-nju-ai-status="loading"] form#pwdFromId::before {
                animation: nju-ai-pulse 2s ease-in-out infinite;
            }
            /* Success State */
            html[data-nju-ai-status="success"] form#pwdFromId::before {
                box-shadow: inset 0 0 0 1px rgba(52, 199, 89, 0.25), inset 0 0 30px rgba(52, 199, 89, 0.15), 0 16px 40px rgba(0, 0, 0, 0.3);
                animation: none;
            }
            html[data-nju-ai-status="success"] form#pwdFromId::after {
                background: none;
                -webkit-text-fill-color: #34c759;
                animation: none;
                text-shadow: 0 0 12px rgba(52, 199, 89, 0.3);
            }
            /* Error State */
            html[data-nju-ai-status="error"] form#pwdFromId::before {
                box-shadow: inset 0 0 0 1px rgba(255, 59, 48, 0.25), inset 0 0 30px rgba(255, 59, 48, 0.15), 0 16px 40px rgba(0, 0, 0, 0.3);
                animation: none;
            }
            html[data-nju-ai-status="error"] form#pwdFromId::after {
                background: none;
                -webkit-text-fill-color: #ff3b30;
                animation: none;
                text-shadow: 0 0 12px rgba(255, 59, 48, 0.3);
            }
            @keyframes nju-ai-text-shimmer {
                to { background-position: -200% center; }
            }
            html[data-nju-ai-status] {
                cursor: wait !important;
            }
        `;
        const root = doc.head || doc.documentElement;
        if (root) root.appendChild(style);
    }

    let statusTimer = null;
    function setAIStatus(message, status = 'loading', autoHideMs = 0) {
        if (statusTimer) {
            clearTimeout(statusTimer);
            statusTimer = null;
        }
        injectAIOverlayStyle();
        const root = global.document.documentElement;
        if (!root) return;
        
        root.style.setProperty('--nju-ai-msg', `"${message}"`);
        root.setAttribute('data-nju-ai-status', status);

        if (autoHideMs > 0) {
            statusTimer = setTimeout(() => {
                root.removeAttribute('data-nju-ai-status');
            }, autoHideMs);
        }
    }

    function lockLoginForm() {
        // Now handled entirely by setAIStatus and CSS
    }

    function unlockLoginForm() {
        const root = global.document.documentElement;
        if (root) root.removeAttribute('data-nju-ai-status');
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
        lockLoginForm();
        setAIStatus('正在进行安全验证...', 'loading');
        
        const needsCaptchaPromise = checkAuthserverNeedsCaptcha(username)
            .then(needsCaptcha => ({ ok: true, needsCaptcha }))
            .catch(error => ({ ok: false, error }));
        const isSlider = await waitForSliderCaptchaPage();
        mark('sliderReady');
        if (!isSlider) {
            snapshot.phase = 'not-slider';
            unlockLoginForm();
            return { kind: 'not-slider' };
        }

        snapshot.sliderDetected = true;
        const captchaCheck = await needsCaptchaPromise;
        if (!captchaCheck.ok) {
            unlockLoginForm();
            throw captchaCheck.error;
        }
        const needsCaptcha = captchaCheck.needsCaptcha;
        mark('checked');
        if (!needsCaptcha) {
            snapshot.phase = 'ready';
            setAIStatus('无需安全验证，正在登录...', 'success');
            return { kind: 'no-captcha', username, timings: { ...timings } };
        }

        const sliderRuntime = global.NjuAuthSliderCaptcha;
        if (!sliderRuntime?.solve) {
            unlockLoginForm();
            throw new Error('滑块认证运行时未加载');
        }

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
        if (sliderResult.ok) {
            setAIStatus('安全验证通过，正在登录...', 'success');
        } else {
            setAIStatus('安全验证未通过，请手动完成', 'error', 3000);
            unlockLoginForm();
        }
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
        },
        unlock() {
            unlockLoginForm();
        }
    };
})(window);
