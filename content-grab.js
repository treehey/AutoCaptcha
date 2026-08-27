// content-grab.js - 南京大学选课系统自动抢课与点击验证码脚本
// 运行在 https://xk.nju.edu.cn/xsxkapp/ 选课页面
console.log('[AutoGrab] 南京大学自动抢课脚本已加载');

const grabModule = globalThis.NjuGrabEngine;
const grabTaskModel = globalThis.NjuGrabTaskModel;
const grabAuthPresentation = globalThis.NjuGrabAuthPresentation;
const grabVerificationModule = globalThis.NjuGrabVerificationEngine;
const grabLoginShieldModule = globalThis.NjuGrabLoginShield;
const GRAB_LOGIN_SHIELD_STATUS = grabLoginShieldModule?.STATUS || Object.freeze({
  PREPARING: 'preparing',
  LOADING: 'loading',
  SUCCESS: 'success',
  ERROR: 'error'
});
const grabLoginShield = grabLoginShieldModule?.createLoginShield?.({ documentRef: document }) || Object.freeze({
  clear() {},
  resolveAutomation() {},
  show() { return false; }
});

// The setting read is asynchronous. Block the official login panel immediately
// so a stray click cannot interfere with automatic captcha input in that gap.
if (document.getElementById('loginDiv') && !document.querySelector('.nju-grab-status-panel')) {
  grabLoginShield.show(GRAB_LOGIN_SHIELD_STATUS.PREPARING, '正在准备自动登录…');
}
const COURSE_ROW_SELECTOR = 'table tbody tr, .cv-tbody tr, .ant-table-tbody tr';
const FEEDBACK_SELECTOR = [
  '.cv-window',
  '.bh-dialog',
  '.cv-dialog',
  '.jqx-window',
  '.ant-modal',
  '[role="dialog"]',
  '.cv-toast',
  '.bh-message',
  '.ant-message-notice'
].join(',');
const GRAB_NETWORK_EVENT = 'nju-autograb-network-v1';
const GRAB_NETWORK_PATH = Object.freeze({
  SUBMIT: '/elective/volunteer.do',
  STATUS: '/elective/studentstatus.do',
  QUERIES: Object.freeze([
    '/elective/programCourse.do',
    '/elective/publicCourse.do',
    '/elective/queryCourse.do',
    '/elective/queryfavorite.do'
  ])
});
const GRAB_NETWORK_PATHS = new Set([
  GRAB_NETWORK_PATH.SUBMIT,
  GRAB_NETWORK_PATH.STATUS,
  ...GRAB_NETWORK_PATH.QUERIES
]);
const COURSE_SCOPE_INFO = Object.freeze({
  ZY: Object.freeze({ label: '专业' }),
  GG: Object.freeze({ label: '公共' }),
  GG01: Object.freeze({ label: '公选课', parent: 'GG' }),
  GG02: Object.freeze({ label: '导学/研讨/通识', parent: 'GG' }),
  KZY: Object.freeze({ label: '跨专业' }),
  TX: Object.freeze({ label: '通修' }),
  TY: Object.freeze({ label: '体育' }),
  YD: Object.freeze({ label: '悦读' }),
  QB: Object.freeze({ label: '课表查询' }),
  SC: Object.freeze({ label: '收藏' })
});
const LEGACY_COURSE_SCOPE_ALIASES = Object.freeze({
  TCT1: 'ZY',
  TCT2: 'KZY',
  TCT3: 'GG01',
  TCT4: 'GG02',
  TCT5: 'TY'
});

function normalizeCourseScope(scope) {
  const normalized = String(scope || '').trim().toUpperCase();
  return LEGACY_COURSE_SCOPE_ALIASES[normalized] || normalized;
}

function courseScopeLabel(scope) {
  const normalized = normalizeCourseScope(scope);
  return COURSE_SCOPE_INFO[normalized]?.label || normalized || '对应分类';
}

function courseScopeNavigationPath(scope) {
  const normalized = normalizeCourseScope(scope);
  if (!normalized) return [];
  const parent = COURSE_SCOPE_INFO[normalized]?.parent;
  return parent ? [parent, normalized] : [normalized];
}
const grabSelectionVerifier = grabVerificationModule.createVerificationEngine({
  outcome: grabModule.OUTCOME,
  paths: {
    submit: GRAB_NETWORK_PATH.SUBMIT,
    status: GRAB_NETWORK_PATH.STATUS
  }
});

const grabNetworkMonitor = (() => {
  let sequence = 0;
  const events = [];

  document.addEventListener(GRAB_NETWORK_EVENT, event => {
    try {
      const detail = JSON.parse(String(event.detail || ''));
      if (!GRAB_NETWORK_PATHS.has(detail.path)) return;
      events.push({ ...detail, sequence: ++sequence });
      if (events.length > 50) events.shift();
    } catch {
      // Ignore malformed or unrelated page events.
    }
  });

  return Object.freeze({
    checkpoint: () => sequence,
    after: checkpoint => events.filter(event => event.sequence > checkpoint)
  });
})();

function createGrabAbortError() {
  const error = new Error('Grab operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfGrabAborted(signal) {
  if (signal?.aborted) throw createGrabAbortError();
}

// This helper is also used by the click-captcha workflow later in this file.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      reject(createGrabAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createGrabAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function elementText(element) {
  return String(element?.innerText || element?.textContent || '').trim();
}

function isVisibleGrabElement(element) {
  if (!element || !element.isConnected) return false;
  const style = globalThis.getComputedStyle ? getComputedStyle(element) : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
  return element.offsetParent !== null || element.getClientRects?.().length > 0;
}

function normalizeCandidateIdentity(text) {
  return String(text || '')
    .replace(/(?:选择|退选|已选|已满|收藏|详情)/g, '')
    .replace(/\d+\s*\/\s*\d+/g, '#/#')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function extractTeachingClassId(row, choiceBtn) {
  const attributeNames = [
    'data-tcid',
    'data-tc-id',
    'data-teaching-class-id',
    'data-teachingclassid',
    'data-jxb-id',
    'data-jxbid',
    'data-class-id',
    'data-classid'
  ];
  const attributeSelector = attributeNames.map(name => `[${name}]`).join(',');
  const elements = [
    choiceBtn,
    row,
    row?.querySelector?.(attributeSelector),
    row?.closest?.(attributeSelector)
  ].filter(Boolean);
  for (const element of elements) {
    for (const name of attributeNames) {
      const value = element.getAttribute?.(name);
      if (value) return value;
    }
    for (const [key, value] of Object.entries(element.dataset || {})) {
      if (value && /(?:teaching.*class.*id|jxb.*id|class.*id)/i.test(key)) return value;
    }
  }
  return '';
}

function extractCourseNumber(row, choiceBtn) {
  const elements = [
    choiceBtn,
    row,
    row?.querySelector?.('[data-number], [data-coursenumber]'),
    row?.closest?.('[data-coursenumber]'),
    row?.closest?.('.course-jxb-container')
  ].filter(Boolean);
  for (const element of elements) {
    const value = element.getAttribute?.('data-number') || element.getAttribute?.('data-coursenumber');
    if (value && value !== 'undefined' && value !== 'null') return value;
  }
  return '';
}

function currentTeachingClassType(choiceBtn) {
  const explicit = choiceBtn?.getAttribute?.('data-teachingclasstype');
  if (explicit && explicit !== 'undefined' && explicit !== 'null') return explicit;
  try {
    return sessionStorage.getItem('teachingClassTypeSecond')
      || sessionStorage.getItem('teachingClassType')
      || '';
  } catch {
    return '';
  }
}

function currentCourseQueryScope(element) {
  const container = element?.closest?.('[data-teachingclasstype]')
    || element?.closest?.('.result-container');
  const explicit = container?.getAttribute?.('data-teachingclasstype');
  if (explicit && explicit !== 'undefined' && explicit !== 'null') return explicit;
  try {
    return sessionStorage.getItem('teachingClassTypeSecond')
      || sessionStorage.getItem('teachingClassType')
      || '';
  } catch {
    return '';
  }
}

function currentElectiveBatchId() {
  try {
    const studentInfo = JSON.parse(sessionStorage.getItem('studentInfo') || 'null');
    return studentInfo?.electiveBatch?.code || '';
  } catch {
    return '';
  }
}

function findChoiceButton(row) {
  return [...row.querySelectorAll('.cv-choice, .cv-btn, button, [role="button"]')].find(button => {
    const label = elementText(button);
    const disabled = button.disabled
      || button.classList?.contains('cv-disabled')
      || button.getAttribute?.('aria-disabled') === 'true';
    const favoriteAction = button.classList?.contains('cv-favorite')
      || button.classList?.contains('cv-delete-favorite');
    return !disabled && !favoriteAction && isVisibleGrabElement(button)
      && /(?:选择|选课|choose|select)/i.test(label)
      && label !== '退选' && label !== '已满';
  }) || null;
}

function rowHasSelectedMarker(row) {
  if (!row) return false;
  if (row.matches?.('.ischoosed, .is-choosed, .is-selected, .selected')) return true;
  const classNames = row.classList
    ? (typeof row.classList[Symbol.iterator] === 'function'
      ? [...row.classList]
      : String(row.className || '').split(/\s+/).filter(Boolean))
    : [];
  if (row.classes instanceof Set) classNames.push(...row.classes);
  if (classNames.some(name => /(?:choose|selected|choosed)/i.test(name))) return true;
  const marker = row.getAttribute?.('data-ischoose')
    || row.getAttribute?.('data-is-choose')
    || row.getAttribute?.('data-selected');
  return /^(?:1|true|yes|y)$/i.test(String(marker || '').trim());
}

function rowShowsSelected(row) {
  const selectedLabels = [...row.querySelectorAll('.cv-choice, .cv-btn, button, [class*="status"], td, span')]
    .filter(isVisibleGrabElement)
    .map(elementText);
  return rowHasSelectedMarker(row) || selectedLabels.some(text => text === '退选' || text === '已选');
}

function getCandidateStatus(row, choiceBtn) {
  const text = elementText(row);
  if (rowShowsSelected(row)) return grabModule.CANDIDATE_STATUS.SELECTED;
  if (/已满/.test(text)) return grabModule.CANDIDATE_STATUS.FULL;
  if (choiceBtn && !choiceBtn.disabled && isVisibleGrabElement(choiceBtn)) return grabModule.CANDIDATE_STATUS.AVAILABLE;
  return grabModule.CANDIDATE_STATUS.UNAVAILABLE;
}

function buildDomCandidate(row, target, order) {
  const normalizedTarget = grabTaskModel.normalizeTarget(target);
  const choiceBtn = findChoiceButton(row);
  const identity = normalizeCandidateIdentity(elementText(row));
  const teachingClassId = extractTeachingClassId(row, choiceBtn);
  const courseNumber = extractCourseNumber(row, choiceBtn);
  const teachingClassType = currentTeachingClassType(choiceBtn);
  const electiveBatchId = currentElectiveBatchId();
  const preciseKey = [electiveBatchId, teachingClassType, teachingClassId].filter(Boolean).join(':');
  const teacherElement = row.querySelector?.('.jxb-title, .jsmc, [data-field="JSXM"], [class*="teacher"]');
  const teacher = teacherElement?.getAttribute?.('title') || elementText(teacherElement);
  const time = firstMetadataText(row, ['.sjdd', '.sksj', '[data-field="SKSJ"]', '[class*="course-time"]']);
  const campus = firstMetadataText(row, ['.xq', '.xqmc', '[data-field="XQMC"]', '[class*="campus"]']);
  return {
    id: teachingClassId ? `class:${preciseKey || teachingClassId}` : `dom:${shortHash(`${normalizedTarget.targetId}|${identity}|${order}`)}`,
    teachingClassId: teachingClassId || null,
    teachingClassType: teachingClassType || null,
    electiveBatchId: electiveBatchId || null,
    courseNumber: courseNumber || null,
    teacher: teacher || null,
    time: time || null,
    campus: campus || null,
    target: normalizedTarget,
    targetId: normalizedTarget.targetId,
    label: [courseNumber, teacher, campus, time, teachingClassId].filter(Boolean).join(' · ') || identity.slice(0, 80),
    identity,
    order,
    row,
    choiceBtn,
    status: getCandidateStatus(row, choiceBtn)
  };
}

function getExpandedClassRows(row) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = element => {
    if (!element || element === row || seen.has(element)) return;
    if (!element.querySelector?.('.cv-choice') && !/已满/.test(elementText(element)) && !rowShowsSelected(element)) return;
    seen.add(element);
    candidates.push(element);
  };

  const add = element => {
    if (!element) return;
    const classItems = element.matches?.('.jxb-item')
      ? [element]
      : [...(element.querySelectorAll?.('.jxb-item') || [])];
    if (classItems.length > 0) classItems.forEach(addCandidate);
    else addCandidate(element);
  };

  row.querySelectorAll([
    '.jxb-item',
    'tr',
    '[data-teaching-class-id]',
    '[data-jxbid]',
    '[class*="class-row"]',
    '[class*="expand-row"]',
    '[class*="child-row"]'
  ].join(',')).forEach(add);

  let next = row.nextElementSibling;
  while (next && candidates.length < 30) {
    if (next.matches?.('.course-tr') || next.querySelector?.([
      '.cv-zy-expand',
      '.cv-course-name',
      '.cv-kcmc',
      '[class*="course-name"]',
      '[data-course-id]',
      '[data-field="KCMC"]'
    ].join(','))) break;
    add(next);
    next = next.nextElementSibling;
  }
  return candidates;
}

function hasVisibleExpandedRow(rows) {
  return rows.some(row => isVisibleGrabElement(row)
    || [...row.querySelectorAll('.cv-choice')].some(isVisibleGrabElement));
}

async function ensureProfessionalRows(row, signal) {
  let classRows = getExpandedClassRows(row);
  if (classRows.length > 0 && hasVisibleExpandedRow(classRows)) return classRows;

  const expandBtn = row.querySelector('.cv-zy-expand');
  if (!expandBtn || !isVisibleGrabElement(expandBtn)) return classRows;
  throwIfGrabAborted(signal);
  expandBtn.click();

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await sleep(100, signal);
    classRows = getExpandedClassRows(row);
    if (classRows.length > 0 && hasVisibleExpandedRow(classRows)) return classRows;
  }
  return classRows;
}

function courseListFingerprint(root) {
  const rows = root.querySelectorAll?.(COURSE_ROW_SELECTOR) || [];
  return `${rows.length}|${String(root.textContent || '').replace(/\s+/g, ' ').trim()}`;
}

function hasVisibleCourseLoading() {
  return [...document.querySelectorAll('.loading, .cv-loading, .ant-spin-spinning, .bh-loading')]
    .some(isVisibleGrabElement);
}

async function refreshCourseList(signal) {
  throwIfGrabAborted(signal);
  const refreshBtn = document.querySelector('.cv-btn.refresh-btn')
    || [...document.querySelectorAll('button, .cv-btn')].find(element => elementText(element) === '刷新');
  if (!refreshBtn || !isVisibleGrabElement(refreshBtn)) return false;

  const tableRoot = document.querySelector('table, .cv-tbody, .ant-table-tbody') || document.body;
  const beforeFingerprint = courseListFingerprint(tableRoot);
  const networkCheckpoint = grabNetworkMonitor.checkpoint();
  const originalStyle = refreshBtn.getAttribute('style') || '';
  refreshBtn.style.cssText += ';outline:3px solid #634798 !important;opacity:0.6 !important;transition:none !important;';
  setTimeout(() => refreshBtn.setAttribute('style', originalStyle), 400);

  if (typeof MutationObserver === 'undefined') {
    refreshBtn.click();
    await sleep(800, signal);
    return courseListFingerprint(tableRoot) !== beforeFingerprint;
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    let sawLoading = hasVisibleCourseLoading();
    let settleTimer = null;
    let timeoutTimer = null;
    let observer = null;
    const queryRequestCompleted = () => grabNetworkMonitor.after(networkCheckpoint).some(event => {
      const status = Number(event.status) || 0;
      return GRAB_NETWORK_PATH.QUERIES.includes(event.path) && status >= 200 && status < 400;
    });

    const cleanup = () => {
      observer?.disconnect();
      if (settleTimer) clearTimeout(settleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      document.removeEventListener(GRAB_NETWORK_EVENT, check);
    };
    const finish = changed => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(changed);
    };
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(createGrabAbortError());
    };
    const check = () => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const loading = hasVisibleCourseLoading();
      if (loading) sawLoading = true;
      const fingerprintChanged = courseListFingerprint(tableRoot) !== beforeFingerprint;
      if ((fingerprintChanged || sawLoading || queryRequestCompleted()) && !loading) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish(fingerprintChanged), 80);
      }
    };

    observer = new MutationObserver(check);
    observer.observe(tableRoot, { childList: true, subtree: true, characterData: true, attributes: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    document.addEventListener(GRAB_NETWORK_EVENT, check);
    timeoutTimer = setTimeout(() => finish(courseListFingerprint(tableRoot) !== beforeFingerprint), 1500);
    refreshBtn.click();
    check();
  });
}

async function scanDomCandidates(targets, context, options = {}) {
  const { signal } = context;
  if (options.query !== undefined) {
    const searchInput = document.querySelector('.search-input');
    if (searchInput) searchInput.value = String(options.query || '').slice(0, 300);
  }
  await refreshCourseList(signal);
  throwIfGrabAborted(signal);

  const rows = [...document.querySelectorAll(COURSE_ROW_SELECTOR)];
  if (rows.length === 0) throw new Error('未发现课程列表，请确认已打开选课页面');

  const normalizedTargets = grabTaskModel.normalizeTargets(targets);
  const result = new Map(normalizedTargets.map(target => [target.targetId, []]));
  const seenRows = new Map(normalizedTargets.map(target => [target.targetId, new Set()]));
  const seenCandidateIds = new Map(normalizedTargets.map(target => [target.targetId, new Set()]));
  const expandedRows = new Map();
  let order = 0;

  const addCandidate = (target, row) => {
    if (!row || seenRows.get(target.targetId).has(row)) return;
    const candidate = buildDomCandidate(row, target, order++);
    if (!grabTaskModel.targetAcceptsCandidate(target, candidate)) return;
    if (seenCandidateIds.get(target.targetId).has(candidate.id)) return;
    seenRows.get(target.targetId).add(row);
    seenCandidateIds.get(target.targetId).add(candidate.id);
    result.get(target.targetId).push(candidate);
  };

  for (const row of rows) {
    const text = elementText(row);
    const courseNumber = extractCourseNumber(row, findChoiceButton(row));
    const matchedTargets = normalizedTargets.filter(target => grabTaskModel.targetMatchesCourse(target, {
      text,
      courseNumber
    }));
    if (matchedTargets.length === 0) continue;

    const expandBtn = row.querySelector('.cv-zy-expand');
    if (expandBtn) {
      let promise = expandedRows.get(row);
      if (!promise) {
        promise = ensureProfessionalRows(row, signal);
        expandedRows.set(row, promise);
      }
      const classRows = await promise;
      for (const target of matchedTargets) {
        if (classRows.length === 0) addCandidate(target, row);
        else classRows.forEach(classRow => addCandidate(target, classRow));
      }
      continue;
    }

    if (findChoiceButton(row) || /已满/.test(text) || rowShowsSelected(row)) {
      matchedTargets.forEach(target => addCandidate(target, row));
    }
  }

  return result;
}

function visibleConfirmButtons() {
  return [...document.querySelectorAll('.cv-sure.cvBtnFlag, .cv-sure, [role="dialog"] .cvBtnFlag, .cvBtnFlag')]
    .filter(button => {
      if (!isVisibleGrabElement(button) || button.disabled) return false;
      const text = elementText(button);
      return button.classList.contains('cv-sure') || /确认|确定|是/.test(text);
    });
}

function visibleFeedbackElements() {
  return [...document.querySelectorAll(FEEDBACK_SELECTOR)]
    .filter(isVisibleGrabElement);
}

function visibleFeedbackTexts(elements = visibleFeedbackElements()) {
  const result = new Set();
  elements.forEach(element => {
    const text = elementText(element).replace(/\s+/g, ' ').trim();
    if (text && text.length <= 500) result.add(text);
  });
  return result;
}

function newFeedbackText(baseline) {
  return [...visibleFeedbackTexts()].filter(text => !baseline.has(text)).join('；');
}

function selectionObservationAfter(candidate, checkpoint, observation = {}) {
  return grabSelectionVerifier.evaluate({
    candidate,
    domSelected: Boolean(observation.domSelected),
    domMessage: observation.domMessage,
    feedbackText: observation.feedbackText,
    networkEvents: grabNetworkMonitor.after(checkpoint)
  });
}

function candidateIsSelected(candidate) {
  if (candidate.row?.isConnected && rowShowsSelected(candidate.row)) {
    if (!candidate.teachingClassId
      || extractTeachingClassId(candidate.row, candidate.row.querySelector?.('.cv-choice, .cv-delete-select')) === candidate.teachingClassId) return true;
  }

  if (candidate.teachingClassId) {
    const exactIdElements = [...document.querySelectorAll('[data-tcid], [data-teachingclassid], [data-teaching-class-id], [data-jxbid]')]
      .filter(element => extractTeachingClassId(element, element) === candidate.teachingClassId);
    for (const element of exactIdElements) {
      const candidateNode = element.closest?.('.jxb-item, tr, [data-teaching-class-id], [data-jxbid]') || element;
      if (rowShowsSelected(candidateNode)) return true;
    }
    return false;
  }

  const rows = [...document.querySelectorAll(COURSE_ROW_SELECTOR)];
  for (const row of rows) {
    if (!rowShowsSelected(row)) continue;
    if (candidate.identity
      && normalizeCandidateIdentity(elementText(row)) === candidate.identity) return true;
  }
  return false;
}

async function waitForConfirmOrImmediateResult(candidate, baselineButtons, baselineFeedback, networkCheckpoint, signal) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    throwIfGrabAborted(signal);
    if (candidateIsSelected(candidate)) return { kind: 'selected' };
    const confirmBtn = visibleConfirmButtons().find(button => !baselineButtons.has(button));
    if (confirmBtn) return { kind: 'confirm', button: confirmBtn };
    const feedback = newFeedbackText(baselineFeedback);
    const observed = selectionObservationAfter(candidate, networkCheckpoint, { feedbackText: feedback });
    if (observed) return { kind: 'outcome', ...observed };
    await sleep(100, signal);
  }
  return { kind: 'none' };
}

async function waitForSelectionOutcome(candidate, baselineFeedback, networkCheckpoint, signal) {
  // The school's own page polls studentstatus.do once per second, at most ten times.
  const deadline = Date.now() + 11500;
  while (Date.now() < deadline) {
    throwIfGrabAborted(signal);
    if (candidateIsSelected(candidate)) {
      return selectionObservationAfter(candidate, networkCheckpoint, { domSelected: true });
    }
    const feedback = newFeedbackText(baselineFeedback);
    const observed = selectionObservationAfter(candidate, networkCheckpoint, { feedbackText: feedback });
    if (observed) return observed;
    await sleep(150, signal);
  }
  return null;
}

function resultDialogForOutcome(result, baselineElements) {
  const expectedOutcome = result?.outcome;
  return visibleFeedbackElements().find(element => {
    if (baselineElements.has(element)) return false;
    const text = elementText(element).replace(/\s+/g, ' ').trim();
    if (!text) return false;
    if (expectedOutcome === grabModule.OUTCOME.SUCCESS) {
      return element.classList?.contains('cv-success')
        || /(?:选课|课程).{0,16}成功|成功.{0,16}(?:选课|课程)/.test(text);
    }
    return element.classList?.contains('cv-error')
      || grabSelectionVerifier.evaluate({ feedbackText: text })?.outcome === expectedOutcome;
  });
}

function resultDialogDismissButton(dialog) {
  if (!dialog) return null;
  return [...dialog.querySelectorAll('.cv-sure.cvBtnFlag, .cv-sure, .cvBtnFlag, button, [role="button"]')]
    .find(button => {
      return isVisibleGrabElement(button)
        && !button.disabled
        && /确认|确定|关闭|知道了/.test(elementText(button));
    }) || null;
}

