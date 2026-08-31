'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const {
  SCHEMA_VERSION,
  sanitizeSnapshot,
  createGrabTaskSessionStore
} = require('../grab-task-session.js');
const { normalizeTarget } = require('../grab-task-model.js');

function keywordTargetId(name) {
  return normalizeTarget(name).targetId;
}

function createHarness() {
  let state = null;
  let timestamp = 1700000000000;
  const revoked = [];
  const store = createGrabTaskSessionStore({
    readState: async () => structuredClone(state),
    writeState: async value => { state = structuredClone(value); },
    revokeOwner: async (tabId, taskId) => { revoked.push({ tabId, taskId }); },
    now: () => timestamp++
  });
  return {
    store,
    revoked,
    getState: () => structuredClone(state),
    seedState: value => { state = structuredClone(value); }
  };
}

function runtimeSnapshot(overrides = {}) {
  return {
    running: true,
    phase: 'RUNNING',
    configuredCourseNames: ['课程甲', '课程乙'],
    interval: 5000,
    round: 3,
    inFlight: false,
    successTargets: ['课程甲'],
    targetStates: {
      课程甲: { phase: 'SELECTED', candidateId: 'batch:ZY:class-a', attempts: 1 },
      课程乙: { phase: 'WATCHING', lastOutcome: 'FULL', lastMessage: '已满', attempts: 0 }
    },
    log: ['第一轮', '第二轮'],
    ...overrides
  };
}

test('sanitizes session snapshots and excludes page/request objects', () => {
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    interval: 250,
    configuredCourseNames: ['课程甲', '课程甲', '', '课程乙'],
    token: 'must-not-persist',
    targetStates: {
      课程甲: {
        phase: 'SELECTED',
        candidateId: 'batch:ZY:class-a',
        attempts: 1,
        row: { innerHTML: 'private page content' },
        requestBody: 'encrypted-secret'
      },
      课程乙: { phase: 'NOT_A_REAL_PHASE' }
    }
  }));

  assert.deepEqual(snapshot.configuredCourseNames, ['课程甲', '课程乙']);
  assert.equal(snapshot.targetStates[keywordTargetId('课程甲')].phase, 'SELECTED');
  assert.equal(snapshot.targetStates[keywordTargetId('课程乙')].phase, 'WATCHING');
  assert.equal(snapshot.interval, 250);
  assert.equal(Object.hasOwn(snapshot, 'token'), false);
  assert.equal(JSON.stringify(snapshot).includes('private page content'), false);
  assert.equal(JSON.stringify(snapshot).includes('encrypted-secret'), false);
});

test('restores state only to the tab that owns the task', async () => {
  const harness = createHarness();
  const saved = await harness.store.save({
    taskId: 'task-a',
    revision: 1,
    snapshot: runtimeSnapshot()
  }, 12, { claim: true });

  assert.equal(saved.schemaVersion, SCHEMA_VERSION);
  assert.equal(saved.ownerTabId, 12);
  assert.equal((await harness.store.read(12)).taskId, 'task-a');
  assert.equal(await harness.store.read(13), null);
});

test('requires an explicit claim before a second tab can replace a running owner', async () => {
  const harness = createHarness();
  await harness.store.save({ taskId: 'task-a', revision: 1, snapshot: runtimeSnapshot() }, 12, { claim: true });

  const rejected = await harness.store.save({
    taskId: 'task-b',
    revision: 1,
    snapshot: runtimeSnapshot({ configuredCourseNames: ['新任务'] })
  }, 13);
  assert.equal(rejected.ownerTabId, 12);
  assert.equal(harness.getState().taskId, 'task-a');

  const claimed = await harness.store.save({
    taskId: 'task-b',
    revision: 2,
    snapshot: runtimeSnapshot({ configuredCourseNames: ['新任务'] })
  }, 13, { claim: true });
  assert.equal(claimed.ownerTabId, 13);
  assert.equal(claimed.taskId, 'task-b');
  assert.deepEqual(harness.revoked, [{ tabId: 12, taskId: 'task-a' }]);
});

