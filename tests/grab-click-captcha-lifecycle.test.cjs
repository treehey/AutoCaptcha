const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const contentSource = fs.readFileSync(path.join(repoRoot, 'content-grab.js'), 'utf8');
const solverStart = contentSource.indexOf('function createClickCaptchaAuthenticatedPageError');
const solverEnd = contentSource.indexOf('async function getClickCaptchaSamples');

assert.notEqual(solverStart, -1, 'click-captcha authenticated-page guard must exist');
assert.notEqual(solverEnd, -1, 'click-captcha solver end must exist');

const solverSource = `${contentSource.slice(solverStart, solverEnd)}\n`
  + 'globalThis.__solverApi = { pollClickCaptchaSolver, runClickCaptchaSolver };';

function createHarness({ authenticated = false, solveFrame = null } = {}) {
  const target = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 250, height: 120 };
    }
  };
  const calls = {
    solve: 0,
    render: 0,
    clearOverlay: 0,
    shieldClear: 0,
    shieldShow: 0,
    notify: 0
  };
  let authenticatedPage = authenticated;
  const clickCaptchaSolver = {
    enabled: true,
    autoClick: false,
    running: false,
    target: null,
    fingerprint: '',
    attemptedTarget: null,
    attemptedFingerprint: '',
    submittedTarget: null,
    submittedFingerprint: '',
    autoClickToken: 0,
    lowConfidenceRefreshes: 0,
    result: null,
    loginStatus: '未检测登录表单',
    status: '等待点击验证码',
    monitor: null,
    suspendedForAuthenticatedPage: false
  };
  const sandbox = {
    clickCaptchaSolver,
    clickCaptchaCapture: { enabled: false },
    CLICK_CAPTCHA_REFERENCE_WIDTH: 250,
    CLICK_CAPTCHA_REFERENCE_HEIGHT: 120,
    CLICK_CAPTCHA_REQUIRED_TARGET_COUNT: 4,
    CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL: 12,
    CLICK_CAPTCHA_MAX_LOW_CONFIDENCE_REFRESH_ATTEMPTS: 5,
    CLICK_CAPTCHA_SOLVER_POLL_MS: 650,
    CLICK_CAPTCHA_SOLVER_ENABLED_KEY: 'enabled',
    CLICK_CAPTCHA_AUTO_CLICK_KEY: 'autoClick',
    GRAB_LOGIN_SHIELD_STATUS: { LOADING: 'loading', SUCCESS: 'success', ERROR: 'error' },
    grabLoginShield: {
      clear() { calls.shieldClear += 1; },
      show() { calls.shieldShow += 1; },
      resolveAutomation() {}
    },
    grabPageStatusPanel: null,
    document: {
      contains(candidate) { return candidate === target; }
    },
    isGrabAuthenticatedPage() { return authenticatedPage; },
    findClickCaptchaElement() { return target; },
    isReadyClickCaptchaElement() { return true; },
    getClickCaptchaFingerprint() { return 'captcha-a'; },
    getClickCaptchaSolverState() { return { status: clickCaptchaSolver.status }; },
    clearClickCaptchaSolverOverlay() { calls.clearOverlay += 1; },
    notifyClickCaptchaSolverUpdate() { calls.notify += 1; },
    prepareFourTargetClickCaptchaForSolver: async candidate => candidate,
    getClickCaptchaFrame() { return { width: 250, height: 120 }; },
    async solveClickCaptchaFrame() {
      calls.solve += 1;
      if (solveFrame) return solveFrame();
      return { points: [], margin: 0, backgroundResidual: 13, referenceWidth: 250, referenceHeight: 120 };
    },
    isClickCaptchaAutoEligible() { return false; },
    renderClickCaptchaSolverOverlay() { calls.render += 1; },
    prepareClickCaptchaLogin: async () => null,
    dispatchClickCaptchaPoints: async () => {},
    submitClickCaptchaLogin: async () => false,
    storageSet: async () => {},
    storageGet: async () => ({}),
    setInterval() { return 1; },
    console,
    Error,
    Promise
  };
  vm.createContext(sandbox);
  vm.runInContext(solverSource, sandbox, { filename: 'content-grab-click-captcha-lifecycle.js' });
  return {
    api: sandbox.__solverApi,
    calls,
    clickCaptchaSolver,
    setAuthenticated(value) { authenticatedPage = value; }
  };
}

test('does not recognize a stale login captcha after the round selector is authenticated', async () => {
  const harness = createHarness({ authenticated: true });

  await harness.api.pollClickCaptchaSolver();

  assert.equal(harness.calls.solve, 0, 'authenticated round selection must suppress recognition');
  assert.equal(harness.calls.render, 0, 'authenticated round selection must not render captcha markers');
  assert.match(harness.clickCaptchaSolver.status, /已登录|选课系统/);
});

test('discards an in-flight recognition result when the round selector appears', async () => {
  let resolveRecognition;
  const recognition = new Promise(resolve => { resolveRecognition = resolve; });
  const harness = createHarness({ solveFrame: () => recognition });

  const run = harness.api.runClickCaptchaSolver();
  while (harness.calls.solve === 0) await Promise.resolve();
  harness.setAuthenticated(true);
  resolveRecognition({
    points: [],
    margin: 0,
    backgroundResidual: 13,
    referenceWidth: 250,
    referenceHeight: 120
  });
  await run;

  assert.equal(harness.calls.render, 0, 'late recognition must not render markers on the round selector');
  assert.match(harness.clickCaptchaSolver.status, /已登录|选课系统/);
  assert.equal(harness.clickCaptchaSolver.suspendedForAuthenticatedPage, true);
});

test('resumes recognition when an authenticated course page later returns to login', async () => {
  const harness = createHarness({ authenticated: true });

  await harness.api.pollClickCaptchaSolver();
  harness.setAuthenticated(false);
  await harness.api.pollClickCaptchaSolver();

  assert.equal(harness.calls.solve, 1, 'session expiry must re-enable recognition on the real login page');
  assert.equal(harness.clickCaptchaSolver.suspendedForAuthenticatedPage, false);
});