async function dismissSelectionResultDialog(result, baselineElements, signal) {
  if (!result?.outcome || [
    grabModule.OUTCOME.AUTH_EXPIRED,
    grabModule.OUTCOME.CAPTCHA_REQUIRED,
    grabModule.OUTCOME.NETWORK_ERROR
  ].includes(result.outcome)) return false;

  const tryDismiss = () => {
    const button = resultDialogDismissButton(resultDialogForOutcome(result, baselineElements));
    if (!button) return false;
    button.click();
    return true;
  };
  if (tryDismiss()) return true;

  // The school's XHR result can arrive before its result dialog is rendered.
  // Keep the submission flow here until that late dialog has had time to appear,
  // otherwise its overlay can block every later course attempt.
  const deadline = Date.now() + 800;
  while (Date.now() < deadline) {
    throwIfGrabAborted(signal);
    if (tryDismiss()) return true;
    await sleep(50, signal);
  }
  return false;
}

async function finalizeDomAttemptResult(result, baselineElements, signal) {
  await dismissSelectionResultDialog(result, baselineElements, signal);
  return result;
}

async function attemptDomCandidate(candidate, context) {
  const { signal } = context;
  throwIfGrabAborted(signal);
  if (!candidate.choiceBtn || !isVisibleGrabElement(candidate.choiceBtn) || candidate.choiceBtn.disabled) {
    return {
      outcome: grabModule.OUTCOME.REJECTED,
      message: '选择按钮已失效，课程列表可能已刷新',
      retryOtherCandidate: true
    };
  }

  const baselineButtons = new Set(visibleConfirmButtons());
  const baselineFeedbackElements = new Set(visibleFeedbackElements());
  const baselineFeedback = visibleFeedbackTexts([...baselineFeedbackElements]);
  const networkCheckpoint = grabNetworkMonitor.checkpoint();
  candidate.choiceBtn.click();

  const immediate = await waitForConfirmOrImmediateResult(candidate, baselineButtons, baselineFeedback, networkCheckpoint, signal);
  if (immediate.kind === 'selected') {
    return finalizeDomAttemptResult(
      selectionObservationAfter(candidate, networkCheckpoint, { domSelected: true }),
      baselineFeedbackElements,
      signal
    );
  }
  if (immediate.kind === 'outcome') {
    return finalizeDomAttemptResult({
      outcome: immediate.outcome,
      message: immediate.message,
      retryOtherCandidate: typeof immediate.retryOtherCandidate === 'boolean'
        ? immediate.retryOtherCandidate
        : undefined
    }, baselineFeedbackElements, signal);
  }
  if (immediate.kind === 'confirm') {
    throwIfGrabAborted(signal);
    immediate.button.click();
  }

  const observed = await waitForSelectionOutcome(candidate, baselineFeedback, networkCheckpoint, signal);
  if (observed) return finalizeDomAttemptResult(observed, baselineFeedbackElements, signal);

  // A fresh list is required before DOM state can be used as a success proof.
  await refreshCourseList(signal);
  await sleep(200, signal);
  if (candidateIsSelected(candidate)) {
    return finalizeDomAttemptResult(
      selectionObservationAfter(candidate, networkCheckpoint, {
        domSelected: true,
        domMessage: '刷新后已确认该教学班为已选'
      }),
      baselineFeedbackElements,
      signal
    );
  }

  const feedback = newFeedbackText(baselineFeedback);
  const classified = grabSelectionVerifier.evaluate({ feedbackText: feedback });
  if (classified) {
    return finalizeDomAttemptResult(
      classified,
      baselineFeedbackElements,
      signal
    );
  }
  return {
    outcome: grabModule.OUTCOME.UNKNOWN_COMMIT,
    message: immediate.kind === 'confirm'
      ? '确认已点击，但未得到可验证的服务端结果'
      : '选择已点击，但未得到可验证的服务端结果',
    retryOtherCandidate: false
  };
}

function sendGrabRuntimeMessage(message) {
  try {
    const pending = chrome.runtime.sendMessage(message);
    if (pending?.catch) pending.catch(() => {});
  } catch (error) {
    // Popup is normally closed; no listener is expected.
  }
}

function unavailableGrabSnapshot(message) {
  return {
    running: false,
    phase: 'FAILED',
    configuredGroups: [],
    configuredTargets: [],
    configuredCourseNames: [],
    remainingTargets: [],
    remainingCourseNames: [],
    courseNames: [],
    initialTargetCount: 0,
    totalGroups: 0,
    completedGroups: 0,
    completedGroupIds: [],
    interval: 3000,
    round: 0,
    globalRetryAt: 0,
    nextRetryAt: 0,
    retryingTargetCount: 0,
    lastScan: null,
    successTargets: [],
    successCourses: [],
    skippedTargetIds: [],
    groupStates: {},
    targetStates: {},
    log: message ? [message] : []
  };
}

const GRAB_TASK_RUNTIME_SAVE = 'grabTaskRuntimeSave';
const GRAB_TASK_RUNTIME_GET = 'grabTaskRuntimeGet';
const GRAB_AUTH_LOGIN_URL = 'https://xk.nju.edu.cn/';
const GRAB_AUTH_RECOVERY_MAX_ATTEMPTS = 3;
const GRAB_AUTH_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const GRAB_PRE_COURSE_ENTRY_WAIT_MS = 8000;
const GRAB_AUTH_LOGIN_ATTEMPT_KEY = 'nju_grab_auth_login_attempt';
const GRAB_AUTH_LOGIN_TIMEOUT_MS = 60000;
let activeGrabTaskId = '';
let activeGrabTaskRevision = 0;
let activeGrabTaskNeedsClaim = false;
let grabTaskPersistTimer = null;
let pendingGrabTaskSnapshot = null;
let grabLifecycleCommandVersion = 0;
let grabAuthRecovery = null;
let pausedGrabTaskSnapshot = null;
let grabAuthResumeRound = 0;
let grabAuthRecoveryWatchCancel = null;

