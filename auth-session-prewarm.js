// Optional, once-per-browser-session SSO preparation. Authentication runs
// entirely in the extension service worker, so no browser tab is created.
if (typeof importScripts === 'function') {
    importScripts('auth-slider-captcha.js', 'auth-background-login.js');
}

(function initNjuAuthSessionPrewarmer(global) {
    'use strict';

    const AUTH_LOGIN_URL = 'https://authserver.nju.edu.cn/authserver/login';
    const AUTH_LOGIN_PATH = '/authserver/login';
    const PREWARM_ENABLED_KEY = 'nju_auth_prewarm_enabled';
    const STATE_KEY = 'nju_auth_prewarm_state';
    const ALARM_NAME = 'nju-auth-prewarm-timeout';
    const SETTINGS_KEYS = [
        PREWARM_ENABLED_KEY,
        'nju_enabled',
        'nju_user',
        'nju_pass',
        'nju_auto_click'
    ];

    function defaultState() {
        return {
            phase: 'idle',
            attempted: false,
            suppressed: false,
            tabId: null,
            runId: 0,
            startedAt: 0,
            reason: ''
        };
    }

    function normalizeState(value) {
        return {
            ...defaultState(),
            ...(value && typeof value === 'object' ? value : {}),
            tabId: null
        };
    }

    function isEligible(settings) {
        return settings?.[PREWARM_ENABLED_KEY] === true
            && settings.nju_enabled !== false
            && settings.nju_auto_click !== false
            && Boolean(String(settings.nju_user || '').trim())
            && Boolean(settings.nju_pass);
    }

    function createAuthSessionPrewarmer(deps) {
        async function readState() {
            return normalizeState(await deps.readState());
        }

        async function writeState(next) {
            const state = normalizeState(next);
            await deps.writeState(state);
            if (typeof deps.publishState === 'function') await deps.publishState(state);
            return state;
        }

        async function clearTimeoutAlarm() {
            if (typeof deps.clearTimeoutAlarm === 'function') await deps.clearTimeoutAlarm();
        }

        async function finish(state, phase, reason, options = {}) {
            const next = await writeState({
                ...state,
                phase,
                reason,
                attempted: options.attempted ?? state.attempted,
                suppressed: options.suppressed ?? state.suppressed
            });
            await clearTimeoutAlarm();
            return next;
        }

        async function start(reason = 'startup') {
            const state = await readState();
            const settings = await deps.getSettings();
            if (!isEligible(settings)) {
                return writeState({
                    ...state,
                    phase: settings?.[PREWARM_ENABLED_KEY] === true ? 'idle' : 'disabled',
                    attempted: false,
                    suppressed: false,
                    reason: settings?.[PREWARM_ENABLED_KEY] === true
                        ? '等待统一认证自动提交或账号配置'
                        : '功能未开启'
                });
            }
            if (state.suppressed || state.attempted || state.phase === 'running') return state;

            const runId = state.runId + 1;
            await writeState({
                ...state,
                phase: 'running',
                attempted: true,
                runId,
                startedAt: deps.now(),
                reason: reason === 'startup' ? '正在后台准备统一认证' : '正在后台建立统一认证会话'
            });
            if (typeof deps.scheduleTimeoutAlarm === 'function') await deps.scheduleTimeoutAlarm();

            let result;
            try {
                result = await deps.authenticate(settings);
            } catch (error) {
                result = {
                    ok: false,
                    attention: error?.name !== 'AbortError',
                    error: error?.name === 'AbortError' ? '后台认证已取消' : '后台认证请求失败，本次不会重试'
                };
            }

            const current = await readState();
            if (current.runId !== runId || current.phase !== 'running') return current;
            if (result?.ok) {
                return finish(current, 'ready', result.alreadyAuthenticated
                    ? '统一认证会话已经可用'
                    : '统一认证会话已准备');
            }
            return finish(
                current,
                result?.attention ? 'attention' : 'failed',
                result?.error || '后台认证未完成，本次不会重试'
            );
        }

        async function cancel(reason = 'cancelled', options = {}) {
            const state = await readState();
            if (state.phase === 'running' && typeof deps.abortAuthentication === 'function') {
                deps.abortAuthentication();
            }
            return finish(state, options.phase || 'cancelled', reason, {
                attempted: options.attempted ?? state.attempted,
                suppressed: options.suppressed ?? state.suppressed
            });
        }

        async function resumeWhenWindowAvailable() {
            return start('resume');
        }

        async function handlePageEvent(event) {
            const state = await readState();
            if (!event) return state;
            if (event.kind === 'logout') {
                return cancel('检测到用户退出统一认证', { attempted: true, suppressed: true });
            }
            if (state.phase === 'running' && event.kind === 'page' && event.path === AUTH_LOGIN_PATH) {
                return cancel('用户已打开认证页，交由可见页面处理');
            }
            return state;
        }

        async function handleTabRemoved() {
            return readState();
        }

        async function handleTimeoutAlarm() {
            const state = await readState();
            if (state.phase === 'running') {
                return cancel('后台认证超时', { phase: 'failed' });
            }
            return state;
        }

        async function reconcileSettings() {
            const state = await readState();
            const settings = await deps.getSettings();
            if (!settings?.[PREWARM_ENABLED_KEY]) {
                if (state.phase === 'running') deps.abortAuthentication?.();
                return finish(state, 'disabled', '功能未开启', {
                    attempted: false,
                    suppressed: false
                });
            }
            if (!isEligible(settings)) {
                if (state.phase === 'running') deps.abortAuthentication?.();
                return finish(state, 'idle', '等待统一认证自动提交或账号配置', {
                    attempted: false,
                    suppressed: false
                });
            }
            if (!state.attempted) return start('settings-changed');
            return state;
        }

        return Object.freeze({
            start,
            resumeWhenWindowAvailable,
            cancel,
            handlePageEvent,
            handleTabRemoved,
            handleTimeoutAlarm,
            reconcileSettings,
            getState: readState
        });
    }

    global.NjuAuthSessionPrewarmer = Object.freeze({
        AUTH_LOGIN_URL,
        AUTH_LOGIN_PATH,
        PREWARM_ENABLED_KEY,
        STATE_KEY,
        ALARM_NAME,
        SETTINGS_KEYS,
        createAuthSessionPrewarmer
    });

    if (!global.chrome?.runtime || !global.chrome?.storage?.local || !global.chrome?.storage?.session) return;

    const chromeApi = global.chrome;
    const backgroundLogin = global.NjuAuthBackgroundLogin?.createAuthBackgroundLogin({
        fetchImpl: global.fetch.bind(global),
        sliderRuntime: global.NjuAuthSliderCaptcha
    });
    let activeAbortController = null;

    const controller = createAuthSessionPrewarmer({
        getSettings: () => chromeApi.storage.local.get(SETTINGS_KEYS),
        readState: async () => (await chromeApi.storage.session.get(STATE_KEY))[STATE_KEY],
        writeState: state => chromeApi.storage.session.set({ [STATE_KEY]: state }),
        authenticate: async settings => {
            if (!backgroundLogin) throw new Error('后台认证运行时未加载');
            const abortController = new AbortController();
            activeAbortController = abortController;
            try {
                return await backgroundLogin.login({
                    username: settings.nju_user,
                    password: settings.nju_pass,
                    signal: abortController.signal
                });
            } finally {
                if (activeAbortController === abortController) activeAbortController = null;
            }
        },
        abortAuthentication: () => activeAbortController?.abort(),
        scheduleTimeoutAlarm: () => chromeApi.alarms.create(ALARM_NAME, { when: Date.now() + 30000 }),
        clearTimeoutAlarm: () => chromeApi.alarms.clear(ALARM_NAME),
        now: () => Date.now(),
        publishState: async state => {
            try {
                await chromeApi.runtime.sendMessage({ action: 'authPrewarmStatusChanged', state });
            } catch {
                // Popup is normally closed; no listener is expected.
            }
        }
    });

    chromeApi.runtime.onStartup.addListener(() => {
        controller.start('startup').catch(() => {});
    });

    chromeApi.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === ALARM_NAME) controller.handleTimeoutAlarm().catch(() => {});
    });

    chromeApi.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !SETTINGS_KEYS.some(key => changes[key])) return;
        controller.reconcileSettings().catch(() => {});
    });

    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action === 'getAuthPrewarmStatus') {
            controller.getState()
                .then(state => sendResponse({ ok: true, state }))
                .catch(error => sendResponse({ ok: false, error: error?.message || '无法读取预认证状态' }));
            return true;
        }
        if (message?.action === 'authPrewarmPageEvent') {
            controller.handlePageEvent(message, sender?.tab?.id).catch(() => {});
        } else if (message?.action === 'authPrewarmLogout') {
            controller.handlePageEvent({ kind: 'logout' }, sender?.tab?.id).catch(() => {});
        }
        return undefined;
    });
})(typeof globalThis !== 'undefined' ? globalThis : window);
