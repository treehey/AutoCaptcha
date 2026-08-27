(function initNjuGrabCourseProvider(global) {
  'use strict';

  const QUERY_EVENT = 'nju-autograb-course-query-v1';
  const RESULT_EVENT = 'nju-autograb-course-result-v1';
  // Keep a hard safety bound, while allowing a normal multi-course task to be
  // observed completely in one engine round. The bridge replays and paces these
  // queries sequentially to avoid a short request burst.
  const DEFAULT_MAX_SEARCHES = 12;
  const DEFAULT_MAX_MATERIALIZATIONS = 2;
  const SCAN_MODE = Object.freeze({
    NETWORK: 'NETWORK',
    NETWORK_WITH_DOM: 'NETWORK_WITH_DOM',
    DOM_FALLBACK: 'DOM_FALLBACK'
  });
  const QUERY_SCOPE_LABELS = Object.freeze({
    ZY: '专业',
    GG: '公共',
    GG01: '公选课',
    GG02: '导学/研讨/通识',
    KZY: '跨专业',
    TX: '通修',
    TY: '体育',
    YD: '悦读',
    SC: '收藏',
    QB: '课表查询'
  });
  const LEGACY_QUERY_SCOPE_ALIASES = Object.freeze({
    TCT1: 'ZY',
    TCT2: 'KZY',
    TCT3: 'GG01',
    TCT4: 'GG02',
    TCT5: 'TY'
  });

  function normalizeQueryScope(scope) {
    const normalized = String(scope || '').trim().toUpperCase();
    return LEGACY_QUERY_SCOPE_ALIASES[normalized] || normalized;
  }

  function abortError() {
    const error = new Error('Course query aborted');
    error.name = 'AbortError';
    return error;
  }

  function queryError(message, outcome = 'NETWORK_ERROR') {
    const error = new Error(message || '课程查询失败');
    error.outcome = outcome;
    return error;
  }

  function shortHash(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeShadowComparison(value) {
    if (!value || typeof value !== 'object') return null;
    const count = input => Math.floor(Math.max(0, Number(input) || 0));
    const comparison = {
      comparisonCount: count(value.comparisonCount),
      mismatchedComparisonCount: count(value.mismatchedComparisonCount),
      networkOnlyCandidateCount: count(value.networkOnlyCandidateCount),
      domOnlyCandidateCount: count(value.domOnlyCandidateCount),
      statusMismatchCount: count(value.statusMismatchCount),
      unidentifiableCandidateCount: count(value.unidentifiableCandidateCount)
    };
    return comparison.comparisonCount > 0 ? Object.freeze(comparison) : null;
  }

  function attachDiagnostics(result, value) {
    if (!result || typeof result !== 'object') return result;
    const shadowComparison = normalizeShadowComparison(value.shadowComparison);
    const scopeDeferredTargetCount = Math.max(0, Number(value.scopeDeferredTargetCount) || 0);
    const diagnostics = Object.freeze({
      mode: value.mode,
      queriedTargetCount: Math.max(0, Number(value.queriedTargetCount) || 0),
      deferredTargetCount: Math.max(0, Number(value.deferredTargetCount) || 0),
      materializedQueryCount: Math.max(0, Number(value.materializedQueryCount) || 0),
      candidateCount: Math.max(0, Number(value.candidateCount) || 0),
      fallbackReason: value.fallbackReason || null,
      ...(scopeDeferredTargetCount > 0 ? { scopeDeferredTargetCount } : {}),
      ...(shadowComparison ? { shadowComparison } : {})
    });
    Object.defineProperty(result, 'diagnostics', {
      configurable: true,
      enumerable: false,
      value: diagnostics
    });
    return result;
  }

  function createNetworkQueryClient(options = {}) {
    const eventTarget = options.document || global.document;
    const timeoutBaseMs = Math.max(1000, Number(options.timeoutBaseMs) || 2500);
    let sequence = 0;

    if (!eventTarget?.addEventListener || !eventTarget?.dispatchEvent) {
      throw new TypeError('Course query client requires a document-like event target');
    }

    async function query(searches, context = {}) {
      const signal = context.signal;
      if (signal?.aborted) throw abortError();
      const requestId = `provider-${Date.now()}-${++sequence}`;
      const safeSearches = (Array.isArray(searches) ? searches : [])
        .slice(0, DEFAULT_MAX_SEARCHES)
        .map((search, index) => ({
          searchId: String(search?.searchId || index).slice(0, 300),
          query: String(search?.query || '').trim().slice(0, 300),
          queryScope: String(search?.queryScope || '').trim().slice(0, 80),
          teachingClassType: String(search?.teachingClassType || '').trim().slice(0, 80)
        })).filter(search => search.query);
      if (safeSearches.length === 0) return [];

      const timeoutMs = timeoutBaseMs + safeSearches.length * 1800;
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          eventTarget.removeEventListener(RESULT_EVENT, onResult);
          signal?.removeEventListener('abort', onAbort);
        };
        const finish = callback => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const cancelMainWorldQuery = () => {
          eventTarget.dispatchEvent(new CustomEvent(QUERY_EVENT, {
            detail: JSON.stringify({ action: 'cancel', requestId })
          }));
        };
        const onAbort = () => finish(() => {
          cancelMainWorldQuery();
          reject(abortError());
        });
        const onResult = event => {
          let detail = null;
          try {
            detail = JSON.parse(String(event.detail || ''));
          } catch {
            return;
          }
          if (detail?.requestId !== requestId) return;
          finish(() => {
            if (!detail.ok) {
              reject(queryError(detail.message, detail.outcome || 'NETWORK_ERROR'));
              return;
            }
            resolve(Array.isArray(detail.results) ? detail.results : []);
          });
        };

        eventTarget.addEventListener(RESULT_EVENT, onResult);
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(() => {
          cancelMainWorldQuery();
          reject(queryError('课程接口查询超时'));
        }), timeoutMs);
        eventTarget.dispatchEvent(new CustomEvent(QUERY_EVENT, {
          detail: JSON.stringify({ action: 'query', requestId, searches: safeSearches })
        }));
      });
    }

    return Object.freeze({ query });
  }

  function createCourseProvider(options = {}) {
    const taskModel = options.taskModel || global.NjuGrabTaskModel;
    const candidateStatus = options.candidateStatus || global.NjuGrabEngine?.CANDIDATE_STATUS;
    const scanDom = options.scanDom;
    const queryClient = options.queryClient || createNetworkQueryClient({ document: options.document || global.document });
    const hasCurrentQueryScope = typeof options.getCurrentQueryScope === 'function';
    const getCurrentQueryScope = hasCurrentQueryScope ? options.getCurrentQueryScope : () => '';
    const maxSearches = Math.min(DEFAULT_MAX_SEARCHES,
      Math.max(1, Number(options.maxSearches) || DEFAULT_MAX_SEARCHES));
    const maxMaterializations = Math.min(DEFAULT_MAX_SEARCHES,
      Math.max(1, Number(options.maxMaterializations) || DEFAULT_MAX_MATERIALIZATIONS));
    let rotationCursor = 0;

    if (!taskModel?.normalizeTargets || !taskModel?.targetAcceptsCandidate) {
      throw new TypeError('CourseProvider requires NjuGrabTaskModel');
    }
    if (!candidateStatus || typeof scanDom !== 'function') {
      throw new TypeError('CourseProvider requires candidate statuses and a DOM scanner');
    }

    function chooseTargets(targets) {
      if (targets.length <= maxSearches) return targets;
      if (maxSearches === 1) return [targets[rotationCursor++ % targets.length]];
      const selected = [targets[0]];
      const rotating = targets.slice(1);
      for (let index = 0; index < maxSearches - 1; index += 1) {
        selected.push(rotating[(rotationCursor + index) % rotating.length]);
      }
      rotationCursor = (rotationCursor + maxSearches - 1) % rotating.length;
      return selected;
    }

    function targetQuery(target) {
      return String(target.courseNumber || target.name || '').trim();
    }

    function normalizeTargetScopes(target) {
      if (!target || typeof target !== 'object') return target;
      const normalized = { ...target };
      for (const key of ['teachingClassType', 'queryScope']) {
        if (Object.hasOwn(target, key)) normalized[key] = normalizeQueryScope(target[key]);
      }
      return normalized;
    }

    function buildNetworkCandidate(entry, target, order) {
      const teachingClassId = String(entry?.teachingClassId || '').trim();
      const electiveBatchId = String(entry?.electiveBatchId || '').trim();
      const teachingClassType = normalizeQueryScope(entry?.teachingClassType);
      const preciseKey = [electiveBatchId, teachingClassType, teachingClassId].filter(Boolean).join(':');
      const courseNumber = String(entry?.courseNumber || '').trim();
      const teacher = String(entry?.teacher || '').trim();
      const time = String(entry?.time || '').trim();
      const campus = String(entry?.campus || '').trim();
      const name = String(entry?.name || '').trim();
      const status = Object.values(candidateStatus).includes(entry?.status)
        ? entry.status
        : candidateStatus.UNAVAILABLE;
      return {
        id: teachingClassId
          ? `class:${preciseKey || teachingClassId}`
          : `api:${shortHash(`${target.targetId}|${courseNumber}|${name}|${teacher}|${order}`)}`,
        teachingClassId: teachingClassId || null,
        teachingClassType: teachingClassType || null,
        electiveBatchId: electiveBatchId || null,
        courseNumber: courseNumber || null,
        teacher: teacher || null,
        time: time || null,
        campus: campus || null,
        target,
        targetId: target.targetId,
        label: [courseNumber, teacher, campus, time, teachingClassId].filter(Boolean).join(' · ') || name,
        identity: [courseNumber, name, teacher, campus, time, teachingClassId].filter(Boolean).join(' '),
        order,
        row: null,
        choiceBtn: null,
        source: 'NETWORK',
        status
      };
    }

    function deferredCandidate(target, label = '已纳入监控，等待下轮分批查询') {
      return {
        id: `deferred:${target.targetId}`,
        teachingClassId: target.teachingClassId || null,
        teachingClassType: target.teachingClassType || null,
        electiveBatchId: target.electiveBatchId || null,
        courseNumber: target.courseNumber || null,
        target,
        targetId: target.targetId,
        label,
        identity: target.targetId,
        order: Number.MAX_SAFE_INTEGER,
        row: null,
        choiceBtn: null,
        source: 'DEFERRED',
        status: candidateStatus.DEFERRED || 'DEFERRED'
      };
    }

    function currentQueryScope() {
      try {
        return normalizeQueryScope(getCurrentQueryScope());
      } catch {
        return '';
      }
    }

    function queryScopeLabel(scope) {
      const normalized = normalizeQueryScope(scope);
      return QUERY_SCOPE_LABELS[normalized] || normalized || '对应';
    }

    function scopeDeferredCandidate(target, activeScope = '') {
      const requiredScope = normalizeQueryScope(target.queryScope);
      if (requiredScope) {
        return deferredCandidate(
          target,
          `等待进入${queryScopeLabel(requiredScope)}课程分类后继续查询`
        );
      }
      if (activeScope) {
        return deferredCandidate(
          target,
          `本轮在${queryScopeLabel(activeScope)}课程分类未找到，继续轮查其他课程分类`
        );
      }
      return deferredCandidate(target, '当前页面不属于可查询课程分类，等待进入课程分类');
    }

    function candidatesForTarget(networkResult, target) {
      return (Array.isArray(networkResult?.candidates) ? networkResult.candidates : [])
        .map((entry, index) => buildNetworkCandidate(entry, target, index))
        .filter(candidate => taskModel.targetAcceptsCandidate(target, candidate));
    }

    function compareMaterializedCandidates(networkCandidates, domCandidates) {
      const indexCandidates = candidates => {
        const identified = new Map();
        const unidentified = new Set();
        for (const [index, candidate] of candidates.entries()) {
          const teachingClassId = String(candidate?.teachingClassId || '').trim();
          if (teachingClassId) {
            identified.set(teachingClassId, candidate);
          } else {
            unidentified.add(String(candidate?.id || `candidate-${index}`));
          }
        }
        return { identified, unidentified };
      };
      const network = indexCandidates(networkCandidates);
      const dom = indexCandidates(domCandidates);
      let networkOnlyCandidateCount = 0;
      let domOnlyCandidateCount = 0;
      let statusMismatchCount = 0;

      for (const [teachingClassId, candidate] of network.identified) {
        const domCandidate = dom.identified.get(teachingClassId);
        if (!domCandidate) {
          networkOnlyCandidateCount += 1;
        } else if (candidate.status !== domCandidate.status) {
          statusMismatchCount += 1;
        }
      }
      for (const teachingClassId of dom.identified.keys()) {
        if (!network.identified.has(teachingClassId)) domOnlyCandidateCount += 1;
      }

      const unidentifiableCandidateCount = network.unidentified.size + dom.unidentified.size;
      const mismatched = networkOnlyCandidateCount > 0
        || domOnlyCandidateCount > 0
        || statusMismatchCount > 0
        || unidentifiableCandidateCount > 0;
      return {
        comparisonCount: 1,
        mismatchedComparisonCount: mismatched ? 1 : 0,
        networkOnlyCandidateCount,
        domOnlyCandidateCount,
        statusMismatchCount,
        unidentifiableCandidateCount
      };
    }

    function addShadowComparison(total, value) {
      if (!value) return total;
      for (const key of Object.keys(total)) total[key] += Math.max(0, Number(value[key]) || 0);
      return total;
    }

    async function materializeAvailableCandidates(target, apiCandidates, context) {
      const result = new Map(apiCandidates.map(candidate => [candidate.id, {
        ...candidate,
        status: candidate.status === candidateStatus.AVAILABLE
          ? candidateStatus.UNAVAILABLE
          : candidate.status
      }]));
      const queries = [];
      for (const candidate of apiCandidates) {
        if (candidate.status !== candidateStatus.AVAILABLE) continue;
        const query = candidate.courseNumber || targetQuery(target);
        if (query && !queries.includes(query)) queries.push(query);
        if (queries.length >= maxMaterializations) break;
      }

      const queriedCourseNumbers = new Set(queries);
      const networkCandidatesInScope = apiCandidates.filter(candidate => {
        return queriedCourseNumbers.has(candidate.courseNumber || targetQuery(target));
      });
      const observedDomCandidates = new Map();

      for (const query of queries) {
        const domResult = await scanDom([target], context, { query });
        const domCandidates = domResult instanceof Map ? domResult.get(target.targetId) || [] : [];
        for (const candidate of domCandidates) {
          result.set(candidate.id, candidate);
          observedDomCandidates.set(candidate.id, candidate);
        }
      }
      return {
        candidates: [...result.values()],
        materializedQueryCount: queries.length,
        shadowComparison: queries.length > 0
          ? compareMaterializedCandidates(networkCandidatesInScope, [...observedDomCandidates.values()])
          : null
      };
    }

    async function scanDomFallback(targets, context, fallbackReason) {
      const normalizedTargets = targets.map(normalizeTargetScopes);
      if (!hasCurrentQueryScope) {
        const fallback = await scanDom(normalizedTargets, context);
        const candidateCount = fallback instanceof Map
          ? [...fallback.values()].reduce((count, candidates) => {
            return count + (Array.isArray(candidates) ? candidates.length : 0);
          }, 0)
          : 0;
        return attachDiagnostics(fallback, {
          mode: SCAN_MODE.DOM_FALLBACK,
          queriedTargetCount: normalizedTargets.length,
          deferredTargetCount: 0,
          materializedQueryCount: 0,
          candidateCount,
          fallbackReason
        });
      }

      const activeScope = currentQueryScope();
      const domTargets = [];
      const scopeDeferredTargets = [];
      for (const target of normalizedTargets) {
        const requiredScope = String(target.queryScope || '').trim();
        if (requiredScope && requiredScope !== activeScope) scopeDeferredTargets.push(target);
        else domTargets.push(target);
      }
      const fallback = domTargets.length > 0
        ? await scanDom(domTargets, context)
        : new Map();
      const result = new Map(normalizedTargets.map(target => [target.targetId, []]));
      for (const target of domTargets) {
        const candidates = fallback instanceof Map ? fallback.get(target.targetId) || [] : [];
        result.set(target.targetId, candidates);
        if (candidates.length === 0 && !target.queryScope) {
          result.set(target.targetId, [scopeDeferredCandidate(target, activeScope)]);
          scopeDeferredTargets.push(target);
        }
      }
      for (const target of scopeDeferredTargets) {
        if ((result.get(target.targetId) || []).length === 0) {
          result.set(target.targetId, [scopeDeferredCandidate(target, activeScope)]);
        }
      }
      const candidateCount = [...result.values()].reduce((count, candidates) => {
        return count + (Array.isArray(candidates)
          ? candidates.filter(candidate => candidate?.status !== candidateStatus.DEFERRED).length
          : 0);
      }, 0);
      return attachDiagnostics(result, {
        mode: SCAN_MODE.DOM_FALLBACK,
        queriedTargetCount: domTargets.length,
        deferredTargetCount: 0,
        scopeDeferredTargetCount: scopeDeferredTargets.length,
        materializedQueryCount: 0,
        candidateCount,
        fallbackReason
      });
    }

    async function scan(targetValues, context = {}) {
      const targets = taskModel.normalizeTargets(targetValues);
      const result = new Map(targets.map(target => [target.targetId, []]));
      if (targets.length === 0) return result;
      const normalizedTargets = targets.map(normalizeTargetScopes);
      const selectedTargets = chooseTargets(normalizedTargets);
      const selectedTargetIds = new Set(selectedTargets.map(target => target.targetId));
      for (const target of normalizedTargets) {
        if (!selectedTargetIds.has(target.targetId)) {
          result.set(target.targetId, [deferredCandidate(target)]);
        }
      }
      const searches = selectedTargets.map(target => ({
        searchId: target.targetId,
        query: targetQuery(target),
        queryScope: normalizeQueryScope(target.queryScope || target.teachingClassType),
        teachingClassType: normalizeQueryScope(target.teachingClassType)
      })).filter(search => search.query);

      let networkResults;
      try {
        networkResults = await queryClient.query(searches, context);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (error?.outcome === 'AUTH_EXPIRED') throw error;
        if (error?.outcome && error.outcome !== 'UNSUPPORTED') throw error;
        return scanDomFallback(targets, context, 'NATIVE_QUERY_UNAVAILABLE');
      }

      const bySearchId = new Map(networkResults.map(item => [String(item?.searchId || ''), {
        ...item,
        queryScope: normalizeQueryScope(item?.queryScope),
        candidates: (Array.isArray(item?.candidates) ? item.candidates : []).map(candidate => ({
          ...candidate,
          teachingClassType: normalizeQueryScope(candidate?.teachingClassType)
        }))
      }]));
      let materializedQueryCount = 0;
      const shadowComparison = {
        comparisonCount: 0,
        mismatchedComparisonCount: 0,
        networkOnlyCandidateCount: 0,
        domOnlyCandidateCount: 0,
        statusMismatchCount: 0,
        unidentifiableCandidateCount: 0
      };
      const emptyNetworkTargets = [];
      const outOfScopeExactTargets = [];
      let usedDom = false;
      let scopeDeferredCount = 0;
      for (const target of selectedTargets) {
        const networkResult = bySearchId.get(target.targetId);
        if (!networkResult) continue;
        if (networkResult.outcome === 'OUT_OF_SCOPE') {
          if (target.teachingClassId) {
            outOfScopeExactTargets.push({
              target,
              message: networkResult.message || '等待进入对应课程分类查询'
            });
          } else {
            scopeDeferredCount += 1;
            result.set(target.targetId, [deferredCandidate(
              target,
              networkResult.message || '等待进入对应课程分类查询'
            )]);
          }
          continue;
        }
        if (networkResult.outcome === 'UNSUPPORTED') {
          return scanDomFallback(targets, context, 'NATIVE_QUERY_UNSUPPORTED');
        }
        if (networkResult.outcome) {
          throw queryError(networkResult.message, networkResult.outcome);
        }
        const apiCandidates = candidatesForTarget(networkResult, target);
        if (apiCandidates.some(candidate => candidate.status === candidateStatus.AVAILABLE)) {
          const observedScope = normalizeQueryScope(networkResult.queryScope);
          const activeScope = currentQueryScope();
          if (hasCurrentQueryScope && observedScope && observedScope !== activeScope) {
            scopeDeferredCount += 1;
            result.set(target.targetId, [deferredCandidate(
              target,
              `在${queryScopeLabel(observedScope)}课程分类发现余量，等待进入该分类完成提交`
            )]);
            continue;
          }
          const materialized = await materializeAvailableCandidates(target, apiCandidates, context);
          materializedQueryCount += materialized.materializedQueryCount;
          usedDom ||= materialized.materializedQueryCount > 0;
          addShadowComparison(shadowComparison, materialized.shadowComparison);
          result.set(target.targetId, materialized.candidates);
        } else {
          result.set(target.targetId, apiCandidates);
          if (apiCandidates.length === 0) {
            emptyNetworkTargets.push({
              target,
              queryScope: normalizeQueryScope(networkResult.queryScope)
            });
          }
        }
      }
      if (outOfScopeExactTargets.length > 0) {
        try {
          const domTargets = outOfScopeExactTargets.map(entry => entry.target);
          const domResult = await scanDom(domTargets, context);
          usedDom = true;
          for (const entry of outOfScopeExactTargets) {
            const domCandidates = domResult instanceof Map
              ? domResult.get(entry.target.targetId) || []
              : [];
            if (domCandidates.length > 0) {
              result.set(entry.target.targetId, domCandidates);
              continue;
            }
            scopeDeferredCount += 1;
            result.set(entry.target.targetId, [deferredCandidate(entry.target, entry.message)]);
          }
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          for (const entry of outOfScopeExactTargets) {
            scopeDeferredCount += 1;
            result.set(entry.target.targetId, [deferredCandidate(entry.target, entry.message)]);
          }
        }
      }
      if (emptyNetworkTargets.length > 0) {
        try {
          const domTargets = emptyNetworkTargets.map(entry => entry.target);
          const domResult = await scanDom(domTargets, context);
          usedDom = true;
          for (const entry of emptyNetworkTargets) {
            const target = entry.target;
            const domCandidates = domResult instanceof Map ? domResult.get(target.targetId) || [] : [];
            addShadowComparison(shadowComparison, compareMaterializedCandidates([], domCandidates));
            if (domCandidates.length > 0) {
              result.set(target.targetId, domCandidates);
            } else if (hasCurrentQueryScope && !target.queryScope) {
              result.set(target.targetId, [scopeDeferredCandidate(
                target,
                entry.queryScope || currentQueryScope()
              )]);
              scopeDeferredCount += 1;
            }
          }
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          // Page-local observation is a conservative supplement to a valid network result.
        }
      }
      const candidateCount = [...result.values()].reduce((count, candidates) => {
        return count + (Array.isArray(candidates)
          ? candidates.filter(candidate => candidate?.status !== candidateStatus.DEFERRED).length
          : 0);
      }, 0);
      return attachDiagnostics(result, {
        mode: usedDom ? SCAN_MODE.NETWORK_WITH_DOM : SCAN_MODE.NETWORK,
        queriedTargetCount: searches.length,
        deferredTargetCount: Math.max(0, targets.length - selectedTargets.length),
        scopeDeferredTargetCount: scopeDeferredCount,
        materializedQueryCount,
        candidateCount,
        fallbackReason: null,
        shadowComparison
      });
    }

    return Object.freeze({ scan });
  }

  const exported = Object.freeze({
    QUERY_EVENT,
    RESULT_EVENT,
    SCAN_MODE,
    createNetworkQueryClient,
    createCourseProvider
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  global.NjuGrabCourseProvider = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
