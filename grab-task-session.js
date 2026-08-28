// Session-scoped persistence for a running course-grab task. No page DOM or request secrets are stored.
(function initGrabTaskSession(global) {
  'use strict';

  const taskModel = global.NjuGrabTaskModel
    || (typeof require === 'function' ? require('./grab-task-model.js') : null);

  const STATE_KEY = 'nju_grab_task_runtime_v1';
  const SCHEMA_VERSION = 2;
  const LEGACY_SCHEMA_VERSION = 1;
  const ACTION_SAVE = 'grabTaskRuntimeSave';
  const ACTION_GET = 'grabTaskRuntimeGet';
  const VALID_TARGET_PHASES = new Set([
    'WATCHING',
    'READY',
    'SUBMITTING',
    'VERIFYING',
    'RETRY',
    'SELECTED',
    'SKIPPED',
    'BLOCKED'
  ]);
  const VALID_AUTH_RECOVERY_STAGES = new Set([
    'WAITING_LOGIN',
    'RETURNING',
    'SELECTING_ROUND',
    'ENTERING_COURSE',
    'VERIFYING',
    'MANUAL_REQUIRED'
  ]);
  const VALID_SCAN_MODES = new Set([
    'NETWORK',
    'NETWORK_WITH_DOM',
    'DOM_FALLBACK',
    'ERROR'
  ]);
  const VALID_SCAN_FALLBACK_REASONS = new Set([
    'NATIVE_QUERY_UNAVAILABLE',
    'NATIVE_QUERY_UNSUPPORTED'
  ]);
  const VALID_SCAN_OUTCOMES = new Set([
    'AUTH_EXPIRED',
    'RATE_LIMITED',
    'NETWORK_ERROR',
    'SERVER_ERROR',
    'STRUCTURE_ERROR',
    'UNKNOWN_SCAN_ERROR',
    'UNKNOWN'
  ]);

  function boundedText(value, maxLength) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
  }

  function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function targetName(target) {
    return taskModel.targetLabel(target) || target.name || target.targetId;
  }

  function sanitizeAuthRecovery(value) {
    if (!value || typeof value !== 'object') return null;
    const rawReturnPath = boundedText(value.returnPath, 500);
    const returnPath = /^\/xsxkapp\/.+\/grablessons\.do$/i.test(rawReturnPath)
      && !rawReturnPath.includes('..')
      ? rawReturnPath
      : '';
    return {
      pending: Boolean(value.pending),
      stage: VALID_AUTH_RECOVERY_STAGES.has(value.stage) ? value.stage : 'WAITING_LOGIN',
      attempts: Math.min(4, Math.floor(nonNegativeNumber(value.attempts))),
      startedAt: nonNegativeNumber(value.startedAt),
      electiveBatchCode: boundedText(value.electiveBatchCode, 200),
      returnPath,
      lastMessage: boundedText(value.lastMessage, 500)
    };
  }

  function sanitizeLastScan(value) {
    const source = value && typeof value === 'object' ? value : null;
    if (!source || !VALID_SCAN_MODES.has(source.mode)) return null;
    const scopeDeferredTargetCount = Math.floor(nonNegativeNumber(source.scopeDeferredTargetCount));
    const shadowSource = source.shadowComparison && typeof source.shadowComparison === 'object'
      ? source.shadowComparison
      : null;
    const shadowComparison = shadowSource
      ? {
          comparisonCount: Math.floor(nonNegativeNumber(shadowSource.comparisonCount)),
          mismatchedComparisonCount: Math.floor(nonNegativeNumber(shadowSource.mismatchedComparisonCount)),
          networkOnlyCandidateCount: Math.floor(nonNegativeNumber(shadowSource.networkOnlyCandidateCount)),
          domOnlyCandidateCount: Math.floor(nonNegativeNumber(shadowSource.domOnlyCandidateCount)),
          statusMismatchCount: Math.floor(nonNegativeNumber(shadowSource.statusMismatchCount)),
          unidentifiableCandidateCount: Math.floor(nonNegativeNumber(shadowSource.unidentifiableCandidateCount))
        }
      : null;
    return {
      mode: source.mode,
      round: Math.floor(nonNegativeNumber(source.round)),
      completedAt: nonNegativeNumber(source.completedAt),
      durationMs: nonNegativeNumber(source.durationMs),
      queriedTargetCount: Math.floor(nonNegativeNumber(source.queriedTargetCount)),
      deferredTargetCount: Math.floor(nonNegativeNumber(source.deferredTargetCount)),
      ...(scopeDeferredTargetCount > 0 ? { scopeDeferredTargetCount } : {}),
      materializedQueryCount: Math.floor(nonNegativeNumber(source.materializedQueryCount)),
      candidateCount: Math.floor(nonNegativeNumber(source.candidateCount)),
      fallbackReason: VALID_SCAN_FALLBACK_REASONS.has(source.fallbackReason)
        ? source.fallbackReason
        : null,
      outcome: VALID_SCAN_OUTCOMES.has(source.outcome) ? source.outcome : null,
      ...(shadowComparison?.comparisonCount > 0 ? { shadowComparison } : {})
    };
  }

  function sanitizeTargetState(target, value) {
    const source = value && typeof value === 'object' ? value : {};
    const conflictingCandidateIds = Array.isArray(source.conflictingCandidateIds)
      ? [...new Set(source.conflictingCandidateIds
          .filter(candidateId => ['string', 'number'].includes(typeof candidateId))
          .map(candidateId => boundedText(candidateId, 300))
          .filter(Boolean))]
          .slice(0, 50)
      : [];
    return {
      targetId: target.targetId,
      phase: VALID_TARGET_PHASES.has(source.phase) ? source.phase : 'WATCHING',
      lastOutcome: source.lastOutcome ? boundedText(source.lastOutcome, 80) : null,
      lastMessage: boundedText(source.lastMessage, 500),
      candidateId: source.candidateId ? boundedText(source.candidateId, 300) : null,
      conflictingCandidateIds,
      attempts: Math.floor(nonNegativeNumber(source.attempts)),
      uncertainUntil: nonNegativeNumber(source.uncertainUntil),
      transientFailures: Math.floor(nonNegativeNumber(source.transientFailures)),
      retryAt: nonNegativeNumber(source.retryAt)
    };
  }

  function sanitizeSnapshot(value) {
    const source = value && typeof value === 'object' ? value : {};
    const taskConfig = taskModel.normalizeTaskConfig({
      groups: source.configuredGroups,
      targets: source.configuredTargets || source.configuredCourseNames || source.courseNames
    }, { intervalMs: source.interval });
    const configuredGroups = taskConfig.groups;
    const configuredTargets = taskConfig.targets;
    const targetStates = {};
    for (const target of configuredTargets) {
      targetStates[target.targetId] = sanitizeTargetState(
        target,
        source.targetStates?.[target.targetId] || source.targetStates?.[target.name]
      );
    }
    const requestedSuccessIds = new Set(Array.isArray(source.successTargetIds)
      ? source.successTargetIds.map(item => boundedText(item, 500))
      : []);
    const legacySuccessNames = new Set(Array.isArray(source.successTargets)
      ? source.successTargets.map(item => boundedText(item, 200))
      : []);
    const successful = configuredTargets.filter(target => {
      return targetStates[target.targetId].phase === 'SELECTED'
        || requestedSuccessIds.has(target.targetId)
        || legacySuccessNames.has(targetName(target));
    });
    const configuredCourseNames = configuredTargets.map(targetName);
    const successTargetIds = successful.map(target => target.targetId);
    const successfulIds = new Set(successTargetIds);
    const successTargets = successful.map(targetName);
    const groupStates = {};
    const completedGroupIds = [];
    for (const group of configuredGroups) {
      const selectedTargetIds = group.targets
        .filter(target => successfulIds.has(target.targetId))
        .map(target => target.targetId);
      const satisfied = selectedTargetIds.length >= group.requiredCount;
      if (satisfied) completedGroupIds.push(group.groupId);
      groupStates[group.groupId] = {
        groupId: group.groupId,
        label: group.label,
        requiredCount: group.requiredCount,
        selectedCount: selectedTargetIds.length,
        satisfied,
        selectedTargetIds,
        remainingTargetIds: satisfied ? [] : group.targets
          .filter(target => !successfulIds.has(target.targetId))
          .filter(target => !['SKIPPED', 'BLOCKED'].includes(targetStates[target.targetId].phase))
          .map(target => target.targetId)
      };
    }
    const satisfiedGroups = new Set(completedGroupIds);
    const groupByTarget = new Map(configuredGroups.flatMap(group => {
      return group.targets.map(target => [target.targetId, group.groupId]);
    }));
    const remainingTargets = configuredTargets
      .filter(target => !successfulIds.has(target.targetId))
      .filter(target => !satisfiedGroups.has(groupByTarget.get(target.targetId)))
      .filter(target => !['SKIPPED', 'BLOCKED'].includes(targetStates[target.targetId].phase));
    const interval = Math.min(600000, Math.max(1000, Number(source.interval) || 5000));
    return {
      running: Boolean(source.running && configuredTargets.length > 0),
      phase: boundedText(source.phase || 'STOPPED', 80),
      configuredGroups,
      configuredTargets,
      remainingTargets,
      configuredCourseNames,
      remainingCourseNames: remainingTargets.map(targetName),
      courseNames: configuredCourseNames,
      initialTargetCount: configuredTargets.length,
      totalGroups: configuredGroups.length,
      completedGroups: completedGroupIds.length,
      completedGroupIds,
      interval,
      round: Math.floor(nonNegativeNumber(source.round)),
      inFlight: Boolean(source.inFlight),
      nextRunAt: nonNegativeNumber(source.nextRunAt),
      lastRoundDurationMs: nonNegativeNumber(source.lastRoundDurationMs),
      globalRetryAt: nonNegativeNumber(source.globalRetryAt),
      nextRetryAt: nonNegativeNumber(source.nextRetryAt),
      retryingTargetCount: Math.floor(nonNegativeNumber(source.retryingTargetCount)),
      scanFailures: Math.floor(nonNegativeNumber(source.scanFailures)),
      lastTransientOutcome: source.lastTransientOutcome
        ? boundedText(source.lastTransientOutcome, 80)
        : null,
      structureFailures: Math.min(5, Math.floor(nonNegativeNumber(source.structureFailures))),
      structureFailureSignature: source.structureFailureSignature
        ? boundedText(source.structureFailureSignature, 380)
        : null,
      lastScan: sanitizeLastScan(source.lastScan),
      authRecovery: sanitizeAuthRecovery(source.authRecovery),
      successTargetIds,
      successTargets,
      successCourses: successTargets,
      skippedTargetIds: configuredTargets
        .filter(target => targetStates[target.targetId].phase === 'SKIPPED')
        .map(target => target.targetId),
      groupStates,
      targetStates,
      log: (Array.isArray(source.log) ? source.log : [])
        .slice(-20)
        .map(entry => boundedText(entry, 500))
        .filter(Boolean)
    };
  }

  function createGrabTaskSessionStore(deps) {
    if (typeof deps?.readState !== 'function' || typeof deps?.writeState !== 'function') {
      throw new TypeError('Grab task session store requires readState() and writeState()');
    }
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    let operationQueue = Promise.resolve();

    function enqueue(operation) {
      const result = operationQueue.then(operation, operation);
      operationQueue = result.catch(() => {});
      return result;
    }

    function save(update, ownerTabId, options = {}) {
      return enqueue(async () => {
        const tabId = Number(ownerTabId);
        const taskId = boundedText(update?.taskId, 120);
        const revision = Math.floor(nonNegativeNumber(update?.revision));
        if (!Number.isInteger(tabId) || tabId < 0 || !taskId) return null;

        const current = await deps.readState();
        const ownerChanged = current && current.ownerTabId !== tabId;
        if (ownerChanged && options.claim !== true) return current;
        if (current?.ownerTabId === tabId && current.taskId === taskId && current.revision > revision) return current;

        const stored = {
          schemaVersion: SCHEMA_VERSION,
          taskId,
          revision,
          ownerTabId: tabId,
          updatedAt: now(),
          snapshot: sanitizeSnapshot(update?.snapshot)
        };
        await deps.writeState(stored);
        if (ownerChanged && options.claim === true && typeof deps.revokeOwner === 'function') {
          try {
            await deps.revokeOwner(current.ownerTabId, current.taskId);
          } catch {
            // A closed or reloading old tab already has no active executor to revoke.
          }
        }
        return stored;
      });
    }

    function read(ownerTabId) {
      return enqueue(async () => {
        const tabId = Number(ownerTabId);
        const current = await deps.readState();
        if (!current || ![LEGACY_SCHEMA_VERSION, SCHEMA_VERSION].includes(current.schemaVersion)
          || current.ownerTabId !== tabId) return null;
        if (current.schemaVersion === SCHEMA_VERSION) return current;
        return {
          ...current,
          schemaVersion: SCHEMA_VERSION,
          snapshot: sanitizeSnapshot(current.snapshot)
        };
      });
    }

    return Object.freeze({ save, read });
  }

  const exported = Object.freeze({
    STATE_KEY,
    SCHEMA_VERSION,
    ACTION_SAVE,
    ACTION_GET,
    sanitizeSnapshot,
    createGrabTaskSessionStore
  });
  global.NjuGrabTaskSession = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;

  if (!global.chrome?.runtime?.onMessage || !global.chrome?.storage?.session) return;
  const store = createGrabTaskSessionStore({
    readState: async () => (await global.chrome.storage.session.get(STATE_KEY))[STATE_KEY],
    writeState: state => global.chrome.storage.session.set({ [STATE_KEY]: state }),
    revokeOwner: (tabId, taskId) => {
      if (!global.chrome.tabs?.sendMessage) return undefined;
      return new Promise(resolve => {
        try {
          global.chrome.tabs.sendMessage(tabId, {
            action: 'grabTaskLeaseRevoked',
            taskId
          }, () => {
            void global.chrome.runtime.lastError;
            resolve();
          });
        } catch {
          resolve();
        }
      });
    },
    now: () => Date.now()
  });

  function trustedCoursePageSender(sender) {
    try {
      return Number.isInteger(sender?.tab?.id)
        && new URL(sender.url).origin === 'https://xk.nju.edu.cn';
    } catch {
      return false;
    }
  }

  global.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action !== ACTION_SAVE && message?.action !== ACTION_GET) return undefined;
    if (!trustedCoursePageSender(sender)) {
      sendResponse({ ok: false, error: '仅选课页面可访问抢课会话状态' });
      return undefined;
    }

    const pending = message.action === ACTION_SAVE
      ? store.save(message, sender.tab.id, { claim: message.claim === true })
      : store.read(sender.tab.id);
    pending
      .then(runtime => sendResponse({ ok: true, runtime }))
      .catch(error => sendResponse({ ok: false, error: error?.message || '抢课会话状态读写失败' }));
    return true;
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
