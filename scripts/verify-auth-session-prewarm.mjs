import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

const [loginSource, runtimeSource, bridgeSource, manifestText, popupSource, popupHtml, buildScript] = await Promise.all([
  read('auth-background-login.js'),
  read('auth-session-prewarm.js'),
  read('auth-prewarm-bridge.js'),
  read('manifest.json'),
  read('popup.js'),
  read('popup.html'),
  read('scripts/build-package.ps1')
]);

const sandbox = {
  console, Date, Error, Number, String, Boolean, Object, Promise, Array, Set,
  URL, URLSearchParams
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(loginSource, sandbox, { filename: 'auth-background-login.js' });
vm.runInContext(runtimeSource, sandbox, { filename: 'auth-session-prewarm.js' });

const loginRuntime = sandbox.NjuAuthBackgroundLogin;
const runtime = sandbox.NjuAuthSessionPrewarmer;
assert.ok(loginRuntime?.createAuthBackgroundLogin, 'The background login transport must expose a testable factory.');
assert.ok(runtime?.createAuthSessionPrewarmer, 'The background prewarm controller must expose a testable factory.');
assert.equal(runtime.AUTH_LOGIN_URL, 'https://authserver.nju.edu.cn/authserver/login');

const loginHtml = `<!doctype html><form class="login" action="/authserver/login" id="pwdFromId">
  <input name="username" value="">
  <input id="password" name="passwordText" value="">
  <input type="hidden" id="saltPassword" name="password" value="">
  <input name="captcha" value="">
  <input name="_eventId" value="submit">
  <input name="cllt" value="userNameLogin">
  <input name="dllt" value="generalLogin">
  <input name="lt" value="">
  <input id="pwdEncryptSalt" value="1234567890abcdef">
  <input id="execution" name="execution" value="e1s1">
</form>`;

function mockResponse({ url, status = 200, text = '', json = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    text: async () => text,
    json: async () => json
  };
}

function createLoginHarness(responses) {
  const requests = [];
  const solves = [];
  const encryptions = [];
  const queue = [...responses];
  const transport = loginRuntime.createAuthBackgroundLogin({
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      assert.ok(queue.length, `Unexpected request: ${url}`);
      return queue.shift();
    },
    sliderRuntime: {
      solve: async options => {
        solves.push(options);
        return { ok: true };
      },
      encryptForPage: async (password, salt) => {
        encryptions.push({ password, salt });
        return 'encrypted-password';
      }
    }
  });
  return { transport, requests, solves, encryptions, remaining: () => queue.length };
}

{
  const parsed = loginRuntime.parsePasswordLoginForm(loginHtml);
  assert.equal(parsed.salt, '1234567890abcdef');
  assert.equal(parsed.execution, 'e1s1');
  assert.equal(parsed.action, loginRuntime.AUTH_LOGIN_URL);
}

{
  const harness = createLoginHarness([
    mockResponse({ url: 'https://authserver.nju.edu.cn/authserver/index.do' })
  ]);
  const result = await harness.transport.login({ username: '12345678', password: 'secret' });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyAuthenticated, true);
  assert.equal(harness.requests.length, 1, 'An existing SSO session must skip captcha and login submission.');
}

{
  const harness = createLoginHarness([
    mockResponse({ url: loginRuntime.AUTH_LOGIN_URL, text: loginHtml }),
    mockResponse({ url: 'https://authserver.nju.edu.cn/authserver/checkNeedCaptcha.htl', json: { isNeed: false } }),
    mockResponse({ url: 'https://authserver.nju.edu.cn/authserver/index.do' })
  ]);
  const result = await harness.transport.login({ username: '12345678', password: 'secret' });
  assert.equal(result.ok, true);
  assert.equal(result.needsCaptcha, false);
  assert.deepEqual(harness.encryptions, [{ password: 'secret', salt: '1234567890abcdef' }]);
  const submission = harness.requests[2];
  const body = new URLSearchParams(submission.init.body);
  assert.equal(submission.init.method, 'POST');
  assert.equal(body.get('username'), '12345678');
  assert.equal(body.get('password'), 'encrypted-password');
  assert.equal(body.has('passwordText'), false, 'The plaintext form field must never be submitted.');
  assert.ok(!submission.init.body.includes('secret'), 'The saved plaintext password must not appear in the request body.');
}

