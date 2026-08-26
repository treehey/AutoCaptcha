// Background-only NJU unified-authentication login transport. This module
// deliberately uses the browser cookie jar without reading cookie values.
(function initNjuAuthBackgroundLogin(global) {
    'use strict';

    const AUTH_ORIGIN = 'https://authserver.nju.edu.cn';
    const AUTH_LOGIN_URL = `${AUTH_ORIGIN}/authserver/login`;
    const AUTH_LOGIN_PATH = '/authserver/login';

    function decodeHtml(value) {
        return String(value || '')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#(?:39|x27);/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
            .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
    }

    function readAttribute(tag, name) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = String(tag || '').match(new RegExp(
            `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
            'i'
        ));
        return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '') : '';
    }

    function parsePasswordLoginForm(html, baseUrl = AUTH_LOGIN_URL) {
        const forms = String(html || '').match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) || [];
        const candidates = forms.filter(candidate => {
            const openingTag = candidate.match(/^<form\b[^>]*>/i)?.[0] || '';
            return readAttribute(openingTag, 'id') === 'pwdFromId';
        });
        let fallback = null;
        for (const form of candidates) {
            const openingTag = form.match(/^<form\b[^>]*>/i)?.[0] || '';
            const fields = {};
            let salt = '';
            for (const match of form.matchAll(/<input\b[^>]*>/gi)) {
                const tag = match[0];
                const id = readAttribute(tag, 'id');
                const name = readAttribute(tag, 'name');
                const value = readAttribute(tag, 'value');
                if (id === 'pwdEncryptSalt') salt = value;
                if (name) fields[name] = value;
            }

            const action = new URL(readAttribute(openingTag, 'action') || AUTH_LOGIN_PATH, baseUrl).href;
            const parsed = { action, salt, execution: fields.execution || '', fields };
            fallback ||= parsed;
            if (parsed.salt && parsed.execution) return parsed;
        }
        return fallback;
    }

    function responsePath(response) {
        try {
            return new URL(response?.url || AUTH_LOGIN_URL, AUTH_LOGIN_URL).pathname;
        } catch {
            return AUTH_LOGIN_PATH;
        }
    }

    function createAuthBackgroundLogin(deps = {}) {
        const fetchImpl = deps.fetchImpl || global.fetch?.bind(global);
        const sliderRuntime = deps.sliderRuntime || global.NjuAuthSliderCaptcha;

        async function login(options = {}) {
            if (typeof fetchImpl !== 'function') throw new Error('后台网络运行时不可用');
            if (!sliderRuntime?.solve || !sliderRuntime?.encryptForPage) {
                throw new Error('滑块认证运行时未加载');
            }

            const username = String(options.username || '').trim();
            const password = String(options.password || '');
            if (!username || !password) {
                return { ok: false, attention: true, error: '统一认证账号或密码未配置' };
            }

            const signal = options.signal;
            const request = (url, init = {}) => fetchImpl(url, { ...init, signal });
            const loginResponse = await request(AUTH_LOGIN_URL, {
                method: 'GET',
                credentials: 'include',
                cache: 'no-store'
            });
            if (!loginResponse?.ok) throw new Error(`认证页加载失败 (${loginResponse?.status || 'unknown'})`);
            if (responsePath(loginResponse) !== AUTH_LOGIN_PATH) {
                return { ok: true, alreadyAuthenticated: true };
            }

            const loginHtml = await loginResponse.text();
            const form = parsePasswordLoginForm(loginHtml, loginResponse.url || AUTH_LOGIN_URL);
            if (!form?.salt || form.salt.length !== 16 || !form.execution
                || new URL(form.action).origin !== AUTH_ORIGIN) {
                return { ok: false, attention: true, error: '认证页结构已变化，请在认证页登录' };
            }

            const captchaResponse = await request(
                `${AUTH_ORIGIN}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(username)}`,
                {
                    method: 'GET',
                    credentials: 'include',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                }
            );
            if (!captchaResponse?.ok) {
                throw new Error(`验证码状态检查失败 (${captchaResponse?.status || 'unknown'})`);
            }
            const needsCaptcha = Boolean((await captchaResponse.json())?.isNeed);
            if (needsCaptcha) {
                const sliderResult = await sliderRuntime.solve({
                    attempts: 3,
                    origin: AUTH_ORIGIN,
                    fetchImpl: request,
                    onStatus: options.onStatus
                });
                if (!sliderResult?.ok) {
                    return {
                        ok: false,
                        attention: true,
                        error: '后台滑块验证未通过，请在认证页登录'
                    };
                }
            }

            const encryptedPassword = await sliderRuntime.encryptForPage(password, form.salt);
            const body = new URLSearchParams(form.fields);
            body.delete('passwordText');
            body.set('username', username);
            body.set('password', encryptedPassword);
            body.set('captcha', '');
            body.set('_eventId', body.get('_eventId') || 'submit');
            body.set('cllt', body.get('cllt') || 'userNameLogin');
            body.set('dllt', body.get('dllt') || 'generalLogin');
            body.set('lt', body.get('lt') || '');
            body.set('execution', form.execution);

            const submitResponse = await request(form.action, {
                method: 'POST',
                credentials: 'include',
                redirect: 'follow',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: body.toString()
            });
            if (!submitResponse?.ok) {
                throw new Error(`统一认证提交失败 (${submitResponse?.status || 'unknown'})`);
            }
            if (responsePath(submitResponse) !== AUTH_LOGIN_PATH) {
                return { ok: true, alreadyAuthenticated: false, needsCaptcha };
            }

            return {
                ok: false,
                attention: true,
                error: '统一认证未完成，请在认证页确认账号或安全验证'
            };
        }

        return Object.freeze({ login });
    }

    global.NjuAuthBackgroundLogin = Object.freeze({
        AUTH_ORIGIN,
        AUTH_LOGIN_URL,
        AUTH_LOGIN_PATH,
        parsePasswordLoginForm,
        createAuthBackgroundLogin
    });
})(typeof globalThis !== 'undefined' ? globalThis : window);
