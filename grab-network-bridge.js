// Runs in the page's MAIN world and exposes only sanitized选课请求结果 to the isolated content script.
(function installGrabNetworkBridge(global) {
  'use strict';

  const INSTALL_FLAG = '__njuAutoGrabNetworkBridgeV1__';
  const EVENT_NAME = 'nju-autograb-network-v1';
  const COURSE_QUERY_EVENT = 'nju-autograb-course-query-v1';
  const COURSE_RESULT_EVENT = 'nju-autograb-course-result-v1';
  // This cap prevents an unbounded task from flooding the page while still
  // covering normal task sizes in one round.
  const MAX_PROVIDER_SEARCHES = 12;
  // Public-course endpoints can expire the session when a fourth lookup follows
  // the first three in the same short burst. Keep requests serial, pause only at
  // the three-query boundary, then continue within the same monitoring round.
  const PUBLIC_COURSE_BURST_SIZE = 3;
  const PUBLIC_COURSE_BURST_WINDOW_MS = 1000;
  const PUBLIC_COURSE_QUERY_SCOPES = new Set(['GG', 'GG01', 'GG02']);
  const STOP_BATCH_OUTCOMES = new Set([
    'AUTH_EXPIRED',
    'RATE_LIMITED',
    'NETWORK_ERROR',
    'SERVER_ERROR'
  ]);
  const COURSE_SCOPE_LABELS = Object.freeze({
    ZY: '专业',
    GG: '公共',
    GG01: '公选课',
    GG02: '导学/研讨/通识',
    KZY: '跨专业',
    TX: '通修',
    TY: '体育',
    YD: '悦读',
    QB: '课表查询',
    SC: '收藏',
    TCT1: '专业',
    TCT2: '跨专业',
    TCT3: '公选课',
    TCT4: '导学/研讨/通识',
    TCT5: '体育'
  });
  const WATCHED_PATHS = [
    '/elective/programCourse.do',
    '/elective/publicCourse.do',
    '/elective/queryCourse.do',
    '/elective/queryfavorite.do',
    '/elective/volunteer.do',
    '/elective/studentstatus.do'
  ];

  const COURSE_SCOPE_ALIASES = Object.freeze({
    TCT1: 'ZY',
    TCT2: 'KZY',
    TCT3: 'GG01',
    TCT4: 'GG02',
    TCT5: 'TY'
  });

  function normalizeCourseScope(value) {
    const scope = safeText(value).toUpperCase();
    return COURSE_SCOPE_ALIASES[scope] || scope;
  }

  if (global[INSTALL_FLAG]) return;
  Object.defineProperty(global, INSTALL_FLAG, { value: true, configurable: false });

  let requestSequence = 0;
  let latestCourseQueryTemplate = null;
  const courseQueryTemplatesByScope = new Map();
  const unscopedCourseQueryCursors = new Map();
  const activeCourseQueries = new Map();

  function isPublicCourseQueryScope(queryScope) {
    return PUBLIC_COURSE_QUERY_SCOPES.has(normalizeCourseScope(queryScope));
  }

  function waitForPublicCourseBatchCooldown(control, cooldownStartedAt) {
    if (control.cancelled) return false;
    const elapsed = Math.max(0, Date.now() - cooldownStartedAt);
    const delay = Math.max(0, PUBLIC_COURSE_BURST_WINDOW_MS - elapsed);
    if (delay === 0) return true;
    return new Promise(resolve => {
      global.setTimeout(() => resolve(!control.cancelled), delay);
    });
  }

  function watchedPath(value) {
    try {
      const pathname = new URL(String(value || ''), global.location.href).pathname;
      return WATCHED_PATHS.find(path => pathname.endsWith(path)) || '';
    } catch {
      return '';
    }
  }

  function bodyField(body, name) {
    try {
      if (typeof body === 'string') return new URLSearchParams(body).get(name) || '';
      if (body instanceof URLSearchParams || body instanceof FormData) return String(body.get(name) || '');
    } catch {
      // Unsupported request bodies are intentionally ignored.
    }
    return '';
  }

  function parseResponse(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function safeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  function isCourseQueryPath(path) {
    return [
      '/elective/programCourse.do',
      '/elective/publicCourse.do',
      '/elective/queryCourse.do',
      '/elective/queryfavorite.do'
    ].includes(path);
  }

  function readQuerySetting(body) {
    try {
      const value = bodyField(body, 'querySetting');
      if (!value) return null;
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function rewriteQueryBody(body, query) {
    const setting = readQuerySetting(body);
    if (!setting?.data || typeof setting.data !== 'object') return null;
    setting.data.queryContent = safeText(query).slice(0, 300);
    setting.pageNumber = '0';
    setting.pageSize = '100';

    try {
      if (typeof body === 'string') {
        const params = new URLSearchParams(body);
        params.set('querySetting', JSON.stringify(setting));
        return params.toString();
      }
      if (body instanceof URLSearchParams) {
        const params = new URLSearchParams(body);
        params.set('querySetting', JSON.stringify(setting));
        return params;
      }
      if (body instanceof FormData) {
        const form = new FormData();
        for (const [name, value] of body.entries()) form.append(name, value);
        form.set('querySetting', JSON.stringify(setting));
        return form;
      }
    } catch {
      return null;
    }
    return null;
  }

  function queryContext(body) {
    const setting = readQuerySetting(body);
    return {
      electiveBatchId: safeText(setting?.data?.electiveBatchCode).slice(0, 300),
      teachingClassType: normalizeCourseScope(setting?.data?.teachingClassType).slice(0, 80)
    };
  }

  function nextUnscopedCourseQueryTemplate(searchId) {
    const templates = [...courseQueryTemplatesByScope.entries()];
    if (templates.length === 0) {
      return { queryScope: '', template: latestCourseQueryTemplate };
    }
    const key = safeText(searchId).slice(0, 300);
    const cursor = Math.max(0, Number(unscopedCourseQueryCursors.get(key)) || 0);
    const [queryScope, template] = templates[cursor % templates.length];
    unscopedCourseQueryCursors.set(key, (cursor + 1) % templates.length);
    if (unscopedCourseQueryCursors.size > 500) {
      unscopedCourseQueryCursors.delete(unscopedCourseQueryCursors.keys().next().value);
    }
    return { queryScope, template };
  }

  function firstText(sources, names, limit = 300) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const name of names) {
        const value = safeText(source[name]);
        if (value) return value.slice(0, limit);
      }
    }
    return '';
  }

  function flag(value) {
    return value === true || /^(?:1|true|yes|y)$/i.test(String(value ?? '').trim());
  }

  function numeric(value) {
    const number = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  function sanitizeCourseCandidate(parent, child, context) {
    const sources = [child, parent];
    const nestedTeachingClass = child !== parent;
    const selectedText = firstText(sources, ['numberOfSelected', 'numberOfFirstVolunteer'], 80);
    const capacityText = firstText(sources, ['classCapacity', 'capacity'], 80);
    const selectedNumber = numeric(selectedText);
    const capacityNumber = numeric(capacityText);
    // A professional-course parent is marked selected when any child class is selected.
    // Only the child flag can prove that this exact teaching class is selected.
    const selected = flag(child?.isChoose) || (!nestedTeachingClass && flag(parent?.isChoose));
    const full = flag(child?.isFull)
      || flag(parent?.isFull)
      || /^(?:已满|full)$/i.test(selectedText)
      || (selectedNumber !== null && capacityNumber !== null && capacityNumber > 0 && selectedNumber >= capacityNumber);
    const unavailable = ['01', '03'].includes(String(parent?.type || ''))
      || String(child?.canChoose ?? parent?.canChoose ?? '') === '0';
    const teachingTime = firstText(sources, ['teachingTime', 'teachingTimeName', 'classTime'], 300);
    const teachingPlace = firstText(sources, ['teachingPlace', 'teachingPlaceName'], 300);
    return {
      teachingClassId: firstText(sources, ['teachingClassID', 'teachingClassId', 'teachingclassid'], 300),
      teachingClassType: firstText(sources, ['teachingClassType'], 80) || context.teachingClassType,
      electiveBatchId: context.electiveBatchId,
      courseId: firstText(sources, ['courseID', 'courseId'], 300),
      courseNumber: firstText(sources, ['courseNumber'], 200),
      teachingClassNo: firstText(sources, ['teachingClassNumber', 'classNumber', 'number'], 200),
      name: firstText(sources, ['courseName'], 300),
      teacher: firstText(sources, ['teacherName'], 200),
      time: [teachingTime, teachingPlace].filter((value, index, values) => value && values.indexOf(value) === index).join(' '),
      campus: firstText(sources, ['campusName'], 100),
      selectedCount: selectedText,
      capacity: capacityText,
      conflict: flag(child?.isConflict) || flag(parent?.isConflict),
      status: selected ? 'SELECTED' : full ? 'FULL' : unavailable ? 'UNAVAILABLE' : 'AVAILABLE'
    };
  }

  function sanitizedCourseCandidates(response, body) {
    const parsed = parseResponse(response);
    const dataList = Array.isArray(parsed.dataList) ? parsed.dataList : [];
    const context = queryContext(body);
    const candidates = [];
    for (const parent of dataList.slice(0, 100)) {
      const classes = Array.isArray(parent?.tcList) && parent.tcList.length > 0
        ? parent.tcList.slice(0, 100)
        : [parent];
      for (const child of classes) {
        candidates.push(sanitizeCourseCandidate(parent, child, context));
        if (candidates.length >= 200) return candidates;
      }
    }
    return candidates;
  }

  function looksLikeLoginResponse(response) {
    const text = typeof response === 'string'
      ? response
      : response && typeof response === 'object'
        ? JSON.stringify(response)
        : '';
    return /(?:authserver\/login|loginDiv|studentLoginBtn|登录状态已失效|请先登录|未登录)/i.test(text);
  }

  function providerOutcome(status, code, response) {
    if (status === 401 || status === 403 || code === '302') return 'AUTH_EXPIRED';
    if (looksLikeLoginResponse(response)) return 'AUTH_EXPIRED';
    if (status === 429) return 'RATE_LIMITED';
    const responseText = typeof response === 'string'
      ? response
      : response && typeof response === 'object'
        ? JSON.stringify(response)
        : '';
    if (/(?:请求过快|操作过于频繁|操作频繁|访问频繁|稍后再试)/.test(responseText)) return 'RATE_LIMITED';
    if (status === 0) return 'NETWORK_ERROR';
    if (status >= 500) return 'SERVER_ERROR';
    // An empty code often means an HTML/login response or an incompatible schema.
    // Never turn that into a trustworthy "no courses" result.
    if (code !== '1') return 'SERVER_ERROR';
    return '';
  }

  function emitCourseResult(detail) {
    try {
      global.document.dispatchEvent(new CustomEvent(COURSE_RESULT_EVENT, {
        detail: JSON.stringify(detail)
      }));
    } catch {
      // Provider observability must never affect the school's page.
    }
  }

  function emitResult({ requestId, path, status, body, response, transport }) {
    if (!path) return;
    const parsed = parseResponse(response);
    const detail = {
      requestId,
      path,
      status: Number(status) || 0,
      code: safeText(parsed.code),
      message: safeText(parsed.msg ?? parsed.message ?? parsed.extmsg),
      outcome: providerOutcome(Number(status) || 0, safeText(parsed.code), response),
      teachingClassId: path === '/elective/studentstatus.do'
        ? safeText(bodyField(body, 'teachingClassId'))
        : '',
      transport,
      completedAt: Date.now()
    };
    try {
      global.document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: JSON.stringify(detail) }));
    } catch {
      // Observability must never affect the school's own request flow.
    }
  }

  const Xhr = global.XMLHttpRequest;
  if (Xhr?.prototype?.open && Xhr?.prototype?.send) {
    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;
    const originalSetRequestHeader = Xhr.prototype.setRequestHeader;
    const originalAbort = Xhr.prototype.abort;

    Xhr.prototype.open = function patchedGrabOpen(method, url, ...rest) {
      this.__njuAutoGrabRequest = {
        path: watchedPath(url),
        method,
        url,
        rest,
        headers: [],
        body: null,
        requestId: 0
      };
      return originalOpen.call(this, method, url, ...rest);
    };

    if (originalSetRequestHeader) {
      Xhr.prototype.setRequestHeader = function patchedGrabSetRequestHeader(name, value) {
        if (this.__njuAutoGrabRequest?.path) {
          this.__njuAutoGrabRequest.headers.push([String(name), String(value)]);
        }
        return originalSetRequestHeader.call(this, name, value);
      };
    }

    Xhr.prototype.send = function patchedGrabSend(body) {
      const request = this.__njuAutoGrabRequest;
      if (request?.path) {
        request.requestId = ++requestSequence;
        request.body = body;
        const querySetting = isCourseQueryPath(request.path) ? readQuerySetting(body) : null;
        if (querySetting?.data && typeof querySetting.data === 'object') {
          latestCourseQueryTemplate = {
            path: request.path,
            method: request.method,
            url: request.url,
            rest: request.rest,
            headers: request.headers.slice(),
            body,
            withCredentials: Boolean(this.withCredentials)
          };
          const scope = normalizeCourseScope(queryContext(body).teachingClassType);
          if (scope) courseQueryTemplatesByScope.set(scope, latestCourseQueryTemplate);
        }
        this.addEventListener('loadend', () => {
          let response = null;
          try {
            response = this.responseType === 'json' ? this.response : this.responseText;
          } catch {
            response = null;
          }
          emitResult({
            requestId: request.requestId,
            path: request.path,
            status: this.status,
            body: request.body,
            response,
            transport: 'xhr'
          });
        }, { once: true });
      }
      return originalSend.call(this, body);
    };

    function replayCourseSearch(template, search, control) {
      return new Promise(resolve => {
        const body = rewriteQueryBody(template.body, search.query);
        if (!body) {
          resolve({
            searchId: search.searchId,
            outcome: 'UNSUPPORTED',
            message: '当前课程查询格式暂不支持接口扫描',
            candidates: []
          });
          return;
        }

        let xhr = null;
        try {
          xhr = new Xhr();
          control.xhrs.add(xhr);
          originalOpen.call(xhr, template.method || 'POST', template.url, ...(template.rest || []));
          xhr.withCredentials = template.withCredentials;
          if (originalSetRequestHeader) {
            for (const [name, value] of template.headers || []) {
              originalSetRequestHeader.call(xhr, name, value);
            }
          }
          try {
            xhr.timeout = 5000;
          } catch {
            // Some test and legacy XHR implementations expose a read-only timeout.
          }
          xhr.addEventListener('loadend', () => {
            control.xhrs.delete(xhr);
            if (control.cancelled) {
              resolve(null);
              return;
            }
            let response = null;
            try {
              response = xhr.responseType === 'json' ? xhr.response : xhr.responseText;
            } catch {
              response = null;
            }
            const parsed = parseResponse(response);
            const status = Number(xhr.status) || 0;
            const code = safeText(parsed.code);
            const outcome = providerOutcome(status, code, response);
            resolve({
              searchId: search.searchId,
              outcome,
              message: outcome ? safeText(parsed.msg ?? parsed.message) || '课程接口查询失败' : '',
              candidates: outcome ? [] : sanitizedCourseCandidates(response, body)
            });
          }, { once: true });
          originalSend.call(xhr, body);
        } catch {
          if (xhr) control.xhrs.delete(xhr);
          resolve({
            searchId: search.searchId,
            outcome: 'NETWORK_ERROR',
            message: '无法复用学校页面的课程查询请求',
            candidates: []
          });
        }
      });
    }

    global.document.addEventListener(COURSE_QUERY_EVENT, event => {
      let detail = null;
      try {
        detail = JSON.parse(String(event.detail || ''));
      } catch {
        return;
      }
      const requestId = safeText(detail?.requestId).slice(0, 300);
      if (!requestId) return;
      if (detail.action === 'cancel') {
        const control = activeCourseQueries.get(requestId);
        if (!control) return;
        control.cancelled = true;
        if (originalAbort) {
          for (const xhr of [...control.xhrs]) originalAbort.call(xhr);
        }
        control.xhrs.clear();
        activeCourseQueries.delete(requestId);
        return;
      }
      if (detail.action !== 'query') return;

      const searches = (Array.isArray(detail.searches) ? detail.searches : [])
        .slice(0, MAX_PROVIDER_SEARCHES)
        .map((search, index) => ({
          searchId: safeText(search?.searchId || index).slice(0, 300),
          query: safeText(search?.query).slice(0, 300),
          queryScope: safeText(search?.queryScope).slice(0, 80),
          teachingClassType: safeText(search?.teachingClassType).slice(0, 80)
        }))
        .filter(search => search.query);
      if (!latestCourseQueryTemplate || searches.length === 0) {
        emitCourseResult({
          requestId,
          ok: false,
          outcome: 'UNSUPPORTED',
          message: latestCourseQueryTemplate ? '没有有效的课程搜索目标' : '尚未捕获学校页面的课程查询请求'
        });
        return;
      }

      const control = { cancelled: false, xhrs: new Set() };
      activeCourseQueries.set(requestId, control);
      void (async () => {
        const results = [];
        const preparedSearches = searches.map(search => {
          const requestedScope = normalizeCourseScope(search.queryScope || search.teachingClassType);
          const selected = requestedScope
            ? { queryScope: requestedScope, template: courseQueryTemplatesByScope.get(requestedScope) }
            : nextUnscopedCourseQueryTemplate(search.searchId);
          return {
            search,
            requestedScope,
            queryScope: selected.queryScope || requestedScope,
            template: selected.template
          };
        });
        let index = 0;
        let publicQueriesInBurst = 0;
        let cooldownStartedAt = null;
        while (index < preparedSearches.length) {
          if (control.cancelled) break;
          const prepared = preparedSearches[index];
          if (!prepared.template) {
            const displayScope = COURSE_SCOPE_LABELS[prepared.requestedScope]
              || prepared.requestedScope
              || '对应';
            results.push({
              searchId: prepared.search.searchId,
              queryScope: prepared.queryScope,
              outcome: 'OUT_OF_SCOPE',
              message: `等待打开 ${displayScope} 课程分类以建立查询通道`,
              candidates: []
            });
            index += 1;
            continue;
          }

          const isPublicCourseQuery = isPublicCourseQueryScope(prepared.queryScope);
          if (isPublicCourseQuery && publicQueriesInBurst >= PUBLIC_COURSE_BURST_SIZE) {
            if (!await waitForPublicCourseBatchCooldown(control, cooldownStartedAt)) break;
            publicQueriesInBurst = 0;
            cooldownStartedAt = null;
          }

          index += 1;
          const result = await replayCourseSearch(prepared.template, prepared.search, control);
          if (isPublicCourseQuery) {
            publicQueriesInBurst += 1;
            if (publicQueriesInBurst === PUBLIC_COURSE_BURST_SIZE) cooldownStartedAt = Date.now();
          }
          if (result) {
            results.push({ ...result, queryScope: prepared.queryScope });
            if (STOP_BATCH_OUTCOMES.has(result.outcome)) break;
          }
        }
        activeCourseQueries.delete(requestId);
        if (!control.cancelled) emitCourseResult({ requestId, ok: true, results });
      })();
    });
  }

  if (typeof global.fetch === 'function') {
    const originalFetch = global.fetch;
    global.fetch = async function patchedGrabFetch(input, init) {
      const url = typeof input === 'string' || input instanceof URL ? input : input?.url;
      const path = watchedPath(url);
      if (!path) return originalFetch.apply(this, arguments);

      const requestId = ++requestSequence;
      const body = init?.body;
      try {
        const result = await originalFetch.apply(this, arguments);
        result.clone().text().then(response => emitResult({
          requestId,
          path,
          status: result.status,
          body,
          response: result.url && /authserver\/login|\/login(?:\.do)?$/i.test(result.url)
            ? `${response}\n${result.url}`
            : response,
          transport: 'fetch'
        })).catch(() => emitResult({ requestId, path, status: result.status, body, response: null, transport: 'fetch' }));
        return result;
      } catch (error) {
        emitResult({ requestId, path, status: 0, body, response: null, transport: 'fetch' });
        throw error;
      }
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