function createGrabTaskId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // Fall through to a local, non-secret identifier.
  }
  return `grab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sendGrabTaskRuntime(snapshot) {
  if (!activeGrabTaskId || !snapshot) return Promise.resolve(null);
  const taskId = activeGrabTaskId;
  const claim = activeGrabTaskNeedsClaim;
  const revision = ++activeGrabTaskRevision;
  try {
    const pending = chrome.runtime.sendMessage({
      action: GRAB_TASK_RUNTIME_SAVE,
      taskId,
      revision,
      claim,
      snapshot
    });
    if (pending?.then) {
      return pending.then(response => {
        if (response?.ok && activeGrabTaskId === taskId) activeGrabTaskNeedsClaim = false;
        return response;
      }).catch(() => null);
    }
    return Promise.resolve(null);
  } catch {
    // A later state update will retry while the page keeps running.
    return Promise.resolve(null);
  }
}

function normalizeGrabAuthRecovery(value) {
  if (!value || typeof value !== 'object') return null;
  const returnPath = /^\/xsxkapp\/.+\/grablessons\.do$/i.test(String(value.returnPath || ''))
    && !String(value.returnPath).includes('..')
    ? String(value.returnPath).slice(0, 500)
    : '';
  return {
    pending: Boolean(value.pending),
    stage: ['WAITING_LOGIN', 'RETURNING', 'ENTERING_COURSE', 'VERIFYING', 'MANUAL_REQUIRED'].includes(value.stage)
      ? value.stage
      : 'WAITING_LOGIN',
    attempts: Math.min(GRAB_AUTH_RECOVERY_MAX_ATTEMPTS + 1, Math.max(0, Math.floor(Number(value.attempts) || 0))),
    startedAt: Math.max(0, Number(value.startedAt) || 0),
    returnPath,
    lastMessage: String(value.lastMessage || '').slice(0, 500)
  };
}

function withGrabAuthRecovery(snapshot) {
  if (!snapshot || !grabAuthRecovery) return snapshot;
  return { ...snapshot, authRecovery: { ...grabAuthRecovery } };
}

function isGrabLoginPage() {
  const loginDiv = document.getElementById('loginDiv');
  const loginBtn = document.getElementById('studentLoginBtn');
  return Boolean((loginDiv && isVisibleGrabElement(loginDiv))
    || (loginBtn && isVisibleGrabElement(loginBtn)));
}

function isGrabPreCoursePage() {
  return Boolean(document.getElementById?.('courseBtn')
    && document.getElementById?.('cvStageAxis')
    && document.getElementById?.('stundentinfoDiv'));
}

function currentGrabPreCourseButton() {
  if (!isGrabPreCoursePage()) return null;
  const button = document.getElementById?.('courseBtn');
  const batchReady = String(button?.getAttribute?.('title') || '').trim().length > 0;
  const enabled = button?.isConnected !== false
    && button?.disabled !== true
    && button?.getAttribute?.('aria-disabled') !== 'true';
  return batchReady && enabled && typeof button?.click === 'function' ? button : null;
}

function cancelGrabAuthRecoveryWatch() {
  if (typeof grabAuthRecoveryWatchCancel === 'function') grabAuthRecoveryWatchCancel();
  grabAuthRecoveryWatchCancel = null;
}

async function waitForGrabPreCourseButton() {
  const deadline = Date.now() + GRAB_PRE_COURSE_ENTRY_WAIT_MS;
  do {
    const button = currentGrabPreCourseButton();
    if (button) return button;
    if (!isGrabPreCoursePage()) return null;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return null;
}

function currentGrabCourseReturnPath() {
  const path = String(location.pathname || '');
  return /^\/xsxkapp\/.+\/grablessons\.do$/i.test(path) && !path.includes('..') ? path : '';
}

function navigateForGrabAuthRecovery(url) {
  try {
    if (typeof location.assign === 'function') location.assign(url);
    else location.href = url;
    return true;
  } catch {
    return false;
  }
}

function persistGrabTaskSnapshot(snapshot, options = {}) {
  if (!activeGrabTaskId || !snapshot) return;
  const storedSnapshot = withGrabAuthRecovery(snapshot);
  pendingGrabTaskSnapshot = storedSnapshot;
  const targetStates = Object.values(storedSnapshot.targetStates || {});
  const criticalTransition = activeGrabTaskNeedsClaim
    || !snapshot.running
    || targetStates.some(state => ['SUBMITTING', 'VERIFYING', 'RETRY'].includes(state.phase));
  if (options.immediate === true || criticalTransition) {
    if (grabTaskPersistTimer) clearTimeout(grabTaskPersistTimer);
    grabTaskPersistTimer = null;
    const latest = pendingGrabTaskSnapshot;
    pendingGrabTaskSnapshot = null;
    sendGrabTaskRuntime(latest);
    return;
  }
  if (grabTaskPersistTimer) return;
  grabTaskPersistTimer = setTimeout(() => {
    grabTaskPersistTimer = null;
    const latest = pendingGrabTaskSnapshot;
    pendingGrabTaskSnapshot = null;
    sendGrabTaskRuntime(latest);
  }, 100);
}

function isGrabCoursePage() {
  return /\/grablessons\.do$/i.test(String(globalThis.location?.pathname || ''))
    || Boolean(document.querySelector('.result-container, .course-list, .refresh-btn'));
}

const GRAB_TASK_CONFIG_KEY = grabTaskModel.STORAGE_KEY;
const GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY = 'nju_grab_page_enhancements_enabled';
const GRAB_TARGET_BUTTON_CLASS = 'nju-grab-add-target';
const GRAB_PAGE_STATUS_CLASS = 'nju-grab-status-panel';
const GRAB_PANEL_WIDTH_KEY = 'njuGrabPanelWidth';
const GRAB_PANEL_MINI_TUTORIAL_KEY = 'njuGrabPanelMiniTutorialSeen';
const GRAB_PANEL_HEIGHT_KEY = 'njuGrabPanelHeight';
const GRAB_PANEL_HIDE_SELECTED_KEY = 'njuGrabPanelHideSelected';
const GRAB_INTERVAL_PRESETS = Object.freeze([3000, 5000, 10000, 30000]);
let configuredGrabTargetIds = new Set();
let configuredGrabTargets = [];
let configuredGrabGroups = [];
let configuredGrabInterval = 5000;
let grabTargetDecorateTimer = null;
let grabTargetObserver = null;
let grabPageStatusPanel = null;
let grabPageStatusTimer = null;
let grabPanelFeedbackTimer = null;
let grabPageStatusExpanded = false;
let grabPageStatusAutoExpandedRunId = 0;
let latestGrabPageState = null;
let grabPageStatusErrorReported = false;
let pendingGrabRemoval = null;
let grabPanelDismissHandlers = null;
let openGrabTargetMenu = null;
let openGrabTargetMenuTrigger = null;
let grabMoreMenu = null;
let grabMoreButton = null;
let grabPageEnhancementsEnabled = true;
let grabPanelHideSelected = false;
let automaticCourseScopeNavigationTimer = null;
let automaticCourseScopeNavigationInFlight = false;
let automaticCourseScopeNavigationInFlightToken = null;
let automaticCourseScopeNavigationGeneration = 0;
const automaticCourseScopeLastAttempt = new Map();
const automaticCourseScopeLastAttemptRunId = new Map();

function invalidateAutomaticCourseScopeNavigation() {
  automaticCourseScopeNavigationGeneration += 1;
  if (automaticCourseScopeNavigationTimer !== null) {
    clearTimeout(automaticCourseScopeNavigationTimer.timeoutId ?? automaticCourseScopeNavigationTimer);
    automaticCourseScopeNavigationTimer = null;
  }
  automaticCourseScopeNavigationInFlight = false;
  automaticCourseScopeNavigationInFlightToken = null;
}

function automaticCourseScopeNavigationToken() {
  return {
    generation: automaticCourseScopeNavigationGeneration,
    runId: Math.max(0, Number(latestGrabPageState?.runId) || 0)
  };
}

function isAutomaticCourseScopeNavigationActive(token) {
  if (!token || token.generation !== automaticCourseScopeNavigationGeneration) return false;
  if (!latestGrabPageState?.running) return false;
  const currentRunId = Math.max(0, Number(latestGrabPageState.runId) || 0);
  return currentRunId === token.runId;
}

function missingCourseScopesForState(source) {
  const missingScopes = new Set();
  if (!source?.running) return missingScopes;
  const runtimeTargets = Array.isArray(source.configuredTargets) && source.configuredTargets.length > 0
    ? source.configuredTargets
    : configuredGrabTargets;
  for (const target of runtimeTargets) {
    const state = source.targetStates?.[target.targetId];
    if (state && String(state.lastMessage || '').includes('课程分类')) {
      const scope = target.queryScope || target.teachingClassType;
      if (scope) missingScopes.add(scope);
    }
  }
  return missingScopes;
}

function readGrabPanelPreference(key) {
  try {
    return globalThis.localStorage?.getItem(key) || null;
  } catch {
    return null;
  }
}

function writeGrabPanelPreference(key, value) {
  try {
    globalThis.localStorage?.setItem(key, String(value));
  } catch {}
}

function removeGrabPanelPreference(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {}
}

function isGrabSelectedTarget(target, state) {
  return state?.targetStates?.[target?.targetId]?.phase === 'SELECTED';
}

function isGrabPanelEditableStopped(state) {
  return !state?.running && state?.phase !== 'PAUSED_AUTH' && !state?.authRecovery?.pending;
}

function isGrabAuthRecoveryActive(state) {
  return state?.phase === 'PAUSED_AUTH' || Boolean(state?.authRecovery?.pending);
}

function grabTargetIdSetMatches(left, right) {
  const leftIds = new Set((Array.isArray(left) ? left : []).map(target => String(target?.targetId || '')).filter(Boolean));
  const rightIds = new Set((Array.isArray(right) ? right : []).map(target => String(target?.targetId || '')).filter(Boolean));
  return leftIds.size === rightIds.size && [...leftIds].every(targetId => rightIds.has(targetId));
}

function readGrabPanelBooleanPreference(key) {
  return readGrabPanelPreference(key) === 'true';
}

function showGrabPanelFeedback(message, tone = 'info') {
  const panel = grabPageStatusPanel;
  const node = panel?.querySelector?.('[data-nju-grab-panel-feedback]');
  if (!node) return;
  if (message && !grabPageStatusExpanded) setGrabPageStatusExpanded(true);
  node.textContent = String(message || '');
  node.dataset.tone = tone;
  node.hidden = !message;
  if (grabPanelFeedbackTimer) clearTimeout(grabPanelFeedbackTimer);
  grabPanelFeedbackTimer = setTimeout(() => {
    if (node) node.hidden = true;
    grabPanelFeedbackTimer = null;
  }, 3500);
}

function buildGrabDiagnosticSummary(state) {
  const source = state && typeof state === 'object' ? state : {};
  const scan = source.lastScan && typeof source.lastScan === 'object' ? source.lastScan : {};
  const targetStates = source.targetStates && typeof source.targetStates === 'object'
    ? Object.values(source.targetStates) : [];
  const counts = {
    configured: Math.max(0, Number(source.initialTargetCount) || Number(source.configuredTargets?.length) || 0),
    remaining: Math.max(0, Number(source.remainingTargets?.length) || 0),
    selected: targetStates.filter(item => item?.phase === 'SELECTED').length,
    retrying: Math.max(0, Number(source.retryingTargetCount) || 0)
  };
  return [
    `phase=${String(source.phase || 'STOPPED')}`,
    `running=${Boolean(source.running)}`,
    `round=${Math.max(0, Number(source.round) || 0)}`,
    `counts=${counts.configured}/${counts.remaining}/${counts.selected}/${counts.retrying}`,
    `scanMode=${String(scan.mode || 'NONE')}`,
    `outcome=${String(scan.outcome || source.lastTransientOutcome || 'NONE')}`,
    `timing=${Math.max(0, Number(source.lastRoundDurationMs) || Number(scan.durationMs) || 0)}ms`
  ].join('\n');
}

function copyGrabDiagnosticSummary() {
  const summary = buildGrabDiagnosticSummary(latestGrabPageState || getStateSnapshot?.() || {});
  try {
    const result = globalThis.navigator?.clipboard?.writeText?.(summary);
    if (result?.then) {
      return result.then(() => {
        showGrabPanelFeedback('已复制脱敏诊断摘要', 'success');
        return { ok: true, summary };
      }).catch(() => {
        showGrabPanelFeedback('复制失败，请检查浏览器剪贴板权限', 'danger');
        return { ok: false, code: 'CLIPBOARD_FAILED', message: '复制失败，请检查浏览器剪贴板权限' };
      });
    }
  } catch {}
  showGrabPanelFeedback('复制失败，请检查浏览器剪贴板权限', 'danger');
  return Promise.resolve({ ok: false, code: 'CLIPBOARD_FAILED', message: '复制失败，请检查浏览器剪贴板权限' });
}

async function persistGrabInterval(intervalMs) {
  const interval = GRAB_INTERVAL_PRESETS.includes(Number(intervalMs)) ? Number(intervalMs) : 5000;
  if (!chrome.storage?.local) return interval;
  const stored = await chrome.storage.local.get([GRAB_TASK_CONFIG_KEY, 'nju_grab_courses', 'nju_grab_interval']);
  const current = grabTaskModel.normalizeTaskConfig(stored[GRAB_TASK_CONFIG_KEY], {
    legacyCourseText: stored.nju_grab_courses,
    intervalMs: stored.nju_grab_interval
  });
  await chrome.storage.local.set({
    [GRAB_TASK_CONFIG_KEY]: { ...current, intervalMs: interval, updatedAt: Date.now() },
    nju_grab_interval: interval
  });
  configuredGrabInterval = interval;
  return interval;
}

function grabPageScanLabel(scan) {
  if (!scan || typeof scan !== 'object') return '查询通道待命';
  const compared = Math.max(0, Number(scan.shadowComparison?.comparisonCount) || 0);
  const mismatched = Math.max(0, Number(scan.shadowComparison?.mismatchedComparisonCount) || 0);
  const comparison = compared > 0
    ? ` · 核对 ${compared}${mismatched > 0 ? `/差异 ${mismatched}` : '/一致'}`
    : '';
  if (scan.mode === 'NETWORK') {
    const deferred = Math.max(0, Number(scan.deferredTargetCount) || 0);
    const scoped = Math.max(0, Number(scan.scopeDeferredTargetCount) || 0);
    const waits = [
      deferred > 0 ? `${deferred} 个下轮分批` : '',
      scoped > 0 ? `${scoped} 个等待分类` : ''
    ].filter(Boolean).join(' · ');
    return waits ? `接口查询 · ${waits}${comparison}` : `接口查询${comparison}`;
  }
  if (scan.mode === 'NETWORK_WITH_DOM') {
    const materialized = Math.max(0, Number(scan.materializedQueryCount) || 0);
    return materialized > 0 ? `接口命中 · 精确物化${comparison}` : `接口查询 · 页面校验${comparison}`;
  }
  if (scan.mode === 'DOM_FALLBACK') return 'DOM 兼容扫描';
  if (scan.mode === 'ERROR') return '查询暂时异常';
  return '查询通道待命';
}

function grabPageTargetPresentation(state, running, timing = {}) {
  if (!state || typeof state !== 'object') {
    return { label: '待启动', detail: '', tone: 'idle' };
  }
  const detail = String(state.lastMessage || '').trim();
  const currentTime = Number(timing.currentTime) || Date.now();
  const nextRunAt = Math.max(0, Number(timing.nextRunAt) || 0);
  const secondsHint = timestamp => timestamp > currentTime
    ? `${Math.max(1, Math.ceil((timestamp - currentTime) / 1000))}s 后`
    : '';
  const nextCheck = secondsHint(nextRunAt);
  if (state.phase === 'SELECTED') return { label: '已选', detail: detail || '已二次确认选课结果', tone: 'success' };
  if (state.phase === 'READY') return { label: '发现余量', detail: detail || '等待进入提交', tone: 'active' };
  if (state.phase === 'SUBMITTING') return { label: '提交中', detail: detail || '正在等待服务端结果', tone: 'active' };
  if (state.phase === 'VERIFYING') return { label: '验证中', detail: detail || '正在二次确认选课结果', tone: 'active' };
  if (state.phase === 'RETRY') {
    const retryHint = secondsHint(Math.max(0, Number(state.retryAt) || 0));
    return {
      label: '等待重试',
      detail: retryHint ? `${retryHint}自动重试` : detail || '临时错误退避中',
      tone: 'warning'
    };
  }
  if (state.phase === 'SKIPPED') return { label: '同组完成', detail: detail || '课程组已满足要求', tone: 'muted' };
  if (state.phase === 'BLOCKED') return { label: '需处理', detail: detail || '存在不可恢复限制', tone: 'danger' };
  if (!running) return { label: '待启动', detail: '', tone: 'idle' };
  if (detail.includes('课程分类发现余量')) return { label: '切页提交', detail, tone: 'warning' };
  if (detail.includes('其他课程分类')) return { label: '跨页待查', detail, tone: 'muted' };
  if (detail.includes('课程分类')) return { label: '等待分类', detail, tone: 'muted' };
  if (state.lastOutcome === 'FULL') {
    return {
      label: '已满监控',
      detail: nextCheck ? `当前无余量，${nextCheck}再次检查` : detail || '当前无余量，继续监控',
      tone: 'warning'
    };
  }
  if (state.lastOutcome === 'NOT_FOUND') {
    return {
      label: '暂未找到',
      detail: nextCheck ? `${nextCheck}再次查找` : detail || '等待下一轮查询',
      tone: 'muted'
    };
  }
  if (detail.includes('分批查询')) return { label: '分批待查', detail, tone: 'muted' };
  return {
    label: '监控中',
    detail: nextCheck ? `${nextCheck}检查` : detail || '等待下一轮查询',
    tone: 'active'
  };
}

function grabPageSummaryPresentation(state, currentTime = Date.now()) {
  const source = state && typeof state === 'object' ? state : {};
  const runtimeTargets = Array.isArray(source.configuredTargets) ? source.configuredTargets : [];
  const isTerminalSnapshot = ['COMPLETED', 'FAILED'].includes(source.phase);
  const useRuntimeConfig = Boolean(source.running) || isGrabAuthRecoveryActive(source)
    || (isTerminalSnapshot && runtimeTargets.length > 0
      && grabTargetIdSetMatches(runtimeTargets, configuredGrabTargets));
  const configuredCount = useRuntimeConfig
    && runtimeTargets.length > 0 ? runtimeTargets.length : configuredGrabTargets.length;
  const configuredGroupCount = useRuntimeConfig
    ? Math.max(0, Number(source.totalGroups) || configuredCount)
    : Math.max(0, configuredGrabGroups.length || configuredCount);
  const round = Math.max(0, Number(source.round) || 0);
  const globalRetryAt = Math.max(0, Number(source.globalRetryAt) || 0);
  const nextRetryAt = Math.max(0, Number(source.nextRetryAt) || 0);
  const retryingTargetCount = Math.max(0, Number(source.retryingTargetCount) || 0);
  const nextRunAt = Math.max(0, Number(source.nextRunAt) || 0);
  const secondsUntil = timestamp => Math.max(1, Math.ceil((timestamp - currentTime) / 1000));

  const authView = grabAuthPresentation.present(source, { groupCount: configuredGroupCount });
  if (authView) {
    return {
      title: authView.title,
      subtitle: authView.subtitle,
      tone: authView.tone
    };
  }
  if (source.running) {
    if (globalRetryAt > currentTime) {
      return {
        title: `暂时退避 · ${secondsUntil(globalRetryAt)}s`,
        subtitle: `${grabPageScanLabel(source.lastScan)} · 不会重复提交`,
        tone: 'warning'
      };
    }
    if (source.inFlight) {
      return {
        title: '正在检查课程',
        subtitle: `第 ${round} 轮 · ${grabPageScanLabel(source.lastScan)}`,
        tone: 'active'
      };
    }
    if (nextRetryAt > currentTime && retryingTargetCount > 0) {
      return {
        title: '课程监控运行中 · 部分退避',
        subtitle: `${retryingTargetCount} 个目标等待重试，其余目标继续检查`,
        tone: 'warning'
      };
    }
    
    const activeStates = Object.values(source.targetStates || {}).filter(s => s.phase !== 'SKIPPED' && s.phase !== 'SELECTED');
    const isAllOutOfScope = activeStates.length > 0 && activeStates.every(s => String(s.lastMessage || '').includes('课程分类'));
    if (isAllOutOfScope) {
      return {
        title: '等待跳转到课程分类',
        subtitle: '请点击下方带下划线的状态，或手动切换选课页签',
        tone: 'warning'
      };
    }
    return {
      title: '课程监控运行中',
      subtitle: nextRunAt > currentTime
        ? `第 ${round} 轮 · ${secondsUntil(nextRunAt)}s 后检查`
        : `第 ${round} 轮 · 准备下一次检查`,
      tone: 'active'
    };
  }
  if (source.phase === 'COMPLETED' && useRuntimeConfig) {
    return { title: '课程组已完成', subtitle: '选课结果已经二次确认', tone: 'success' };
  }
  if (source.phase === 'FAILED' && useRuntimeConfig) {
    return { title: '任务需要处理', subtitle: '请查看目标状态并调整配置', tone: 'danger' };
  }
  return {
    title: configuredCount > 0 ? `已配置 ${configuredCount} 门课程` : '课程监控待启动',
    subtitle: configuredCount > 0 ? '尚未监控 · 准备就绪' : '先在课程旁加入目标',
    tone: 'idle'
  };
}

function setGrabPageStatusExpanded(expanded) {
  grabPageStatusExpanded = Boolean(expanded);
  if (!grabPageStatusPanel) return;
  const mini = grabPageStatusPanel.classList.contains('is-mini');
  grabPageStatusPanel.classList.toggle('is-expanded', grabPageStatusExpanded);
  const toggle = grabPageStatusPanel.querySelector('[data-nju-grab-status-toggle]');
  const body = grabPageStatusPanel.querySelector('[data-nju-grab-status-body]');
  toggle?.setAttribute('aria-expanded', String(!mini && grabPageStatusExpanded));
  if (body) body.hidden = mini || !grabPageStatusExpanded;
}

function dismissGrabPanelMiniTutorial(panel) {
  const tooltip = panel?.querySelector?.('.nju-grab-tutorial-tooltip');
  tooltip?.remove?.();
  panel?.querySelector?.('.nju-grab-resize-handle-l')?.classList.remove('is-tutoring');
  writeGrabPanelPreference(GRAB_PANEL_MINI_TUTORIAL_KEY, '1');
}

function setGrabPanelMiniMode(panel, mini, { dismissTutorial = false } = {}) {
  if (!panel) return;
  const enabled = Boolean(mini);
  panel.classList.toggle('is-mini', enabled);
  const toggle = panel.querySelector('[data-nju-grab-status-toggle]');
  const body = panel.querySelector('[data-nju-grab-status-body]');
  const miniButton = panel.querySelector('[data-nju-grab-mini]');
  toggle?.setAttribute('aria-expanded', String(!enabled && grabPageStatusExpanded));
  toggle?.setAttribute('aria-label', enabled ? '展开课程监控面板' : '折叠或展开课程监控状态');
  miniButton?.setAttribute('aria-pressed', String(enabled));
  if (body) body.hidden = enabled || !grabPageStatusExpanded;
  if (dismissTutorial) dismissGrabPanelMiniTutorial(panel);
}

function revealGrabPageStatusPanel() {
  const panel = grabPageStatusPanel;
  if (!panel) return null;
  panel.style.display = '';
  const restore = document.getElementById?.('nju-grab-restore-btn');
  restore?.remove?.();
  setGrabPageStatusExpanded(true);
  return panel;
}

function hideGrabPageStatusPanel() {
  const panel = grabPageStatusPanel;
  if (!panel) return false;
  closeGrabMoreMenuPortal();
  closeGrabTargetMenuPortal();
  panel.style.display = 'none';
  let restoreBtn = document.getElementById?.('nju-grab-restore-btn');
  if (!restoreBtn && document.createElement) {
    restoreBtn = document.createElement('button');
    restoreBtn.id = 'nju-grab-restore-btn';
    restoreBtn.type = 'button';
    restoreBtn.title = '恢复课程监控面板';
    restoreBtn.setAttribute('aria-label', '恢复课程监控面板');
    restoreBtn.textContent = '◉';
    Object.assign(restoreBtn.style, {
      position: 'fixed', bottom: '24px', right: '24px', width: '44px', height: '44px',
      borderRadius: '50%', background: '#ffffff', border: '1px solid rgba(0,0,0,0.08)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', cursor: 'pointer', color: '#007aff', zIndex: '2147483647'
    });
    restoreBtn.addEventListener('click', () => {
      restoreBtn.remove();
      panel.style.display = '';
      setGrabPageStatusExpanded(true);
    });
    document.body?.appendChild(restoreBtn);
  }
  return true;
}

function resetGrabPanelPositionAndSize(panel) {
  removeGrabPanelPreference(GRAB_PANEL_WIDTH_KEY);
  removeGrabPanelPreference(GRAB_PANEL_HEIGHT_KEY);
  panel?.style?.removeProperty?.('--nju-panel-width');
  panel?.style?.removeProperty?.('--nju-panel-height');
  panel?.style?.removeProperty?.('transform');
  if (panel) panel.dataset.lastTopClick = '0';
  showGrabPanelFeedback('面板位置和尺寸已重置', 'success');
}

function closeGrabTargetMenuPortal({ restoreFocus = false } = {}) {
  const trigger = openGrabTargetMenuTrigger;
  openGrabTargetMenu?.remove?.();
  openGrabTargetMenu = null;
  openGrabTargetMenuTrigger = null;
  trigger?.setAttribute?.('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus?.();
}

function closeGrabMoreMenuPortal() {
  if (grabMoreMenu) grabMoreMenu.hidden = true;
  grabMoreButton?.setAttribute?.('aria-expanded', 'false');
}

function openGrabTargetMenuPortal(target, trigger) {
  closeGrabMoreMenuPortal();
  closeGrabTargetMenuPortal();
  const menu = document.createElement('div');
  menu.className = 'nju-grab-target-menu';
  menu.setAttribute('role', 'menu');
  const scope = target?.queryScope || target?.teachingClassType;
  if (scope) {
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.setAttribute('role', 'menuitem');
    jump.textContent = `前往${courseScopeLabel(scope)}分类`;
    jump.addEventListener('click', event => {
      event.preventDefault();
      closeGrabTargetMenuPortal();
      jumpToCourseTab(scope, true);
    });
    menu.appendChild(jump);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'nju-grab-target-remove';
  remove.setAttribute('role', 'menuitem');
  remove.textContent = '移除监控';
  remove.setAttribute('aria-label', `移除监控目标：${grabTaskModel.targetLabel(target)}`);
  remove.addEventListener('click', event => {
    event.preventDefault();
    closeGrabTargetMenuPortal();
    requestGrabTargetRemoval(target, trigger);
  });
  menu.appendChild(remove);
  document.body?.appendChild(menu);
  openGrabTargetMenu = menu;
  openGrabTargetMenuTrigger = trigger;
  trigger?.setAttribute?.('aria-expanded', 'true');
  const rect = trigger?.getBoundingClientRect?.();
  if (rect) {
    const viewportHeight = Number(globalThis.innerHeight) || 800;
    const viewportWidth = Number(globalThis.innerWidth) || 1200;
    const menuHeight = 90;
    const menuWidth = 150;
    menu.style.top = `${Math.max(8, rect.bottom + menuHeight > viewportHeight ? rect.top - menuHeight - 4 : rect.bottom + 4)}px`;
    menu.style.left = `${Math.max(8, Math.min(viewportWidth - menuWidth - 8, rect.right - menuWidth))}px`;
  }
  menu.querySelector('button')?.focus?.();
}

function removeGrabPageStatusPanel() {
  if (grabPageStatusTimer) clearTimeout(grabPageStatusTimer);
  grabPageStatusTimer = null;
  if (grabPanelFeedbackTimer) clearTimeout(grabPanelFeedbackTimer);
  grabPanelFeedbackTimer = null;
  grabPageStatusPanel?.remove();
  grabMoreMenu?.remove?.();
  grabMoreMenu = null;
  grabMoreButton = null;
  document.getElementById?.('nju-grab-restore-btn')?.remove?.();
  if (grabPanelDismissHandlers) {
    document.removeEventListener('pointerdown', grabPanelDismissHandlers.pointerdown);
    document.removeEventListener('keydown', grabPanelDismissHandlers.keydown);
    if (typeof globalThis.window?.removeEventListener === 'function') {
      globalThis.window.removeEventListener('scroll', grabPanelDismissHandlers.dismissFloatingMenus, true);
      globalThis.window.removeEventListener('resize', grabPanelDismissHandlers.dismissFloatingMenus);
    }
    grabPanelDismissHandlers = null;
  }
  closeGrabTargetMenuPortal();
  grabPageStatusPanel = null;
}

function removeGrabPageTargetControls() {
  if (grabTargetDecorateTimer) clearTimeout(grabTargetDecorateTimer);
  grabTargetDecorateTimer = null;
  document.querySelectorAll(`.${GRAB_TARGET_BUTTON_CLASS}`).forEach(button => button.remove());
  document.querySelectorAll('.nju-grab-enhanced').forEach(row => row.classList.remove('nju-grab-enhanced'));
  document.querySelectorAll('.nju-grab-enhanced-row').forEach(row => row.classList.remove('nju-grab-enhanced-row'));
  document.querySelectorAll('.nju-grab-card-actions').forEach(actions => actions.classList.remove('nju-grab-card-actions'));
}

function removeGrabPageEnhancements() {
  removeGrabPageStatusPanel();
  removeGrabPageTargetControls();
}

async function setGrabPageEnhancementsEnabled(enabled, options = {}) {
  grabPageEnhancementsEnabled = Boolean(enabled);
  if (!grabPageEnhancementsEnabled) removeGrabPageEnhancements();
  if (options.persist !== false && chrome.storage?.local) {
    await chrome.storage.local.set({ [GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY]: grabPageEnhancementsEnabled });
  }
  if (grabPageEnhancementsEnabled) {
    updateGrabPageStatus(latestGrabPageState || {});
    decorateCourseTargets();
  }
}

function ensureGrabPageStatusPanel() {
  if (grabPageStatusPanel?.isConnected) return grabPageStatusPanel;
  if (!grabPageEnhancementsEnabled || !isGrabCoursePage()
    || !document.body || typeof document.createElement !== 'function') return null;
  const panel = document.createElement('aside');
  panel.className = GRAB_PAGE_STATUS_CLASS;
  panel.setAttribute('aria-label', '课程监控状态');
  panel.innerHTML = `
    <div class="nju-grab-pill-grabber" data-resize="top"></div>
    <div class="nju-grab-resize-handle-l" data-resize="left" title="双击收起为胶囊"></div>
    <div class="nju-grab-status-head">
      <button class="nju-grab-status-toggle" type="button" data-nju-grab-status-toggle aria-expanded="false">
        <svg class="nju-grab-drag-handle" aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="opacity: 0.3; cursor: grab;"><path d="M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/></svg>
        <span class="nju-grab-radar-dot" aria-hidden="true"></span>
        <span class="nju-grab-status-copy" aria-live="polite">
          <strong data-nju-grab-status-title>课程监控待启动</strong>
          <span data-nju-grab-status-subtitle>先在课程旁加入目标</span>
        </span>
        <span class="nju-grab-status-chevron" aria-hidden="true"></span>
      </button>
      <div class="nju-grab-status-actions">
         <button class="nju-grab-control-btn" type="button" data-nju-grab-control aria-label="开始监控"></button>
         <button class="nju-grab-minimize-btn" type="button" data-nju-grab-mini aria-label="收起为胶囊" aria-pressed="false" title="收起为胶囊">−</button>
         <button class="nju-grab-more-btn" type="button" data-nju-grab-more aria-expanded="false" aria-haspopup="menu" aria-label="更多课程监控操作" title="更多">•••</button>
         <button class="nju-grab-status-close" type="button" data-nju-grab-status-close aria-label="隐藏面板" title="隐藏课程监控面板">×</button>
         <div class="nju-grab-more-menu" data-nju-grab-more-menu role="menu" hidden>
           <button type="button" role="menuitem" data-nju-grab-import-favorites>导入当前收藏页课程</button>
           <button type="button" role="menuitem" data-nju-grab-toggle-selected>隐藏已选目标</button>
           <button type="button" role="menuitem" data-nju-grab-copy-diagnostic>复制脱敏诊断摘要</button>
           <button type="button" role="menuitem" data-nju-grab-reset-panel>重置面板位置和尺寸</button>
           <button type="button" role="menuitem" data-nju-grab-hide-panel>隐藏面板</button>
           <button type="button" role="menuitem" data-nju-grab-disable-enhancements class="is-destructive">关闭选课页增强</button>
         </div>
      </div>
    </div>
    <div class="nju-grab-status-body" data-nju-grab-status-body hidden>
       <div class="nju-grab-status-metrics">
        <span><strong data-nju-grab-status-progress>0/0</strong><small>课程组</small></span>
        <span><strong data-nju-grab-status-round>0</strong><small>检测轮次</small></span>
         <span><strong data-nju-grab-status-channel>待命</strong><small>底层状态</small></span>
       </div>
       <div class="nju-grab-command-bar" data-nju-grab-command-bar>
         <button type="button" class="nju-grab-now-btn" data-nju-grab-run-now>立即检查</button>
         <label>间隔 <select data-nju-grab-interval aria-label="监控间隔">
           <option value="3000">3 秒</option><option value="5000">5 秒</option><option value="10000">10 秒</option><option value="30000">30 秒</option>
         </select></label>
         <span data-nju-grab-next-check>下次检查：—</span>
       </div>
       <div class="nju-grab-panel-feedback" data-nju-grab-panel-feedback hidden role="status"></div>
      <div class="nju-grab-missing-scopes" data-nju-grab-missing-scopes hidden></div>
      <div class="nju-grab-status-targets" data-nju-grab-status-targets></div>
      <div class="nju-grab-remove-confirm" data-nju-grab-remove-confirm hidden>
        <span data-nju-grab-remove-message>移除目标需要先停止全部监控。</span>
        <button type="button" data-nju-grab-remove-cancel>取消</button>
        <button type="button" data-nju-grab-remove-stop>停止并移除</button>
      </div>
    </div>`;
  let wasDragged = false;
  let isDragging = false;
  let startX = 0, startY = 0;
  let currentTranslateX = 0, currentTranslateY = 0;
  const savedWidth = readGrabPanelPreference(GRAB_PANEL_WIDTH_KEY);
  const savedHeight = readGrabPanelPreference(GRAB_PANEL_HEIGHT_KEY);
  if (savedWidth) panel.style.setProperty('--nju-panel-width', savedWidth + 'px');
  if (savedHeight) panel.style.setProperty('--nju-panel-height', savedHeight + 'px');

  panel.addEventListener('pointerdown', e => {
    const resizeHandle = e.target.closest('[data-resize]');
    if (!resizeHandle) return;

    e.preventDefault();
    e.stopPropagation();

    const type = resizeHandle.dataset.resize;
    const initialWidth = panel.offsetWidth;
    const initialHeight = panel.offsetHeight;
    
    // Check for double click on top handle
    if (type === 'top') {
      const now = Date.now();
      if (panel.dataset.lastTopClick && (now - Number(panel.dataset.lastTopClick)) < 300) {
        // Double click: toggle between auto and 90vh
        const isExpanded = panel.style.getPropertyValue('--nju-panel-height') === '90vh';
        panel.style.setProperty('--nju-panel-height', isExpanded ? 'auto' : '90vh');
        removeGrabPanelPreference(GRAB_PANEL_HEIGHT_KEY);
        if (!isExpanded && !grabPageStatusExpanded) {
          setGrabPageStatusExpanded(true);
        }
        panel.dataset.lastTopClick = '0';
        return;
      }
      panel.dataset.lastTopClick = String(now);
    }
    
    // Check for double click on left handle to toggle Mini Mode
    if (type === 'left') {
      const now = Date.now();
      if (panel.dataset.lastLeftClick && (now - Number(panel.dataset.lastLeftClick)) < 300) {
        setGrabPanelMiniMode(panel, !panel.classList.contains('is-mini'), { dismissTutorial: true });
        panel.dataset.lastLeftClick = '0';
        return;
      }
      panel.dataset.lastLeftClick = String(now);
    }

    const startX = e.clientX;
    const startY = e.clientY;
    
    panel.setPointerCapture(e.pointerId);
    
    const onPointerMove = moveEvent => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      
      if (type === 'left') {
        const newWidth = Math.max(340, Math.min(800, initialWidth - dx));
        panel.style.setProperty('--nju-panel-width', newWidth + 'px');
        writeGrabPanelPreference(GRAB_PANEL_WIDTH_KEY, newWidth);
      }
      
      if (type === 'top') {
        // Dragging top UP (negative dy) INCREASES the height since bottom is fixed
        const newHeight = Math.max(120, initialHeight - dy);
        panel.style.setProperty('--nju-panel-height', newHeight + 'px');
        writeGrabPanelPreference(GRAB_PANEL_HEIGHT_KEY, newHeight);
        
        if (!grabPageStatusExpanded && newHeight > 100) {
          setGrabPageStatusExpanded(true);
        }
      }
    };
    
    const onPointerUp = () => {
      panel.releasePointerCapture(e.pointerId);
      panel.removeEventListener('pointermove', onPointerMove);
      panel.removeEventListener('pointerup', onPointerUp);
      panel.removeEventListener('pointercancel', onPointerUp);
    };
    
    panel.addEventListener('pointermove', onPointerMove);
    panel.addEventListener('pointerup', onPointerUp);
    panel.addEventListener('pointercancel', onPointerUp);
  });

  const head = panel.querySelector('.nju-grab-status-head');
  head.addEventListener('pointerdown', e => {
    const isControlBtn = !!e.target.closest('button:not(.nju-grab-status-toggle)');
    if (isControlBtn) return;

    isDragging = false;
    wasDragged = false;
    startX = e.clientX - currentTranslateX;
    startY = e.clientY - currentTranslateY;
    head.setPointerCapture(e.pointerId);

    const rect = panel.getBoundingClientRect();
    const baseLeft = rect.left - currentTranslateX;
    const baseTop = rect.top - currentTranslateY;
    const baseWidth = rect.width;
    
    // Bounds constraints
    const minDy = -baseTop + 12; 
    const maxDy = window.innerHeight - 40 - baseTop;
    const maxDx = window.innerWidth - 40 - baseLeft;
    const minDx = 40 - baseWidth - baseLeft;

    const onPointerMove = moveEvent => {
      let rawDx = moveEvent.clientX - startX;
      let rawDy = moveEvent.clientY - startY;
      
      const dx = Math.max(minDx, Math.min(rawDx, maxDx));
      const dy = Math.max(minDy, Math.min(rawDy, maxDy));

      if (!isDragging && (Math.abs(dx - currentTranslateX) > 3 || Math.abs(dy - currentTranslateY) > 3)) {
        isDragging = true;
        wasDragged = true;
        panel.style.transition = 'none';
      }
      if (isDragging) {
        currentTranslateX = dx;
        currentTranslateY = dy;
        panel.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      }
    };

    const onPointerUp = upEvent => {
      head.releasePointerCapture(e.pointerId);
      head.removeEventListener('pointermove', onPointerMove);
      head.removeEventListener('pointerup', onPointerUp);
      head.removeEventListener('pointercancel', onPointerUp);

      if (isDragging) {
        panel.style.transition = '';
        setTimeout(() => wasDragged = false, 150);
      }
    };

    head.addEventListener('pointermove', onPointerMove);
    head.addEventListener('pointerup', onPointerUp);
    head.addEventListener('pointercancel', onPointerUp);
  });

  panel.querySelector('[data-nju-grab-status-toggle]')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (wasDragged) return;
    if (panel.classList.contains('is-mini')) {
      setGrabPanelMiniMode(panel, false);
      return;
    }
    setGrabPageStatusExpanded(!grabPageStatusExpanded);
  });
  panel.querySelector('[data-nju-grab-mini]')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setGrabPanelMiniMode(panel, true, { dismissTutorial: true });
    panel.querySelector('[data-nju-grab-status-toggle]')?.focus?.();
  });
  panel.querySelector('[data-nju-grab-control]')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const currentState = latestGrabPageState || getStateSnapshot();
    const isRunning = Boolean(currentState?.running);
    if (isRunning || isGrabAuthRecoveryActive(currentState)) {
      stopGrab();
      renderGrabPageStatus(getStateSnapshot());
    } else {
      chrome.storage.local.get([GRAB_TASK_CONFIG_KEY, 'nju_grab_courses', 'nju_grab_interval']).then(stored => {
        const config = grabTaskModel.normalizeTaskConfig(stored[GRAB_TASK_CONFIG_KEY], {
          legacyCourseText: stored.nju_grab_courses,
          intervalMs: stored.nju_grab_interval
        });
        const interval = Number(stored.nju_grab_interval) || config.intervalMs || 5000;
        if (config.targets.length === 0) {
          alert('请先添加课程目标');
          return;
        }
        startGrab(config, interval);
        renderGrabPageStatus(getStateSnapshot());
      }).catch(error => {
        alert('启动失败：' + error.message);
      });
    }
  });
  panel.querySelector('[data-nju-grab-run-now]')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const result = runNowGrab();
    if (result?.message) showGrabPanelFeedback(result.message, result.ok ? 'success' : 'warning');
  });
  panel.querySelector('[data-nju-grab-interval]')?.addEventListener('change', async event => {
    const select = event.target;
    const currentState = latestGrabPageState || getStateSnapshot();
    if (!isGrabPanelEditableStopped(currentState)) {
      select.value = String(currentState.interval || 5000);
      showGrabPanelFeedback(currentState?.authRecovery?.pending || currentState?.phase === 'PAUSED_AUTH'
        ? '登录恢复中不能修改监控间隔' : '运行中不能修改监控间隔', 'warning');
      return;
    }
    try {
      const interval = await persistGrabInterval(select.value);
      showGrabPanelFeedback(`已保存监控间隔：${interval / 1000} 秒`, 'success');
    } catch (error) {
      showGrabPanelFeedback(`保存间隔失败：${error?.message || '未知错误'}`, 'danger');
    }
  });
  const moreButton = panel.querySelector('[data-nju-grab-more]');
  const moreMenu = panel.querySelector('[data-nju-grab-more-menu]');
  grabMoreButton = moreButton;
  grabMoreMenu = moreMenu;
  const closeMoreMenu = ({ restoreFocus = false } = {}) => {
    if (!moreMenu) return;
    moreMenu.hidden = true;
    moreButton?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) moreButton?.focus?.();
  };
  moreButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (!moreMenu) return;
    if (moreMenu.hidden) closeGrabTargetMenuPortal();
    moreMenu.hidden = !moreMenu.hidden;
    moreButton.setAttribute('aria-expanded', String(!moreMenu.hidden));
    if (!moreMenu.hidden) {
      if (moreMenu.parentElement !== document.body) document.body?.appendChild(moreMenu);
      const rect = moreButton.getBoundingClientRect?.();
      if (rect) {
        const viewportHeight = Number(globalThis.innerHeight) || 800;
        const viewportWidth = Number(globalThis.innerWidth) || 1200;
        const menuHeight = 260;
        const menuWidth = 210;
        moreMenu.style.top = `${Math.max(8, rect.bottom + menuHeight > viewportHeight ? rect.top - menuHeight - 4 : rect.bottom + 4)}px`;
        moreMenu.style.left = `${Math.max(8, Math.min(viewportWidth - menuWidth - 8, rect.right - menuWidth))}px`;
      }
    }
    if (!moreMenu.hidden) moreMenu.querySelector('[role="menuitem"]')?.focus?.();
  });
  panel.querySelector('[data-nju-grab-import-favorites]')?.addEventListener('click', async () => {
    closeMoreMenu();
    if (!isGrabPanelEditableStopped(latestGrabPageState || getStateSnapshot())
      || normalizeCourseScope(currentCourseQueryScope(document.body)) !== 'SC') {
      showGrabPanelFeedback('仅可在停止态的收藏页导入课程', 'warning');
      return;
    }
    try {
      const result = await importFavoriteCourseTargets();
      showGrabPanelFeedback(result?.message || (result?.ok ? '已导入当前收藏课程' : '导入收藏课程失败'), result?.ok ? 'success' : 'danger');
    } catch (error) {
      showGrabPanelFeedback(`导入失败：${error?.message || '未知错误'}`, 'danger');
    }
  });
  panel.querySelector('[data-nju-grab-toggle-selected]')?.addEventListener('click', () => {
    grabPanelHideSelected = !grabPanelHideSelected;
    writeGrabPanelPreference(GRAB_PANEL_HIDE_SELECTED_KEY, grabPanelHideSelected);
    closeMoreMenu();
    renderGrabPageStatus(latestGrabPageState || {});
  });
  panel.querySelector('[data-nju-grab-copy-diagnostic]')?.addEventListener('click', () => {
    closeMoreMenu();
    void copyGrabDiagnosticSummary();
  });
  panel.querySelector('[data-nju-grab-reset-panel]')?.addEventListener('click', () => {
    closeMoreMenu();
    currentTranslateX = 0;
    currentTranslateY = 0;
    wasDragged = false;
    isDragging = false;
    resetGrabPanelPositionAndSize(panel);
  });
  panel.querySelector('[data-nju-grab-disable-enhancements]')?.addEventListener('click', () => {
    closeMoreMenu();
    void setGrabPageEnhancementsEnabled(false);
  });
  panel.querySelector('[data-nju-grab-hide-panel]')?.addEventListener('click', () => {
    closeMoreMenu();
    hideGrabPageStatusPanel();
  });
  const dismissPointerdown = event => {
    if (moreMenu && !moreMenu.hidden
      && !event.target?.closest?.('.nju-grab-more-btn')
      && !event.target?.closest?.('.nju-grab-more-menu')) {
      closeMoreMenu();
    }
    if (openGrabTargetMenu && !event.target?.closest?.('.nju-grab-target-actions')
      && !event.target?.closest?.('.nju-grab-target-menu')) {
      closeGrabTargetMenuPortal();
    }
  };
  const dismissKeydown = event => {
    if (event.key === 'Escape') {
      closeMoreMenu({ restoreFocus: true });
      closeGrabTargetMenuPortal({ restoreFocus: true });
    }
  };
  const dismissFloatingMenus = () => {
    closeMoreMenu();
    closeGrabTargetMenuPortal();
  };
  if (typeof globalThis.window?.addEventListener === 'function') {
    globalThis.window.addEventListener('scroll', dismissFloatingMenus, true);
    globalThis.window.addEventListener('resize', dismissFloatingMenus);
  }
  document.addEventListener('pointerdown', dismissPointerdown);
  document.addEventListener('keydown', dismissKeydown);
  grabPanelDismissHandlers = { pointerdown: dismissPointerdown, keydown: dismissKeydown, dismissFloatingMenus };
  panel.querySelector('[data-nju-grab-status-close]')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    hideGrabPageStatusPanel();
  });
  panel.querySelector('[data-nju-grab-remove-cancel]')?.addEventListener('click', () => {
    if (pendingGrabRemoval?.processing) return;
    pendingGrabRemoval = null;
    const confirm = panel.querySelector('[data-nju-grab-remove-confirm]');
    if (confirm) confirm.hidden = true;
  });
  panel.querySelector('[data-nju-grab-remove-stop]')?.addEventListener('click', () => {
    void confirmGrabTargetRemoval();
  });
  document.body.appendChild(panel);
  grabPageStatusPanel = panel;
  panel.querySelector('[data-nju-grab-status-close]')?.setAttribute('aria-label', '隐藏面板');
  panel.querySelector('[data-nju-grab-status-close]')?.setAttribute('title', '隐藏课程监控面板');
  setGrabPageStatusExpanded(grabPageStatusExpanded);

  if (!readGrabPanelPreference(GRAB_PANEL_MINI_TUTORIAL_KEY)) {
    const tooltip = document.createElement('div');
    tooltip.className = 'nju-grab-tutorial-tooltip';
    tooltip.setAttribute('role', 'status');
    tooltip.textContent = '点“−”或双击边缘收起';
    panel.appendChild(tooltip);
    panel.querySelector('.nju-grab-resize-handle-l')?.classList.add('is-tutoring');
  }

  return panel;
}

function renderGrabPageStatus(state) {
  latestGrabPageState = state && typeof state === 'object' ? state : null;
  const source = latestGrabPageState || {};
  const missingScopes = missingCourseScopesForState(source);
  if (!grabPageEnhancementsEnabled) {
    removeGrabPageEnhancements();
    if (source.running && missingScopes.size > 0) {
      scheduleAutomaticCourseScopeNavigation(missingScopes);
    } else {
      invalidateAutomaticCourseScopeNavigation();
    }
    return;
  }
  const panel = ensureGrabPageStatusPanel();
  if (!panel) {
    if (source.running && missingScopes.size > 0) {
      scheduleAutomaticCourseScopeNavigation(missingScopes);
    } else {
      invalidateAutomaticCourseScopeNavigation();
    }
    return;
  }
  const currentTime = Date.now();
  const summary = grabPageSummaryPresentation(source, currentTime);
  const runId = Math.max(0, Number(source.runId) || 0);
  if (source.running && runId > 0 && grabPageStatusAutoExpandedRunId !== runId) {
    grabPageStatusAutoExpandedRunId = runId;
    setGrabPageStatusExpanded(true);
  }
  panel.dataset.tone = summary.tone;
  panel.classList.toggle('is-scanning', Boolean(source.running && source.inFlight));
  panel.querySelector('[data-nju-grab-status-title]').textContent = summary.title;
  panel.querySelector('[data-nju-grab-status-subtitle]').textContent = summary.subtitle;

  const runtimeSnapshotTargets = Array.isArray(source.configuredTargets)
    ? source.configuredTargets : [];
  const isTerminalSnapshot = ['COMPLETED', 'FAILED'].includes(source.phase);
  const useRuntimeConfig = isGrabAuthRecoveryActive(source) || Boolean(source.running)
    || (isTerminalSnapshot && runtimeSnapshotTargets.length > 0
      && grabTargetIdSetMatches(runtimeSnapshotTargets, configuredGrabTargets));

  const controlBtn = panel.querySelector('[data-nju-grab-control]');
  if (controlBtn) {
    if (source.running || isGrabAuthRecoveryActive(source)) {
      controlBtn.textContent = source.running ? '停止' : '停止恢复';
      controlBtn.setAttribute('aria-label', source.running ? '停止监控' : '停止登录恢复');
      controlBtn.className = 'nju-grab-control-btn is-running';
    } else {
      controlBtn.textContent = '开始监控';
      controlBtn.setAttribute('aria-label', '开始监控');
      controlBtn.className = 'nju-grab-control-btn';
    }
  }

  const runNowButton = panel.querySelector('[data-nju-grab-run-now]');
  if (runNowButton) {
    const retryingAllTargets = Number(source.retryingTargetCount) > 0
      && Number(source.retryingTargetCount) >= Math.max(1, Number(source.remainingTargets?.length) || Number(source.initialTargetCount) || 1)
      && Number(source.nextRetryAt) > currentTime;
    const globallyBackingOff = Number(source.globalRetryAt) > currentTime;
    const blocked = source.inFlight || globallyBackingOff || retryingAllTargets;
    runNowButton.hidden = !source.running;
    runNowButton.disabled = blocked;
    runNowButton.textContent = source.inFlight ? '正在检查'
      : globallyBackingOff || retryingAllTargets ? '退避中'
        : '立即检查';
    runNowButton.title = source.inFlight ? '正在检查课程，请稍候'
      : globallyBackingOff ? '课程查询正在退避，请稍候'
        : retryingAllTargets ? '所有目标都在等待重试，请稍候'
          : '立即检查一轮课程';
  }
  const intervalSelect = panel.querySelector('[data-nju-grab-interval]');
  if (intervalSelect) {
    const interval = source.running ? Number(source.interval) || configuredGrabInterval : configuredGrabInterval;
    const intervalIsPreset = GRAB_INTERVAL_PRESETS.includes(interval);
    if (!intervalIsPreset) {
      let currentOption = intervalSelect.querySelector('[data-nju-grab-current-interval]');
      if (!currentOption && typeof document.createElement === 'function') {
        currentOption = document.createElement('option');
        currentOption.setAttribute('data-nju-grab-current-interval', 'true');
        currentOption.disabled = true;
        intervalSelect.appendChild(currentOption);
      }
      if (currentOption) {
        currentOption.value = String(interval);
        currentOption.textContent = `当前值 ${Math.max(1, Math.round(interval / 1000))} 秒`;
      }
    } else {
      intervalSelect.querySelector('[data-nju-grab-current-interval]')?.remove?.();
    }
    intervalSelect.value = String(intervalIsPreset ? interval : Math.max(0, interval));
    intervalSelect.disabled = !isGrabPanelEditableStopped(source);
  }
  const nextCheck = panel.querySelector('[data-nju-grab-next-check]');
  if (nextCheck) {
    const nextTimestamp = Math.max(Number(source.globalRetryAt) || 0, Number(source.nextRetryAt) || 0, Number(source.nextRunAt) || 0);
    const seconds = nextTimestamp > currentTime ? Math.max(1, Math.ceil((nextTimestamp - currentTime) / 1000)) : 0;
    const retryingAllTargets = Number(source.retryingTargetCount) > 0
      && Number(source.retryingTargetCount) >= Math.max(1, Number(source.remainingTargets?.length) || Number(source.initialTargetCount) || 1)
      && Number(source.nextRetryAt) > currentTime;
    nextCheck.textContent = source.inFlight ? '正在检查…'
      : Number(source.globalRetryAt) > currentTime ? `退避中 · ${seconds}s 后恢复`
        : retryingAllTargets ? `全体退避中 · ${seconds}s 后恢复`
        : source.phase === 'PAUSED_AUTH' ? '等待登录恢复'
          : seconds > 0 ? `下次检查：${seconds}s 后` : source.running ? '下次检查：准备中' : '下次检查：启动后检查';
  }
  const menuRoot = grabMoreMenu || panel.querySelector('[data-nju-grab-more-menu]');
  const importButton = menuRoot?.querySelector?.('[data-nju-grab-import-favorites]');
  if (importButton) {
    const isFavoriteScope = normalizeCourseScope(currentCourseQueryScope(document.body)) === 'SC';
    importButton.hidden = !isFavoriteScope;
    importButton.disabled = !isGrabPanelEditableStopped(source) || !isFavoriteScope;
  }
  const toggleSelected = menuRoot?.querySelector?.('[data-nju-grab-toggle-selected]');
  if (toggleSelected) toggleSelected.textContent = grabPanelHideSelected ? '显示已选目标' : '隐藏已选目标';

  const configuredGroupCount = configuredGrabGroups.length || configuredGrabTargets.length;
  const totalGroups = Math.max(0, useRuntimeConfig
    ? Number(source.totalGroups) || configuredGroupCount
    : configuredGroupCount);
  const completedGroups = useRuntimeConfig
    ? Math.min(totalGroups, Math.max(0, Number(source.completedGroups) || 0)) : 0;
  const authView = grabAuthPresentation.present(source, { groupCount: totalGroups });
  panel.querySelector('[data-nju-grab-status-progress]').textContent = `${completedGroups}/${totalGroups}`;
  panel.querySelector('[data-nju-grab-status-round]').textContent = String(Math.max(0, Number(source.round) || 0));
  panel.querySelector('[data-nju-grab-status-channel]').textContent = grabPageScanLabel(source.lastScan)
    .replace(' · ', ' / ');

  const runtimeTargets = useRuntimeConfig && runtimeSnapshotTargets.length > 0
    ? runtimeSnapshotTargets : configuredGrabTargets;

  const scopesContainer = panel.querySelector('[data-nju-grab-missing-scopes]');
  const hasMissingScope = missingScopes.size > 0;
  
  if (source.running) {
    if (hasMissingScope) {
      const scopeKey = Array.from(missingScopes).sort().join(',');
      
      clearNativeCourseTabHighlights();
      missingScopes.forEach(scope => highlightNativeCourseTab(scope));
      
      if (scopesContainer.dataset.scopeKey !== scopeKey) {
        scopesContainer.dataset.scopeKey = scopeKey;
        scopesContainer.replaceChildren();
        missingScopes.forEach(scope => {
          const displayScope = courseScopeLabel(scope);
          const btn = document.createElement('button');
          btn.className = 'nju-grab-quick-jump-btn';
          btn.type = 'button';
          btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; display: inline-block; vertical-align: middle; margin-top: -2px;"><path d="M5 12h14M12 5l7 7-7 7"/></svg>切至「${displayScope}」`;
          
          btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            jumpToCourseTab(scope, true);
          });
          scopesContainer.appendChild(btn);
        });
      }
    }
  }
  
  if (!hasMissingScope) {
    clearNativeCourseTabHighlights();
    delete scopesContainer.dataset.scopeKey;
    scopesContainer.replaceChildren();
  }
  scopesContainer.hidden = !hasMissingScope;
  if (source.running && hasMissingScope) {
    scheduleAutomaticCourseScopeNavigation(missingScopes);
  } else {
    invalidateAutomaticCourseScopeNavigation();
  }

  const targetContainer = panel.querySelector('[data-nju-grab-status-targets]');
  targetContainer.replaceChildren();
  const visibleRuntimeTargets = runtimeTargets.filter(target => !(grabPanelHideSelected && isGrabSelectedTarget(target, source)));
  if (visibleRuntimeTargets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'nju-grab-status-empty';
    empty.textContent = grabPanelHideSelected && runtimeTargets.length > 0
      ? '已隐藏已选目标（监控配置未改变）。'
      : '在课程行点击“加入监控”，目标状态会显示在这里。';
    targetContainer.appendChild(empty);
  } else {
    for (const target of runtimeTargets) {
      const targetState = source.targetStates?.[target.targetId] || null;
      if (grabPanelHideSelected && isGrabSelectedTarget(target, source)) continue;
      const presentation = authView?.target || grabPageTargetPresentation(
        targetState,
        Boolean(source.running),
        { currentTime, nextRunAt: source.nextRunAt }
      );
      const item = document.createElement('div');
      item.className = 'nju-grab-status-target';
      item.dataset.tone = presentation.tone;
      const indicator = document.createElement('span');
      indicator.className = 'nju-grab-target-dot';
      indicator.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'nju-grab-target-copy';
      const name = document.createElement('strong');
      name.textContent = target.name || '教学班';

      const extraDetails = target.kind === 'KEYWORD' ? [
        target.filters?.teacher ? `教师 ${target.filters.teacher}` : '',
        target.filters?.time ? `时间 ${target.filters.time}` : '',
        target.filters?.campus ? `校区 ${target.filters.campus}` : ''
      ] : [
        target.teacher,
        target.time,
        target.campus,
        target.teachingClassNo && target.teachingClassNo.length <= 6 ? `班次 ${target.teachingClassNo}` : ''
      ];
      const extraText = extraDetails.filter(Boolean).join(' · ');
      
      const meta = document.createElement('span');
      meta.className = 'nju-grab-target-meta';
      meta.textContent = extraText || '暂无详细信息';
      
      const copyNodes = [name, meta];
      if (presentation.detail) {
        const statusText = document.createElement('span');
        statusText.className = 'nju-grab-target-status';
        statusText.textContent = presentation.detail;
        
        if (presentation.label === '等待分类' || presentation.label === '跨页待查' || presentation.label === '切页提交') {
          item.style.cursor = 'pointer';
          item.title = '点击尝试自动切换到目标分类';
          statusText.style.textDecoration = 'underline';
          statusText.style.textDecorationStyle = 'dashed';
          item.addEventListener('click', (e) => {
              if (e.target.closest('.nju-grab-target-remove')) return;
              let scope = target.queryScope || target.teachingClassType;
              if (!scope) return;
              jumpToCourseTab(scope, true);
          });
        }
        copyNodes.push(statusText);
      }
      copy.append(...copyNodes);
      const badge = document.createElement('span');
      badge.className = 'nju-grab-target-badge';
      badge.textContent = presentation.label;
       const targetMenuButton = document.createElement('button');
       targetMenuButton.type = 'button';
       targetMenuButton.className = 'nju-grab-target-menu-trigger';
       targetMenuButton.textContent = '•••';
       targetMenuButton.title = '目标操作';
       targetMenuButton.setAttribute('aria-label', `目标操作：${grabTaskModel.targetLabel(target)}`);
       targetMenuButton.setAttribute('aria-expanded', 'false');
       targetMenuButton.setAttribute('aria-haspopup', 'menu');
        targetMenuButton.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (openGrabTargetMenuTrigger === targetMenuButton) {
            closeGrabTargetMenuPortal({ restoreFocus: true });
            return;
          }
          openGrabTargetMenuPortal(target, targetMenuButton);
        });
        // Keep a hidden semantic fallback for keyboard/legacy integrations;
        // the visible row action is always the explicit ••• menu above.
        const semanticRemove = document.createElement('button');
        semanticRemove.type = 'button';
        semanticRemove.className = 'nju-grab-target-remove';
        semanticRemove.hidden = true;
        semanticRemove.textContent = '移除监控';
        semanticRemove.setAttribute('aria-label', `移除监控目标：${grabTaskModel.targetLabel(target)}`);
        semanticRemove.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          requestGrabTargetRemoval(target, semanticRemove);
        });
        const actions = document.createElement('div');
        actions.className = 'nju-grab-target-actions';
        actions.append(badge, targetMenuButton, semanticRemove);
      item.append(indicator, copy, actions);
      targetContainer.appendChild(item);
    }
  }

  if (grabPageStatusTimer) clearTimeout(grabPageStatusTimer);
  grabPageStatusTimer = null;
  const nextTimestamp = Math.max(
    Number(source.globalRetryAt) || 0,
    Number(source.nextRetryAt) || 0,
    Number(source.nextRunAt) || 0
  );
  if (source.running && nextTimestamp > currentTime) {
    grabPageStatusTimer = setTimeout(() => updateGrabPageStatus(latestGrabPageState), 1000);
  }
  scheduleCourseTargetDecoration();
}