test('an old owner cannot reclaim storage after the new owner stops', async () => {
  const harness = createHarness();
  await harness.store.save({ taskId: 'task-a', revision: 1, snapshot: runtimeSnapshot() }, 12, { claim: true });
  await harness.store.save({ taskId: 'task-b', revision: 1, snapshot: runtimeSnapshot() }, 13, { claim: true });
  await harness.store.save({
    taskId: 'task-b',
    revision: 2,
    snapshot: runtimeSnapshot({ running: false, phase: 'STOPPED' })
  }, 13);

  const rejected = await harness.store.save({
    taskId: 'task-a',
    revision: 99,
    snapshot: runtimeSnapshot({ running: true })
  }, 12);
  assert.equal(rejected.ownerTabId, 13);
  assert.equal(rejected.snapshot.running, false);
  assert.equal(harness.getState().taskId, 'task-b');
});

test('ignores an older revision from the same task', async () => {
  const harness = createHarness();
  await harness.store.save({ taskId: 'task-a', revision: 4, snapshot: runtimeSnapshot({ round: 4 }) }, 12, { claim: true });
  const result = await harness.store.save({ taskId: 'task-a', revision: 3, snapshot: runtimeSnapshot({ round: 3 }) }, 12);

  assert.equal(result.revision, 4);
  assert.equal(harness.getState().snapshot.round, 4);
});

test('production wiring loads the session store and restores through GrabEngine', () => {
  const authWorker = readFileSync(resolve(__dirname, '..', 'auth-session-prewarm.js'), 'utf8');
  const contentScript = readFileSync(resolve(__dirname, '..', 'content-grab.js'), 'utf8');
  const buildScript = readFileSync(resolve(__dirname, '..', 'scripts', 'build-package.ps1'), 'utf8');

  assert.match(authWorker, /importScripts\([^)]*'grab-task-model\.js'[^)]*'grab-task-session\.js'[^)]*\)/);
  assert.match(buildScript, /'grab-task-model\.js'/);
  assert.match(buildScript, /'grab-task-session\.js'/);
  assert.match(contentScript, /grabTaskRuntimeSave/);
  assert.match(contentScript, /grabTaskRuntimeGet/);
  assert.match(contentScript, /grabEngine\.restore/);
  assert.match(contentScript, /grabTaskLeaseRevoked/);
  assert.match(
    contentScript,
    /Promise\.resolve\(grabTaskRestoreReady\)\.finally\(\(\) => initializeClickCaptchaSolver\(\)\)/,
    'Course-login automation must wait until a running task has been checkpointed for recovery.'
  );
});

test('preserves exact teaching-class targets in the session whitelist', () => {
  const exact = normalizeTarget({
    name: '课程甲', electiveBatchId: 'BATCH-1', teachingClassType: 'ZY', teachingClassId: 'class-a',
    teacher: '教师甲', queryScope: 'SC'
  });
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    configuredTargets: [exact],
    configuredCourseNames: ['错误的旧名称'],
    successTargetIds: [exact.targetId],
    targetStates: { [exact.targetId]: { phase: 'SELECTED', candidateId: exact.targetId } }
  }));

  assert.equal(snapshot.configuredTargets[0].teachingClassId, 'class-a');
  assert.equal(snapshot.configuredTargets[0].queryScope, 'SC');
  assert.deepEqual(snapshot.successTargetIds, [exact.targetId]);
  assert.equal(snapshot.targetStates[exact.targetId].phase, 'SELECTED');
});

test('preserves only supported keyword filters in the session whitelist', () => {
  const rawTarget = {
    name: '机器学习',
    filters: {
      teacher: '教师甲',
      time: '周一 3-4 节',
      campus: '仙林',
      requestToken: 'must-not-persist'
    }
  };
  const filtered = normalizeTarget(rawTarget);
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    configuredTargets: [rawTarget],
    configuredCourseNames: ['错误的旧名称'],
    targetStates: { [filtered.targetId]: { phase: 'WATCHING' } }
  }));

  assert.deepEqual({ ...snapshot.configuredTargets[0].filters }, {
    teacher: '教师甲',
    time: '周一 3-4 节',
    campus: '仙林'
  });
  assert.equal(snapshot.configuredTargets[0].targetId, filtered.targetId);
  assert.equal(JSON.stringify(snapshot).includes('must-not-persist'), false);
});

