(function initNjuGrabEngine(global) {
  'use strict';

  const taskModel = global.NjuGrabTaskModel
    || (typeof require === 'function' ? require('./grab-task-model.js') : null);

  const TARGET_PHASE = Object.freeze({
    WATCHING: 'WATCHING',
    READY: 'READY',
    SUBMITTING: 'SUBMITTING',
    VERIFYING: 'VERIFYING',
    RETRY: 'RETRY',
    SELECTED: 'SELECTED',
    SKIPPED: 'SKIPPED',
    BLOCKED: 'BLOCKED'
  });

  const CANDIDATE_STATUS = Object.freeze({
    SELECTED: 'SELECTED',
    AVAILABLE: 'AVAILABLE',
    FULL: 'FULL',
    DEFERRED: 'DEFERRED',
    UNAVAILABLE: 'UNAVAILABLE'
  });

  const OUTCOME = Object.freeze({
    SUCCESS: 'SUCCESS',
    FULL: 'FULL',
    CONFLICT: 'CONFLICT',
    DUPLICATE: 'DUPLICATE',
    CREDIT_LIMIT: 'CREDIT_LIMIT',
    COURSE_LIMIT: 'COURSE_LIMIT',
    PREREQUISITE_FAILED: 'PREREQUISITE_FAILED',
    CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
    AUTH_EXPIRED: 'AUTH_EXPIRED',
    RATE_LIMITED: 'RATE_LIMITED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    SERVER_ERROR: 'SERVER_ERROR',
    REJECTED: 'REJECTED',
    GROUP_SATISFIED: 'GROUP_SATISFIED',
    UNKNOWN_COMMIT: 'UNKNOWN_COMMIT',
    UNKNOWN: 'UNKNOWN'
  });

  const TRY_NEXT_CANDIDATE = new Set([
    OUTCOME.FULL,
    OUTCOME.CONFLICT,
    OUTCOME.REJECTED
  ]);
  const BLOCKING_OUTCOMES = new Set([
    OUTCOME.CREDIT_LIMIT,
    OUTCOME.COURSE_LIMIT,
    OUTCOME.PREREQUISITE_FAILED,
    OUTCOME.CAPTCHA_REQUIRED
  ]);
  const VERIFY_FIRST_OUTCOMES = new Set([
    OUTCOME.DUPLICATE,
    OUTCOME.UNKNOWN_COMMIT
  ]);
  const TRANSIENT_OUTCOMES = new Set([
    OUTCOME.NETWORK_ERROR,
    OUTCOME.SERVER_ERROR,
    OUTCOME.RATE_LIMITED
  ]);
  const SCAN_MODES = new Set([
    'NETWORK',
    'NETWORK_WITH_DOM',
    'DOM_FALLBACK',
    'ERROR'
  ]);
  const SCAN_FALLBACK_REASONS = new Set([
    'NATIVE_QUERY_UNAVAILABLE',
    'NATIVE_QUERY_UNSUPPORTED'
  ]);

  function normalizeScanDiagnostics(value, defaults = {}) {
    const source = value && typeof value === 'object' ? value : null;
    const mode = source?.mode || defaults.mode;
    if (!SCAN_MODES.has(mode)) return null;
    const nonNegativeInteger = input => Math.floor(Math.max(0, Number(input) || 0));
    const fallbackReason = source?.fallbackReason || defaults.fallbackReason;
    const outcome = source?.outcome || defaults.outcome;
    const shadowSource = source?.shadowComparison;
    const shadowComparison = shadowSource && typeof shadowSource === 'object'
      ? {
          comparisonCount: nonNegativeInteger(shadowSource.comparisonCount),
          mismatchedComparisonCount: nonNegativeInteger(shadowSource.mismatchedComparisonCount),
          networkOnlyCandidateCount: nonNegativeInteger(shadowSource.networkOnlyCandidateCount),
          domOnlyCandidateCount: nonNegativeInteger(shadowSource.domOnlyCandidateCount),
          statusMismatchCount: nonNegativeInteger(shadowSource.statusMismatchCount),
          unidentifiableCandidateCount: nonNegativeInteger(shadowSource.unidentifiableCandidateCount)
        }
      : null;
    const scopeDeferredTargetCount = nonNegativeInteger(source?.scopeDeferredTargetCount);
    return {
      mode,
      round: nonNegativeInteger(defaults.round ?? source?.round),
      completedAt: Math.max(0, Number(defaults.completedAt ?? source?.completedAt) || 0),
      durationMs: Math.max(0, Number(defaults.durationMs ?? source?.durationMs) || 0),
      queriedTargetCount: nonNegativeInteger(source?.queriedTargetCount),
      deferredTargetCount: nonNegativeInteger(source?.deferredTargetCount),
      ...(scopeDeferredTargetCount > 0 ? { scopeDeferredTargetCount } : {}),
      materializedQueryCount: nonNegativeInteger(source?.materializedQueryCount),
      candidateCount: nonNegativeInteger(source?.candidateCount),
      fallbackReason: SCAN_FALLBACK_REASONS.has(fallbackReason) ? fallbackReason : null,
      outcome: Object.values(OUTCOME).includes(outcome) ? outcome : null,
      ...(shadowComparison?.comparisonCount > 0 ? { shadowComparison } : {})
    };
  }

  function accumulateShadowComparison(previousDiagnostics, currentDiagnostics) {
    if (!currentDiagnostics) return currentDiagnostics;
    const previous = previousDiagnostics?.shadowComparison;
    const current = currentDiagnostics.shadowComparison;
    if (!previous && !current) return currentDiagnostics;
    const count = (value, key) => Math.floor(Math.max(0, Number(value?.[key]) || 0));
    const keys = [
      'comparisonCount',
      'mismatchedComparisonCount',
      'networkOnlyCandidateCount',
      'domOnlyCandidateCount',
      'statusMismatchCount',
      'unidentifiableCandidateCount'
    ];
    currentDiagnostics.shadowComparison = Object.fromEntries(keys.map(key => [
      key,
      count(previous, key) + count(current, key)
    ]));
    return currentDiagnostics;
  }

  function normalizeTargets(values) {
    if (taskModel) return taskModel.normalizeTargets(values);
    return (Array.isArray(values) ? values : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .map(name => ({ targetId: `keyword:${name}`, kind: 'KEYWORD', name }));
  }

  function normalizeTask(value, intervalMs) {
    if (taskModel) {
      const source = Array.isArray(value) ? { targets: value } : value;
      return taskModel.normalizeTaskConfig(source, { intervalMs });
    }
    const targets = normalizeTargets(Array.isArray(value) ? value : value?.targets);
    return {
      intervalMs: Math.max(1000, Number(intervalMs) || 3000),
      targets,
      groups: targets.map(target => ({
        groupId: `group:${target.targetId}`,
        label: target.name,
        requiredCount: 1,
        targets: [target]
      }))
    };
  }

  function targetName(target) {
    return taskModel?.targetLabel(target) || target?.name || target?.targetId || '';
  }

  function abortError() {
    const error = new Error('Grab run aborted');
    error.name = 'AbortError';
    return error;
  }

  function isAbortError(error) {
    return error?.name === 'AbortError';
  }

  function createTargetState(target) {
    return {
      targetId: target.targetId,
      phase: TARGET_PHASE.WATCHING,
      lastOutcome: null,
      lastMessage: '',
      candidateId: null,
      conflictingCandidateIds: [],
      attempts: 0,
      uncertainUntil: 0,
      transientFailures: 0,
      retryAt: 0
    };
  }

  function createIdleSnapshot() {
    return {
      runId: 0,
      running: false,
      phase: 'STOPPED',
      configuredGroups: [],
      configuredTargets: [],
      remainingTargets: [],
      configuredCourseNames: [],
      remainingCourseNames: [],
      courseNames: [],
      initialTargetCount: 0,
      totalGroups: 0,
      completedGroups: 0,
      completedGroupIds: [],
      interval: 3000,
      round: 0,
      inFlight: false,
      nextRunAt: 0,
      lastRoundDurationMs: 0,
      globalRetryAt: 0,
      nextRetryAt: 0,
      retryingTargetCount: 0,
      scanFailures: 0,
      lastTransientOutcome: null,
      lastScan: null,
      successTargetIds: [],
      successTargets: [],
      successCourses: [],
      skippedTargetIds: [],
      groupStates: {},
      targetStates: {},
      log: []
    };
  }

  function createGrabEngine(deps) {
    if (!deps?.adapter || typeof deps.adapter.scan !== 'function' || typeof deps.adapter.attempt !== 'function') {
      throw new TypeError('GrabEngine requires an adapter with scan() and attempt()');
    }

    const adapter = deps.adapter;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : (fn, delay) => setTimeout(fn, delay);
    const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : timer => clearTimeout(timer);
    const onState = typeof deps.onState === 'function' ? deps.onState : () => {};
    const onLog = typeof deps.onLog === 'function' ? deps.onLog : () => {};
    const onStopped = typeof deps.onStopped === 'function' ? deps.onStopped : () => {};
    const minimumRestMs = Math.max(0, Number(deps.minimumRestMs ?? 100));
    const uncertainCommitMs = Math.max(1000, Number(deps.uncertainCommitMs ?? 10000));
    const random = typeof deps.random === 'function' ? deps.random : Math.random;
    const transientBackoffBaseMs = Math.max(1000, Number(deps.transientBackoffBaseMs ?? 2000));
    const rateLimitBackoffBaseMs = Math.max(5000, Number(deps.rateLimitBackoffBaseMs ?? 10000));
    const maxBackoffMs = Math.max(rateLimitBackoffBaseMs, Number(deps.maxBackoffMs ?? 120000));
    const maxLogEntries = Math.max(10, Number(deps.maxLogEntries ?? 50));
    let sequence = 0;
    let activeRun = null;
    let lastSnapshot = createIdleSnapshot();

    function isCurrent(run) {
      return activeRun === run && !run.controller.signal.aborted;
    }

    function isCurrentRunning(run) {
      return isCurrent(run) && run.state.running;
    }

    function groupSelectedTargets(run, group) {
      return group.targets.filter(target => run.targets.get(target.targetId)?.phase === TARGET_PHASE.SELECTED);
    }

    function isGroupSatisfied(run, group) {
      return groupSelectedTargets(run, group).length >= group.requiredCount;
    }

    function groupForTarget(run, targetId) {
      return run.groupByTarget.get(targetId) || null;
    }

    function isTargetActionable(run, target) {
      const group = groupForTarget(run, target.targetId);
      const state = run.targets.get(target.targetId);
      if (!group || !state || isGroupSatisfied(run, group)) return false;
      return ![TARGET_PHASE.SELECTED, TARGET_PHASE.SKIPPED, TARGET_PHASE.BLOCKED].includes(state.phase);
    }

    function snapshot(run = activeRun) {
      if (!run) return { ...lastSnapshot };
      const currentTime = now();
      const groups = run.state.configuredGroups.slice();
      const targets = run.state.configuredTargets.slice();
      const success = targets.filter(target => run.targets.get(target.targetId)?.phase === TARGET_PHASE.SELECTED);
      const skipped = targets.filter(target => run.targets.get(target.targetId)?.phase === TARGET_PHASE.SKIPPED);
      const remaining = targets.filter(target => isTargetActionable(run, target));
      const configuredCourseNames = targets.map(targetName);
      const successTargets = success.map(targetName);
      const remainingCourseNames = remaining.map(targetName);
      const targetStates = {};
      for (const target of targets) {
        const state = run.targets.get(target.targetId);
        targetStates[target.targetId] = {
          ...state,
          conflictingCandidateIds: state.conflictingCandidateIds.slice()
        };
      }
      const groupStates = {};
      const completedGroupIds = [];
      for (const group of groups) {
        const selectedTargets = groupSelectedTargets(run, group);
        const satisfied = selectedTargets.length >= group.requiredCount;
        if (satisfied) completedGroupIds.push(group.groupId);
        groupStates[group.groupId] = {
          groupId: group.groupId,
          label: group.label,
          requiredCount: group.requiredCount,
          selectedCount: selectedTargets.length,
          satisfied,
          selectedTargetIds: selectedTargets.map(target => target.targetId),
          remainingTargetIds: group.targets
            .filter(target => isTargetActionable(run, target))
            .map(target => target.targetId)
        };
      }
      const retryTimes = [...run.targets.values()]
        .filter(state => state.phase === TARGET_PHASE.RETRY && state.retryAt > currentTime)
        .map(state => state.retryAt);
      if (run.state.globalRetryAt > currentTime) retryTimes.push(run.state.globalRetryAt);
      return {
        runId: run.id,
        running: run.state.running,
        phase: run.state.phase,
        configuredGroups: groups,
        configuredTargets: targets,
        remainingTargets: remaining,
        configuredCourseNames,
        remainingCourseNames,
        // Kept for older Popup versions. It is intentionally the immutable configured list.
        courseNames: configuredCourseNames,
        initialTargetCount: targets.length,
        totalGroups: groups.length,
        completedGroups: completedGroupIds.length,
        completedGroupIds,
        interval: run.state.interval,
        round: run.state.round,
        inFlight: run.state.inFlight,
        nextRunAt: run.state.nextRunAt,
        lastRoundDurationMs: run.state.lastRoundDurationMs,
        globalRetryAt: run.state.globalRetryAt,
        nextRetryAt: retryTimes.length > 0 ? Math.min(...retryTimes) : 0,
        retryingTargetCount: [...run.targets.values()]
          .filter(state => state.phase === TARGET_PHASE.RETRY && state.retryAt > currentTime).length,
        scanFailures: run.state.scanFailures,
        lastTransientOutcome: run.state.lastTransientOutcome,
        lastScan: run.state.lastScan ? { ...run.state.lastScan } : null,
        successTargetIds: success.map(target => target.targetId),
        successTargets,
        successCourses: successTargets,
        skippedTargetIds: skipped.map(target => target.targetId),
        groupStates,
        targetStates,
        log: run.state.log.slice(-20)
      };
    }

    function publish(run) {
      if (activeRun !== run) return;
      lastSnapshot = snapshot(run);
      onState(lastSnapshot);
    }

    function formatLogTime(timestamp) {
      if (typeof deps.formatLogTime === 'function') return deps.formatLogTime(timestamp);
      return new Date(timestamp).toLocaleTimeString();
    }

    function log(run, message) {
      if (activeRun !== run) return;
      const entry = `[${formatLogTime(now())}] ${message}`;
      run.state.log.push(entry);
      if (run.state.log.length > maxLogEntries) run.state.log.shift();
      publish(run);
      onLog(entry, snapshot(run));
    }

    function clearTargetRetry(state, { resetFailures = true } = {}) {
      state.retryAt = 0;
      if (state.phase === TARGET_PHASE.RETRY) state.phase = TARGET_PHASE.WATCHING;
      if (resetFailures) state.transientFailures = 0;
    }

    function calculateBackoffDelay(run, outcome, failures) {
      const base = Math.max(
        run.state.interval,
        outcome === OUTCOME.RATE_LIMITED ? rateLimitBackoffBaseMs : transientBackoffBaseMs
      );
      const exponential = Math.min(maxBackoffMs, base * (2 ** Math.min(6, Math.max(0, failures - 1))));
      const randomValue = Number(random());
      const normalizedRandom = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0.5;
      const jittered = Math.round(exponential * (0.9 + normalizedRandom * 0.2));
      return Math.max(minimumRestMs, Math.min(maxBackoffMs, jittered));
    }

    function clampRestoredRetryAt(value) {
      const currentTime = now();
      const retryAt = Number(value);
      if (!Number.isFinite(retryAt) || retryAt <= currentTime) return 0;
      return Math.min(retryAt, currentTime + maxBackoffMs);
    }

    function setTargetRetry(run, target, state, outcome, message) {
      state.phase = TARGET_PHASE.RETRY;
      state.transientFailures += 1;
      const delay = calculateBackoffDelay(run, outcome, state.transientFailures);
      state.retryAt = now() + delay;
      state.lastOutcome = outcome;
      state.lastMessage = message || '临时错误，等待自动重试';
      run.state.lastTransientOutcome = outcome;
      if (outcome === OUTCOME.RATE_LIMITED) {
        run.state.globalRetryAt = Math.max(run.state.globalRetryAt, state.retryAt);
      }
      log(run, `🛡️ "${targetName(target)}" 遇到临时错误（${outcome}），${Math.ceil(delay / 1000)} 秒后重试`);
    }

    function clearScheduledRound(run) {
      // In addition to clearing the platform timer, invalidate its callback.
      // This keeps a queued/late callback from starting a stale round in
      // environments where clearTimeout cannot cancel an already-dispatched
      // callback (and makes runNow safe under test and extension lifecycle
      // races).
      run.scheduleGeneration += 1;
      if (run.timer !== null) {
        clearTimer(run.timer);
        run.timer = null;
      }
      run.state.nextRunAt = 0;
    }

    function abortRun(run) {
      clearScheduledRound(run);
      if (!run.controller.signal.aborted) run.controller.abort();
      run.state.running = false;
      run.state.inFlight = false;
    }

    function stopActiveForRestart() {
      if (!activeRun) return;
      abortRun(activeRun);
      activeRun.state.phase = 'STOPPED';
      lastSnapshot = snapshot(activeRun);
    }

    function finish(run, phase, message) {
      if (activeRun !== run) return;
      clearScheduledRound(run);
      run.state.running = false;
      run.state.inFlight = false;
      run.state.phase = phase;
      if (message) log(run, message);
      publish(run);
      onStopped(snapshot(run));
    }

    function markSelected(run, target, candidate, message) {
      const state = run.targets.get(target.targetId);
      const group = groupForTarget(run, target.targetId);
      const groupWasSatisfied = group ? isGroupSatisfied(run, group) : false;
      state.phase = TARGET_PHASE.SELECTED;
      state.lastOutcome = OUTCOME.SUCCESS;
      state.lastMessage = message || '已确认选课结果';
      state.candidateId = candidate?.id || state.candidateId;
      state.uncertainUntil = 0;
      state.retryAt = 0;
      state.transientFailures = 0;
      if (group && !groupWasSatisfied && isGroupSatisfied(run, group)) {
        for (const sibling of group.targets) {
          if (sibling.targetId === target.targetId) continue;
          const siblingState = run.targets.get(sibling.targetId);
          if (!siblingState || [
            TARGET_PHASE.SELECTED,
            TARGET_PHASE.SUBMITTING,
            TARGET_PHASE.VERIFYING,
            TARGET_PHASE.BLOCKED
          ].includes(siblingState.phase)) continue;
          siblingState.phase = TARGET_PHASE.SKIPPED;
          siblingState.lastOutcome = OUTCOME.GROUP_SATISFIED;
          siblingState.lastMessage = `课程组“${group.label}”已满足要求数量`;
          siblingState.retryAt = 0;
          siblingState.transientFailures = 0;
        }
      }
      log(run, `✅ "${targetName(target)}" 已确认选课成功${candidate?.label ? `（${candidate.label}）` : ''}`);
      if (group && !groupWasSatisfied && isGroupSatisfied(run, group)) {
        log(run, `🏁 课程组“${group.label}”已满足 ${group.requiredCount} 项，停止尝试同组其他目标`);
      }
    }

    function candidateListFor(scanResult, target) {
      if (scanResult instanceof Map) {
        const value = scanResult.get(target.targetId) || scanResult.get(target.name);
        return Array.isArray(value) ? value : [];
      }
      const value = scanResult?.[target.targetId] || scanResult?.[target.name];
      return Array.isArray(value) ? value : [];
    }

    function normalizeAttemptResult(value) {
      const result = value && typeof value === 'object' ? value : {};
      const outcome = Object.values(OUTCOME).includes(result.outcome) ? result.outcome : OUTCOME.UNKNOWN;
      return {
        outcome,
        message: String(result.message || ''),
        retryOtherCandidate: typeof result.retryOtherCandidate === 'boolean'
          ? result.retryOtherCandidate
          : TRY_NEXT_CANDIDATE.has(outcome)
      };
    }

    function candidateIdentity(candidate) {
      return String(candidate?.id || candidate?.teachingClassId || candidate?.identity || '')
        .trim()
        .slice(0, 300);
    }

    function restoredCandidateIds(value) {
      if (!Array.isArray(value)) return [];
      return [...new Set(value
        .filter(candidateId => ['string', 'number'].includes(typeof candidateId))
        .map(candidateId => String(candidateId || '').trim().slice(0, 300))
        .filter(Boolean))]
        .slice(0, 50);
    }

    function restoredTargetState(target, savedValue) {
      const saved = savedValue && typeof savedValue === 'object' ? savedValue : {};
      const state = createTargetState(target);
      state.lastOutcome = saved.lastOutcome || null;
      state.lastMessage = String(saved.lastMessage || '');
      state.candidateId = saved.candidateId || null;
      state.conflictingCandidateIds = restoredCandidateIds(saved.conflictingCandidateIds);
      state.attempts = Math.max(0, Number(saved.attempts) || 0);
      state.transientFailures = Math.max(0, Number(saved.transientFailures) || 0);
      state.retryAt = clampRestoredRetryAt(saved.retryAt);

      if (saved.phase === TARGET_PHASE.RETRY && state.retryAt > now()) {
        state.phase = TARGET_PHASE.RETRY;
        state.lastMessage = saved.lastMessage || '临时错误，等待自动重试';
        return state;
      }
      if (saved.phase === TARGET_PHASE.RETRY) state.retryAt = 0;

      if (saved.phase === TARGET_PHASE.BLOCKED) {
        state.phase = TARGET_PHASE.BLOCKED;
        return state;
      }

      if ([TARGET_PHASE.READY, TARGET_PHASE.SUBMITTING, TARGET_PHASE.VERIFYING].includes(saved.phase)) {
        state.phase = TARGET_PHASE.VERIFYING;
        state.lastOutcome = saved.lastOutcome || OUTCOME.UNKNOWN_COMMIT;
        state.lastMessage = '页面重载发生在提交附近，先验证结果再决定是否重试';
        state.uncertainUntil = Math.max(
          Number(saved.uncertainUntil) || 0,
          now() + uncertainCommitMs
        );
        return state;
      }

      if (saved.phase === TARGET_PHASE.SELECTED) {
        state.lastMessage = '页面重载后将重新验证该教学班是否仍为已选';
        state.transientFailures = 0;
        state.retryAt = 0;
      }
      return state;
    }

    async function processTarget(run, target, candidates) {
      const state = run.targets.get(target.targetId);
      if (!state || [TARGET_PHASE.SELECTED, TARGET_PHASE.SKIPPED, TARGET_PHASE.BLOCKED].includes(state.phase)) return;
      const matchingCandidates = candidates.filter(candidate => {
        return !taskModel || taskModel.targetAcceptsCandidate(target, candidate);
      });

      const selectedCandidate = matchingCandidates.find(candidate => candidate?.status === CANDIDATE_STATUS.SELECTED);
      if (selectedCandidate) {
        markSelected(run, target, selectedCandidate, '已选列表中存在该教学班');
        return;
      }

      if (matchingCandidates.length > 0
        && matchingCandidates.every(candidate => candidate?.status === CANDIDATE_STATUS.DEFERRED)) {
        state.phase = TARGET_PHASE.WATCHING;
        if (state.lastOutcome === 'NOT_FOUND') state.lastOutcome = null;
        state.lastMessage = matchingCandidates.find(candidate => candidate?.label)?.label
          || '已纳入监控，等待下轮分批查询';
        return;
      }

      if (state.phase === TARGET_PHASE.RETRY && state.retryAt > now()) {
        state.lastMessage = '临时错误退避中，本轮只观察，不重复提交';
        publish(run);
        return;
      }
      if (state.phase === TARGET_PHASE.RETRY) clearTargetRetry(state, { resetFailures: false });

      if (state.phase === TARGET_PHASE.VERIFYING && now() < state.uncertainUntil) {
        state.lastMessage = '上次提交结果仍未确认，本轮只验证，不重复提交';
        publish(run);
        return;
      }

      if (state.phase === TARGET_PHASE.VERIFYING) {
        state.phase = TARGET_PHASE.WATCHING;
        state.uncertainUntil = 0;
      }

      if (matchingCandidates.length === 0) {
        clearTargetRetry(state);
        state.phase = TARGET_PHASE.WATCHING;
        state.lastOutcome = 'NOT_FOUND';
        state.lastMessage = '当前课程列表中未找到匹配项';
        return;
      }

      const conflictingCandidateIds = new Set(state.conflictingCandidateIds);
      const eligibleCandidates = matchingCandidates.filter(candidate => {
        const candidateId = candidateIdentity(candidate);
        return !candidateId || !conflictingCandidateIds.has(candidateId);
      });
      if (eligibleCandidates.length === 0 && conflictingCandidateIds.size > 0) {
        clearTargetRetry(state);
        state.phase = TARGET_PHASE.BLOCKED;
        state.lastOutcome = OUTCOME.CONFLICT;
        state.lastMessage = state.lastMessage || '所有候选教学班均存在课程冲突';
        log(run, `⛔ "${targetName(target)}" 的冲突教学班均已排除，本次任务不再重复提交`);
        return;
      }

      const available = eligibleCandidates.filter(candidate => candidate?.status === CANDIDATE_STATUS.AVAILABLE);
      if (available.length === 0) {
        clearTargetRetry(state);
        state.phase = TARGET_PHASE.WATCHING;
        state.lastOutcome = eligibleCandidates.some(candidate => candidate?.status === CANDIDATE_STATUS.FULL)
          ? OUTCOME.FULL
          : OUTCOME.UNKNOWN;
        state.lastMessage = state.lastOutcome === OUTCOME.FULL
          ? (conflictingCandidateIds.size > 0
              ? '已跳过冲突教学班，其他候选教学班当前无余量'
              : '所有候选教学班均无余量')
          : '没有可提交的候选教学班';
        return;
      }

      for (const candidate of available) {
        if (!isCurrentRunning(run)) throw abortError();
        state.phase = TARGET_PHASE.READY;
        state.candidateId = candidate.id || null;
        state.lastMessage = '发现可选教学班';
        publish(run);

        state.phase = TARGET_PHASE.SUBMITTING;
        state.attempts += 1;
        state.lastMessage = '正在提交并等待结果';
        log(run, `🖱️ "${targetName(target)}" 发现可选教学班${candidate.label ? `（${candidate.label}）` : ''}，正在尝试...`);

        let attempt;
        try {
          attempt = normalizeAttemptResult(await adapter.attempt(candidate, {
            target,
            targetId: target.targetId,
            runId: run.id,
            round: run.state.round,
            signal: run.controller.signal
          }));
        } catch (error) {
          if (isAbortError(error) || !isCurrentRunning(run)) throw abortError();
          attempt = {
            outcome: OUTCOME.NETWORK_ERROR,
            message: error?.message || '提交时发生异常',
            retryOtherCandidate: false
          };
        }

        if (!isCurrentRunning(run)) throw abortError();
        state.lastOutcome = attempt.outcome;
        state.lastMessage = attempt.message;

        if (attempt.outcome === OUTCOME.SUCCESS) {
          markSelected(run, target, candidate, attempt.message);
          return;
        }

        if (TRANSIENT_OUTCOMES.has(attempt.outcome)) {
          setTargetRetry(run, target, state, attempt.outcome, attempt.message);
          return;
        }

        clearTargetRetry(state);

        if (attempt.outcome === OUTCOME.AUTH_EXPIRED) {
          state.phase = TARGET_PHASE.WATCHING;
          run.state.phase = 'PAUSED_AUTH';
          finish(run, 'PAUSED_AUTH', `🔐 登录状态已失效，已暂停监控：${attempt.message || targetName(target)}`);
          return;
        }

        if (VERIFY_FIRST_OUTCOMES.has(attempt.outcome)) {
          state.phase = TARGET_PHASE.VERIFYING;
          state.uncertainUntil = now() + uncertainCommitMs;
          log(run, `⚠️ "${targetName(target)}" 提交结果尚未确认，后续只验证，暂不重复提交`);
          return;
        }

        if (BLOCKING_OUTCOMES.has(attempt.outcome)) {
          state.phase = TARGET_PHASE.BLOCKED;
          log(run, `⛔ "${targetName(target)}" 已停止尝试：${attempt.message || attempt.outcome}`);
          return;
        }

        if (attempt.outcome === OUTCOME.CONFLICT) {
          const conflictingCandidateId = candidateIdentity(candidate);
          if (!conflictingCandidateId) {
            state.phase = TARGET_PHASE.BLOCKED;
            log(run, `⛔ "${targetName(target)}" 的冲突教学班缺少稳定标识，已停止自动重试`);
            return;
          }
          if (!conflictingCandidateIds.has(conflictingCandidateId)) {
            conflictingCandidateIds.add(conflictingCandidateId);
            state.conflictingCandidateIds = [...conflictingCandidateIds].slice(0, 50);
          }
          log(run, `↪️ "${targetName(target)}" 已排除当前冲突教学班，继续检查其他候选班`);
          if (attempt.retryOtherCandidate) continue;
          break;
        }

        state.phase = TARGET_PHASE.WATCHING;
        if (!attempt.retryOtherCandidate) return;
        log(run, `↪️ "${targetName(target)}" 当前教学班未成功，继续尝试其他候选班`);
      }

      if (state.lastOutcome === OUTCOME.CONFLICT) {
        const remainingCandidates = matchingCandidates.filter(candidate => {
          const candidateId = candidateIdentity(candidate);
          return !candidateId || !conflictingCandidateIds.has(candidateId);
        });
        clearTargetRetry(state);
        if (remainingCandidates.length === 0) {
          state.phase = TARGET_PHASE.BLOCKED;
          log(run, `⛔ "${targetName(target)}" 的所有候选教学班均冲突，本次任务不再重复提交`);
          return;
        }
        state.phase = TARGET_PHASE.WATCHING;
        state.lastMessage = '已跳过冲突教学班，等待其他候选教学班出现余量';
      }
    }

    function activeTargetCount(run) {
      return run.state.configuredTargets.filter(target => isTargetActionable(run, target)).length;
    }

    function allGroupsSatisfied(run) {
      return run.state.configuredGroups.length > 0
        && run.state.configuredGroups.every(group => isGroupSatisfied(run, group));
    }

    function activeRetryScheduleAt(run, currentTime) {
      if (run.state.globalRetryAt > currentTime) return run.state.globalRetryAt;
      const activeStates = run.state.configuredTargets
        .filter(target => isTargetActionable(run, target))
        .map(target => run.targets.get(target.targetId));
      if (activeStates.length === 0) return 0;
      const retrying = activeStates.filter(state => {
        return state.phase === TARGET_PHASE.RETRY && state.retryAt > currentTime;
      });
      if (retrying.length !== activeStates.length) return 0;
      return Math.min(...retrying.map(state => state.retryAt));
    }

    function scheduleNextRound(run, roundStartedAt) {
      if (!isCurrentRunning(run)) return;
      const currentTime = now();
      const elapsed = Math.max(0, currentTime - roundStartedAt);
      run.state.lastRoundDurationMs = elapsed;
      const cadenceDelay = Math.max(minimumRestMs, run.state.interval - elapsed);
      const retryAt = activeRetryScheduleAt(run, currentTime);
      const nextRunAt = Math.max(currentTime + cadenceDelay, retryAt);
      const delay = Math.max(minimumRestMs, nextRunAt - currentTime);
      run.state.nextRunAt = currentTime + delay;
      const generation = ++run.scheduleGeneration;
      run.timer = setTimer(() => {
        if (run.scheduleGeneration !== generation || !isCurrentRunning(run)) return;
        run.timer = null;
        void runRound(run, { fromTimer: true });
      }, delay);
      publish(run);
    }

    function admissionFailure(run, code, message) {
      return { ok: false, code, message, snapshot: snapshot(run) };
    }

    function roundAdmission(run) {
      if (!run || !isCurrentRunning(run) || !run.state.running || run.state.phase === 'PAUSED_AUTH') {
        return admissionFailure(run, 'NOT_RUNNING', '监控未运行');
      }
      if (run.state.inFlight) {
        return admissionFailure(run, 'IN_FLIGHT', '正在检查课程，请稍候');
      }
      if (run.state.globalRetryAt > now()) {
        return admissionFailure(run, 'BACKOFF', '课程查询正在退避，请稍候');
      }
      const retryAt = activeRetryScheduleAt(run, now());
      if (retryAt > now()) {
        return admissionFailure(run, 'RETRY_PENDING', '所有目标都在等待重试，请稍候');
      }
      return null;
    }

    async function runRound(run, options = {}) {
      const blocked = roundAdmission(run);
      if (blocked) {
        // A timer can be dispatched a little early (or a backoff can be
        // extended while it is queued). Keep the task scheduled instead of
        // losing its cadence after the stale callback returns.
        if (options.fromTimer && isCurrentRunning(run)) scheduleNextRound(run, now());
        return blocked;
      }
      if (run.state.globalRetryAt <= now()) run.state.globalRetryAt = 0;
      const roundStartedAt = now();
      run.state.inFlight = true;
      run.state.nextRunAt = 0;
      run.state.round += 1;
      const remaining = snapshot(run).remainingTargets
        .map((target, index) => ({ target, index }))
        .sort((left, right) => {
          const priorityDifference = Number(right.target.priority || 0) - Number(left.target.priority || 0);
          return priorityDifference || left.index - right.index;
        })
        .map(item => item.target);
      log(run, `🔄 第 ${run.state.round} 轮检测中...（监控课程: ${remaining.map(targetName).join('、')}）`);

      try {
        const scanResult = await adapter.scan(remaining, {
          runId: run.id,
          round: run.state.round,
          signal: run.controller.signal
        });
        if (!isCurrentRunning(run)) throw abortError();
        run.state.lastScan = accumulateShadowComparison(run.state.lastScan, normalizeScanDiagnostics(scanResult?.diagnostics, {
          round: run.state.round,
          completedAt: now(),
          durationMs: Math.max(0, now() - roundStartedAt)
        }));
        run.state.scanFailures = 0;

        for (const target of remaining) {
          await processTarget(run, target, candidateListFor(scanResult, target));
          if (!isCurrentRunning(run) || run.state.globalRetryAt > now()) break;
        }

        if (!isCurrent(run)) return;
        if (!run.state.running) return;

        if (allGroupsSatisfied(run)) {
          finish(run, 'COMPLETED', '🎊 所有课程组均已满足要求，监控停止！');
          return;
        }
        if (activeTargetCount(run) === 0) {
          finish(run, 'FAILED', '⛔ 剩余目标均为不可恢复限制，监控停止');
          return;
        }

        const fullTargets = [];
        const missingTargets = [];
        for (const target of remaining) {
          const state = run.targets.get(target.targetId);
          if (state?.lastOutcome === OUTCOME.FULL) fullTargets.push(targetName(target));
          if (state?.lastOutcome === 'NOT_FOUND') missingTargets.push(targetName(target));
        }
        if (fullTargets.length) log(run, `⏳ 以下课程当前无余量，继续监控: ${fullTargets.join('、')}`);
        if (missingTargets.length) log(run, `🔍 当前页面未找到以下课程: ${missingTargets.join('、')}`);
      } catch (error) {
        if (!isAbortError(error) && isCurrentRunning(run)) {
          const outcome = Object.values(OUTCOME).includes(error?.outcome) ? error.outcome : null;
          run.state.lastScan = accumulateShadowComparison(run.state.lastScan, normalizeScanDiagnostics({
            mode: 'ERROR',
            queriedTargetCount: remaining.length,
            outcome: outcome || OUTCOME.UNKNOWN
          }, {
            round: run.state.round,
            completedAt: now(),
            durationMs: Math.max(0, now() - roundStartedAt)
          }));
          if (outcome === OUTCOME.AUTH_EXPIRED) {
            finish(run, 'PAUSED_AUTH', `🔐 登录状态已失效，已暂停监控：${error?.message || '课程查询需要重新登录'}`);
          } else if (TRANSIENT_OUTCOMES.has(outcome)) {
            run.state.scanFailures += 1;
            const delay = calculateBackoffDelay(run, outcome, run.state.scanFailures);
            run.state.globalRetryAt = now() + delay;
            run.state.lastTransientOutcome = outcome;
            log(run, `🛡️ 课程查询遇到临时错误（${outcome}），${Math.ceil(delay / 1000)} 秒后恢复`);
          } else {
            log(run, `❌ 本轮检测出错: ${error?.message || String(error)}`);
          }
        }
      } finally {
        if (activeRun === run) {
          run.state.inFlight = false;
          publish(run);
        }
      }

      scheduleNextRound(run, roundStartedAt);
    }

    function start(taskValue, intervalMs, resumeSnapshot = null) {
      stopActiveForRestart();
      const task = normalizeTask(taskValue, intervalMs);
      const groups = task.groups;
      const targets = task.targets;
      const interval = Math.max(1000, Number(task.intervalMs) || 3000);
      const restoredStates = resumeSnapshot?.targetStates && typeof resumeSnapshot.targetStates === 'object'
        ? resumeSnapshot.targetStates
        : {};
      const restoredLog = Array.isArray(resumeSnapshot?.log)
        ? resumeSnapshot.log.slice(-maxLogEntries).map(entry => String(entry))
        : [];
      const run = {
        id: ++sequence,
        controller: new AbortController(),
        timer: null,
        scheduleGeneration: 0,
        groupByTarget: new Map(groups.flatMap(group => {
          return group.targets.map(target => [target.targetId, group]);
        })),
        targets: new Map(targets.map(target => [
          target.targetId,
          resumeSnapshot
            ? restoredTargetState(target, restoredStates[target.targetId] || restoredStates[target.name])
            : createTargetState(target)
        ])),
        state: {
          running: targets.length > 0,
          phase: targets.length > 0 ? 'RUNNING' : 'STOPPED',
          configuredGroups: groups,
          configuredTargets: targets,
          interval,
          round: resumeSnapshot ? Math.max(0, Number(resumeSnapshot.round) || 0) : 0,
          inFlight: false,
          nextRunAt: 0,
          lastRoundDurationMs: 0,
          globalRetryAt: resumeSnapshot ? clampRestoredRetryAt(resumeSnapshot.globalRetryAt) : 0,
          scanFailures: resumeSnapshot ? Math.max(0, Number(resumeSnapshot.scanFailures) || 0) : 0,
          lastTransientOutcome: resumeSnapshot?.lastTransientOutcome || null,
          lastScan: normalizeScanDiagnostics(resumeSnapshot?.lastScan),
          log: restoredLog
        }
      };
      activeRun = run;
      publish(run);

      if (targets.length === 0) {
        log(run, '⚠️ 没有有效的目标课程，未启动监控');
        return snapshot(run);
      }

      const restoredRetryAt = resumeSnapshot ? activeRetryScheduleAt(run, now()) : 0;
      if (restoredRetryAt > now()) {
        log(run, `♻️ 已恢复监控，共 ${groups.length} 个课程组、${targets.length} 个目标，保留临时错误退避状态`);
        scheduleNextRound(run, now());
      } else {
        log(run, resumeSnapshot
          ? `♻️ 已恢复监控，共 ${groups.length} 个课程组、${targets.length} 个目标，正在重新验证页面状态`
          : `🚀 开始监控，共 ${groups.length} 个课程组、${targets.length} 个目标，目标周期 ${interval / 1000}s`);
        void runRound(run);
      }
      return snapshot(run);
    }

    function restore(savedSnapshot) {
      const source = savedSnapshot && typeof savedSnapshot === 'object' ? savedSnapshot : {};
      return start(
        {
          groups: source.configuredGroups,
          targets: source.configuredTargets || source.configuredCourseNames || source.courseNames || []
        },
        source.interval,
        source
      );
    }

    function stop(reason = 'manual') {
      const run = activeRun;
      if (!run || !run.state.running) return snapshot(run);
      abortRun(run);
      run.state.phase = 'STOPPED';
      const message = reason === 'manual' ? '⏹️ 监控已停止' : `⏹️ 监控已停止（${reason}）`;
      log(run, message);
      publish(run);
      onStopped(snapshot(run));
      return snapshot(run);
    }

    function runNow() {
      const run = activeRun;
      const blocked = roundAdmission(run);
      if (blocked) return blocked;
      clearScheduledRound(run);
      void runRound(run);
      return { ok: true, code: 'STARTED', message: '已立即检查' };
    }

    const engine = Object.freeze({
      start,
      restore,
      stop,
      runNow,
      requestRunNow: runNow,
      getSnapshot: () => snapshot(activeRun)
    });
    return engine;
  }

  const exported = Object.freeze({
    TARGET_PHASE,
    CANDIDATE_STATUS,
    OUTCOME,
    createGrabEngine
  });

  global.NjuGrabEngine = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : window);
