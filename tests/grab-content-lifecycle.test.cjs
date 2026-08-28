'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const grabModule = require('../grab-engine.js');
const grabTaskModel = require('../grab-task-model.js');

const contentSource = readFileSync(resolve(__dirname, '..', 'content-grab.js'), 'utf8');
const lifecycleStart = contentSource.indexOf('function sendGrabRuntimeMessage');
const lifecycleEnd = contentSource.indexOf('// ============ 点击式验证码离线采样');
const lifecycleSource = contentSource.slice(lifecycleStart, lifecycleEnd);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

function createLifecycleHarness(runtimeRead, options = {}) {
  const saved = [];
  const navigations = [];
  const mutationObservers = [];
  const pageState = options.pageState || options;
  const clock = { now: Number(options.now) || Date.now() };
  class HarnessDate extends Date {
    static now() { return clock.now; }
  }
  let preCourseEntryClicks = 0;
  let roundConfirmClicks = 0;
  const roundChoices = (options.roundChoices || []).map(choice => ({
    checked: false,
    clickCount: 0,
    isConnected: true,
    offsetParent: {},
    getClientRects: () => [{}],
    getAttribute(name) {
      if (name === 'data-value') return JSON.stringify({
        code: choice.code,
        name: choice.name || choice.code,
        canSelect: choice.canSelect === false ? '0' : '1'
      });
      return null;
    },
    click() {
      this.clickCount += 1;
      roundChoices.forEach(item => { item.checked = false; });
      this.checked = true;
    }
  }));
  const roundTableBody = {
    isConnected: true,
    offsetParent: {},
    getClientRects: () => [{}]
  };
  const roundConfirmButton = {
    disabled: false,
    isConnected: true,
    offsetParent: {},
    getClientRects: () => [{}],
    click() {
      roundConfirmClicks += 1;
      options.onRoundConfirmClick?.();
    }
  };
  const roundDialog = {
    querySelector(selector) {
      return selector.includes('.bh-btn-primary') ? roundConfirmButton : null;
    }
  };
  const roundTable = {
    isConnected: true,
    offsetParent: {},
    getClientRects: () => [{}],
    closest(selector) {
      return selector.includes('.jqx-window') ? roundDialog : null;
    }
  };
  const neverFinishes = new Promise(() => {});
  const preCourseButton = {
    disabled: options.preCourseButtonDisabled === true,
    isConnected: true,
    getAttribute(name) {
      if (name === 'title') return options.preCourseButtonReady === false ? '' : 'current-batch';
      if (name === 'aria-disabled') return this.disabled ? 'true' : null;
      return null;
    },
    click() {
      preCourseEntryClicks += 1;
      options.onPreCourseEntryClick?.();
    }
  };
  const location = {
    origin: 'https://xk.nju.edu.cn',
    pathname: options.pathname || '/xsxkapp/sys/xsxkapp/*default/grablessons.do',
    href: '',
    assign(url) {
      navigations.push(String(url));
      this.href = String(url);
    }
  };
  const context = vm.createContext({
    AbortController,
    clearTimeout,
    console,
    crypto: { randomUUID: () => 'new-task-id' },
    Date: HarnessDate,
    MutationObserver: class FakeMutationObserver {
      constructor(callback) {
        this.callback = callback;
        mutationObservers.push(this);
      }
      observe() {}
      disconnect() { this.disconnected = true; }
      notify() {
        if (!this.disconnected) setImmediate(() => this.callback([{ type: 'childList' }]));
      }
    },
    document: {
      getElementById(id) {
        if (pageState.loginPage && (id === 'loginDiv' || id === 'studentLoginBtn')) {
          return { isConnected: true, offsetParent: {}, getClientRects: () => [{}] };
        }
        if (!pageState.preCoursePage) return null;
        if (id === 'courseBtn') return preCourseButton;
        if (id === 'cvStageAxis' || id === 'stundentinfoDiv') return {};
        return null;
      },
      querySelector(selector) {
        if (pageState.roundSelectionPage && selector.includes('.electiveBatch-list-table')) return roundTable;
        if (pageState.roundSelectionPage && selector.includes('.electiveBatch-body')) return roundTableBody;
        if (selector.includes('.result-container') || selector.includes('.course-list') || selector.includes('.refresh-btn')) {
          return pageState.coursePage === false ? null : {};
        }
        return null;
      },
      querySelectorAll(selector) {
        if (pageState.roundSelectionPage && selector.includes('.cv-electiveBatch-select')) return roundChoices;
        return [];
      }
    },
    isVisibleGrabElement: element => Boolean(element?.isConnected
      && (element.offsetParent !== null || element.getClientRects?.().length > 0)),
    location,
    Math,
    NjuGrabEngine: grabModule,
    NjuGrabTaskModel: grabTaskModel,
    scanDomCandidates: options.scan || (async () => neverFinishes),
    attemptDomCandidate: options.attempt || (async () => ({ outcome: grabModule.OUTCOME.UNKNOWN_COMMIT })),
    setTimeout,
    sessionStorage: {
      getItem(key) {
        if (key === 'currentBatch') return JSON.stringify({ code: options.currentBatchCode || 'ROUND-ORIGINAL' });
        if (key === 'studentInfo') return JSON.stringify({ electiveBatch: { code: options.currentBatchCode || 'ROUND-ORIGINAL' } });
        return null;
      }
    },
    URL,
    chrome: {
      runtime: {
        sendMessage(message) {
          if (message.action === 'grabTaskRuntimeGet') return runtimeRead.promise;
          if (message.action === 'grabTaskRuntimeSave') {
            saved.push(structuredClone(message));
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve();
        }
      }
    }
  });
  context.globalThis = context;
  context.window = context;
  vm.runInContext(`const grabModule = globalThis.NjuGrabEngine;\nconst grabTaskModel = globalThis.NjuGrabTaskModel;\n${lifecycleSource}`, context, {
    filename: 'content-grab-lifecycle.js'
  });
  return {
    context,
    saved,
    navigations,
    notifyDomMutation() { mutationObservers.slice().forEach(observer => observer.notify()); },
    setNow(value) { clock.now = Number(value); },
    get preCourseEntryClicks() { return preCourseEntryClicks; },
    get roundConfirmClicks() { return roundConfirmClicks; },
    get roundChoices() { return roundChoices; }
  };
}

function pausedAuthRuntime(overrides = {}) {
  return {
    ok: true,
    runtime: {
      taskId: 'paused-task-id',
      revision: 4,
      snapshot: {
        running: false,
        phase: 'PAUSED_AUTH',
        configuredCourseNames: ['恢复课程'],
        interval: 1000,
        round: 2,
        targetStates: { 恢复课程: { phase: 'WATCHING' } },
        authRecovery: {
          pending: true,
          stage: 'WAITING_LOGIN',
          attempts: 1,
          startedAt: Date.now(),
          returnPath: '/xsxkapp/sys/xsxkapp/*default/grablessons.do',
          lastMessage: '等待选课登录'
        },
        ...overrides
      }
    }
  };
}

test('a late session restore cannot replace a task the user just started', async () => {
  const runtimeRead = deferred();
  const harness = createLifecycleHarness(runtimeRead);

  harness.context.startGrab(['新任务'], 1000);
  await waitFor(() => harness.saved.some(message => message.taskId === 'new-task-id'));
  runtimeRead.resolve({
    ok: true,
    runtime: {
      taskId: 'old-task-id',
      revision: 8,
      snapshot: {
        running: true,
        configuredCourseNames: ['旧任务'],
        interval: 1000,
        targetStates: { 旧任务: { phase: 'WATCHING' } }
      }
    }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(Array.from(harness.context.getStateSnapshot().configuredCourseNames), ['新任务']);
  harness.context.stopGrab();
});

test('only the matching task lease revocation stops the active executor', async () => {
  const runtimeRead = deferred();
  const harness = createLifecycleHarness(runtimeRead);
  harness.context.startGrab(['新任务'], 1000);
  await waitFor(() => harness.context.getStateSnapshot().running);

  harness.context.revokeGrabTaskLease('different-task');
  assert.equal(harness.context.getStateSnapshot().running, true);
  harness.context.revokeGrabTaskLease('new-task-id');
  assert.equal(harness.context.getStateSnapshot().running, false);
  assert.equal(harness.context.getStateSnapshot().phase, 'STOPPED');
});

test('an auth-expired task is checkpointed before navigating to the course login page', async () => {
  const runtimeRead = deferred();
  const authError = new Error('选课登录状态已失效');
  authError.outcome = grabModule.OUTCOME.AUTH_EXPIRED;
  const harness = createLifecycleHarness(runtimeRead, {
    scan: async () => { throw authError; }
  });

  harness.context.startGrab(['恢复课程'], 1000);
  await waitFor(() => harness.saved.some(message => message.snapshot?.authRecovery?.pending));
  await waitFor(() => harness.navigations.length === 1);

  const checkpoint = harness.saved.findLast(message => message.snapshot?.authRecovery?.pending).snapshot;
  assert.equal(checkpoint.running, false);
  assert.equal(checkpoint.phase, 'PAUSED_AUTH');
  assert.equal(checkpoint.authRecovery.stage, 'WAITING_LOGIN');
  assert.equal(checkpoint.authRecovery.attempts, 1);
  assert.equal(checkpoint.authRecovery.electiveBatchCode, 'ROUND-ORIGINAL');
  assert.deepEqual(harness.navigations, ['https://xk.nju.edu.cn/']);
});

test('a paused task waits on the course login page and can be stopped there', async () => {
  const runtimeRead = { promise: Promise.resolve(pausedAuthRuntime()) };
  const harness = createLifecycleHarness(runtimeRead, {
    coursePage: false,
    loginPage: true,
    pathname: '/'
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.pending);
  assert.equal(harness.context.getStateSnapshot().phase, 'PAUSED_AUTH');
  assert.deepEqual(harness.navigations, []);

  const stopped = harness.context.stopGrab();
  await waitFor(() => harness.saved.some(message => message.snapshot?.phase === 'STOPPED'));
  assert.equal(stopped.phase, 'STOPPED');
  assert.equal(stopped.authRecovery, null);
});

test('a direct redirect to the login page converts a running checkpoint into auth recovery', async () => {
  const redirected = pausedAuthRuntime({
    running: true,
    phase: 'RUNNING',
    authRecovery: null
  });
  const harness = createLifecycleHarness({ promise: Promise.resolve(redirected) }, {
    coursePage: false,
    loginPage: true,
    pathname: '/'
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.pending);
  const state = harness.context.getStateSnapshot();
  assert.equal(state.running, false);
  assert.equal(state.phase, 'PAUSED_AUTH');
  assert.equal(state.authRecovery.stage, 'WAITING_LOGIN');
  assert.deepEqual(harness.navigations, []);
  harness.context.stopGrab();
});

test('a completed login opens the safe course-round landing page before resuming', async () => {
  const runtimeRead = { promise: Promise.resolve(pausedAuthRuntime()) };
  const harness = createLifecycleHarness(runtimeRead, {
    coursePage: false,
    loginPage: false,
    pathname: '/xsxkapp/'
  });

  await waitFor(() => harness.navigations.length === 1);
  assert.deepEqual(harness.navigations, ['https://xk.nju.edu.cn/']);
  assert.equal(
    harness.saved.findLast(message => message.snapshot?.authRecovery)?.snapshot.authRecovery.stage,
    'RETURNING'
  );
});

test('a recovered task selects its original elective batch from a multi-round login result', async () => {
  const pageState = { loginPage: false, roundSelectionPage: true, preCoursePage: false, coursePage: false };
  const runtime = pausedAuthRuntime({
    authRecovery: {
      pending: true,
      stage: 'WAITING_LOGIN',
      attempts: 1,
      startedAt: Date.now(),
      electiveBatchCode: 'ROUND-OLD',
      returnPath: '/xsxkapp/sys/xsxkapp/*default/grablessons.do',
      lastMessage: '等待选课登录'
    }
  });
  const harness = createLifecycleHarness({ promise: Promise.resolve(runtime) }, {
    pathname: '/xsxkapp/sys/xsxkapp/*default/index.do',
    pageState,
    roundChoices: [
      { code: 'ROUND-OLD', name: '原监控轮次' },
      { code: 'ROUND-NEW', name: '其他轮次' }
    ]
  });

  await waitFor(() => harness.roundConfirmClicks === 1);
  assert.equal(harness.roundChoices[0].clickCount, 1);
  assert.equal(harness.roundChoices[1].clickCount, 0);
  assert.equal(
    harness.saved.findLast(message => message.snapshot?.authRecovery)?.snapshot.authRecovery.stage,
    'SELECTING_ROUND'
  );

  harness.notifyDomMutation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.roundConfirmClicks, 1, 'the same round dialog must not be submitted twice');
  harness.context.stopGrab();
});

test('a recovered task never guesses another elective batch when its original round is absent', async () => {
  const runtime = pausedAuthRuntime({
    authRecovery: {
      pending: true,
      stage: 'WAITING_LOGIN',
      attempts: 1,
      startedAt: Date.now(),
      electiveBatchCode: 'ROUND-MISSING',
      returnPath: '/xsxkapp/sys/xsxkapp/*default/grablessons.do',
      lastMessage: '等待选课登录'
    }
  });
  const harness = createLifecycleHarness({ promise: Promise.resolve(runtime) }, {
    pathname: '/xsxkapp/sys/xsxkapp/*default/index.do',
    pageState: { loginPage: false, roundSelectionPage: true, preCoursePage: false, coursePage: false },
    roundChoices: [
      { code: 'ROUND-OTHER-1', name: '其他轮次一' },
      { code: 'ROUND-OTHER-2', name: '其他轮次二' }
    ]
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'MANUAL_REQUIRED');
  assert.equal(harness.roundConfirmClicks, 0);
  assert.equal(harness.roundChoices.every(choice => choice.clickCount === 0), true);
  assert.match(harness.context.getStateSnapshot().authRecovery.lastMessage, /原监控轮次/);
  harness.context.stopGrab();
});

test('the course-round landing page checkpoints before using its native entry button', async () => {
  const runtimeRead = { promise: Promise.resolve(pausedAuthRuntime()) };
  const harness = createLifecycleHarness(runtimeRead, {
    coursePage: false,
    loginPage: false,
    preCoursePage: true,
    pathname: '/xsxkapp/sys/xsxkapp/*default/index.do'
  });

  await waitFor(() => harness.preCourseEntryClicks === 1);
  assert.deepEqual(harness.navigations, []);
  assert.equal(
    harness.saved.findLast(message => message.snapshot?.authRecovery)?.snapshot.authRecovery.stage,
    'ENTERING_COURSE'
  );
  harness.context.stopGrab();
});

test('a same-document login transition enters the course and resumes after one restore', async () => {
  const pageState = { loginPage: true, preCoursePage: false, coursePage: false };
  const harness = createLifecycleHarness({ promise: Promise.resolve(pausedAuthRuntime()) }, {
    pathname: '/',
    pageState,
    onPreCourseEntryClick() {
      pageState.preCoursePage = false;
      pageState.coursePage = true;
      harness.notifyDomMutation();
    }
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'WAITING_LOGIN');
  pageState.loginPage = false;
  pageState.preCoursePage = true;
  harness.notifyDomMutation();

  await waitFor(() => harness.preCourseEntryClicks === 1);
  assert.equal(
    harness.saved.findLast(message => message.snapshot?.authRecovery)?.snapshot.authRecovery.stage,
    'ENTERING_COURSE'
  );
  await waitFor(() => {
    const state = harness.context.getStateSnapshot();
    return state.running && state.authRecovery?.stage === 'VERIFYING';
  });
  assert.equal(harness.preCourseEntryClicks, 1);
  harness.context.stopGrab();
});

test('a running task redirected to login watches the same-document course transition', async () => {
  const pageState = { loginPage: true, preCoursePage: false, coursePage: false };
  const redirected = pausedAuthRuntime({ running: true, phase: 'RUNNING', authRecovery: null });
  const harness = createLifecycleHarness({ promise: Promise.resolve(redirected) }, {
    pathname: '/',
    pageState,
    onPreCourseEntryClick() {
      pageState.preCoursePage = false;
      pageState.coursePage = true;
      harness.notifyDomMutation();
    }
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'WAITING_LOGIN');
  pageState.loginPage = false;
  pageState.preCoursePage = true;
  harness.notifyDomMutation();
  await waitFor(() => harness.preCourseEntryClicks === 1);
  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'VERIFYING');
  assert.equal(harness.preCourseEntryClicks, 1);
  harness.context.stopGrab();
});

test('a running snapshot restored on the course-round landing page checkpoints before entering', async () => {
  const pageState = { loginPage: false, preCoursePage: true, coursePage: false };
  const running = pausedAuthRuntime({ running: true, phase: 'RUNNING', authRecovery: null });
  const harness = createLifecycleHarness({ promise: Promise.resolve(running) }, {
    pathname: '/xsxkapp/sys/xsxkapp/*default/index.do',
    pageState,
    onPreCourseEntryClick() {
      pageState.preCoursePage = false;
      pageState.coursePage = true;
      harness.notifyDomMutation();
    }
  });

  await waitFor(() => harness.preCourseEntryClicks === 1);
  const checkpoint = harness.saved.findLast(message => message.snapshot?.authRecovery)?.snapshot;
  assert.equal(checkpoint.phase, 'PAUSED_AUTH');
  assert.equal(checkpoint.running, false);
  assert.equal(checkpoint.authRecovery.stage, 'ENTERING_COURSE');
  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'VERIFYING');
  assert.equal(harness.context.getStateSnapshot().running, true);
  assert.equal(harness.preCourseEntryClicks, 1);
  harness.context.stopGrab();
});

test('a paused recovery restored on the course-round landing page watches its same-document course transition', async () => {
  const pageState = { loginPage: false, preCoursePage: true, coursePage: false };
  const harness = createLifecycleHarness({ promise: Promise.resolve(pausedAuthRuntime()) }, {
    pathname: '/xsxkapp/sys/xsxkapp/*default/index.do',
    pageState,
    onPreCourseEntryClick() {
      pageState.preCoursePage = false;
      pageState.coursePage = true;
      harness.notifyDomMutation();
    }
  });

  await waitFor(() => harness.preCourseEntryClicks === 1);
  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'VERIFYING');
  assert.equal(harness.context.getStateSnapshot().running, true);
  assert.equal(harness.preCourseEntryClicks, 1);
  harness.context.stopGrab();
});

test('a recovery at its deadline still resumes when the course page is already ready', async () => {
  const pageState = { loginPage: true, preCoursePage: false, coursePage: false };
  const harness = createLifecycleHarness({ promise: Promise.resolve(pausedAuthRuntime()) }, {
    pathname: '/',
    pageState,
    now: Date.now(),
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'WAITING_LOGIN');
  pageState.loginPage = false;
  pageState.coursePage = true;
  harness.setNow(Date.now() + 60000);
  harness.notifyDomMutation();
  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'VERIFYING');
  harness.context.stopGrab();
});

test('a stale login marker cannot block a ready course page during recovery', async () => {
  const pageState = { loginPage: true, preCoursePage: false, coursePage: true };
  const harness = createLifecycleHarness({ promise: Promise.resolve(pausedAuthRuntime()) }, {
    pathname: '/xsxkapp/sys/xsxkapp/*default/grablessons.do',
    pageState
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'VERIFYING');
  assert.equal(harness.context.getStateSnapshot().running, true);
  harness.context.stopGrab();
});

test('a recovery that remains on the login page hands off at its deadline', async () => {
  const pageState = { loginPage: true, preCoursePage: false, coursePage: false };
  const harness = createLifecycleHarness({ promise: Promise.resolve(pausedAuthRuntime()) }, { pathname: '/', pageState });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'WAITING_LOGIN');
  harness.setNow(Date.now() + 60000);
  harness.notifyDomMutation();
  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'MANUAL_REQUIRED');
  assert.equal(harness.preCourseEntryClicks, 0);
  harness.context.stopGrab();
});

test('an entering-course recovery hands off at its deadline without a second click', async () => {
  const pageState = { loginPage: true, preCoursePage: false, coursePage: false };
  const harness = createLifecycleHarness({ promise: Promise.resolve(pausedAuthRuntime()) }, {
    pathname: '/',
    pageState,
    onPreCourseEntryClick() { harness.notifyDomMutation(); }
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'WAITING_LOGIN');
  pageState.loginPage = false;
  pageState.preCoursePage = true;
  harness.notifyDomMutation();
  await waitFor(() => harness.preCourseEntryClicks === 1);
  assert.equal(harness.context.getStateSnapshot().authRecovery.stage, 'ENTERING_COURSE');
  harness.setNow(Date.now() + 60000);
  harness.notifyDomMutation();
  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'MANUAL_REQUIRED');
  assert.equal(harness.preCourseEntryClicks, 1);
  harness.context.stopGrab();
});

test('a login DOM transition can wait at the root page between login and course states', async () => {
  const pageState = { loginPage: true, preCoursePage: false, coursePage: false };
  const harness = createLifecycleHarness({ promise: Promise.resolve(pausedAuthRuntime()) }, {
    pathname: '/',
    pageState,
    onPreCourseEntryClick() {
      pageState.preCoursePage = false;
      pageState.coursePage = true;
      harness.notifyDomMutation();
    }
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'WAITING_LOGIN');
  pageState.loginPage = false;
  harness.notifyDomMutation();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.navigations, []);
  assert.equal(harness.context.getStateSnapshot().authRecovery.stage, 'WAITING_LOGIN');

  pageState.preCoursePage = true;
  harness.notifyDomMutation();
  await waitFor(() => harness.preCourseEntryClicks === 1);
  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'VERIFYING');
  harness.context.stopGrab();
});

test('an entering-course recovery waits for the course page instead of clicking twice', async () => {
  const pageState = { loginPage: true, preCoursePage: false, coursePage: false };
  const harness = createLifecycleHarness({ promise: Promise.resolve(pausedAuthRuntime()) }, {
    pathname: '/',
    pageState,
    onPreCourseEntryClick() {
      harness.notifyDomMutation();
    }
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'WAITING_LOGIN');
  pageState.loginPage = false;
  pageState.preCoursePage = true;
  harness.notifyDomMutation();
  await waitFor(() => harness.preCourseEntryClicks === 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.context.getStateSnapshot().authRecovery.stage, 'ENTERING_COURSE');
  assert.equal(harness.preCourseEntryClicks, 1);

  pageState.preCoursePage = false;
  pageState.coursePage = true;
  harness.notifyDomMutation();
  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'VERIFYING');
  assert.equal(harness.preCourseEntryClicks, 1);
  harness.context.stopGrab();
});

test('a mutation received during entry is replayed after handling finishes', async () => {
  const pageState = { loginPage: true, preCoursePage: false, coursePage: false };
  const harness = createLifecycleHarness({ promise: Promise.resolve(pausedAuthRuntime()) }, {
    pathname: '/',
    pageState,
    onPreCourseEntryClick() {
      pageState.preCoursePage = false;
      pageState.coursePage = true;
      harness.notifyDomMutation();
    }
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'WAITING_LOGIN');
  pageState.loginPage = false;
  pageState.preCoursePage = true;
  harness.notifyDomMutation();
  await waitFor(() => harness.preCourseEntryClicks === 1);
  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'VERIFYING');
  assert.equal(harness.preCourseEntryClicks, 1);
  harness.context.stopGrab();
});

test('a repeated course-round entry does not click forever', async () => {
  const runtime = pausedAuthRuntime({
    authRecovery: {
      pending: true,
      stage: 'ENTERING_COURSE',
      attempts: 1,
      startedAt: Date.now(),
      returnPath: '/xsxkapp/sys/xsxkapp/*default/grablessons.do',
      lastMessage: '正在进入选课页'
    }
  });
  const harness = createLifecycleHarness({ promise: Promise.resolve(runtime) }, {
    coursePage: false,
    loginPage: false,
    preCoursePage: true,
    pathname: '/xsxkapp/sys/xsxkapp/*default/index.do'
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'MANUAL_REQUIRED');
  assert.equal(harness.preCourseEntryClicks, 0);
  assert.deepEqual(harness.navigations, []);
});

test('manual recovery never auto-clicks the course-round entry', async () => {
  const runtime = pausedAuthRuntime({
    authRecovery: {
      pending: true,
      stage: 'MANUAL_REQUIRED',
      attempts: 4,
      startedAt: Date.now(),
      returnPath: '/xsxkapp/sys/xsxkapp/*default/grablessons.do',
      lastMessage: '请手动进入当前轮次'
    }
  });
  const harness = createLifecycleHarness({ promise: Promise.resolve(runtime) }, {
    coursePage: false,
    loginPage: false,
    preCoursePage: true,
    pathname: '/xsxkapp/sys/xsxkapp/*default/index.do'
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'MANUAL_REQUIRED');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.preCourseEntryClicks, 0);
  assert.deepEqual(harness.navigations, []);
  harness.context.stopGrab();
});

test('returning to the course page resumes the paused task in verify-first mode', async () => {
  const runtimeRead = { promise: Promise.resolve(pausedAuthRuntime()) };
  const harness = createLifecycleHarness(runtimeRead, { coursePage: true, loginPage: false });

  await waitFor(() => harness.context.getStateSnapshot().running);
  const snapshot = harness.context.getStateSnapshot();
  assert.equal(snapshot.phase, 'RUNNING');
  assert.equal(snapshot.authRecovery.stage, 'VERIFYING');
  assert.equal(snapshot.authRecovery.pending, false);
  assert.deepEqual(Array.from(snapshot.configuredCourseNames), ['恢复课程']);
  assert.deepEqual(harness.navigations, []);
  harness.context.stopGrab();
});

test('a healthy scan clears the login-recovery checkpoint', async () => {
  const runtimeRead = { promise: Promise.resolve(pausedAuthRuntime()) };
  const harness = createLifecycleHarness(runtimeRead, {
    coursePage: true,
    scan: async targets => new Map(targets.map(target => [target.targetId, []]))
  });

  await waitFor(() => {
    const state = harness.context.getStateSnapshot();
    return state.running && state.round > 2 && !state.inFlight && !state.authRecovery;
  });
  assert.equal(harness.context.getStateSnapshot().authRecovery, undefined);
  harness.context.stopGrab();
});

test('repeated immediate auth expiry requires manual login instead of redirecting forever', async () => {
  const authError = new Error('登录仍然失效');
  authError.outcome = grabModule.OUTCOME.AUTH_EXPIRED;
  const runtime = pausedAuthRuntime({
    authRecovery: {
      pending: true,
      stage: 'WAITING_LOGIN',
      attempts: 3,
      startedAt: Date.now(),
      returnPath: '/xsxkapp/sys/xsxkapp/*default/grablessons.do',
      lastMessage: '第三次恢复'
    }
  });
  const harness = createLifecycleHarness({ promise: Promise.resolve(runtime) }, {
    coursePage: true,
    scan: async () => { throw authError; }
  });

  await waitFor(() => harness.context.getStateSnapshot().authRecovery?.stage === 'MANUAL_REQUIRED');
  const state = harness.context.getStateSnapshot();
  assert.equal(state.authRecovery.attempts, 4);
  assert.deepEqual(harness.navigations, []);
});