test('preserves course groups, priorities and derived completion state', () => {
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    configuredGroups: [{
      groupId: 'sport',
      label: '体育组',
      requiredCount: 1,
      secret: 'must-not-persist',
      targets: [
        { name: '羽毛球 A 班', priority: 100 },
        { name: '羽毛球 B 班', priority: 80 }
      ]
    }],
    configuredCourseNames: ['错误的旧名称'],
    targetStates: {
      '羽毛球 A 班': { phase: 'SELECTED' },
      '羽毛球 B 班': { phase: 'SKIPPED', lastOutcome: 'GROUP_SATISFIED' }
    }
  }));

  assert.equal(snapshot.totalGroups, 1);
  assert.equal(snapshot.completedGroups, 1);
  assert.equal(snapshot.configuredGroups[0].groupId, 'sport');
  assert.deepEqual(snapshot.configuredGroups[0].targets.map(target => target.priority), [100, 80]);
  assert.deepEqual(snapshot.remainingTargets, []);
  assert.equal(snapshot.targetStates[keywordTargetId('羽毛球 B 班')].phase, 'SKIPPED');
  assert.equal(JSON.stringify(snapshot).includes('must-not-persist'), false);
});

test('reads and upgrades a legacy session checkpoint for the owning tab', async () => {
  const harness = createHarness();
  harness.seedState({
    schemaVersion: 1,
    taskId: 'legacy-task',
    revision: 3,
    ownerTabId: 12,
    updatedAt: 1700000000000,
    snapshot: runtimeSnapshot()
  });

  const restored = await harness.store.read(12);
  assert.equal(restored.schemaVersion, SCHEMA_VERSION);
  assert.equal(restored.snapshot.totalGroups, 2);
  assert.deepEqual(restored.snapshot.configuredCourseNames, ['课程甲', '课程乙']);
});

test('preserves bounded retry checkpoints in the session whitelist', () => {
  const targetId = keywordTargetId('课程甲');
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    globalRetryAt: 1700000005000,
    nextRetryAt: 1700000005000,
    retryingTargetCount: 1,
    scanFailures: 2,
    lastTransientOutcome: 'RATE_LIMITED',
    targetStates: {
      课程甲: {
        phase: 'RETRY', retryAt: 1700000005000, transientFailures: 3,
        requestBody: 'must-not-persist'
      },
      课程乙: { phase: 'WATCHING' }
    }
  }));

  assert.equal(snapshot.globalRetryAt, 1700000005000);
  assert.equal(snapshot.retryingTargetCount, 1);
  assert.equal(snapshot.scanFailures, 2);
  assert.equal(snapshot.lastTransientOutcome, 'RATE_LIMITED');
  assert.equal(snapshot.targetStates[targetId].phase, 'RETRY');
  assert.equal(snapshot.targetStates[targetId].transientFailures, 3);
  assert.equal(JSON.stringify(snapshot).includes('must-not-persist'), false);
});

test('preserves bounded structure-error recovery state for a safe reload', () => {
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    running: true,
    phase: 'RUNNING',
    scanFailures: 4,
    structureFailures: 4,
    structureFailureSignature: 'STRUCTURE_ERROR: 未发现课程列表',
    lastTransientOutcome: 'STRUCTURE_ERROR',
    lastScan: { mode: 'ERROR', outcome: 'STRUCTURE_ERROR' }
  }));

  assert.equal(snapshot.structureFailures, 4);
  assert.equal(snapshot.structureFailureSignature, 'STRUCTURE_ERROR: 未发现课程列表');
  assert.equal(snapshot.lastScan.outcome, 'STRUCTURE_ERROR');
});

test('preserves only bounded conflict candidate identifiers for task recovery', () => {
  const targetId = keywordTargetId('课程甲');
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    targetStates: {
      课程甲: {
        phase: 'WATCHING',
        lastOutcome: 'CONFLICT',
        conflictingCandidateIds: [
          'class-conflict',
          'class-conflict',
          ...Array.from({ length: 60 }, (_, index) => `class-${index}`)
        ],
        conflictingCandidateRows: ['must-not-persist']
      },
      课程乙: { phase: 'WATCHING' }
    }
  }));

  assert.equal(snapshot.targetStates[targetId].conflictingCandidateIds[0], 'class-conflict');
  assert.equal(snapshot.targetStates[targetId].conflictingCandidateIds.length, 50);
  assert.equal(JSON.stringify(snapshot).includes('must-not-persist'), false);
});