{
  const harness = createLoginHarness([
    mockResponse({ url: loginRuntime.AUTH_LOGIN_URL, text: loginHtml }),
    mockResponse({ url: 'https://authserver.nju.edu.cn/authserver/checkNeedCaptcha.htl', json: { isNeed: true } }),
    mockResponse({ url: 'https://authserver.nju.edu.cn/authserver/index.do' })
  ]);
  const result = await harness.transport.login({ username: '12345678', password: 'secret' });
  assert.equal(result.ok, true);
  assert.equal(harness.solves.length, 1);
  assert.equal(harness.solves[0].origin, loginRuntime.AUTH_ORIGIN);
  assert.equal(harness.solves[0].attempts, 3);
}

{
  const harness = createLoginHarness([
    mockResponse({ url: loginRuntime.AUTH_LOGIN_URL, text: loginHtml }),
    mockResponse({ url: 'https://authserver.nju.edu.cn/authserver/checkNeedCaptcha.htl', json: { isNeed: false } }),
    mockResponse({ url: loginRuntime.AUTH_LOGIN_URL, text: loginHtml })
  ]);
  const result = await harness.transport.login({ username: '12345678', password: 'secret' });
  assert.equal(result.ok, false);
  assert.equal(result.attention, true);
  assert.match(result.error, /认证未完成/);
}

function eligibleSettings(overrides = {}) {
  return {
    nju_auth_prewarm_enabled: true,
    nju_enabled: true,
    nju_auto_click: true,
    nju_user: '12345678',
    nju_pass: 'secret',
    ...overrides
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createControllerHarness(settings = eligibleSettings(), options = {}) {
  let currentSettings = settings;
  let state = options.state;
  const published = [];
  const authentication = options.authentication || { login: async () => ({ ok: true }) };
  let authenticateCalls = 0;
  let aborts = 0;
  let scheduled = 0;
  let cleared = 0;
  const deps = {
    getSettings: async () => currentSettings,
    readState: async () => state,
    writeState: async next => { state = structuredClone(next); },
    authenticate: async authSettings => {
      authenticateCalls += 1;
      return authentication.login(authSettings);
    },
    abortAuthentication: () => { aborts += 1; },
    scheduleTimeoutAlarm: async () => { scheduled += 1; },
    clearTimeoutAlarm: async () => { cleared += 1; },
    publishState: async next => { published.push(structuredClone(next)); },
    now: () => 1700000000000
  };
  return {
    controller: runtime.createAuthSessionPrewarmer(deps),
    published,
    getState: () => state,
    setSettings: value => { currentSettings = value; },
    get authenticateCalls() { return authenticateCalls; },
    get aborts() { return aborts; },
    get scheduled() { return scheduled; },
    get cleared() { return cleared; }
  };
}

{
  const harness = createControllerHarness(eligibleSettings({ nju_auth_prewarm_enabled: false }));
  const state = await harness.controller.start();
  assert.equal(state.phase, 'disabled');
  assert.equal(harness.authenticateCalls, 0);
}

{
  const harness = createControllerHarness(eligibleSettings({ nju_auto_click: false }));
  const state = await harness.controller.start();
  assert.equal(state.phase, 'idle');
  assert.equal(harness.authenticateCalls, 0);
}

{
  const auth = deferred();
  const harness = createControllerHarness(eligibleSettings(), { authentication: { login: () => auth.promise } });
  const firstRun = harness.controller.start('startup');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.getState().phase, 'running');
  const duplicate = await harness.controller.start('duplicate');
  assert.equal(duplicate.phase, 'running');
  assert.equal(harness.authenticateCalls, 1, 'Only one background login may run per browser session.');
  assert.equal(harness.scheduled, 1);
  auth.resolve({ ok: true });
  const ready = await firstRun;
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.tabId, null);
  assert.equal(harness.cleared, 1);
}