function clearNativeCourseTabHighlights() {
  document.querySelectorAll('.nju-grab-native-glow').forEach(el => el.classList.remove('nju-grab-native-glow'));
}

function updateGrabPageStatus(state) {
  try {
    renderGrabPageStatus(state);
    grabPageStatusErrorReported = false;
  } catch (error) {
    if (!grabPageStatusErrorReported) {
      grabPageStatusErrorReported = true;
      console.warn('[AutoGrab] 页面状态面板更新失败，抢课任务继续运行', error);
    }
  }
}

function requestGrabTargetRemoval(target, button = null) {
  if (!target) return { ok: false, code: 'INVALID_TARGET' };
  const state = typeof getStateSnapshot === 'function' ? getStateSnapshot() : latestGrabPageState;
  if (state?.running || state?.authRecovery?.pending) {
    if (pendingGrabRemoval?.processing) return;
    pendingGrabRemoval = { target, button, stopped: false, processing: false };
    const panel = ensureGrabPageStatusPanel();
    revealGrabPageStatusPanel();
    const confirm = panel?.querySelector?.('[data-nju-grab-remove-confirm]');
    if (confirm) {
      confirm.hidden = false;
      confirm.querySelector('[data-nju-grab-remove-message]').textContent = `移除“${target.name || '教学班'}”需要先停止全部监控。`;
      const stopButton = confirm.querySelector('[data-nju-grab-remove-stop]');
      if (stopButton) {
        stopButton.disabled = false;
        stopButton.textContent = '停止并移除';
      }
      setGrabPageStatusExpanded(true);
      confirm.querySelector('[data-nju-grab-remove-cancel]')?.focus?.();
    }
    return { ok: true, code: 'CONFIRM_REQUIRED' };
  }
  void removeConfiguredGrabTarget(target, button);
  return { ok: true, code: 'REMOVING' };
}

function updateGrabRemovalConfirmation({ hidden = false, message, error = false, processing = false, retry = false } = {}) {
  const confirm = grabPageStatusPanel?.querySelector?.('[data-nju-grab-remove-confirm]');
  if (!confirm) return;
  confirm.hidden = hidden;
  if (message) {
    const messageNode = confirm.querySelector('[data-nju-grab-remove-message]');
    if (messageNode) {
      messageNode.textContent = message;
      messageNode.classList?.toggle('is-error', Boolean(error));
    }
  }
  const stopButton = confirm.querySelector('[data-nju-grab-remove-stop]');
  if (stopButton) {
    stopButton.disabled = Boolean(processing);
    stopButton.textContent = retry ? '重试移除' : '停止并移除';
  }
  const cancelButton = confirm.querySelector('[data-nju-grab-remove-cancel]');
  if (cancelButton) cancelButton.disabled = Boolean(processing);
  if (!hidden) setGrabPageStatusExpanded(true);
}

async function confirmGrabTargetRemoval() {
  const pending = pendingGrabRemoval;
  if (!pending || pending.processing) return;
  pending.processing = true;
  updateGrabRemovalConfirmation({ processing: true });
  if (!pending.stopped) {
    stopGrab();
    pending.stopped = true;
  }
  const result = await removeConfiguredGrabTarget(pending.target, null);
  if (result?.ok) {
    pendingGrabRemoval = null;
    updateGrabRemovalConfirmation({ hidden: true });
    return;
  }
  pending.processing = false;
  updateGrabRemovalConfirmation({
    message: `停止成功，但移除“${pending.target.name || '教学班'}”保存失败：${result?.message || '保存失败'}`,
    error: true,
    retry: true
  });
}

function previousCourseRow(element) {
  if (element?.matches?.('.course-tr')) return element;
  let current = element?.closest?.('.course-jxb-container-tr, tr') || element;
  while (current) {
    current = current.previousElementSibling;
    if (current?.matches?.('.course-tr')) return current;
  }
  return element?.closest?.('.course-tr') || null;
}

function firstMetadataText(root, selectors) {
  for (const selector of selectors) {
    const element = root?.querySelector?.(selector);
    const value = element?.getAttribute?.('title') || elementText(element);
    if (value) return value;
  }
  return '';
}

function firstAttribute(elements, names) {
  for (const element of elements.filter(Boolean)) {
    for (const name of names) {
      const value = element.getAttribute?.(name);
      if (value && value !== 'undefined' && value !== 'null') return value;
    }
  }
  return '';
}

