'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createGrabEngine,
  TARGET_PHASE,
  CANDIDATE_STATUS,
  OUTCOME
} = require('../grab-engine.js');
const { normalizeTarget } = require('../grab-task-model.js');

function keywordTargetId(name) {
  return normalizeTarget(name).targetId;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createHarness(adapter, options = {}) {
  const clock = {
    value: 0,
    advance(ms) {
      this.value += ms;
    }
  };
  const timers = [];
  const states = [];
  const stopped = [];
  const engine = createGrabEngine({
    adapter,
    now: () => clock.value,
    formatLogTime: () => '00:00:00',
    minimumRestMs: options.minimumRestMs ?? 100,
    uncertainCommitMs: options.uncertainCommitMs ?? 10000,
    transientBackoffBaseMs: options.transientBackoffBaseMs ?? 1000,
    rateLimitBackoffBaseMs: options.rateLimitBackoffBaseMs ?? 5000,
    maxBackoffMs: options.maxBackoffMs ?? 60000,
    random: options.random || (() => 0.5),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => {
      timer.cancelled = true;
    },
    onState: state => states.push(state),
    onStopped: state => stopped.push(state)
  });
  return { engine, clock, timers, states, stopped };
}

async function waitFor(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

async function runLatestTimer(harness) {
  const timer = [...harness.timers].reverse().find(item => !item.cancelled);
  assert(timer, 'expected a scheduled round');
  timer.cancelled = true;
  timer.callback();
  await new Promise(resolve => setImmediate(resolve));
}

test('tries higher-priority targets first and stops after a course group is satisfied', async () => {
  const attempts = [];
  const harness = createHarness({
    async scan() {
      return new Map([
        ['羽毛球 A 班', [{ id: 'badminton-a', status: CANDIDATE_STATUS.AVAILABLE }]],
        ['羽毛球 B 班', [{ id: 'badminton-b', status: CANDIDATE_STATUS.AVAILABLE }]],
        ['网球', [{ id: 'tennis', status: CANDIDATE_STATUS.AVAILABLE }]]
      ]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      return { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start({
    groups: [{
      groupId: 'sport',
      label: '体育组',
      requiredCount: 1,
      targets: [
        { name: '网球', priority: 20 },
        { name: '羽毛球 B 班', priority: 80 },
        { name: '羽毛球 A 班', priority: 100 }
      ]
    }]
  }, 1000);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  const snapshot = harness.engine.getSnapshot();
  assert.deepEqual(attempts, ['badminton-a']);
  assert.equal(snapshot.totalGroups, 1);
  assert.equal(snapshot.completedGroups, 1);
  assert.deepEqual(snapshot.successTargets, ['羽毛球 A 班']);
  assert.equal(snapshot.targetStates[keywordTargetId('羽毛球 B 班')].phase, TARGET_PHASE.SKIPPED);
  assert.equal(snapshot.targetStates[keywordTargetId('网球')].lastOutcome, OUTCOME.GROUP_SATISFIED);
});

test('keeps selecting by priority until the course group required count is reached', async () => {
  const attempts = [];
  const harness = createHarness({
    async scan() {
      return new Map([
        ['第一志愿', [{ id: 'first', status: CANDIDATE_STATUS.AVAILABLE }]],
        ['第二志愿', [{ id: 'second', status: CANDIDATE_STATUS.AVAILABLE }]],
        ['第三志愿', [{ id: 'third', status: CANDIDATE_STATUS.AVAILABLE }]]
      ]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      return { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start({
    groups: [{
      groupId: 'electives',
      label: '选修课',
      requiredCount: 2,
      targets: [
        { name: '第三志愿', priority: 10 },
        { name: '第一志愿', priority: 30 },
        { name: '第二志愿', priority: 20 }
      ]
    }]
  }, 1000);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  const snapshot = harness.engine.getSnapshot();
  assert.deepEqual(attempts, ['first', 'second']);
  assert.equal(snapshot.groupStates.electives.selectedCount, 2);
  assert.equal(snapshot.targetStates[keywordTargetId('第三志愿')].phase, TARGET_PHASE.SKIPPED);
});

test('continues to a lower-priority fallback when the preferred target is rejected', async () => {
  const attempts = [];
  const harness = createHarness({
    async scan() {
      return new Map([
        ['优先课', [{ id: 'preferred', status: CANDIDATE_STATUS.AVAILABLE }]],
        ['保底课', [{ id: 'fallback', status: CANDIDATE_STATUS.AVAILABLE }]]
      ]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      return candidate.id === 'preferred'
        ? { outcome: OUTCOME.REJECTED, retryOtherCandidate: false }
        : { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start({
    groups: [{
      groupId: 'fallbacks',
      label: '优先与保底',
      requiredCount: 1,
      targets: [
        { name: '保底课', priority: 10 },
        { name: '优先课', priority: 100 }
      ]
    }]
  }, 1000);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  assert.deepEqual(attempts, ['preferred', 'fallback']);
  assert.deepEqual(harness.engine.getSnapshot().successTargets, ['保底课']);
});

test('restores grouped strategy and re-verifies the selected target before completing', async () => {
  let attempts = 0;
  const harness = createHarness({
    async scan() {
      return new Map([
        ['优先课', [{ id: 'preferred', status: CANDIDATE_STATUS.SELECTED }]],
        ['保底课', [{ id: 'fallback', status: CANDIDATE_STATUS.AVAILABLE }]]
      ]);
    },
    async attempt() {
      attempts += 1;
      return { outcome: OUTCOME.SUCCESS };
    }
  });
  const preferredId = keywordTargetId('优先课');
  const fallbackId = keywordTargetId('保底课');

  harness.engine.restore({
    running: true,
    configuredGroups: [{
      groupId: 'fallbacks',
      label: '优先与保底',
      requiredCount: 1,
      targets: [
        { name: '优先课', priority: 100 },
        { name: '保底课', priority: 10 }
      ]
    }],
    interval: 1000,
    targetStates: {
      [preferredId]: { phase: TARGET_PHASE.SELECTED },
      [fallbackId]: { phase: TARGET_PHASE.SKIPPED, lastOutcome: OUTCOME.GROUP_SATISFIED }
    }
  });
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  const snapshot = harness.engine.getSnapshot();
  assert.equal(attempts, 0);
  assert.equal(snapshot.completedGroups, 1);
  assert.deepEqual(snapshot.successTargets, ['优先课']);
  assert.equal(snapshot.targetStates[fallbackId].phase, TARGET_PHASE.SKIPPED);
});

test('collects all same-name candidates and selects a later available class', async () => {
  const attempts = [];
  const harness = createHarness({
    async scan() {
      return new Map([['羽毛球', [
        { id: 'class-full', status: CANDIDATE_STATUS.FULL },
        { id: 'class-open', label: '二班', status: CANDIDATE_STATUS.AVAILABLE }
      ]]]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      return { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start(['羽毛球'], 1000);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  assert.deepEqual(attempts, ['class-open']);
  assert.deepEqual(harness.engine.getSnapshot().successTargets, ['羽毛球']);
});

test('continues to the next teaching class after the first one conflicts', async () => {
  const attempts = [];
  const harness = createHarness({
    async scan() {
      return new Map([['专业课', [
        { id: 'class-a', status: CANDIDATE_STATUS.AVAILABLE },
        { id: 'class-b', status: CANDIDATE_STATUS.AVAILABLE }
      ]]]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      return candidate.id === 'class-a'
        ? { outcome: OUTCOME.CONFLICT, message: '第一教学班与已选课程冲突' }
        : { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start(['专业课'], 1000);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  assert.deepEqual(attempts, ['class-a', 'class-b']);
});

test('does not resubmit the same conflict candidate in later monitoring rounds', async () => {
  const attempts = [];
  const harness = createHarness({
    async scan() {
      return new Map([
        ['冲突课程', [{ id: 'conflict-class', status: CANDIDATE_STATUS.AVAILABLE }]],
        ['继续监控课程', [{ id: 'watching-class', status: CANDIDATE_STATUS.FULL }]]
      ]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      return {
        outcome: OUTCOME.CONFLICT,
        message: '已选课程时间冲突',
        retryOtherCandidate: true
      };
    }
  });

  harness.engine.start(['冲突课程', '继续监控课程'], 1000);
  await waitFor(() => {
    const state = harness.engine.getSnapshot();
    return state.round === 1 && !state.inFlight;
  });

  assert.deepEqual(attempts, ['conflict-class']);
  assert.equal(
    harness.engine.getSnapshot().targetStates[keywordTargetId('冲突课程')].phase,
    TARGET_PHASE.BLOCKED
  );

  await runLatestTimer(harness);
  await waitFor(() => {
    const state = harness.engine.getSnapshot();
    return state.round === 2 && !state.inFlight;
  });

  assert.deepEqual(attempts, ['conflict-class']);
  harness.engine.stop();
});

test('keeps monitoring a full alternative after excluding a conflicting teaching class', async () => {
  let round = 0;
  const attempts = [];
  const harness = createHarness({
    async scan() {
      round += 1;
      return new Map([['目标课程', [
        { id: 'conflict-class', status: CANDIDATE_STATUS.AVAILABLE },
        {
          id: 'alternative-class',
          status: round === 1 ? CANDIDATE_STATUS.FULL : CANDIDATE_STATUS.AVAILABLE
        }
      ]]]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      return candidate.id === 'conflict-class'
        ? { outcome: OUTCOME.CONFLICT, message: '已选课程时间冲突' }
        : { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start(['目标课程'], 1000);
  await waitFor(() => {
    const state = harness.engine.getSnapshot();
    return state.round === 1 && !state.inFlight;
  });

  let targetState = harness.engine.getSnapshot().targetStates[keywordTargetId('目标课程')];
  assert.deepEqual(attempts, ['conflict-class']);
  assert.equal(targetState.phase, TARGET_PHASE.WATCHING);
  assert.deepEqual(targetState.conflictingCandidateIds, ['conflict-class']);

  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  targetState = harness.engine.getSnapshot().targetStates[keywordTargetId('目标课程')];
  assert.deepEqual(attempts, ['conflict-class', 'alternative-class']);
  assert.equal(targetState.phase, TARGET_PHASE.SELECTED);
});

test('restores conflict exclusions without resubmitting the teaching class after reload', async () => {
  const attempts = [];
  const harness = createHarness({
    async scan() {
      return new Map([
        ['冲突课程', [{ id: 'conflict-class', status: CANDIDATE_STATUS.AVAILABLE }]],
        ['继续监控课程', [{ id: 'watching-class', status: CANDIDATE_STATUS.FULL }]]
      ]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      return { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.restore({
    running: true,
    configuredTargets: ['冲突课程', '继续监控课程'],
    interval: 1000,
    targetStates: {
      冲突课程: {
        phase: TARGET_PHASE.WATCHING,
        lastOutcome: OUTCOME.CONFLICT,
        lastMessage: '已选课程时间冲突',
        conflictingCandidateIds: ['conflict-class']
      },
      继续监控课程: { phase: TARGET_PHASE.WATCHING }
    }
  });
  await waitFor(() => {
    const state = harness.engine.getSnapshot();
    return state.round === 1 && !state.inFlight;
  });

  assert.deepEqual(attempts, []);
  assert.equal(
    harness.engine.getSnapshot().targetStates[keywordTargetId('冲突课程')].phase,
    TARGET_PHASE.BLOCKED
  );
  harness.engine.stop();
});

test('does not count an unverified confirmation as success and verifies before retrying', async () => {
  let round = 0;
  let attempts = 0;
  const harness = createHarness({
    async scan() {
      round += 1;
      return new Map([['操作系统', round === 1
        ? [{ id: 'os-a', status: CANDIDATE_STATUS.AVAILABLE }]
        : [{ id: 'os-a', status: CANDIDATE_STATUS.SELECTED }]]]);
    },
    async attempt() {
      attempts += 1;
      return { outcome: OUTCOME.UNKNOWN_COMMIT };
    }
  });

  harness.engine.start(['操作系统'], 1000);
  await waitFor(() => {
    const state = harness.engine.getSnapshot();
    return state.round === 1
      && !state.inFlight
      && state.targetStates[keywordTargetId('操作系统')].phase === TARGET_PHASE.VERIFYING;
  });

  let snapshot = harness.engine.getSnapshot();
  assert.deepEqual(snapshot.successTargets, []);
  assert.equal(attempts, 1);

  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');
  snapshot = harness.engine.getSnapshot();
  assert.deepEqual(snapshot.successTargets, ['操作系统']);
  assert.equal(attempts, 1, 'verification must happen before another submission');
});

test('a restarted run cannot submit or mutate state from the previous run', async () => {
  const oldScan = deferred();
  const attempts = [];
  const harness = createHarness({
    async scan(targets) {
      if (targets.some(target => target.name === '旧任务')) return oldScan.promise;
      return new Map([['新任务', [{ id: 'new-a', status: CANDIDATE_STATUS.AVAILABLE }]]]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      return { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start(['旧任务'], 1000);
  await waitFor(() => harness.engine.getSnapshot().inFlight);
  harness.engine.start(['新任务'], 1000);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  oldScan.resolve(new Map([['旧任务', [{ id: 'old-a', status: CANDIDATE_STATUS.AVAILABLE }]]]));
  await new Promise(resolve => setImmediate(resolve));

  const snapshot = harness.engine.getSnapshot();
  assert.deepEqual(attempts, ['new-a']);
  assert.deepEqual(snapshot.configuredCourseNames, ['新任务']);
  assert.deepEqual(snapshot.successTargets, ['新任务']);
});

test('stopping during an in-flight submission prevents a late success write', async () => {
  const submission = deferred();
  let attemptStarted = false;
  const harness = createHarness({
    async scan() {
      return new Map([['数据库', [{ id: 'db-a', status: CANDIDATE_STATUS.AVAILABLE }]]]);
    },
    async attempt() {
      attemptStarted = true;
      return submission.promise;
    }
  });

  harness.engine.start(['数据库'], 1000);
  await waitFor(() => attemptStarted);
  harness.engine.stop();
  submission.resolve({ outcome: OUTCOME.SUCCESS });
  await new Promise(resolve => setImmediate(resolve));

  const snapshot = harness.engine.getSnapshot();
  assert.equal(snapshot.phase, 'STOPPED');
  assert.deepEqual(snapshot.successTargets, []);
});

test('schedules against the target period and never creates a zero-delay catch-up burst', async () => {
  const harness = createHarness({
    async scan() {
      harness.clock.advance(400);
      return new Map([['编译原理', [{ id: 'compiler-a', status: CANDIDATE_STATUS.AVAILABLE }]]]);
    },
    async attempt() {
      harness.clock.advance(300);
      return { outcome: OUTCOME.REJECTED, retryOtherCandidate: false };
    }
  });

  harness.engine.start(['编译原理'], 1000);
  await waitFor(() => harness.engine.getSnapshot().round === 1 && !harness.engine.getSnapshot().inFlight);

  let timer = harness.timers.at(-1);
  assert.equal(harness.engine.getSnapshot().lastRoundDurationMs, 700);
  assert.equal(timer.delay, 300);

  const slowHarness = createHarness({
    async scan() {
      slowHarness.clock.advance(1500);
      return new Map([['计算机网络', []]]);
    },
    async attempt() {
      throw new Error('not reached');
    }
  });
  slowHarness.engine.start(['计算机网络'], 1000);
  await waitFor(() => slowHarness.engine.getSnapshot().round === 1 && !slowHarness.engine.getSnapshot().inFlight);
  timer = slowHarness.timers.at(-1);
  assert.equal(timer.delay, 100);
});

test('exposes bounded scan diagnostics without coupling the engine to provider internals', async () => {
  const harness = createHarness({
    async scan() {
      harness.clock.advance(240);
      const result = new Map([['课程甲', []]]);
      result.diagnostics = {
        mode: 'NETWORK',
        queriedTargetCount: 1,
        deferredTargetCount: 0,
        materializedQueryCount: 0,
        candidateCount: 0,
        shadowComparison: {
          comparisonCount: 2,
          mismatchedComparisonCount: 1,
          networkOnlyCandidateCount: 1,
          domOnlyCandidateCount: 0,
          statusMismatchCount: 1,
          unidentifiableCandidateCount: 0,
          candidateIds: ['must-not-expose']
        },
        requestBody: 'must-not-expose'
      };
      return result;
    },
    async attempt() {
      throw new Error('not reached');
    }
  });

  harness.engine.start(['课程甲'], 1000);
  await waitFor(() => harness.engine.getSnapshot().round === 1 && !harness.engine.getSnapshot().inFlight);

  assert.deepEqual(harness.engine.getSnapshot().lastScan, {
    mode: 'NETWORK',
    round: 1,
    completedAt: 240,
    durationMs: 240,
    queriedTargetCount: 1,
    deferredTargetCount: 0,
    materializedQueryCount: 0,
    candidateCount: 0,
    fallbackReason: null,
    outcome: null,
    shadowComparison: {
      comparisonCount: 2,
      mismatchedComparisonCount: 1,
      networkOnlyCandidateCount: 1,
      domOnlyCandidateCount: 0,
      statusMismatchCount: 1,
      unidentifiableCandidateCount: 0
    }
  });
  assert.equal(JSON.stringify(harness.engine.getSnapshot()).includes('must-not-expose'), false);
  harness.engine.stop();
});

test('accumulates aggregate shadow comparisons across rounds and keeps them after a scan error', async () => {
  let scans = 0;
  const harness = createHarness({
    async scan() {
      scans += 1;
      if (scans === 3) {
        const error = new Error('temporary query error');
        error.outcome = OUTCOME.SERVER_ERROR;
        throw error;
      }
      const result = new Map([['课程甲', []]]);
      result.diagnostics = {
        mode: 'NETWORK_WITH_DOM',
        queriedTargetCount: 1,
        materializedQueryCount: 1,
        candidateCount: 1,
        shadowComparison: {
          comparisonCount: 1,
          mismatchedComparisonCount: scans === 1 ? 0 : 1,
          networkOnlyCandidateCount: scans === 1 ? 0 : 1,
          domOnlyCandidateCount: 0,
          statusMismatchCount: 0,
          unidentifiableCandidateCount: 0
        }
      };
      return result;
    },
    async attempt() {
      throw new Error('not reached');
    }
  });

  harness.engine.start(['课程甲'], 1000);
  await waitFor(() => harness.engine.getSnapshot().round === 1 && !harness.engine.getSnapshot().inFlight);
  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().round === 2 && !harness.engine.getSnapshot().inFlight);
  assert.deepEqual(harness.engine.getSnapshot().lastScan.shadowComparison, {
    comparisonCount: 2,
    mismatchedComparisonCount: 1,
    networkOnlyCandidateCount: 1,
    domOnlyCandidateCount: 0,
    statusMismatchCount: 0,
    unidentifiableCandidateCount: 0
  });

  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().round === 3 && !harness.engine.getSnapshot().inFlight);
  assert.equal(harness.engine.getSnapshot().lastScan.mode, 'ERROR');
  assert.equal(harness.engine.getSnapshot().lastScan.shadowComparison.comparisonCount, 2);
  assert.equal(harness.engine.getSnapshot().lastScan.shadowComparison.mismatchedComparisonCount, 1);
  harness.engine.stop();
});

test('keeps the last observed state while a target waits for the next bounded query batch', async () => {
  let scans = 0;
  const harness = createHarness({
    async scan() {
      scans += 1;
      return new Map([['课程甲', [{
        id: scans === 1 ? 'full-a' : 'deferred-a',
        status: scans === 1 ? CANDIDATE_STATUS.FULL : CANDIDATE_STATUS.DEFERRED
      }]]]);
    },
    async attempt() {
      throw new Error('deferred targets must never submit');
    }
  });
  const targetId = keywordTargetId('课程甲');

  harness.engine.start(['课程甲'], 1000);
  await waitFor(() => harness.engine.getSnapshot().round === 1 && !harness.engine.getSnapshot().inFlight);
  assert.equal(harness.engine.getSnapshot().targetStates[targetId].lastOutcome, OUTCOME.FULL);

  harness.clock.advance(1000);
  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().round === 2 && !harness.engine.getSnapshot().inFlight);

  const targetState = harness.engine.getSnapshot().targetStates[targetId];
  assert.equal(targetState.phase, TARGET_PHASE.WATCHING);
  assert.equal(targetState.lastOutcome, OUTCOME.FULL);
  assert.equal(targetState.lastMessage, '已纳入监控，等待下轮分批查询');
  harness.engine.stop();
});

test('clears a stale not-found outcome when the target is waiting for its catalog query', async () => {
  let scans = 0;
  const harness = createHarness({
    async scan() {
      scans += 1;
      return new Map([['课程甲', scans === 1 ? [] : [{
        id: 'catalog-deferred',
        status: CANDIDATE_STATUS.DEFERRED,
        label: '等待打开 SC 课程分类以建立查询通道'
      }]]]);
    },
    async attempt() {
      throw new Error('deferred targets must never submit');
    }
  });
  const targetId = keywordTargetId('课程甲');

  harness.engine.start(['课程甲'], 1000);
  await waitFor(() => harness.engine.getSnapshot().round === 1 && !harness.engine.getSnapshot().inFlight);
  assert.equal(harness.engine.getSnapshot().targetStates[targetId].lastOutcome, 'NOT_FOUND');

  harness.clock.advance(1000);
  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().round === 2 && !harness.engine.getSnapshot().inFlight);

  const targetState = harness.engine.getSnapshot().targetStates[targetId];
  assert.equal(targetState.lastOutcome, null);
  assert.equal(targetState.lastMessage, '等待打开 SC 课程分类以建立查询通道');
  harness.engine.stop();
});

test('keeps configured totals immutable while exposing remaining and selected targets separately', async () => {
  const harness = createHarness({
    async scan() {
      return new Map([
        ['课程甲', [{ id: 'a', status: CANDIDATE_STATUS.SELECTED }]],
        ['课程乙', [{ id: 'b', status: CANDIDATE_STATUS.FULL }]]
      ]);
    },
    async attempt() {
      throw new Error('not reached');
    }
  });

  harness.engine.start(['课程甲', '课程乙'], 1000);
  await waitFor(() => harness.engine.getSnapshot().round === 1 && !harness.engine.getSnapshot().inFlight);

  const snapshot = harness.engine.getSnapshot();
  assert.equal(snapshot.initialTargetCount, 2);
  assert.deepEqual(snapshot.configuredCourseNames, ['课程甲', '课程乙']);
  assert.deepEqual(snapshot.courseNames, ['课程甲', '课程乙']);
  assert.deepEqual(snapshot.remainingCourseNames, ['课程乙']);
  assert.deepEqual(snapshot.successTargets, ['课程甲']);
});

test('restores configured targets but re-verifies a persisted success on the current page', async () => {
  let scans = 0;
  const harness = createHarness({
    async scan() {
      scans += 1;
      return new Map([['课程甲', [{ id: 'class-a', status: CANDIDATE_STATUS.SELECTED }]]]);
    },
    async attempt() {
      throw new Error('not reached');
    }
  });

  harness.engine.restore({
    running: true,
    configuredCourseNames: ['课程甲'],
    interval: 1000,
    round: 3,
    targetStates: {
      课程甲: { phase: TARGET_PHASE.SELECTED, candidateId: 'class-a', attempts: 1 }
    },
    log: ['[00:00:00] 旧页面记录']
  });
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  const snapshot = harness.engine.getSnapshot();
  assert.equal(scans, 1);
  assert.equal(snapshot.round, 4);
  assert.deepEqual(snapshot.successTargets, ['课程甲']);
  assert.match(snapshot.log.join('\n'), /已恢复监控/);
});

test('restores an interrupted submission in verify-only mode before allowing another attempt', async () => {
  let attempts = 0;
  const harness = createHarness({
    async scan() {
      return new Map([['课程甲', [{ id: 'class-a', status: CANDIDATE_STATUS.AVAILABLE }]]]);
    },
    async attempt() {
      attempts += 1;
      return { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.restore({
    running: true,
    configuredCourseNames: ['课程甲'],
    interval: 1000,
    targetStates: {
      课程甲: { phase: TARGET_PHASE.SUBMITTING, candidateId: 'class-a', attempts: 1 }
    }
  });
  await waitFor(() => harness.engine.getSnapshot().round === 1 && !harness.engine.getSnapshot().inFlight);
  assert.equal(attempts, 0);
  assert.equal(
    harness.engine.getSnapshot().targetStates[keywordTargetId('课程甲')].phase,
    TARGET_PHASE.VERIFYING
  );

  harness.clock.advance(10000);
  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');
  assert.equal(attempts, 1);
});

test('an exact target ignores a selected same-name class and submits only its teaching class ID', async () => {
  const target = normalizeTarget({
    name: '同名课程', electiveBatchId: 'BATCH-1', teachingClassType: 'ZY', teachingClassId: 'class-b'
  });
  const attempts = [];
  const harness = createHarness({
    async scan(targets) {
      assert.equal(targets[0].targetId, target.targetId);
      return new Map([[target.targetId, [
        {
          id: 'wrong', teachingClassId: 'class-a', electiveBatchId: 'BATCH-1', teachingClassType: 'ZY',
          status: CANDIDATE_STATUS.SELECTED
        },
        {
          id: 'right', teachingClassId: 'class-b', electiveBatchId: 'BATCH-1', teachingClassType: 'ZY',
          status: CANDIDATE_STATUS.AVAILABLE
        }
      ]]]);
    },
    async attempt(candidate) {
      attempts.push(candidate.teachingClassId);
      return { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start([target], 1000);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');

  const snapshot = harness.engine.getSnapshot();
  assert.deepEqual(attempts, ['class-b']);
  assert.deepEqual(snapshot.successTargetIds, [target.targetId]);
  assert.equal(snapshot.configuredTargets[0].teachingClassId, 'class-b');
});

test('backs off repeated network failures exponentially before retrying the target', async () => {
  let attempts = 0;
  const harness = createHarness({
    async scan() {
      return new Map([['网络课程', [{ id: 'network-a', status: CANDIDATE_STATUS.AVAILABLE }]]]);
    },
    async attempt() {
      attempts += 1;
      return attempts < 3
        ? { outcome: OUTCOME.NETWORK_ERROR, message: '网络暂时不可用' }
        : { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start(['网络课程'], 1000);
  await waitFor(() => harness.engine.getSnapshot().targetStates[keywordTargetId('网络课程')]?.phase === TARGET_PHASE.RETRY);

  let snapshot = harness.engine.getSnapshot();
  let timer = harness.timers.at(-1);
  assert.equal(snapshot.targetStates[keywordTargetId('网络课程')].transientFailures, 1);
  assert.equal(snapshot.targetStates[keywordTargetId('网络课程')].retryAt, 1000);
  assert.equal(timer.delay, 1000);

  harness.clock.advance(1000);
  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().targetStates[keywordTargetId('网络课程')]?.transientFailures === 2);
  snapshot = harness.engine.getSnapshot();
  timer = harness.timers.at(-1);
  assert.equal(snapshot.targetStates[keywordTargetId('网络课程')].retryAt, 3000);
  assert.equal(timer.delay, 2000);

  harness.clock.advance(2000);
  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');
  assert.equal(attempts, 3);
});

test('rate limiting stops other submissions in the round and applies global backoff', async () => {
  const attempts = [];
  let limited = true;
  const harness = createHarness({
    async scan() {
      return new Map([
        ['课程甲', [{ id: 'a', status: CANDIDATE_STATUS.AVAILABLE }]],
        ['课程乙', [{ id: 'b', status: CANDIDATE_STATUS.AVAILABLE }]]
      ]);
    },
    async attempt(candidate) {
      attempts.push(candidate.id);
      if (candidate.id === 'a' && limited) {
        limited = false;
        return { outcome: OUTCOME.RATE_LIMITED, message: '请求过于频繁' };
      }
      return { outcome: OUTCOME.SUCCESS };
    }
  });

  harness.engine.start(['课程甲', '课程乙'], 1000);
  await waitFor(() => harness.engine.getSnapshot().globalRetryAt === 5000);

  let snapshot = harness.engine.getSnapshot();
  assert.deepEqual(attempts, ['a']);
  assert.equal(snapshot.retryingTargetCount, 1);
  assert.equal(harness.timers.at(-1).delay, 5000);

  harness.clock.advance(5000);
  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');
  snapshot = harness.engine.getSnapshot();
  assert.deepEqual(attempts, ['a', 'a', 'b']);
  assert.equal(snapshot.globalRetryAt, 0);
});

test('restores a future retry checkpoint without scanning or submitting immediately', async () => {
  let scans = 0;
  const harness = createHarness({
    async scan() {
      scans += 1;
      return new Map([['课程甲', [{ id: 'a', status: CANDIDATE_STATUS.AVAILABLE }]]]);
    },
    async attempt() {
      return { outcome: OUTCOME.SUCCESS };
    }
  });
  const targetId = keywordTargetId('课程甲');

  harness.engine.restore({
    running: true,
    configuredCourseNames: ['课程甲'],
    interval: 1000,
    targetStates: {
      [targetId]: { phase: TARGET_PHASE.RETRY, retryAt: 5000, transientFailures: 1 }
    }
  });

  assert.equal(scans, 0);
  assert.equal(harness.engine.getSnapshot().nextRunAt, 5000);
  assert.equal(harness.timers.at(-1).delay, 5000);

  harness.clock.advance(5000);
  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().phase === 'COMPLETED');
  assert.equal(scans, 1);
});

test('clamps a restored retry checkpoint to the configured maximum backoff', () => {
  let scans = 0;
  const harness = createHarness({
    async scan() {
      scans += 1;
      return new Map();
    },
    async attempt() {
      throw new Error('not reached');
    }
  }, { maxBackoffMs: 60000 });
  const targetId = keywordTargetId('课程甲');

  harness.engine.restore({
    running: true,
    configuredCourseNames: ['课程甲'],
    interval: 1000,
    globalRetryAt: 900000,
    targetStates: {
      [targetId]: { phase: TARGET_PHASE.RETRY, retryAt: 900000, transientFailures: 100 }
    }
  });

  const snapshot = harness.engine.getSnapshot();
  assert.equal(scans, 0);
  assert.equal(snapshot.globalRetryAt, 60000);
  assert.equal(snapshot.targetStates[targetId].retryAt, 60000);
  assert.equal(harness.timers.at(-1).delay, 60000);
});

test('backs off a structured transient scan failure globally', async () => {
  let scans = 0;
  const harness = createHarness({
    async scan() {
      scans += 1;
      if (scans === 1) {
        const error = new Error('服务端暂时不可用');
        error.outcome = OUTCOME.SERVER_ERROR;
        throw error;
      }
      return new Map([['课程甲', []]]);
    },
    async attempt() {
      throw new Error('not reached');
    }
  });

  harness.engine.start(['课程甲'], 1000);
  await waitFor(() => harness.engine.getSnapshot().globalRetryAt === 1000);
  assert.equal(harness.engine.getSnapshot().scanFailures, 1);
  assert.equal(harness.engine.getSnapshot().lastScan.mode, 'ERROR');
  assert.equal(harness.engine.getSnapshot().lastScan.outcome, OUTCOME.SERVER_ERROR);
  assert.equal(harness.timers.at(-1).delay, 1000);

  harness.clock.advance(1000);
  await runLatestTimer(harness);
  await waitFor(() => harness.engine.getSnapshot().round === 2 && !harness.engine.getSnapshot().inFlight);
  assert.equal(harness.engine.getSnapshot().scanFailures, 0);
});