{
  const auth = deferred();
  const harness = createControllerHarness(eligibleSettings(), { authentication: { login: () => auth.promise } });
  const run = harness.controller.start();
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = await harness.controller.handlePageEvent({ kind: 'page', path: runtime.AUTH_LOGIN_PATH }, 99);
  assert.equal(cancelled.phase, 'cancelled');
  assert.match(cancelled.reason, /用户已打开认证页/);
  assert.equal(harness.aborts, 1);
  auth.resolve({ ok: true });
  assert.equal((await run).phase, 'cancelled', 'A stale background result must not replace cancellation.');
}

{
  const harness = createControllerHarness(eligibleSettings(), {
    authentication: { login: async () => ({ ok: false, attention: true, error: '需要人工确认' }) }
  });
  const attention = await harness.controller.start();
  assert.equal(attention.phase, 'attention');
  assert.equal(attention.reason, '需要人工确认');
}

{
  const auth = deferred();
  const harness = createControllerHarness(eligibleSettings(), { authentication: { login: () => auth.promise } });
  const run = harness.controller.start();
  await new Promise(resolve => setImmediate(resolve));
  const failed = await harness.controller.handleTimeoutAlarm();
  assert.equal(failed.phase, 'failed');
  assert.equal(harness.aborts, 1);
  auth.resolve({ ok: true });
  await run;
}

{
  const auth = deferred();
  const harness = createControllerHarness(eligibleSettings(), { authentication: { login: () => auth.promise } });
  const run = harness.controller.start();
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = await harness.controller.handlePageEvent({ kind: 'logout' }, 777);
  assert.equal(cancelled.suppressed, true);
  assert.equal(cancelled.phase, 'cancelled');
  auth.resolve({ ok: true });
  await run;
  const restart = await harness.controller.start('after-logout');
  assert.equal(restart.suppressed, true);
  assert.equal(harness.authenticateCalls, 1, 'Logout must suppress another attempt in this browser session.');
}

const manifest = JSON.parse(manifestText);
assert.equal(manifest.background?.service_worker, 'auth-session-prewarm.js');
assert.ok(manifest.permissions.includes('alarms'), 'Timeout cleanup uses the non-sensitive alarms permission.');
assert.ok(!manifest.permissions.includes('cookies'), 'Background login must never read or modify cookie values.');
assert.ok(!manifest.permissions.includes('tabs'), 'Background login must not require tabs permission.');
assert.ok(!manifest.permissions.includes('offscreen'), 'The service-worker transport must not require an offscreen document.');
assert.ok(manifest.host_permissions.includes('https://authserver.nju.edu.cn/*'), 'The service worker needs authserver host access.');
const authEntry = manifest.content_scripts.find(entry => entry.matches.includes('https://authserver.nju.edu.cn/*') && entry.js.includes('auth-login-fast.js'));
assert.ok(authEntry?.js.includes('auth-prewarm-bridge.js'), 'Visible auth pages must be able to preempt background login.');
assert.equal(authEntry.run_at, 'document_start');
assert.match(runtimeSource, /importScripts\('auth-slider-captcha\.js', 'auth-background-login\.js', 'grab-task-model\.js', 'grab-task-session\.js'\)/);
assert.doesNotMatch(runtimeSource, /chromeApi\.(?:tabs|windows)/, 'The production controller must not create tabs or windows.');
assert.match(bridgeSource, /AUTH_LOGIN_PATH/);
assert.match(bridgeSource, /authPrewarmPageEvent/);
assert.match(bridgeSource, /authPrewarmLogout/);
assert.match(popupSource, /nju_auth_prewarm_enabled/);
assert.match(popupHtml, /id="authPrewarm"/);
assert.match(popupHtml, /不新增标签页/);
assert.match(buildScript, /'auth-background-login\.js'/);
assert.match(buildScript, /'grab-task-model\.js'/);
assert.match(buildScript, /'auth-session-prewarm\.js'/);
assert.match(buildScript, /'auth-prewarm-bridge\.js'/);

console.log('Background-only auth session preparation verified.');
