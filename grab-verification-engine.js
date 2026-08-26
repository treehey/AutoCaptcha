// Pure selection-result verification. Callers provide observations from DOM or network adapters.
(function initGrabVerificationEngine(global) {
  'use strict';

  const DEFAULT_PATHS = Object.freeze({
    submit: '/elective/volunteer.do',
    status: '/elective/studentstatus.do'
  });

  function safeText(value) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
  }

  function createVerificationEngine(options = {}) {
    const outcome = options.outcome;
    if (!outcome || typeof outcome !== 'object') {
      throw new TypeError('VerificationEngine requires the grab outcome enum');
    }
    const paths = Object.freeze({
      submit: safeText(options.paths?.submit) || DEFAULT_PATHS.submit,
      status: safeText(options.paths?.status) || DEFAULT_PATHS.status
    });

    function classifyFeedback(value) {
      const text = safeText(value);
      if (!text) return null;
      if (/未登录|登录(?:状态)?(?:已)?(?:失效|过期)|重新登录|loginURL/i.test(text)) return outcome.AUTH_EXPIRED;
      if (/验证码/.test(text)) return outcome.CAPTCHA_REQUIRED;
      if (/已满|无余量|没有余量|名额已满/.test(text)) return outcome.FULL;
      if (/冲突/.test(text)) return outcome.CONFLICT;
      if (/学分.*(?:上限|超过|超出)/.test(text)) return outcome.CREDIT_LIMIT;
      if (/(?:课程|门数).*(?:上限|超过|超出)/.test(text)) return outcome.COURSE_LIMIT;
      if (/先修|前置课程|不满足.*条件/.test(text)) return outcome.PREREQUISITE_FAILED;
      if (/请求频繁|操作频繁|稍后再试|限流/.test(text)) return outcome.RATE_LIMITED;
      if (/重复|已经选择|已选过/.test(text)) return outcome.DUPLICATE;
      if (/服务器|系统异常|服务异常/.test(text)) return outcome.SERVER_ERROR;
      if (/失败|不能|不可|不允许|拒绝|未开放|未开始|已结束|不在.*(?:时间|范围)/.test(text)) return outcome.REJECTED;
      return null;
    }

    function isGlobalSelectionWindowRejection(message) {
      return /未开放|未开始|已结束|关闭|不在.*(?:时间|范围)/.test(safeText(message));
    }

    function feedbackResult(feedbackText) {
      const message = safeText(feedbackText);
      const classified = classifyFeedback(message);
      if (!classified) return null;
      return {
        outcome: classified,
        message,
        ...(isGlobalSelectionWindowRejection(message) ? { retryOtherCandidate: false } : {})
      };
    }

    function networkResult(candidate, values) {
      const events = Array.isArray(values) ? values : [];
      const teachingClassId = safeText(candidate?.teachingClassId);
      for (const event of events) {
        const path = safeText(event?.path);
        const isSubmit = path === paths.submit;
        const isMatchingStatus = path === paths.status
          && teachingClassId
          && safeText(event?.teachingClassId) === teachingClassId;
        if (!isSubmit && !isMatchingStatus) continue;

        const status = Number(event?.status) || 0;
        const code = safeText(event?.code);
        const message = safeText(event?.message);
        if (status === 401 || status === 403 || code === '302') {
          return { outcome: outcome.AUTH_EXPIRED, message: message || '选课登录状态已失效' };
        }
        if (status === 429) {
          return { outcome: outcome.RATE_LIMITED, message: message || '选课请求受到限流' };
        }
        if (status >= 500) {
          return { outcome: outcome.SERVER_ERROR, message: message || `选课服务返回 HTTP ${status}` };
        }
        if (status === 0) {
          return { outcome: outcome.NETWORK_ERROR, message: message || '选课请求未得到网络响应' };
        }

        if (isSubmit) {
          if (code && code !== '1') {
            const classified = classifyFeedback(message) || outcome.REJECTED;
            return {
              outcome: classified,
              message: message || `选课提交被拒绝（code=${code}）`,
              ...(isGlobalSelectionWindowRejection(message) ? { retryOtherCandidate: false } : {})
            };
          }
          continue;
        }

        if (code === '1') {
          return { outcome: outcome.SUCCESS, message: message || '服务端已确认该教学班选课成功' };
        }
        if (code === '-1') {
          return {
            outcome: classifyFeedback(message) || outcome.REJECTED,
            message: message || '服务端确认该教学班选课失败'
          };
        }
      }
      return null;
    }

    function evaluate(observation = {}) {
      if (observation.domSelected && observation.candidate && typeof observation.candidate === 'object') {
        return {
          outcome: outcome.SUCCESS,
          message: safeText(observation.domMessage) || '页面已显示该教学班为已选'
        };
      }
      return feedbackResult(observation.feedbackText)
        || networkResult(observation.candidate, observation.networkEvents);
    }

    return Object.freeze({ evaluate });
  }

  const exported = Object.freeze({ createVerificationEngine });
  global.NjuGrabVerificationEngine = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : self);