function targetFromCourseElement(element) {
  const idElement = element?.querySelector?.([
    '[data-tcid]',
    '[data-teachingclassid]',
    '[data-teaching-class-id]',
    '[data-jxbid]'
  ].join(','));
  const teachingClassId = extractTeachingClassId(element, idElement);
  if (!teachingClassId) return null;

  const courseRow = previousCourseRow(element) || element;
  const courseName = firstMetadataText(courseRow, [
    '.kcmc', '.cv-course-name', '.cv-kcmc', '[data-field="KCMC"]', '[class*="course-name"]'
  ]) || firstMetadataText(element, ['.kcmc', '.cv-course-name', '.cv-kcmc']);
  const courseNumber = extractCourseNumber(element, idElement) || extractCourseNumber(courseRow, idElement);
  const teachingClassNo = firstAttribute([element, idElement], [
    'data-teachingclassno', 'data-teaching-class-no', 'data-jxbh', 'data-class-number'
  ]) || firstMetadataText(element, ['.jxbh', '[data-field="JXBH"]', '[class*="class-number"]']);
  const courseId = firstAttribute([courseRow, element, idElement], [
    'data-courseid', 'data-course-id', 'data-kcid'
  ]);
  const typedChoiceElement = [...(element?.querySelectorAll?.('.cv-choice') || [])]
    .find(candidate => {
      const value = candidate.getAttribute?.('data-teachingclasstype');
      return value && value !== 'undefined' && value !== 'null';
    });
  const explicitTypeElement = [element, idElement].find(candidate => {
    const value = candidate?.getAttribute?.('data-teachingclasstype');
    return value && value !== 'undefined' && value !== 'null';
  });

  return grabTaskModel.normalizeTarget({
    kind: grabTaskModel.TARGET_KIND.TEACHING_CLASS,
    name: courseName,
    electiveBatchId: currentElectiveBatchId(),
    teachingClassType: currentTeachingClassType(typedChoiceElement || explicitTypeElement || idElement),
    teachingClassId,
    queryScope: currentCourseQueryScope(element),
    courseId,
    courseNumber,
    teachingClassNo,
    teacher: firstMetadataText(element, [
      '.jxb-title', '.jsmc', '.skjs', '[data-field="JSXM"]', '[data-field="SKJS"]', '[class*="teacher"]'
    ]),
    time: firstMetadataText(element, ['.sjdd', '.sksj', '[data-field="SKSJ"]', '[class*="course-time"]']),
    campus: firstMetadataText(element, ['.xq', '.xqmc', '[data-field="XQMC"]', '[class*="campus"]'])
  });
}

function exactTargetIdentityMatches(left, right) {
  return left?.kind === grabTaskModel.TARGET_KIND.TEACHING_CLASS
    && right?.kind === grabTaskModel.TARGET_KIND.TEACHING_CLASS
    && String(left.electiveBatchId || '').trim()
    && String(right.electiveBatchId || '').trim()
    && String(left.electiveBatchId) === String(right.electiveBatchId)
    && String(left.teachingClassId || '').trim() === String(right.teachingClassId || '').trim();
}

function matchingConfiguredGrabTarget(pageTarget) {
  if (!pageTarget) return null;
  const exact = configuredGrabTargets.find(target => target.targetId === pageTarget.targetId);
  if (exact) return exact;
  const stableExact = configuredGrabTargets.find(target => exactTargetIdentityMatches(target, pageTarget));
  if (stableExact) return stableExact;
  return configuredGrabTargets.find(target => {
    return target.kind === grabTaskModel.TARGET_KIND.KEYWORD
      && grabTaskModel.targetMatchesCourse(target, {
        name: pageTarget.name,
        text: pageTarget.name,
        courseNumber: pageTarget.courseNumber
      })
      && grabTaskModel.targetAcceptsCandidate(target, pageTarget);
  }) || null;
}

function collectFavoriteCourseTargets() {
  const targets = [];
  const seenTargetIds = new Set();
  for (const row of document.querySelectorAll('.course-tr')) {
    if (!row.querySelector?.('.cv-delete-favorite')) continue;
    const target = targetFromCourseElement(row);
    if (!target || seenTargetIds.has(target.targetId)) continue;
    seenTargetIds.add(target.targetId);
    targets.push(target);
  }
  return targets;
}

async function importFavoriteCourseTargets() {
  if (!isGrabCoursePage()) {
    return { ok: false, code: 'NOT_COURSE_PAGE', message: '请先进入实际选课页面并打开“收藏”列表' };
  }
  const state = typeof getStateSnapshot === 'function' ? getStateSnapshot() : latestGrabPageState;
  if (state?.running || state?.authRecovery?.pending) {
    return { ok: false, code: 'TASK_RUNNING', message: '请先停止当前监控，再修改课程目标' };
  }

  const discoveredTargets = collectFavoriteCourseTargets();
  if (discoveredTargets.length === 0) {
    return {
      ok: false,
      code: 'NO_FAVORITES_VISIBLE',
      message: '当前页未发现收藏课程，请先打开“收藏”并等待课程列表加载完成'
    };
  }

  const stored = await chrome.storage.local.get([
    GRAB_TASK_CONFIG_KEY,
    'nju_grab_courses',
    'nju_grab_interval'
  ]);
  const current = grabTaskModel.normalizeTaskConfig(stored[GRAB_TASK_CONFIG_KEY], {
    legacyCourseText: stored.nju_grab_courses,
    intervalMs: stored.nju_grab_interval
  });
  const discoveredByTargetId = new Map(discoveredTargets.map(target => [target.targetId, target]));
  const discoveredForTarget = target => discoveredByTargetId.get(target.targetId)
    || discoveredTargets.find(discovered => exactTargetIdentityMatches(discovered, target))
    || null;
  let enrichedCount = 0;
  const enrichedGroups = current.groups.map(group => ({
    ...group,
    targets: group.targets.map(target => {
      const discovered = discoveredForTarget(target);
      if (!discovered) return target;
      const enriched = {
        ...target,
        teachingClassType: discovered.teachingClassType || target.teachingClassType,
        queryScope: discovered.queryScope || target.queryScope,
        courseId: discovered.courseId || target.courseId,
        courseNumber: discovered.courseNumber || target.courseNumber,
        teachingClassNo: discovered.teachingClassNo || target.teachingClassNo,
        teacher: discovered.teacher || target.teacher,
        time: discovered.time || target.time,
        campus: discovered.campus || target.campus
      };
      const changed = [
        'teachingClassType', 'queryScope', 'courseId', 'courseNumber',
        'teachingClassNo', 'teacher', 'time', 'campus'
      ].some(key => enriched[key] !== target[key]);
      if (!changed) return target;
      enrichedCount += 1;
      return enriched;
    })
  }));
  const wasExisting = discovered => current.targets.some(target => {
    return target.targetId === discovered.targetId || exactTargetIdentityMatches(target, discovered);
  });
  let next = enrichedCount > 0
    ? grabTaskModel.normalizeTaskConfig({ ...current, groups: enrichedGroups, updatedAt: Date.now() })
    : current;
  for (const target of discoveredTargets) next = grabTaskModel.addTargetToTaskConfig(next, target);

  const savedTargetIds = new Set(next.targets.map(target => target.targetId));
  const existingCount = discoveredTargets.filter(wasExisting).length;
  const addedCount = discoveredTargets.filter(target => {
    return !wasExisting(target) && savedTargetIds.has(target.targetId);
  }).length;
  const capacitySkippedCount = Math.max(0, discoveredTargets.length - existingCount - addedCount);
  if (addedCount > 0 || enrichedCount > 0) {
    await chrome.storage.local.set({ [GRAB_TASK_CONFIG_KEY]: next });
  }

  configuredGrabTargetIds = savedTargetIds;
  configuredGrabTargets = next.targets.slice();
  configuredGrabGroups = next.groups.slice();
  updateGrabPageStatus(latestGrabPageState || {});
  return {
    ok: true,
    discoveredCount: discoveredTargets.length,
    addedCount,
    enrichedCount,
    existingCount,
    capacitySkippedCount,
    totalTargetCount: next.targets.length
  };
}

function updateGrabTargetButton(button, target) {
  const configuredTarget = matchingConfiguredGrabTarget(target);
  const added = Boolean(configuredTarget);
  const exactConfiguredTarget = exactTargetIdentityMatches(configuredTarget, target);
  const running = Boolean(latestGrabPageState?.running);
  const targetState = configuredTarget
    ? latestGrabPageState?.targetStates?.[configuredTarget.targetId] || null
    : null;
  const runtimePresentation = exactConfiguredTarget && running
    ? grabPageTargetPresentation(targetState, true)
    : null;
  const presentation = exactConfiguredTarget
    ? {
      label: running
        ? `${runtimePresentation.label.replace('已满监控', '已满').replace('等待重试', '监控中')} · 移除`
        : '移除监控',
      detail: running
        ? `${runtimePresentation.detail}；请先停止监控后移除`
        : '点击移除此精确教学班监控目标',
      tone: running ? runtimePresentation.tone : 'remove'
    }
    : added
    ? grabPageTargetPresentation(targetState, running)
    : { label: '加入监控', detail: '将此教学班加入目标', tone: 'idle' };
  button.dataset.targetId = target.targetId;
  if (configuredTarget) button.dataset.configuredTargetId = configuredTarget.targetId;
  else delete button.dataset.configuredTargetId;
  const hasNativeDom = Boolean(button.ownerDocument?.createElement);
  if (hasNativeDom && exactConfiguredTarget) {
    button.innerHTML = `<span class="nju-grab-state-label" data-nju-grab-state-label>${presentation.label.replace(/ · 移除$/, '')}</span><span class="nju-grab-remove-label" data-nju-grab-remove-label>移除监控</span>`;
  } else if (!hasNativeDom || !exactConfiguredTarget) {
    button.textContent = presentation.label;
  }
  button.classList.toggle('is-added', added);
  button.classList.toggle('is-exact-removable', exactConfiguredTarget);
  button.classList.toggle('is-active', added && presentation.tone === 'active');
  button.classList.toggle('is-selected', added && presentation.tone === 'success');
  button.classList.toggle('is-warning', added && presentation.tone === 'warning');
  button.classList.toggle('is-blocked', added && presentation.tone === 'danger');
  button.classList.toggle('is-muted', added && presentation.tone === 'muted');
  button.classList.toggle('is-remove', added && presentation.tone === 'remove');
  button.classList.remove('is-loading');
  // Keep the control clickable after adding: the same exact target can be removed.
  button.disabled = added && !exactConfiguredTarget;
  button.removeAttribute('aria-busy');
  button.title = added ? presentation.detail : '';
  button.setAttribute('aria-label', `${presentation.label}：${grabTaskModel.targetLabel(target)}${added ? `；${presentation.detail}` : ''}`);
}

async function addConfiguredGrabTarget(target, button) {
  if (!target || matchingConfiguredGrabTarget(target)) return;
  button.disabled = true;
  button.classList.add('is-loading');
  button.setAttribute('aria-busy', 'true');
  button.textContent = '添加中…';
  try {
    const stored = await chrome.storage.local.get([
      GRAB_TASK_CONFIG_KEY,
      'nju_grab_courses',
      'nju_grab_interval'
    ]);
    const current = grabTaskModel.normalizeTaskConfig(stored[GRAB_TASK_CONFIG_KEY], {
      legacyCourseText: stored.nju_grab_courses,
      intervalMs: stored.nju_grab_interval
    });
    const next = grabTaskModel.addTargetToTaskConfig(current, target);
    await chrome.storage.local.set({ [GRAB_TASK_CONFIG_KEY]: next });
    configuredGrabTargetIds = new Set(next.targets.map(item => item.targetId));
    configuredGrabTargets = next.targets.slice();
    configuredGrabGroups = next.groups.slice();
    updateGrabTargetButton(button, target);
    updateGrabPageStatus(latestGrabPageState || {});
    sendGrabRuntimeMessage({ action: 'grabTargetAdded', target });
  } catch (error) {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    button.textContent = '重试添加';
    console.warn('[AutoGrab] 保存教学班目标失败', error);
  }
}

async function removeConfiguredGrabTarget(target, button) {
  if (!target) return { ok: false, code: 'INVALID_TARGET' };
  const configuredTarget = matchingConfiguredGrabTarget(target);
  if (!configuredTarget) {
    if (button) updateGrabTargetButton(button, target);
    return { ok: true, removed: false };
  }
  const state = typeof getStateSnapshot === 'function' ? getStateSnapshot() : latestGrabPageState;
  if (state?.running || state?.authRecovery?.pending) {
    const message = '请先停止当前监控，再移除课程目标';
    if (button) {
      button.title = message;
      button.setAttribute?.('aria-label', message);
    }
    requestGrabTargetRemoval(configuredTarget, button);
    return { ok: false, code: 'TASK_RUNNING', message };
  }
  if (button) {
    button.disabled = true;
    button.classList?.add('is-loading');
    button.textContent = '移除中…';
  }
  try {
    const stored = await chrome.storage.local.get([
      GRAB_TASK_CONFIG_KEY,
      'nju_grab_courses',
      'nju_grab_interval'
    ]);
    const current = grabTaskModel.normalizeTaskConfig(stored[GRAB_TASK_CONFIG_KEY], {
      legacyCourseText: stored.nju_grab_courses,
      intervalMs: stored.nju_grab_interval
    });
    const next = grabTaskModel.removeTargetFromTaskConfig(current, configuredTarget.targetId);
    await chrome.storage.local.set({ [GRAB_TASK_CONFIG_KEY]: next });
    configuredGrabTargetIds = new Set(next.targets.map(item => item.targetId));
    configuredGrabTargets = next.targets.slice();
    configuredGrabGroups = next.groups.slice();
    if (button) updateGrabTargetButton(button, target);
    updateGrabPageStatus(latestGrabPageState || {});
    scheduleCourseTargetDecoration();
    sendGrabRuntimeMessage({ action: 'grabTargetRemoved', targetId: configuredTarget.targetId });
    return { ok: true, removed: true };
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.classList?.remove('is-loading');
      button.textContent = '重试移除';
    }
    console.warn('[AutoGrab] 移除教学班目标失败', error);
    return { ok: false, code: 'SAVE_FAILED', message: error?.message || '保存失败' };
  }
}

function grabTargetButtonContainer(row) {
  const anchor = row.querySelector('.cv-choice, .cv-delete-select, [data-tcid]');
  if (row.matches?.('.jxb-item')) {
    row.classList.add('nju-grab-enhanced');
    const actions = row.querySelector('.buttons') || anchor?.parentElement || row;
    actions.classList?.add('nju-grab-card-actions');
    return actions;
  }

  row.classList.add('nju-grab-enhanced-row');
  return row.querySelector('.cz') || anchor?.parentElement || row.lastElementChild || row;
}

function decorateCourseTargets() {
  if (!grabPageEnhancementsEnabled || !isGrabCoursePage()) return;
  const rows = document.querySelectorAll('.jxb-item, .course-tr');
  for (const row of rows) {
    const target = targetFromCourseElement(row);
    if (!target) continue;
    let button = row.querySelector(`.${GRAB_TARGET_BUTTON_CLASS}`);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = GRAB_TARGET_BUTTON_CLASS;
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const pageTarget = targetFromCourseElement(row);
        const configuredTarget = matchingConfiguredGrabTarget(pageTarget)
          || (button.dataset.configuredTargetId
            ? configuredGrabTargets.find(item => item.targetId === button.dataset.configuredTargetId)
            : null);
        if (configuredTarget) {
          requestGrabTargetRemoval(configuredTarget, button);
        } else if (pageTarget) {
          void addConfiguredGrabTarget(pageTarget, button);
        }
      });
      grabTargetButtonContainer(row).appendChild(button);
    }
    updateGrabTargetButton(button, target);
  }
}

function scheduleCourseTargetDecoration() {
  if (!grabPageEnhancementsEnabled || grabTargetDecorateTimer) return;
  grabTargetDecorateTimer = setTimeout(() => {
    grabTargetDecorateTimer = null;
    decorateCourseTargets();
  }, 80);
}

function handleCourseTargetMutations(records) {
  if (!grabPageEnhancementsEnabled) return;
  const hasPageMutation = Array.from(records || []).some(record => {
    const target = record?.target?.nodeType === 1 ? record.target : record?.target?.parentElement;
    return !target?.closest?.(`.${GRAB_PAGE_STATUS_CLASS}`);
  });
  if (hasPageMutation) scheduleCourseTargetDecoration();
}

async function initializeCourseTargetControls() {
  if (!isGrabCoursePage() || !chrome.storage?.local) return;
  try {
    const stored = await chrome.storage.local.get([
      GRAB_TASK_CONFIG_KEY,
      GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY,
      'nju_grab_courses',
      'nju_grab_interval'
    ]);
    const config = grabTaskModel.normalizeTaskConfig(stored[GRAB_TASK_CONFIG_KEY], {
      legacyCourseText: stored.nju_grab_courses,
      intervalMs: stored.nju_grab_interval
    });
    grabPageEnhancementsEnabled = stored[GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY] !== false;
    grabPanelHideSelected = readGrabPanelBooleanPreference(GRAB_PANEL_HIDE_SELECTED_KEY);
    configuredGrabTargetIds = new Set(config.targets.map(target => target.targetId));
    configuredGrabTargets = config.targets.slice();
    configuredGrabGroups = config.groups.slice();
    configuredGrabInterval = config.intervalMs;
  } catch {
    configuredGrabTargetIds = new Set();
    configuredGrabTargets = [];
    configuredGrabGroups = [];
    configuredGrabInterval = 5000;
  }
  updateGrabPageStatus(typeof getStateSnapshot === 'function' ? getStateSnapshot() : {});
  decorateCourseTargets();
  grabTargetObserver = new MutationObserver(handleCourseTargetMutations);
  grabTargetObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY]) {
      void setGrabPageEnhancementsEnabled(
        changes[GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY].newValue !== false,
        { persist: false }
      );
    }
    if (changes[GRAB_TASK_CONFIG_KEY]) {
      const config = grabTaskModel.normalizeTaskConfig(changes[GRAB_TASK_CONFIG_KEY].newValue);
      configuredGrabTargetIds = new Set(config.targets.map(target => target.targetId));
      configuredGrabTargets = config.targets.slice();
      configuredGrabGroups = config.groups.slice();
      configuredGrabInterval = config.intervalMs;
      updateGrabPageStatus(latestGrabPageState || {});
      scheduleCourseTargetDecoration();
    }
  });
}

function exposeGrabState(state) {
  if (pausedGrabTaskSnapshot && !state?.running) return pausedGrabTaskSnapshot;
  return withGrabAuthRecovery(state);
}

function handleGrabEngineState(state) {
  const recoveryVerified = grabAuthRecovery?.stage === 'VERIFYING'
    && state?.running
    && state.phase === 'RUNNING'
    && !state.inFlight
    && Number(state.round) > grabAuthResumeRound;
  if (recoveryVerified) {
    grabAuthRecovery = null;
    pausedGrabTaskSnapshot = null;
    grabAuthResumeRound = 0;
    sendGrabRuntimeMessage({
      action: 'grabLog',
      message: '🔓 选课登录已恢复，任务已重新验证并继续监控',
      state
    });
  }
  updateGrabPageStatus(exposeGrabState(state));
  persistGrabTaskSnapshot(state);
}

async function beginGrabAuthRecovery(state, options = {}) {
  cancelGrabAuthRecoveryWatch();
  const taskId = activeGrabTaskId;
  const currentTime = Date.now();
  const previous = normalizeGrabAuthRecovery(grabAuthRecovery || state?.authRecovery);
  const withinRecoveryWindow = previous?.startedAt
    && currentTime - previous.startedAt <= GRAB_AUTH_RECOVERY_WINDOW_MS;
  const attempts = Math.min(
    GRAB_AUTH_RECOVERY_MAX_ATTEMPTS + 1,
    (withinRecoveryWindow ? previous.attempts : 0) + 1
  );
  const manualRequired = attempts > GRAB_AUTH_RECOVERY_MAX_ATTEMPTS;
  const returnPath = previous?.returnPath
    || currentGrabCourseReturnPath()
    || '/xsxkapp/sys/xsxkapp/*default/grablessons.do';
  grabAuthRecovery = {
    pending: true,
    stage: manualRequired ? 'MANUAL_REQUIRED' : 'WAITING_LOGIN',
    attempts,
    startedAt: withinRecoveryWindow ? previous.startedAt : currentTime,
    returnPath,
    lastMessage: manualRequired
      ? '登录状态连续失效，已停止自动跳转，请手动完成选课登录'
      : '登录状态已失效，正在转到选课登录页'
  };
  pausedGrabTaskSnapshot = withGrabAuthRecovery(state);
  sendGrabRuntimeMessage({ action: 'grabStopped', state: pausedGrabTaskSnapshot });

  const response = await sendGrabTaskRuntime(pausedGrabTaskSnapshot);
  if (activeGrabTaskId !== taskId || !grabAuthRecovery?.pending) return;
  if (!response?.ok) {
    grabAuthRecovery.stage = 'MANUAL_REQUIRED';
    grabAuthRecovery.lastMessage = '无法保存登录恢复检查点，任务保持暂停，请手动登录后重新启动';
    pausedGrabTaskSnapshot = withGrabAuthRecovery(state);
    sendGrabRuntimeMessage({ action: 'grabStopped', state: pausedGrabTaskSnapshot });
    return;
  }
  if (manualRequired || options.preserveCurrentPage === true || isGrabLoginPage()) return;
  if (!navigateForGrabAuthRecovery(GRAB_AUTH_LOGIN_URL)) {
    grabAuthRecovery.stage = 'MANUAL_REQUIRED';
    grabAuthRecovery.lastMessage = '无法打开选课登录页，请手动完成登录';
    pausedGrabTaskSnapshot = withGrabAuthRecovery(state);
    sendGrabRuntimeMessage({ action: 'grabStopped', state: pausedGrabTaskSnapshot });
  }
}

async function routeGrabAuthRecoveryToPreCoursePage(savedSnapshot) {
  if (['RETURNING', 'ENTERING_COURSE'].includes(grabAuthRecovery?.stage)
    || (location.origin === new URL(GRAB_AUTH_LOGIN_URL).origin && String(location.pathname || '/') === '/')) {
    await requireManualGrabAuthRecovery(savedSnapshot, '登录完成后未识别到选课轮次入口，请手动进入当前选课轮次');
    return;
  }
  grabAuthRecovery.stage = 'RETURNING';
  grabAuthRecovery.lastMessage = '选课登录已完成，正在打开选课轮次预备页';
  pausedGrabTaskSnapshot = withGrabAuthRecovery(savedSnapshot);
  const response = await sendGrabTaskRuntime(pausedGrabTaskSnapshot);
  if (!response?.ok || !grabAuthRecovery?.pending) return;
  if (!navigateForGrabAuthRecovery(GRAB_AUTH_LOGIN_URL)) {
    await requireManualGrabAuthRecovery(savedSnapshot, '无法打开选课轮次预备页，请手动进入当前选课轮次');
  }
}

async function requireManualGrabAuthRecovery(savedSnapshot, message) {
  if (!grabAuthRecovery) return;
  grabAuthRecovery.stage = 'MANUAL_REQUIRED';
  grabAuthRecovery.lastMessage = message;
  pausedGrabTaskSnapshot = withGrabAuthRecovery(savedSnapshot);
  sendGrabRuntimeMessage({ action: 'grabStopped', state: pausedGrabTaskSnapshot });
  await sendGrabTaskRuntime(pausedGrabTaskSnapshot);
}

async function continueGrabAuthRecoveryFromPage(savedSnapshot, taskId, commandVersion) {
  if (activeGrabTaskId !== taskId
    || commandVersion !== grabLifecycleCommandVersion
    || !grabAuthRecovery?.pending) return;
  const checkpoint = pausedGrabTaskSnapshot || savedSnapshot;
  if (grabAuthRecovery.stage === 'MANUAL_REQUIRED' && !isGrabCoursePage()) return;
  if (isGrabPreCoursePage()) {
    if (grabAuthRecovery.stage === 'ENTERING_COURSE') return;
    await enterGrabCourseFromPrePage(checkpoint);
    return;
  }
  if (!isGrabCoursePage()) {
    if (String(location.pathname || '/') === '/') return;
    await routeGrabAuthRecoveryToPreCoursePage(checkpoint);
    return;
  }

  cancelGrabAuthRecoveryWatch();
  grabAuthRecovery = {
    ...grabAuthRecovery,
    pending: false,
    stage: 'VERIFYING',
    lastMessage: '已返回选课页面，正在重新验证任务状态'
  };
  pausedGrabTaskSnapshot = null;
  grabAuthResumeRound = Math.max(0, Number(savedSnapshot.round) || 0);
  grabEngine.restore(savedSnapshot);
}