test('persists only aggregate scan diagnostics', () => {
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    lastScan: {
      mode: 'NETWORK_WITH_DOM',
      round: 3,
      completedAt: 1700000000123,
      durationMs: 321,
      queriedTargetCount: 3,
      deferredTargetCount: 2,
      publicDeferredTargetCount: 1,
      materializedQueryCount: 1,
      candidateCount: 4,
      shadowComparison: {
        comparisonCount: 3,
        mismatchedComparisonCount: 1,
        networkOnlyCandidateCount: 1,
        domOnlyCandidateCount: 2,
        statusMismatchCount: 1,
        unidentifiableCandidateCount: 0,
        candidateIds: ['must-not-persist']
      },
      fallbackReason: null,
      outcome: null,
      requestBody: 'must-not-persist',
      query: 'must-not-persist'
    }
  }));

  assert.deepEqual(snapshot.lastScan, {
    mode: 'NETWORK_WITH_DOM',
    round: 3,
    completedAt: 1700000000123,
    durationMs: 321,
    queriedTargetCount: 3,
    deferredTargetCount: 2,
    publicDeferredTargetCount: 1,
    materializedQueryCount: 1,
    candidateCount: 4,
    fallbackReason: null,
    outcome: null,
    shadowComparison: {
      comparisonCount: 3,
      mismatchedComparisonCount: 1,
      networkOnlyCandidateCount: 1,
      domOnlyCandidateCount: 2,
      statusMismatchCount: 1,
      unidentifiableCandidateCount: 0
    }
  });
  assert.equal(JSON.stringify(snapshot).includes('must-not-persist'), false);
  assert.equal(sanitizeSnapshot(runtimeSnapshot({ lastScan: { mode: 'UNTRUSTED' } })).lastScan, null);
});

test('preserves only a same-site course return path for login recovery', () => {
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    running: false,
    phase: 'PAUSED_AUTH',
    authRecovery: {
      pending: true,
      stage: 'WAITING_LOGIN',
      attempts: 2,
      startedAt: 1700000000000,
      electiveBatchCode: 'ROUND-ORIGINAL',
      returnPath: '/xsxkapp/sys/xsxkapp/demo/grablessons.do',
      lastMessage: '等待重新登录',
      token: 'must-not-persist'
    }
  }));

  assert.deepEqual(snapshot.authRecovery, {
    pending: true,
    stage: 'WAITING_LOGIN',
    attempts: 2,
    startedAt: 1700000000000,
    electiveBatchCode: 'ROUND-ORIGINAL',
    returnPath: '/xsxkapp/sys/xsxkapp/demo/grablessons.do',
    lastMessage: '等待重新登录'
  });
  assert.equal(JSON.stringify(snapshot).includes('must-not-persist'), false);

  const external = sanitizeSnapshot(runtimeSnapshot({
    authRecovery: {
      pending: true,
      returnPath: 'https://example.com/steal'
    }
  }));
  assert.equal(external.authRecovery.returnPath, '');
});

test('preserves the pre-course entry recovery stage', () => {
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    running: false,
    phase: 'PAUSED_AUTH',
    authRecovery: {
      pending: true,
      stage: 'ENTERING_COURSE',
      attempts: 1,
      startedAt: 1700000000000,
      returnPath: '/xsxkapp/sys/xsxkapp/demo/grablessons.do',
      lastMessage: '正在进入当前选课轮次'
    }
  }));

  assert.equal(snapshot.authRecovery.stage, 'ENTERING_COURSE');
  assert.equal(snapshot.authRecovery.pending, true);
});

test('preserves the selecting-round recovery stage without accepting arbitrary batch data', () => {
  const snapshot = sanitizeSnapshot(runtimeSnapshot({
    running: false,
    phase: 'PAUSED_AUTH',
    authRecovery: {
      pending: true,
      stage: 'SELECTING_ROUND',
      attempts: 1,
      startedAt: 1700000000000,
      electiveBatchCode: '  ROUND-ORIGINAL  ',
      returnPath: '/xsxkapp/sys/xsxkapp/demo/grablessons.do',
      lastMessage: '正在选择原监控轮次'
    }
  }));

  assert.equal(snapshot.authRecovery.stage, 'SELECTING_ROUND');
  assert.equal(snapshot.authRecovery.electiveBatchCode, 'ROUND-ORIGINAL');
});