function watchGrabAuthRecoveryPage(savedSnapshot) {
  cancelGrabAuthRecoveryWatch();
  if (typeof MutationObserver !== 'function') return;

  const taskId = activeGrabTaskId;
  const commandVersion = grabLifecycleCommandVersion;
  const deadline = Date.now() + GRAB_AUTH_LOGIN_TIMEOUT_MS;
  let observer = null;
  let timeoutId = null;
  let handling = false;
  let rerunPending = false;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
    observer?.disconnect?.();
    if (grabAuthRecoveryWatchCancel === cancel) grabAuthRecoveryWatchCancel = null;
  };
  const check = async () => {
    if (cancelled) return;
    if (handling) {
      rerunPending = true;
      return;
    }
    if (activeGrabTaskId !== taskId || commandVersion !== grabLifecycleCommandVersion
      || !grabAuthRecovery?.pending) {
      cancel();
      return;
    }
    const pageStateReady = isGrabCoursePage()
      || (isGrabPreCoursePage() && grabAuthRecovery.stage !== 'ENTERING_COURSE');
    if (!pageStateReady && Date.now() >= deadline) {
      await requireManualGrabAuthRecovery(
        pausedGrabTaskSnapshot || savedSnapshot,
        '登录后未在限定时间内进入当前选课轮次，请手动点击轮次入口'
      );
      cancel();
      return;
    }
    if (!pageStateReady && isGrabLoginPage()) return;
    handling = true;
    try {
      await continueGrabAuthRecoveryFromPage(savedSnapshot, taskId, commandVersion);
    } finally {
      handling = false;
      if (!grabAuthRecovery?.pending || grabAuthRecovery.stage === 'MANUAL_REQUIRED') cancel();
      else if (rerunPending) {
        rerunPending = false;
        void check();
      }
    }
  };

  observer = new MutationObserver(() => { void check(); });
  observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
  timeoutId = setTimeout(() => { void check(); }, Math.max(0, deadline - Date.now()));
  grabAuthRecoveryWatchCancel = cancel;
  void check();
}

async function enterGrabCourseFromPrePage(savedSnapshot) {
  if (grabAuthRecovery?.stage === 'ENTERING_COURSE') {
    await requireManualGrabAuthRecovery(savedSnapshot, '自动进入当前选课轮次后页面未跳转，请手动点击轮次入口');
    return;
  }

  const taskId = activeGrabTaskId;
  const commandVersion = grabLifecycleCommandVersion;
  const button = await waitForGrabPreCourseButton();
  if (activeGrabTaskId !== taskId || commandVersion !== grabLifecycleCommandVersion) return;
  if (!button) {
    await requireManualGrabAuthRecovery(savedSnapshot, '当前选课轮次入口尚不可用，请确认轮次后手动进入');
    return;
  }

  grabAuthRecovery.stage = 'ENTERING_COURSE';
  grabAuthRecovery.lastMessage = '已识别当前选课轮次，正在进入实际选课页面';
  pausedGrabTaskSnapshot = withGrabAuthRecovery(savedSnapshot);
  sendGrabRuntimeMessage({ action: 'grabStopped', state: pausedGrabTaskSnapshot });
  const response = await sendGrabTaskRuntime(pausedGrabTaskSnapshot);
  if (!response?.ok || activeGrabTaskId !== taskId || !grabAuthRecovery?.pending) return;

  const currentButton = currentGrabPreCourseButton();
  if (!currentButton || currentButton !== button) {
    await requireManualGrabAuthRecovery(savedSnapshot, '选课轮次入口在进入前发生变化，请确认后手动进入');
    return;
  }
  try {
    currentButton.click();
  } catch {
    await requireManualGrabAuthRecovery(savedSnapshot, '无法自动进入当前选课轮次，请手动点击轮次入口');
  }
}

const grabCourseProvider = globalThis.NjuGrabCourseProvider && grabModule && grabTaskModel
  ? globalThis.NjuGrabCourseProvider.createCourseProvider({
      document,
      taskModel: grabTaskModel,
      candidateStatus: grabModule.CANDIDATE_STATUS,
      getCurrentQueryScope: () => currentCourseQueryScope(
        document.querySelector('.result-container[data-teachingclasstype], [data-teachingclasstype].result-container')
          || document.body
      ),
      scanDom: scanDomCandidates
    })
  : null;

const grabEngine = grabModule
  ? grabModule.createGrabEngine({
      adapter: {
        scan: grabCourseProvider?.scan || scanDomCandidates,
        attempt: attemptDomCandidate
      },
      onState: handleGrabEngineState,
      onLog: (entry, state) => sendGrabRuntimeMessage({
        action: 'grabLog',
        message: entry,
        state: exposeGrabState(state)
      }),
      onStopped: state => {
        if (state.phase === 'PAUSED_AUTH') {
          void beginGrabAuthRecovery(state);
          return;
        }
        grabAuthRecovery = null;
        pausedGrabTaskSnapshot = null;
        grabAuthResumeRound = 0;
        persistGrabTaskSnapshot(state, { immediate: true });
        sendGrabRuntimeMessage({ action: 'grabStopped', state });
      }
    })
  : null;

if (!grabEngine) console.error('[AutoGrab] grab-engine.js 未加载，抢课模块不可用');

function getStateSnapshot() {
  const state = grabEngine?.getSnapshot() || unavailableGrabSnapshot('抢课引擎未加载');
  return exposeGrabState(state);
}

function startGrab(taskConfig, intervalMs) {
  if (!grabEngine) return getStateSnapshot();
  invalidateAutomaticCourseScopeNavigation();
  cancelGrabAuthRecoveryWatch();
  grabLifecycleCommandVersion += 1;
  grabAuthRecovery = null;
  pausedGrabTaskSnapshot = null;
  grabAuthResumeRound = 0;
  activeGrabTaskId = createGrabTaskId();
  activeGrabTaskRevision = 0;
  activeGrabTaskNeedsClaim = true;
  return grabEngine.start(taskConfig, intervalMs);
}

function stopGrab() {
  if (!grabEngine) return getStateSnapshot();
  invalidateAutomaticCourseScopeNavigation();
  cancelGrabAuthRecoveryWatch();
  grabLifecycleCommandVersion += 1;
  if (pausedGrabTaskSnapshot?.phase === 'PAUSED_AUTH' && grabAuthRecovery?.pending) {
    grabAuthRecovery = null;
    grabAuthResumeRound = 0;
    const stopped = {
      ...pausedGrabTaskSnapshot,
      running: false,
      phase: 'STOPPED',
      authRecovery: null,
      log: [...(pausedGrabTaskSnapshot.log || []), '⏹️ 登录恢复和课程监控已停止'].slice(-50)
    };
    pausedGrabTaskSnapshot = stopped;
    persistGrabTaskSnapshot(stopped, { immediate: true });
    return stopped;
  }
  const snapshot = grabEngine.stop('manual');
  persistGrabTaskSnapshot(snapshot, { immediate: true });
  return snapshot;
}

function runNowGrab() {
  if (!grabEngine?.runNow) {
    const result = { ok: false, code: 'UNAVAILABLE', message: '立即检查暂不可用' };
    showGrabPanelFeedback(result.message, 'warning');
    return result;
  }
  const result = grabEngine.runNow();
  renderGrabPageStatus(getStateSnapshot());
  return result;
}

function revokeGrabTaskLease(taskId) {
  if (!activeGrabTaskId || taskId !== activeGrabTaskId) return getStateSnapshot();
  invalidateAutomaticCourseScopeNavigation();
  grabLifecycleCommandVersion += 1;
  cancelGrabAuthRecoveryWatch();
  const snapshot = grabEngine?.stop('另一个选课标签页已接管') || getStateSnapshot();
  if (grabTaskPersistTimer) clearTimeout(grabTaskPersistTimer);
  grabTaskPersistTimer = null;
  pendingGrabTaskSnapshot = null;
  activeGrabTaskId = '';
  activeGrabTaskNeedsClaim = false;
  grabAuthRecovery = null;
  pausedGrabTaskSnapshot = null;
  grabAuthResumeRound = 0;
  return snapshot;
}

async function restoreGrabTaskFromSession() {
  if (!grabEngine) return;
  const commandVersion = grabLifecycleCommandVersion;
  try {
    const response = await chrome.runtime.sendMessage({ action: GRAB_TASK_RUNTIME_GET });
    const runtime = response?.ok ? response.runtime : null;
    const savedSnapshot = runtime?.snapshot;
    const savedRecovery = normalizeGrabAuthRecovery(savedSnapshot?.authRecovery);
    const recovering = savedSnapshot?.phase === 'PAUSED_AUTH' && savedRecovery?.pending;
    if ((!savedSnapshot?.running && !recovering)
      || commandVersion !== grabLifecycleCommandVersion
      || grabEngine.getSnapshot().running) return;

    grabLifecycleCommandVersion += 1;
    activeGrabTaskId = runtime.taskId;
    activeGrabTaskRevision = Math.max(0, Number(runtime.revision) || 0);
    activeGrabTaskNeedsClaim = false;
    if (savedSnapshot.running && (isGrabLoginPage() || isGrabPreCoursePage())) {
      const preserveCurrentPage = isGrabPreCoursePage();
      await beginGrabAuthRecovery({
        ...savedSnapshot,
        running: false,
        phase: 'PAUSED_AUTH'
      }, { preserveCurrentPage });
      if (grabAuthRecovery?.pending && grabAuthRecovery.stage === 'WAITING_LOGIN') {
        watchGrabAuthRecoveryPage(savedSnapshot);
      }
      return;
    }
    if (recovering) {
      grabAuthRecovery = savedRecovery;
      pausedGrabTaskSnapshot = withGrabAuthRecovery(savedSnapshot);
      sendGrabRuntimeMessage({ action: 'grabStopped', state: pausedGrabTaskSnapshot });
      if (isGrabLoginPage()) {
        if (!['WAITING_LOGIN', 'MANUAL_REQUIRED'].includes(grabAuthRecovery.stage)) {
          grabAuthRecovery.stage = 'WAITING_LOGIN';
          grabAuthRecovery.lastMessage = '仍需完成选课登录，任务保持暂停';
          pausedGrabTaskSnapshot = withGrabAuthRecovery(savedSnapshot);
          await sendGrabTaskRuntime(pausedGrabTaskSnapshot);
        }
        if (grabAuthRecovery.stage === 'WAITING_LOGIN') {
          watchGrabAuthRecoveryPage(savedSnapshot);
        }
        return;
      }
      if (grabAuthRecovery.stage === 'MANUAL_REQUIRED' && !isGrabCoursePage()) return;
      if (isGrabPreCoursePage()) {
        if (grabAuthRecovery.stage === 'ENTERING_COURSE') {
          await enterGrabCourseFromPrePage(savedSnapshot);
        } else {
          watchGrabAuthRecoveryPage(savedSnapshot);
        }
        return;
      }
      if (!isGrabCoursePage()) {
        await routeGrabAuthRecoveryToPreCoursePage(savedSnapshot);
        return;
      }

      grabAuthRecovery = {
        ...savedRecovery,
        pending: false,
        stage: 'VERIFYING',
        lastMessage: '已返回选课页面，正在重新验证任务状态'
      };
      pausedGrabTaskSnapshot = null;
      grabAuthResumeRound = Math.max(0, Number(savedSnapshot.round) || 0);
      grabEngine.restore(savedSnapshot);
      return;
    }
    if (isGrabCoursePage()) {
      if (savedRecovery?.stage === 'VERIFYING') {
        grabAuthRecovery = savedRecovery;
        grabAuthResumeRound = Math.max(0, Number(savedSnapshot.round) || 0);
      }
      grabEngine.restore(savedSnapshot);
    }
  } catch {
    // Missing or unavailable session state leaves the page in the normal idle state.
  }
}

const grabTaskRestoreReady = restoreGrabTaskFromSession();
void initializeCourseTargetControls();

// ============ 点击式验证码离线采样 ============
// 采样默认关闭。开启后仅旁路记录验证码原图和用户的手动点击，不会阻止、修改或代替页面点击。
const CLICK_CAPTCHA_SAMPLE_COUNT_KEY = 'nju_click_captcha_v1_count';
const CLICK_CAPTCHA_SAMPLE_KEY_PREFIX = 'nju_click_captcha_v1_';
const CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY = 'nju_click_captcha_v1_skipped_three_count';
const CLICK_CAPTCHA_SAMPLE_MAX_COUNT = 30;
const CLICK_CAPTCHA_MIN_TARGET_COUNT = 3;
const CLICK_CAPTCHA_MAX_TARGET_COUNT = 4;
const CLICK_CAPTCHA_REFERENCE_WIDTH = 250;
const CLICK_CAPTCHA_REFERENCE_HEIGHT = 120;
const CLICK_CAPTCHA_FOUR_TARGET_RIGHT_BRACKET = [211, 222];
const CLICK_CAPTCHA_TARGET_TEXT_TOP = 101;
const CLICK_CAPTCHA_TARGET_TEXT_BOTTOM = 119;
const CLICK_CAPTCHA_REFRESH_SETTLE_MS = 450;
const CLICK_CAPTCHA_REFRESH_TIMEOUT_MS = 4000;
const CLICK_CAPTCHA_REQUIRED_TARGET_COUNT = 4;
const CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS = 5;
const CLICK_CAPTCHA_SOLVER_ENABLED_KEY = 'nju_click_captcha_solver_enabled';
const CLICK_CAPTCHA_AUTO_CLICK_KEY = 'nju_click_captcha_auto_click';
const CLICK_CAPTCHA_AUTO_MARGIN = 0.4;
const CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL = 12;
const CLICK_CAPTCHA_MAX_LOW_CONFIDENCE_REFRESH_ATTEMPTS = 5;
const CLICK_CAPTCHA_SOLVER_POLL_MS = 650;
const CLICK_CAPTCHA_LOGIN_SUBMIT_DELAY_MS = 180;

const clickCaptchaSolver = {
  enabled: false,
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
  status: '未启用',
  monitor: null
};

const clickCaptchaWorker = {
  worker: null,
  ready: null,
  requestId: 0,
  requests: new Map()
};

const clickCaptchaCapture = {
  enabled: false,
  target: null,
  current: null,
  saving: false,
  refreshing: false,
  skippedThreeTargetCount: 0,
  expectedClicks: CLICK_CAPTCHA_MAX_TARGET_COUNT,
  status: '未启动'
};

function isVisibleCaptureElement(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

function describeCaptureElement(element) {
  const rect = element.getBoundingClientRect();
  const hint = [element.id, element.className, element.getAttribute('alt'), element.getAttribute('title')]
    .filter(Boolean)
    .join(' ')
    .slice(0, 160);
  return {
    tagName: element.tagName.toLowerCase(),
    hint,
    displayedWidth: Math.round(rect.width),
    displayedHeight: Math.round(rect.height)
  };
}

function findClickCaptchaElement() {
  const candidates = Array.from(document.querySelectorAll('img, canvas'))
    .filter(isVisibleCaptureElement)
    .map(element => {
      const rect = element.getBoundingClientRect();
      const hint = [element.id, element.className, element.getAttribute('alt'), element.getAttribute('title')]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const ratio = rect.width / rect.height;
      const captchaHint = /(captcha|verify|valid|code|yzm|验证码|校验)/.test(hint);
      const sizeMatch = rect.width >= 120 && rect.width <= 520 && rect.height >= 50 && rect.height <= 260;
      const ratioMatch = ratio >= 1.2 && ratio <= 4.5;
      const score = (captchaHint ? 1000 : 0) + (sizeMatch ? 120 : 0) + (ratioMatch ? 80 : 0) - Math.abs(ratio - 2) * 12;
      return { element, score, sizeMatch, ratioMatch };
    })
    .filter(item => item.sizeMatch && item.ratioMatch)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.element || null;
}

function isReadyClickCaptchaElement(element) {
  if (!element || !isVisibleCaptureElement(element)) return false;
  if (element instanceof HTMLImageElement) return element.naturalWidth > 0 && element.naturalHeight > 0;
  if (element instanceof HTMLCanvasElement) return element.width > 0 && element.height > 0;
  return false;
}

function getClickCaptchaFingerprint(element) {
  if (element instanceof HTMLImageElement) {
    return `image:${element.currentSrc || element.src || ''}`;
  }
  if (element instanceof HTMLCanvasElement) {
    try {
      const context = element.getContext('2d', { willReadFrequently: true });
      const { data } = context.getImageData(0, 0, element.width, element.height);
      const stride = Math.max(4, Math.floor(Math.sqrt((element.width * element.height) / 720)));
      let hash = 2166136261;
      for (let y = 0; y < element.height; y += stride) {
        for (let x = 0; x < element.width; x += stride) {
          const offset = (y * element.width + x) * 4;
          hash ^= data[offset];
          hash = Math.imul(hash, 16777619);
          hash ^= data[offset + 1];
          hash = Math.imul(hash, 16777619);
          hash ^= data[offset + 2];
          hash = Math.imul(hash, 16777619);
        }
      }
      return `canvas:${element.width}x${element.height}:${hash >>> 0}`;
    } catch {
      return `canvas:${element.width}x${element.height}`;
    }
  }
  return '';
}

function findClickCaptchaRefreshControl(target) {
  const verifyRefresh = document.querySelector('.verify-refresh');
  if (verifyRefresh && isVisibleCaptureElement(verifyRefresh)) {
    return verifyRefresh;
  }

  const targetRect = target.getBoundingClientRect();
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
    .filter(isVisibleCaptureElement)
    .map(element => {
      const text = [element.textContent, element.getAttribute('title'), element.getAttribute('aria-label'), element.className, element.id]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/(刷新|换一张|看不清|reload|refresh)/i.test(text)) return null;

      const rect = element.getBoundingClientRect();
      const distance = Math.hypot(rect.left - targetRect.left, rect.top - targetRect.top);
      return { element, distance };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);

  return controls[0]?.element || null;
}

async function waitForRefreshedClickCaptcha(previousTarget, previousFingerprint, timeoutMs = CLICK_CAPTCHA_REFRESH_TIMEOUT_MS) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const candidate = findClickCaptchaElement();
    const fingerprint = getClickCaptchaFingerprint(candidate);
    if (candidate && isReadyClickCaptchaElement(candidate) && (candidate !== previousTarget || fingerprint !== previousFingerprint)) {
      // CVVerifyCode briefly clears and redraws the same canvas. Require the new frame to settle before rearming capture.
      await sleep(260);
      const settledCandidate = findClickCaptchaElement();
      if (settledCandidate && isReadyClickCaptchaElement(settledCandidate) && getClickCaptchaFingerprint(settledCandidate) === getClickCaptchaFingerprint(candidate)) {
        return settledCandidate;
      }
    }
    await sleep(80);
  }
  return null;
}

async function requestFreshClickCaptcha(previousTarget) {
  const previousFingerprint = getClickCaptchaFingerprint(previousTarget);
  const refreshControl = previousTarget ? findClickCaptchaRefreshControl(previousTarget) : null;
  if (refreshControl) {
    refreshControl.click();
  } else if (previousTarget instanceof HTMLImageElement) {
    const refreshUrl = new URL(previousTarget.currentSrc || previousTarget.src, location.href);
    refreshUrl.searchParams.set('_njuCaptureRefresh', String(Date.now()));
    previousTarget.src = refreshUrl.toString();
  } else {
    throw new Error('未找到页面刷新控件，且验证码不是图片元素');
  }

  const refreshedTarget = await waitForRefreshedClickCaptcha(previousTarget, previousFingerprint);
  if (!refreshedTarget) {
    throw new Error('等待新验证码超时');
  }

  return refreshedTarget;
}

function isVisibleFormControl(element) {
  return element instanceof HTMLElement
    && !element.disabled
    && isVisibleCaptureElement(element);
}

function getControlHint(element) {
  return [
    element.id,
    element.name,
    element.className,
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
    element.getAttribute('autocomplete'),
    element.getAttribute('type')
  ].filter(Boolean).join(' ').toLowerCase();
}

function getElementDistance(first, second) {
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  return Math.hypot((a.left + a.width / 2) - (b.left + b.width / 2), (a.top + a.height / 2) - (b.top + b.height / 2));
}

function getLoginScopes(target) {
  const scopes = [];
  const form = target.closest('form');
  if (form) scopes.push(form);

  let ancestor = target.parentElement;
  for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
    if (!scopes.includes(ancestor)) scopes.push(ancestor);
  }
  return scopes;
}

function findLoginSubmitControl(scope, target) {
  const controls = Array.from(scope.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
    .filter(isVisibleFormControl)
    .map(element => {
      const label = [element.textContent, element.value, element.getAttribute('title'), element.getAttribute('aria-label'), element.id, element.className]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (/(verify-refresh|captcha-refresh|刷新|换一张|看不清|reload|refresh|重置|reset)/i.test(label)) return null;
      const loginMatch = /(登录|login|sign\s*in|提交|submit|确认)/i.test(label);
      const typeMatch = element.matches('input[type="submit"]') || element.getAttribute('type') === 'submit';
      if (!loginMatch && !typeMatch) return null;
      return {
        element,
        score: (loginMatch ? 1000 : 0) + (typeMatch ? 120 : 0) - getElementDistance(element, target)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return controls[0]?.element || null;
}

function findClickCaptchaLoginContext(target) {
  // The current selection portal has stable login IDs. Prefer this exact
  // container so a later in-page captcha cannot be mistaken for login.
  const loginContainer = document.getElementById('loginDiv');
  const portalCaptcha = document.getElementById('vcodeImg');
  const portalUsername = document.getElementById('loginName');
  const portalPassword = document.getElementById('loginPwd');
  const portalSubmit = document.getElementById('studentLoginBtn');
  if (target === portalCaptcha
    && loginContainer
    && portalUsername
    && portalPassword
    && portalSubmit
    && isVisibleCaptureElement(loginContainer)
    && isVisibleFormControl(portalUsername)
    && isVisibleFormControl(portalPassword)
    && isVisibleFormControl(portalSubmit)) {
    return {
      scope: loginContainer,
      form: null,
      usernameInput: portalUsername,
      passwordInput: portalPassword,
      submitButton: portalSubmit,
      score: Number.POSITIVE_INFINITY
    };
  }

  const contexts = getLoginScopes(target)
    .map(scope => {
      const passwordInput = Array.from(scope.querySelectorAll('input[type="password"]'))
        .filter(isVisibleFormControl)
        .sort((a, b) => getElementDistance(a, target) - getElementDistance(b, target))[0];
      if (!passwordInput) return null;

      const usernameInput = Array.from(scope.querySelectorAll('input'))
        .filter(isVisibleFormControl)
        .filter(input => input !== passwordInput && !/captcha|verify|valid|code|yzm|验证码|校验/.test(getControlHint(input)))
        .filter(input => /^(text|email|tel|number)?$/i.test(input.type || 'text'))
        .map(input => ({
          input,
          score: (/(user|account|student|username|login|xh|学号|账号)/.test(getControlHint(input)) ? 1000 : 0)
            - getElementDistance(input, passwordInput)
        }))
        .sort((a, b) => b.score - a.score)[0]?.input;
      if (!usernameInput) return null;

      const submitButton = findLoginSubmitControl(scope, target);
      const form = scope instanceof HTMLFormElement ? scope : (passwordInput.closest('form') || usernameInput.closest('form'));
      if (!submitButton && !form) return null;
      return {
        scope,
        form,
        usernameInput,
        passwordInput,
        submitButton,
        score: (scope instanceof HTMLFormElement ? 2000 : 0) + (submitButton ? 500 : 0)
          - getElementDistance(passwordInput, target)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return contexts[0] || null;
}

function setNativeInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function prepareClickCaptchaLogin(target) {
  const settings = await storageGet(['nju_user', 'nju_pass', 'nju_force']);

  const context = findClickCaptchaLoginContext(target);
  if (!context) {
    clickCaptchaSolver.loginStatus = '未在验证码附近找到登录表单';
    return null;
  }

  const shouldFill = settings.nju_force || (!context.usernameInput.value && !context.passwordInput.value);
  if (shouldFill && settings.nju_user && settings.nju_pass) {
    setNativeInputValue(context.usernameInput, settings.nju_user);
    setNativeInputValue(context.passwordInput, settings.nju_pass);
  }

  if (!context.usernameInput.value || !context.passwordInput.value) {
    clickCaptchaSolver.loginStatus = '登录表单已找到，但账号或密码未配置';
    return null;
  }

  clickCaptchaSolver.loginStatus = context.submitButton
    ? '登录表单已就绪'
    : '登录表单已就绪，将通过表单提交';
  return context;
}

async function submitClickCaptchaLogin(target, fingerprint, context, autoClickToken) {
  if (!context || !clickCaptchaSolver.enabled || !clickCaptchaSolver.autoClick
    || clickCaptchaSolver.autoClickToken !== autoClickToken) {
    return false;
  }
  if (clickCaptchaSolver.submittedTarget === target && clickCaptchaSolver.submittedFingerprint === fingerprint) {
    clickCaptchaSolver.loginStatus = '当前验证码已提交过登录';
    return false;
  }
  if (!document.contains(target) || getClickCaptchaFingerprint(target) !== fingerprint) {
    clickCaptchaSolver.loginStatus = '验证码已更新，跳过重复提交';
    return false;
  }

  await sleep(CLICK_CAPTCHA_LOGIN_SUBMIT_DELAY_MS);
  if (!document.contains(target) || getClickCaptchaFingerprint(target) !== fingerprint) {
    clickCaptchaSolver.loginStatus = '验证码已验证，页面正在跳转';
    return false;
  }

  clickCaptchaSolver.status = '验证码已点击，正在提交登录';
  notifyClickCaptchaSolverUpdate();
  if (context.submitButton && isVisibleFormControl(context.submitButton)) {
    context.submitButton.click();
  } else if (context.form) {
    if (typeof context.form.requestSubmit === 'function') context.form.requestSubmit();
    else context.form.submit();
  } else {
    clickCaptchaSolver.loginStatus = '登录按钮已不可用，未提交';
    return false;
  }
  clickCaptchaSolver.submittedTarget = target;
  clickCaptchaSolver.submittedFingerprint = fingerprint;
  clickCaptchaSolver.loginStatus = '登录已提交';
  // The portal switches to the user card asynchronously without a full page
  // navigation. The prior captcha canvas can therefore remain in the DOM.
  clearClickCaptchaSolverOverlay();
  return true;
}

async function recordSkippedThreeTargetCaptcha() {
  try {
    const data = await storageGet([CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY]);
    const count = Number(data[CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY] || 0) + 1;
    await storageSet({ [CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY]: count });
    clickCaptchaCapture.skippedThreeTargetCount = count;
  } catch {
    // Telemetry must never prevent the refresh policy from running.
    clickCaptchaCapture.skippedThreeTargetCount += 1;
  }
}

async function ensureFourTargetClickCaptcha(target) {
  let currentTarget = target;
  let refreshCount = 0;

  while (inferClickCaptchaTargetCount(currentTarget) !== CLICK_CAPTCHA_REQUIRED_TARGET_COUNT) {
    if (refreshCount >= CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS) {
      throw new Error(`连续 ${CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS} 次仍为三字验证码`);
    }

    refreshCount += 1;
    await recordSkippedThreeTargetCaptcha();
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.current = null;
    clickCaptchaCapture.target = currentTarget;
    clickCaptchaCapture.refreshing = true;
    clickCaptchaCapture.status = `检测到三字验证码，正在刷新为四字（${refreshCount}/${CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS}）`;
    renderClickCaptchaOverlay();
    notifyClickCaptchaCaptureUpdate();
    currentTarget = await requestFreshClickCaptcha(currentTarget);
  }

  return { target: currentTarget, refreshCount };
}

async function refreshClickCaptchaAndResume(sampleId) {
  const previousTarget = clickCaptchaCapture.target;
  const previousFingerprint = getClickCaptchaFingerprint(previousTarget);

  // Some pages refresh automatically after the final valid click. Prefer that result and avoid an unnecessary extra request.
  let refreshedTarget = await waitForRefreshedClickCaptcha(
    previousTarget,
    previousFingerprint,
    CLICK_CAPTCHA_REFRESH_SETTLE_MS
  );
  const pageRefreshed = Boolean(refreshedTarget);
  if (!refreshedTarget) {
    refreshedTarget = await requestFreshClickCaptcha(previousTarget);
  }

  const prepared = await ensureFourTargetClickCaptcha(refreshedTarget);

  clickCaptchaCapture.target = prepared.target;
  clickCaptchaCapture.expectedClicks = CLICK_CAPTCHA_REQUIRED_TARGET_COUNT;
  clickCaptchaCapture.enabled = true;
  clickCaptchaCapture.refreshing = false;
  clickCaptchaCapture.status = prepared.refreshCount
    ? `样本 ${sampleId} 已保存，已跳过三字验证码并继续采样`
    : pageRefreshed
      ? `样本 ${sampleId} 已保存，已检测到新验证码并继续采样`
      : `样本 ${sampleId} 已保存，新验证码已就绪，继续采样`;
  renderClickCaptchaOverlay();
  notifyClickCaptchaCaptureUpdate('clickCaptchaSampleSaved');
}

function getClickCaptchaOverlay() {
  let overlay = document.getElementById('nju-click-captcha-capture-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'nju-click-captcha-capture-overlay';
  overlay.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'display:none',
    'pointer-events:none',
    'border:2px dashed #634798',
    'border-radius:5px',
    'box-shadow:0 0 0 3px rgba(99,71,152,.16)'
  ].join(';');

  const label = document.createElement('div');
  label.dataset.njuCaptureLabel = 'true';
  label.style.cssText = 'position:absolute;left:0;top:-27px;padding:4px 7px;border-radius:5px;background:#634798;color:#fff;font:700 12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(36,28,55,.24)';
  overlay.appendChild(label);
  document.body.appendChild(overlay);
  return overlay;
}

function renderClickCaptchaOverlay() {
  const overlay = getClickCaptchaOverlay();
  const target = clickCaptchaCapture.target;
  if (!clickCaptchaCapture.enabled || !target || !document.contains(target) || !isVisibleCaptureElement(target)) {
    overlay.style.display = 'none';
    return;
  }

  const rect = target.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.left = `${Math.round(rect.left - 2)}px`;
  overlay.style.top = `${Math.round(rect.top - 2)}px`;
  overlay.style.width = `${Math.round(rect.width + 4)}px`;
  overlay.style.height = `${Math.round(rect.height + 4)}px`;
  const count = clickCaptchaCapture.current?.clicks.length || 0;
  const expected = clickCaptchaCapture.current?.expectedClicks || clickCaptchaCapture.expectedClicks;
  overlay.querySelector('[data-nju-capture-label]').textContent = `采样中：请手动点击（${count}/${expected}）`;
}

function inferClickCaptchaTargetCountFromCanvas(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const xScale = canvas.width / CLICK_CAPTCHA_REFERENCE_WIDTH;
  const yScale = canvas.height / CLICK_CAPTCHA_REFERENCE_HEIGHT;
  const left = Math.floor(CLICK_CAPTCHA_FOUR_TARGET_RIGHT_BRACKET[0] * xScale);
  const right = Math.ceil(CLICK_CAPTCHA_FOUR_TARGET_RIGHT_BRACKET[1] * xScale);
  const top = Math.floor(CLICK_CAPTCHA_TARGET_TEXT_TOP * yScale);
  const bottom = Math.ceil(CLICK_CAPTCHA_TARGET_TEXT_BOTTOM * yScale);
  const pixels = context.getImageData(left, top, Math.max(1, right - left), Math.max(1, bottom - top)).data;
  let brightPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] + pixels[index + 1] + pixels[index + 2] >= 480) brightPixels += 1;
  }

  // The closing bracket sits at x≈213 for four targets and moves left for three.
  // Counting glyph slots is unreliable because that moved bracket overlaps slot four.
  return brightPixels >= 32 ? CLICK_CAPTCHA_MAX_TARGET_COUNT : CLICK_CAPTCHA_MIN_TARGET_COUNT;
}

function inferClickCaptchaTargetCount(element) {
  try {
    return inferClickCaptchaTargetCountFromCanvas(getClickCaptchaFrame(element).canvas);
  } catch {
    return CLICK_CAPTCHA_MAX_TARGET_COUNT;
  }
}

function getClickCaptchaFrame(element) {
  const sourceCanvas = document.createElement('canvas');
  let width = 0;
  let height = 0;

  if (element instanceof HTMLCanvasElement) {
    width = element.width;
    height = element.height;
  } else if (element instanceof HTMLImageElement) {
    width = element.naturalWidth;
    height = element.naturalHeight;
  }

  if (!width || !height) {
    throw new Error('验证码图片尚未加载完成');
  }

  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const context = sourceCanvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(element, 0, 0, width, height);
  return {
    canvas: sourceCanvas,
    context,
    width,
    height,
    imageData: context.getImageData(0, 0, width, height)
  };
}

function getClickCaptchaSource(element) {
  const frame = getClickCaptchaFrame(element);
  const sourceUrl = element instanceof HTMLImageElement ? (element.currentSrc || element.src || '') : '';
  return {
    dataUrl: frame.canvas.toDataURL('image/png'),
    width: frame.width,
    height: frame.height,
    targetCount: inferClickCaptchaTargetCountFromCanvas(frame.canvas),
    sourcePath: sourceUrl ? new URL(sourceUrl, location.href).pathname : '',
    element: describeCaptureElement(element)
  };
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function getClickCaptchaSolverOverlay() {
  let overlay = document.getElementById('nju-click-captcha-solver-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'nju-click-captcha-solver-overlay';
  overlay.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'display:none',
    'pointer-events:none',
    'border:2px solid rgba(37,99,235,.72)',
    'border-radius:5px',
    'box-shadow:0 0 0 3px rgba(37,99,235,.12)'
  ].join(';');

  const label = document.createElement('div');
  label.dataset.njuSolverLabel = 'true';
  label.style.cssText = 'position:absolute;left:0;top:-27px;padding:4px 7px;border-radius:5px;background:#2563eb;color:#fff;font:700 12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(20,49,109,.22)';
  overlay.appendChild(label);
  document.body.appendChild(overlay);
  return overlay;
}

function renderClickCaptchaSolverOverlay() {
  const overlay = getClickCaptchaSolverOverlay();
  const target = clickCaptchaSolver.target;
  const result = clickCaptchaSolver.result;
  if (!target || !result || !document.contains(target) || !isVisibleCaptureElement(target)) {
    overlay.style.display = 'none';
    return;
  }

  const rect = target.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.left = `${Math.round(rect.left - 2)}px`;
  overlay.style.top = `${Math.round(rect.top - 2)}px`;
  overlay.style.width = `${Math.round(rect.width + 4)}px`;
  overlay.style.height = `${Math.round(rect.height + 4)}px`;
  overlay.querySelector('[data-nju-solver-label]').textContent = clickCaptchaSolver.status;
  overlay.querySelectorAll('[data-nju-solver-point], [data-nju-solver-box]').forEach(node => node.remove());

  result.points.forEach((point, index) => {
    const markerSize = 18;
    const box = point.box || {
      left: point.x - 8,
      top: point.y - 8,
      right: point.x + 8,
      bottom: point.y + 8
    };
    const scaleX = rect.width / result.referenceWidth;
    const scaleY = rect.height / result.referenceHeight;
    const glyphLeft = 2 + (box.left * scaleX);
    const glyphTop = 2 + (box.top * scaleY);
    const glyphRight = 2 + (box.right * scaleX);
    const glyphBottom = 2 + (box.bottom * scaleY);
    const maxMarkerLeft = Math.max(2, rect.width + 2 - markerSize);
    const maxMarkerTop = Math.max(2, rect.height + 2 - markerSize);
    const markerLeft = Math.max(2, Math.min(maxMarkerLeft, glyphRight + 2));
    const markerTop = Math.max(2, Math.min(maxMarkerTop, glyphTop - markerSize - 2));

    const highlight = document.createElement('div');
    highlight.dataset.njuSolverBox = 'true';
    highlight.style.cssText = [
      'position:absolute',
      `left:${Math.round(glyphLeft - 1)}px`,
      `top:${Math.round(glyphTop - 1)}px`,
      `width:${Math.max(2, Math.round(glyphRight - glyphLeft + 2))}px`,
      `height:${Math.max(2, Math.round(glyphBottom - glyphTop + 2))}px`,
      'box-sizing:border-box',
      'border:1px solid rgba(37,99,235,.82)',
      'border-radius:3px',
      'background:rgba(37,99,235,.035)'
    ].join(';');
    overlay.appendChild(highlight);

    const marker = document.createElement('div');
    marker.dataset.njuSolverPoint = 'true';
    marker.textContent = String(index + 1);
    marker.style.cssText = [
      'position:absolute',
      `left:${Math.round(markerLeft)}px`,
      `top:${Math.round(markerTop)}px`,
      `width:${markerSize}px`,
      `height:${markerSize}px`,
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'border-radius:50%',
      'color:#fff',
      'background:#1d4ed8',
      'border:1px solid #fff',
      'box-shadow:0 1px 5px rgba(20,49,109,.32)',
      'font:800 11px/1 system-ui,-apple-system,"Segoe UI",sans-serif'
    ].join(';');
    overlay.appendChild(marker);
  });
}

function clearClickCaptchaSolverOverlay() {
  clickCaptchaSolver.result = null;
  renderClickCaptchaSolverOverlay();
}

function getClickCaptchaSolverState() {
  const result = clickCaptchaSolver.result;
  const backgroundCompatible = Boolean(result
    && result.backgroundResidual <= CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL);
  return {
    enabled: clickCaptchaSolver.enabled,
    autoClick: clickCaptchaSolver.autoClick,
    loginStatus: clickCaptchaSolver.loginStatus,
    running: clickCaptchaSolver.running,
    lowConfidenceRefreshes: clickCaptchaSolver.lowConfidenceRefreshes,
    ready: Boolean(clickCaptchaSolver.target && document.contains(clickCaptchaSolver.target)),
    status: clickCaptchaSolver.status,
    confidenceMargin: result?.margin ?? null,
    backgroundResidual: result?.backgroundResidual ?? null,
    backgroundCompatible,
    headAgreement: result?.headAgreement ?? null,
    autoEligible: isClickCaptchaAutoEligible(result),
    order: result?.order || null,
    elapsedMs: result?.elapsedMs ?? null,
    modelVersion: result?.modelVersion || null
  };
}

function getClickCaptchaManualStatus() {
  const target = findClickCaptchaElement();
  const loginContext = target && findClickCaptchaLoginContext(target);
  const ready = Boolean(loginContext && isReadyClickCaptchaElement(target));
  return {
    ok: true,
    mode: ready ? 'click-mark' : 'none',
    ready,
    state: getClickCaptchaSolverState()
  };
}

function isClickCaptchaAutoEligible(result) {
  return Boolean(result
    && result.margin >= CLICK_CAPTCHA_AUTO_MARGIN
    && result.backgroundResidual <= CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL);
}

function notifyClickCaptchaSolverUpdate() {
  try {
    chrome.runtime.sendMessage({ action: 'clickCaptchaSolverUpdate', state: getClickCaptchaSolverState() });
  } catch {
    // The popup is optional; solving must continue while it is closed.
  }
}

function rejectClickCaptchaWorkerRequests(error) {
  for (const request of clickCaptchaWorker.requests.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  clickCaptchaWorker.requests.clear();
}

function resetClickCaptchaWorker(error) {
  const worker = clickCaptchaWorker.worker;
  clickCaptchaWorker.ready = null;
  clickCaptchaWorker.worker = null;
  if (worker) worker.terminate();
  rejectClickCaptchaWorkerRequests(error);
}

function createClickCaptchaWorker() {
  // A content script's dedicated Worker is created under the page's origin.
  // Bootstrapping from a Blob keeps that initial URL same-origin, then imports
  // the explicitly declared web-accessible extension module with CORS enabled.
  const workerModuleUrl = chrome.runtime.getURL('click-captcha-worker.js');
  const bootstrap = new Blob([
    `import ${JSON.stringify(workerModuleUrl)};`
  ], { type: 'text/javascript' });
  const bootstrapUrl = URL.createObjectURL(bootstrap);
  try {
    return new Worker(bootstrapUrl, { type: 'module' });
  } finally {
    URL.revokeObjectURL(bootstrapUrl);
  }
}

function getClickCaptchaWorker() {
  if (clickCaptchaWorker.ready) return clickCaptchaWorker.ready;

  clickCaptchaWorker.ready = new Promise((resolve, reject) => {
    const worker = createClickCaptchaWorker();
    clickCaptchaWorker.worker = worker;
    worker.onmessage = event => {
      const message = event.data || {};
      if (message.type === 'ready') {
        resolve(worker);
        return;
      }
      if (message.type === 'solved' || message.type === 'error') {
        if (message.type === 'error' && !message.requestId) {
          const error = new Error(message.error || '点击验证码模型初始化失败');
          resetClickCaptchaWorker(error);
          reject(error);
          return;
        }
        const request = clickCaptchaWorker.requests.get(message.requestId);
        if (!request) return;
        clickCaptchaWorker.requests.delete(message.requestId);
        clearTimeout(request.timer);
        if (message.type === 'solved') request.resolve(message.result);
        else request.reject(new Error(message.error || '点击验证码模型执行失败'));
      }
    };
    worker.onerror = event => {
      const error = new Error(event.message || '点击验证码 Worker 启动失败');
      resetClickCaptchaWorker(error);
      reject(error);
    };
    worker.postMessage({
      type: 'init',
      modelUrl: chrome.runtime.getURL('assets/click-captcha-model.onnx'),
      backgroundUrl: chrome.runtime.getURL('assets/click-captcha-background.png'),
      wasmBaseUrl: chrome.runtime.getURL('vendor/onnxruntime/')
    });
  });
  return clickCaptchaWorker.ready;
}

async function solveClickCaptchaFrame(frame, targetCount) {
  const worker = await getClickCaptchaWorker();
  const requestId = ++clickCaptchaWorker.requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (clickCaptchaWorker.requests.delete(requestId)) {
        reject(new Error('点击验证码识别超时'));
      }
    }, 6000);
    clickCaptchaWorker.requests.set(requestId, { resolve, reject, timer });
    worker.postMessage({
      type: 'solve',
      requestId,
      width: frame.width,
      height: frame.height,
      targetCount,
      pixels: frame.imageData.data.buffer
    }, [frame.imageData.data.buffer]);
  });
}

async function prepareFourTargetClickCaptchaForSolver(target) {
  let current = target;
  for (let attempts = 0; attempts < CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS; attempts += 1) {
    if (inferClickCaptchaTargetCount(current) === CLICK_CAPTCHA_REQUIRED_TARGET_COUNT) return current;
    clickCaptchaSolver.status = `检测到三字验证码，正在刷新（${attempts + 1}/${CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS}）`;
    notifyClickCaptchaSolverUpdate();
    current = await requestFreshClickCaptcha(current);
  }
  throw new Error('连续刷新后仍未获得四字验证码');
}

function dispatchClickCaptchaPointer(target, clientX, clientY, type) {
  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0
  };
  if (type.startsWith('pointer') && window.PointerEvent) {
    target.dispatchEvent(new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  } else {
    target.dispatchEvent(new MouseEvent(type, common));
  }
}

function createClickCaptchaAutoClickCancelledError() {
  const error = new Error('自动点击已取消');
  error.code = 'AUTO_CLICK_CANCELLED';
  return error;
}

async function dispatchClickCaptchaPoints(target, result, autoClickToken) {
  const fingerprint = getClickCaptchaFingerprint(target);
  for (const point of result.points) {
    if (!clickCaptchaSolver.enabled
      || !clickCaptchaSolver.autoClick
      || clickCaptchaSolver.autoClickToken !== autoClickToken) {
      throw createClickCaptchaAutoClickCancelledError();
    }
    if (!document.contains(target) || getClickCaptchaFingerprint(target) !== fingerprint) {
      throw new Error('验证码在点击过程中已刷新');
    }
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + ((point.x / result.referenceWidth) * rect.width);
    const clientY = rect.top + ((point.y / result.referenceHeight) * rect.height);
    dispatchClickCaptchaPointer(target, clientX, clientY, 'pointerdown');
    dispatchClickCaptchaPointer(target, clientX, clientY, 'mousedown');
    dispatchClickCaptchaPointer(target, clientX, clientY, 'pointerup');
    dispatchClickCaptchaPointer(target, clientX, clientY, 'mouseup');
    dispatchClickCaptchaPointer(target, clientX, clientY, 'click');
    await sleep(80);
  }
}

async function runClickCaptchaSolver({ allowAutoClick = false, force = false } = {}) {
  if (clickCaptchaCapture.enabled) {
    grabLoginShield.clear();
    clickCaptchaSolver.status = '采样进行中，识别已暂停';
    notifyClickCaptchaSolverUpdate();
    return getClickCaptchaSolverState();
  }
  if (clickCaptchaSolver.running) return getClickCaptchaSolverState();

  const initialTarget = findClickCaptchaElement();
  if (!initialTarget) {
    clickCaptchaSolver.target = null;
    clickCaptchaSolver.status = '未找到点击验证码';
    clearClickCaptchaSolverOverlay();
    notifyClickCaptchaSolverUpdate();
    return getClickCaptchaSolverState();
  }

  const initialFingerprint = getClickCaptchaFingerprint(initialTarget);
  if (!force
    && initialTarget === clickCaptchaSolver.attemptedTarget
    && initialFingerprint === clickCaptchaSolver.attemptedFingerprint) {
    return getClickCaptchaSolverState();
  }

  clickCaptchaSolver.running = true;
  clickCaptchaSolver.lowConfidenceRefreshes = 0;
  clickCaptchaSolver.target = initialTarget;
  clickCaptchaSolver.status = '正在识别点击验证码';
  notifyClickCaptchaSolverUpdate();
  let loginSubmitted = false;
  let errorShieldShown = false;
  const automaticLoginRequested = allowAutoClick
    && clickCaptchaSolver.enabled
    && clickCaptchaSolver.autoClick;
  if (automaticLoginRequested) {
    grabLoginShield.show(GRAB_LOGIN_SHIELD_STATUS.LOADING, '正在识别验证码…');
    if (grabPageStatusPanel) grabPageStatusPanel.classList.add('is-solving-captcha');
  } else {
    grabLoginShield.clear();
  }
  try {
    let target = initialTarget;
    const canAutoClickNow = () => allowAutoClick
      && clickCaptchaSolver.enabled
      && clickCaptchaSolver.autoClick;

    while (true) {
      if (clickCaptchaSolver.lowConfidenceRefreshes > 0 && !canAutoClickNow()) {
        clickCaptchaSolver.status = '自动点击已关闭，已停止换图重试';
        break;
      }
      target = await prepareFourTargetClickCaptchaForSolver(target);
      const fingerprint = getClickCaptchaFingerprint(target);
      clickCaptchaSolver.attemptedTarget = target;
      clickCaptchaSolver.attemptedFingerprint = fingerprint;
      const frame = getClickCaptchaFrame(target);
      if (frame.width !== CLICK_CAPTCHA_REFERENCE_WIDTH || frame.height !== CLICK_CAPTCHA_REFERENCE_HEIGHT) {
        throw new Error(`当前验证码尺寸 ${frame.width}x${frame.height} 与本地模型不兼容`);
      }
      const result = await solveClickCaptchaFrame(frame, CLICK_CAPTCHA_REQUIRED_TARGET_COUNT);
      if (!document.contains(target) || getClickCaptchaFingerprint(target) !== fingerprint) {
        throw new Error('验证码在识别过程中已刷新');
      }

      clickCaptchaSolver.target = target;
      clickCaptchaSolver.fingerprint = fingerprint;
      clickCaptchaSolver.result = result;
      const autoEligible = isClickCaptchaAutoEligible(result);
      if (canAutoClickNow() && autoEligible) {
        const loginContext = await prepareClickCaptchaLogin(target);
        if (!loginContext) {
          grabLoginShield.clear();
          clickCaptchaSolver.status = `${clickCaptchaSolver.loginStatus}，已标出识别顺序供人工处理`;
          renderClickCaptchaSolverOverlay();
          notifyClickCaptchaSolverUpdate();
          break;
        }
        clickCaptchaSolver.status = '正在按识别顺序点击';
        grabLoginShield.show(GRAB_LOGIN_SHIELD_STATUS.LOADING, '识别成功，正在登录…');
        renderClickCaptchaSolverOverlay();
        notifyClickCaptchaSolverUpdate();
        await dispatchClickCaptchaPoints(target, result, clickCaptchaSolver.autoClickToken);
        const submitted = await submitClickCaptchaLogin(target, fingerprint, loginContext, clickCaptchaSolver.autoClickToken);
        if (submitted) {
          loginSubmitted = true;
          grabLoginShield.show(GRAB_LOGIN_SHIELD_STATUS.SUCCESS, '登录请求已提交，正在等待页面响应…');
        }
        clickCaptchaSolver.status = submitted
          ? `已提交登录，等待页面验证（分差 ${result.margin.toFixed(2)}）`
          : `已发送点击，等待页面验证（分差 ${result.margin.toFixed(2)}；${clickCaptchaSolver.loginStatus}）`;
        break;
      }

      if (result.backgroundResidual > CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL) {
        clickCaptchaSolver.status = `页面背景与模型不匹配，已标点待人工确认（残差 ${result.backgroundResidual.toFixed(1)}）`;
        break;
      }

      if (autoEligible) {
        clickCaptchaSolver.status = `已标出识别顺序（分差 ${result.margin.toFixed(2)}）`;
        break;
      }

      if (canAutoClickNow()
        && clickCaptchaSolver.lowConfidenceRefreshes < CLICK_CAPTCHA_MAX_LOW_CONFIDENCE_REFRESH_ATTEMPTS) {
        clickCaptchaSolver.lowConfidenceRefreshes += 1;
        clickCaptchaSolver.status = `候选顺序接近，正在换图重试（${clickCaptchaSolver.lowConfidenceRefreshes}/${CLICK_CAPTCHA_MAX_LOW_CONFIDENCE_REFRESH_ATTEMPTS}，分差 ${result.margin.toFixed(2)}）`;
        grabLoginShield.show(GRAB_LOGIN_SHIELD_STATUS.LOADING, '结果不确定，正在换图重试…');
        clickCaptchaSolver.result = null;
        renderClickCaptchaSolverOverlay();
        notifyClickCaptchaSolverUpdate();
        target = await requestFreshClickCaptcha(target);
        continue;
      }

      clickCaptchaSolver.status = clickCaptchaSolver.lowConfidenceRefreshes > 0
        ? `连续换图后仍未达到自动点击门槛，已标点待人工确认（分差 ${result.margin.toFixed(2)}）`
        : `已生成候选顺序，但与次优方案接近，已标点待人工确认（分差 ${result.margin.toFixed(2)}）`;
      break;
    }
    renderClickCaptchaSolverOverlay();
  } catch (error) {
    if (error?.code === 'AUTO_CLICK_CANCELLED') {
      grabLoginShield.clear();
      clickCaptchaSolver.status = '自动点击已取消，已保留标点供人工确认';
      renderClickCaptchaSolverOverlay();
    } else {
      clickCaptchaSolver.status = `识别未执行：${error.message}`;
      if (automaticLoginRequested) {
        errorShieldShown = true;
        grabLoginShield.show(GRAB_LOGIN_SHIELD_STATUS.ERROR, '自动登录未完成，请手动登录');
      }
      clearClickCaptchaSolverOverlay();
    }
  } finally {
    if (!loginSubmitted && !errorShieldShown) grabLoginShield.clear();
    if (grabPageStatusPanel) grabPageStatusPanel.classList.remove('is-solving-captcha');
    clickCaptchaSolver.running = false;
    notifyClickCaptchaSolverUpdate();
  }
  return getClickCaptchaSolverState();
}

async function pollClickCaptchaSolver() {
  if (!clickCaptchaSolver.enabled || clickCaptchaSolver.running || clickCaptchaCapture.enabled) return;
  const target = findClickCaptchaElement();
  if (!target || !isReadyClickCaptchaElement(target)) return;
  const fingerprint = getClickCaptchaFingerprint(target);
  if (target === clickCaptchaSolver.attemptedTarget && fingerprint === clickCaptchaSolver.attemptedFingerprint) return;
  await runClickCaptchaSolver({ allowAutoClick: true });
}

function startClickCaptchaSolverMonitor() {
  if (clickCaptchaSolver.monitor) return;
  clickCaptchaSolver.monitor = setInterval(() => {
    pollClickCaptchaSolver().catch(error => {
      grabLoginShield.clear();
      clickCaptchaSolver.status = `识别监控异常：${error.message}`;
      notifyClickCaptchaSolverUpdate();
    });
  }, CLICK_CAPTCHA_SOLVER_POLL_MS);
  pollClickCaptchaSolver().catch(() => {});
}

async function setClickCaptchaSolverEnabled(enabled) {
  clickCaptchaSolver.enabled = enabled;
  if (enabled) {
    clickCaptchaSolver.target = null;
    clickCaptchaSolver.fingerprint = '';
    clickCaptchaSolver.attemptedTarget = null;
    clickCaptchaSolver.attemptedFingerprint = '';
    clickCaptchaSolver.submittedTarget = null;
    clickCaptchaSolver.submittedFingerprint = '';
    clickCaptchaSolver.lowConfidenceRefreshes = 0;
    clickCaptchaSolver.result = null;
    clickCaptchaSolver.loginStatus = '未检测登录表单';
    clickCaptchaSolver.status = '等待点击验证码';
    startClickCaptchaSolverMonitor();
  } else {
    clickCaptchaSolver.autoClickToken += 1;
    clickCaptchaSolver.status = '识别已暂停';
    grabLoginShield.clear();
    clearClickCaptchaSolverOverlay();
  }
  await storageSet({ [CLICK_CAPTCHA_SOLVER_ENABLED_KEY]: enabled });
  notifyClickCaptchaSolverUpdate();
  return getClickCaptchaSolverState();
}

async function setClickCaptchaAutoClick(enabled) {
  if (!enabled) clickCaptchaSolver.autoClickToken += 1;
  clickCaptchaSolver.autoClick = enabled;
  if (!enabled) grabLoginShield.clear();
  await storageSet({ [CLICK_CAPTCHA_AUTO_CLICK_KEY]: enabled });
  clickCaptchaSolver.status = enabled
    ? '自动点击与自动登录已开启，低置信会换图重试'
    : '仅标出识别顺序，不会自动点击';
  notifyClickCaptchaSolverUpdate();
  return getClickCaptchaSolverState();
}

async function initializeClickCaptchaSolver() {
  try {
    const settings = await storageGet([CLICK_CAPTCHA_SOLVER_ENABLED_KEY, CLICK_CAPTCHA_AUTO_CLICK_KEY]);
    // 自动登录是发布版默认行为；只有用户显式关闭时才暂停。
    clickCaptchaSolver.enabled = settings[CLICK_CAPTCHA_SOLVER_ENABLED_KEY] !== false;
    clickCaptchaSolver.autoClick = settings[CLICK_CAPTCHA_AUTO_CLICK_KEY] !== false;
    grabLoginShield.resolveAutomation(clickCaptchaSolver.enabled && clickCaptchaSolver.autoClick);
    clickCaptchaSolver.status = clickCaptchaSolver.enabled ? '等待点击验证码' : '未启用';
    if (clickCaptchaSolver.enabled) startClickCaptchaSolverMonitor();
    notifyClickCaptchaSolverUpdate();
  } catch {
    clickCaptchaSolver.status = '本地设置读取失败';
    grabLoginShield.clear();
  }
}

async function getClickCaptchaSamples() {
  const data = await storageGet([CLICK_CAPTCHA_SAMPLE_COUNT_KEY]);
  const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
  if (count === 0) return [];
  const keys = Array.from({ length: count }, (_, i) =>
    CLICK_CAPTCHA_SAMPLE_KEY_PREFIX + String(i + 1).padStart(4, '0'));
  const result = await storageGet(keys);
  return keys.map(k => result[k]).filter(Boolean);
}

async function getClickCaptchaCaptureState() {
  const data = await storageGet([
    CLICK_CAPTCHA_SAMPLE_COUNT_KEY,
    CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY
  ]);
  const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
  clickCaptchaCapture.skippedThreeTargetCount = Number(data[CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY] || 0);
  return {
    enabled: clickCaptchaCapture.enabled,
    refreshing: clickCaptchaCapture.refreshing,
    ready: Boolean(clickCaptchaCapture.target && document.contains(clickCaptchaCapture.target)),
    pendingClicks: clickCaptchaCapture.current?.clicks.length || 0,
    expectedClicks: clickCaptchaCapture.current?.expectedClicks || clickCaptchaCapture.expectedClicks,
    sampleCount: count,
    skippedThreeTargetCount: clickCaptchaCapture.skippedThreeTargetCount,
    maxSampleCount: CLICK_CAPTCHA_SAMPLE_MAX_COUNT,
    status: clickCaptchaCapture.status,
    target: clickCaptchaCapture.target ? describeCaptureElement(clickCaptchaCapture.target) : null
  };
}

function notifyClickCaptchaCaptureUpdate(action = 'clickCaptchaCaptureUpdate') {
  getClickCaptchaCaptureState()
    .then(state => chrome.runtime.sendMessage({ action, state }))
    .catch(() => {});
}

async function saveClickCaptchaSample() {
  const current = clickCaptchaCapture.current;
  if (!current || current.clicks.length !== current.expectedClicks) return;

  const data = await storageGet([CLICK_CAPTCHA_SAMPLE_COUNT_KEY]);
  const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
  if (count >= CLICK_CAPTCHA_SAMPLE_MAX_COUNT) {
    clickCaptchaCapture.status = `已达到 ${CLICK_CAPTCHA_SAMPLE_MAX_COUNT} 条上限，请先导出`;
    clickCaptchaCapture.current = null;
    clickCaptchaCapture.enabled = false;
    renderClickCaptchaOverlay();
    notifyClickCaptchaCaptureUpdate();
    return;
  }

  const id = String(count + 1).padStart(4, '0');
  const key = CLICK_CAPTCHA_SAMPLE_KEY_PREFIX + id;
  await storageSet({
    [CLICK_CAPTCHA_SAMPLE_COUNT_KEY]: count + 1,
    [key]: {
      id,
      createdAt: new Date().toISOString(),
      imageDataUrl: current.imageDataUrl,
      image: current.image,
      targetCount: current.expectedClicks,
      clicks: current.clicks
    }
  });
  clickCaptchaCapture.current = null;
  clickCaptchaCapture.enabled = false;
  clickCaptchaCapture.refreshing = true;
  clickCaptchaCapture.status = `样本 ${id} 已保存，正在刷新验证码`;
  renderClickCaptchaOverlay();
  notifyClickCaptchaCaptureUpdate('clickCaptchaSampleSaved');
  try {
    await refreshClickCaptchaAndResume(id);
  } catch (error) {
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.refreshing = false;
    clickCaptchaCapture.current = null;
    clickCaptchaCapture.status = `样本 ${id} 已保存，自动刷新失败：${error.message}`;
    renderClickCaptchaOverlay();
    notifyClickCaptchaCaptureUpdate('clickCaptchaSampleSaved');
  }
}

async function setClickCaptchaCaptureEnabled(enabled) {
  if (enabled) grabLoginShield.clear();
  if (!enabled) {
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.current = null;
    clickCaptchaCapture.refreshing = false;
    clickCaptchaCapture.status = '采样已停止';
    renderClickCaptchaOverlay();
    return await getClickCaptchaCaptureState();
  }

  const target = findClickCaptchaElement();
  if (!target) {
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.target = null;
    clickCaptchaCapture.status = '未找到可采样的验证码图片';
    renderClickCaptchaOverlay();
    return await getClickCaptchaCaptureState();
  }

  clickCaptchaCapture.enabled = false;
  clickCaptchaCapture.target = target;
  clickCaptchaCapture.current = null;
  clickCaptchaCapture.refreshing = false;
  let prepared;
  try {
    prepared = await ensureFourTargetClickCaptcha(target);
  } catch (error) {
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.refreshing = false;
    clickCaptchaCapture.status = `准备四字验证码失败：${error.message}`;
    renderClickCaptchaOverlay();
    return await getClickCaptchaCaptureState();
  }

  clickCaptchaCapture.enabled = true;
  clickCaptchaCapture.target = prepared.target;
  clickCaptchaCapture.refreshing = false;
  clickCaptchaCapture.expectedClicks = CLICK_CAPTCHA_REQUIRED_TARGET_COUNT;
  clickCaptchaCapture.status = prepared.refreshCount
    ? '已跳过三字验证码，请正常手动点击 4 个目标字'
    : '已锁定验证码，请正常手动点击 4 个目标字';
  renderClickCaptchaOverlay();
  return await getClickCaptchaCaptureState();
}

async function discardLastClickCaptchaSample() {
  const data = await storageGet([CLICK_CAPTCHA_SAMPLE_COUNT_KEY]);
  const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
  if (count === 0) return await getClickCaptchaCaptureState();
  const key = CLICK_CAPTCHA_SAMPLE_KEY_PREFIX + String(count).padStart(4, '0');
  await storageRemove([key]);
  await storageSet({ [CLICK_CAPTCHA_SAMPLE_COUNT_KEY]: count - 1 });
  clickCaptchaCapture.status = '已删除最近一条样本';
  return await getClickCaptchaCaptureState();
}

// 在页面自身的点击处理前记录图像，避免最后一次点击触发验证码刷新后丢失原图。
document.addEventListener('pointerdown', event => {
  if (!clickCaptchaCapture.enabled || clickCaptchaCapture.saving || event.button !== 0 || !event.isPrimary) return;
  let target = clickCaptchaCapture.target;
  if (!target || !document.contains(target) || !isVisibleCaptureElement(target)) {
    target = findClickCaptchaElement();
    clickCaptchaCapture.target = target;
  }
  if (!target) {
    clickCaptchaCapture.status = '验证码图片已变化，请重新开始采样';
    clickCaptchaCapture.enabled = false;
    renderClickCaptchaOverlay();
    notifyClickCaptchaCaptureUpdate();
    return;
  }

  const rect = target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
    return;
  }

  try {
    if (!clickCaptchaCapture.current) {
      const source = getClickCaptchaSource(target);
      if (source.targetCount !== CLICK_CAPTCHA_REQUIRED_TARGET_COUNT) {
        clickCaptchaCapture.enabled = false;
        clickCaptchaCapture.refreshing = true;
        clickCaptchaCapture.status = '检测到三字验证码，正在刷新为四字';
        renderClickCaptchaOverlay();
        notifyClickCaptchaCaptureUpdate();
        ensureFourTargetClickCaptcha(target)
          .then(prepared => {
            clickCaptchaCapture.target = prepared.target;
            clickCaptchaCapture.expectedClicks = CLICK_CAPTCHA_REQUIRED_TARGET_COUNT;
            clickCaptchaCapture.enabled = true;
            clickCaptchaCapture.refreshing = false;
            clickCaptchaCapture.status = '已跳过三字验证码，请正常手动点击 4 个目标字';
            renderClickCaptchaOverlay();
            notifyClickCaptchaCaptureUpdate();
          })
          .catch(error => {
            clickCaptchaCapture.enabled = false;
            clickCaptchaCapture.refreshing = false;
            clickCaptchaCapture.status = `准备四字验证码失败：${error.message}`;
            renderClickCaptchaOverlay();
            notifyClickCaptchaCaptureUpdate();
          });
        return;
      }
      clickCaptchaCapture.current = {
        imageDataUrl: source.dataUrl,
        expectedClicks: CLICK_CAPTCHA_REQUIRED_TARGET_COUNT,
        image: {
          width: source.width,
          height: source.height,
          displayedWidth: Math.round(rect.width),
          displayedHeight: Math.round(rect.height),
          sourcePath: source.sourcePath,
          element: source.element
        },
        clicks: []
      };
    }

    const image = clickCaptchaCapture.current.image;
    const relativeX = (event.clientX - rect.left) / rect.width;
    const relativeY = (event.clientY - rect.top) / rect.height;
    clickCaptchaCapture.current.clicks.push({
      order: clickCaptchaCapture.current.clicks.length + 1,
      x: Math.round(relativeX * image.width),
      y: Math.round(relativeY * image.height),
      relativeX: Number(relativeX.toFixed(6)),
      relativeY: Number(relativeY.toFixed(6))
    });
    clickCaptchaCapture.status = `已记录 ${clickCaptchaCapture.current.clicks.length}/${clickCaptchaCapture.current.expectedClicks} 次点击`;
    renderClickCaptchaOverlay();

    if (clickCaptchaCapture.current.clicks.length === clickCaptchaCapture.current.expectedClicks) {
      clickCaptchaCapture.saving = true;
      saveClickCaptchaSample()
        .catch(error => {
          clickCaptchaCapture.status = `保存失败：${error.message}`;
          notifyClickCaptchaCaptureUpdate();
        })
        .finally(() => {
          clickCaptchaCapture.saving = false;
        });
    } else {
      notifyClickCaptchaCaptureUpdate();
    }
  } catch (error) {
    clickCaptchaCapture.status = `采样失败：${error.message}`;
    clickCaptchaCapture.current = null;
    notifyClickCaptchaCaptureUpdate();
  }
}, true);

window.addEventListener('scroll', renderClickCaptchaOverlay, true);
window.addEventListener('resize', renderClickCaptchaOverlay);
window.addEventListener('scroll', renderClickCaptchaSolverOverlay, true);
window.addEventListener('resize', renderClickCaptchaSolverOverlay);

// ============ 消息监听（与popup通信）============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'grabTaskLeaseRevoked') {
    const state = revokeGrabTaskLease(msg.taskId);
    sendResponse({ ok: true, state });
  } else if (msg.action === 'startGrab') {
    startGrab(msg.taskConfig || msg.targets || msg.courseNames, msg.interval);
    sendResponse({ ok: true, state: getStateSnapshot() });
  } else if (msg.action === 'stopGrab') {
    stopGrab();
    sendResponse({ ok: true, state: getStateSnapshot() });
  } else if (['runGrabNow', 'runNow', 'requestRunNow'].includes(msg.action)) {
    sendResponse({ ...runNowGrab(), state: getStateSnapshot() });
  } else if (msg.action === 'getGrabStatus') {
    sendResponse({ ok: true, state: getStateSnapshot() });
  } else if (msg.action === 'importFavoriteCourses') {
    importFavoriteCourseTargets()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, code: 'IMPORT_FAILED', message: error?.message || '导入收藏课程失败' }));
    return true;
  } else if (msg.action === 'getClickCaptchaCaptureStatus') {
    getClickCaptchaCaptureState().then(state => sendResponse({ ok: true, state }));
    return true;
  } else if (msg.action === 'setClickCaptchaCaptureEnabled') {
    setClickCaptchaCaptureEnabled(Boolean(msg.enabled))
      .then(state => sendResponse({ ok: true, state }));
    return true;
  } else if (msg.action === 'discardLastClickCaptchaSample') {
    discardLastClickCaptchaSample().then(state => sendResponse({ ok: true, state }));
    return true;
  } else if (msg.action === 'getClickCaptchaSolverStatus') {
    sendResponse({ ok: true, state: getClickCaptchaSolverState() });
  } else if (msg.action === 'getClickCaptchaManualStatus') {
    sendResponse(getClickCaptchaManualStatus());
  } else if (msg.action === 'setClickCaptchaSolverEnabled') {
    setClickCaptchaSolverEnabled(Boolean(msg.enabled))
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: error.message, state: getClickCaptchaSolverState() }));
    return true;
  } else if (msg.action === 'setClickCaptchaAutoClick') {
    setClickCaptchaAutoClick(Boolean(msg.enabled))
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: error.message, state: getClickCaptchaSolverState() }));
    return true;
  } else if (msg.action === 'runClickCaptchaSolver') {
    // 手动“重新识别”只标出顺序，不触发点击或提交。
    runClickCaptchaSolver({ allowAutoClick: false, force: true })
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: error.message, state: getClickCaptchaSolverState() }));
    return true;
  } else if (msg.action === 'clearClickCaptchaSolverOverlay') {
    clearClickCaptchaSolverOverlay();
    sendResponse({ ok: true, state: getClickCaptchaSolverState() });
  }
  return true; // 保持消息通道以支持异步sendResponse
});

// 迁移：清除旧版单 key 数组格式的残留数据（v5.0 之前的格式）
storageRemove(['nju_click_captcha_samples_v1']).catch(() => {});
void Promise.resolve(grabTaskRestoreReady).finally(() => initializeClickCaptchaSolver());
// DOM UI Interactions
function findCourseTabElement(scope) {
  const normalizedScope = normalizeCourseScope(scope);
  if (!normalizedScope) return null;
  const displayScope = courseScopeLabel(normalizedScope);
  const isVisible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const tabs = [...document.querySelectorAll('a, button, li, [role="tab"], [data-teachingclasstype], .cv-tab, .nav-item, .el-tabs__item, .ant-tabs-tab, .item')]
      .filter(el => !el.closest('table, tbody, tr, .course-jxb-container, .course-list, .cv-tbody, .nju-grab-status-panel'));
  const exactScopeTabs = tabs.filter(tab => {
    return isVisible(tab)
      && normalizeCourseScope(tab.getAttribute?.('data-teachingclasstype')) === normalizedScope;
  });
  if (exactScopeTabs.length > 0) return exactScopeTabs[exactScopeTabs.length - 1];
  const targetTabs = tabs.filter(tab => {
      if (!isVisible(tab)) return false;
      const text = (tab.textContent || '').trim();
      return text && (
          text === displayScope || 
          text === `我的${displayScope}` || 
          (text.includes(displayScope) && text.length < displayScope.length + 6)
      );
  });
  return targetTabs.length > 0 ? targetTabs[targetTabs.length - 1] : null;
}

function activateCourseTabElement(element, isActive = () => true) {
  if (!element) return false;
  if (typeof element.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
    for (const eventName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      if (!isActive()) return false;
      element.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }
  if (!isActive()) return false;
  if (typeof element.click === 'function') {
    element.click();
    return true;
  }
  return false;
}

async function waitForCourseTab(scope, attempts = 8, isActive = () => true) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isActive()) return null;
    const tab = findCourseTabElement(scope);
    if (tab) return tab;
    await sleep(250);
    if (!isActive()) return null;
  }
  return null;
}

async function jumpToCourseTab(scope, forceAlert = true, token = null) {
  const normalizedScope = normalizeCourseScope(scope);
  const isActive = () => token
    ? isAutomaticCourseScopeNavigationActive(token)
    : true;
  if (!isActive()) return false;
  const directTab = findCourseTabElement(normalizedScope);
  if (directTab) return activateCourseTabElement(directTab, isActive);

  const path = courseScopeNavigationPath(normalizedScope);
  for (const step of path) {
    if (!isActive()) return false;
    const targetTab = await waitForCourseTab(step, step === normalizedScope ? 8 : 2, isActive);
    if (!targetTab || !activateCourseTabElement(targetTab, isActive)) {
      if (!isActive()) return false;
      if (forceAlert) {
        alert(`未在屏幕上找到可见的“${courseScopeLabel(normalizedScope)}”切换按钮，请手动点击对应的选课标签页。`);
      }
      return false;
    }
    if (step !== normalizedScope) {
      await sleep(300);
      if (!isActive()) return false;
    }
  }
  return true;
}

function scheduleAutomaticCourseScopeNavigation(scopes) {
  if (automaticCourseScopeNavigationTimer !== null) return;
  if (automaticCourseScopeNavigationInFlight) {
    if (isAutomaticCourseScopeNavigationActive(automaticCourseScopeNavigationInFlightToken)) return;
    invalidateAutomaticCourseScopeNavigation();
  }
  const currentTime = Date.now();
  const candidates = [...new Set([...scopes].map(normalizeCourseScope).filter(Boolean))]
    .sort((left, right) => {
      return (automaticCourseScopeLastAttempt.get(left) || 0)
        - (automaticCourseScopeLastAttempt.get(right) || 0);
    });
  const scope = candidates.find(candidate => {
    const lastRunId = automaticCourseScopeLastAttemptRunId.get(candidate);
    const currentRunId = Math.max(0, Number(latestGrabPageState?.runId) || 0);
    return currentTime - (automaticCourseScopeLastAttempt.get(candidate) || 0) >= 4000
      || (currentRunId > 0 && lastRunId !== undefined && lastRunId !== currentRunId);
  });
  if (!scope) return;

  const token = automaticCourseScopeNavigationToken();
  const scheduledTimer = { timeoutId: null };
  automaticCourseScopeNavigationTimer = scheduledTimer;
  scheduledTimer.timeoutId = setTimeout(() => {
    if (automaticCourseScopeNavigationTimer !== scheduledTimer) return;
    automaticCourseScopeNavigationTimer = null;
    if (!isAutomaticCourseScopeNavigationActive(token)) return;
    automaticCourseScopeNavigationInFlight = true;
    automaticCourseScopeNavigationInFlightToken = token;
    automaticCourseScopeLastAttempt.set(scope, Date.now());
    automaticCourseScopeLastAttemptRunId.set(scope, token.runId);
    void jumpToCourseTab(scope, false, token).finally(() => {
      if (token.generation === automaticCourseScopeNavigationGeneration) {
        automaticCourseScopeNavigationInFlight = false;
        automaticCourseScopeNavigationInFlightToken = null;
      }
    });
  }, 200);
}

function highlightNativeCourseTab(scope) {
  const targetTab = findCourseTabElement(scope);
  if (targetTab && !targetTab.classList.contains('nju-grab-native-glow')) {
    targetTab.classList.add('nju-grab-native-glow');
  }
}
