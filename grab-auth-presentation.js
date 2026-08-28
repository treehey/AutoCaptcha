// Pure presentation model for course-login recovery. It never reads credentials or changes runtime state.
(function initGrabAuthPresentation(global) {
  'use strict';

  const STAGE = Object.freeze({
    WAITING_LOGIN: 'WAITING_LOGIN',
    RETURNING: 'RETURNING',
    SELECTING_ROUND: 'SELECTING_ROUND',
    ENTERING_COURSE: 'ENTERING_COURSE',
    VERIFYING: 'VERIFYING',
    MANUAL_REQUIRED: 'MANUAL_REQUIRED'
  });

  const STAGE_PRESENTATION = Object.freeze({
    [STAGE.WAITING_LOGIN]: Object.freeze({
      badge: '等待登录',
      pill: '任务已安全暂停',
      title: '登录失效，等待恢复',
      defaultMessage: '扩展会尝试复用自动登录；登录完成后先验证选课状态，再继续监控。',
      tone: 'warning',
      targetLabel: '等待登录',
      targetDetail: '任务已保存，登录完成后先验证再继续'
    }),
    [STAGE.RETURNING]: Object.freeze({
      badge: '自动恢复',
      pill: '正在返回选课系统',
      title: '登录已完成，正在返回选课系统',
      defaultMessage: '任务配置已经保留，返回课程页后会先验证当前选课结果。',
      tone: 'active',
      targetLabel: '恢复中',
      targetDetail: '正在返回课程页，不会在此阶段提交'
    }),
    [STAGE.SELECTING_ROUND]: Object.freeze({
      badge: '自动恢复',
      pill: '正在选择原轮次',
      title: '正在恢复原监控轮次',
      defaultMessage: '扩展只会选择任务暂停前的轮次；无法精确匹配时会等待人工确认。',
      tone: 'active',
      targetLabel: '恢复中',
      targetDetail: '正在确认原监控轮次，不会选择其他轮次'
    }),
    [STAGE.ENTERING_COURSE]: Object.freeze({
      badge: '自动恢复',
      pill: '正在进入选课轮次',
      title: '正在进入当前选课轮次',
      defaultMessage: '扩展只调用学校页面已有的进入按钮，进入后先执行恢复验证。',
      tone: 'active',
      targetLabel: '恢复中',
      targetDetail: '正在进入选课轮次，不会重复点击入口'
    }),
    [STAGE.VERIFYING]: Object.freeze({
      badge: '恢复验证',
      pill: '正在核对选课状态',
      title: '课程页已恢复，正在核对状态',
      defaultMessage: '正在验证已选课程和未决提交，确认完成前不会重复提交。',
      tone: 'active',
      targetLabel: '恢复验证',
      targetDetail: '正在核对已选结果，暂不重复提交'
    }),
    [STAGE.MANUAL_REQUIRED]: Object.freeze({
      badge: '需要操作',
      pill: '等待人工登录',
      title: '请手动完成选课系统登录',
      defaultMessage: '自动恢复已停止以避免重复跳转；任务仍然保留，登录后会先验证再继续。',
      tone: 'danger',
      targetLabel: '等待处理',
      targetDetail: '任务仍已保存，请先完成选课系统登录'
    })
  });

  function present(state, options = {}) {
    const source = state && typeof state === 'object' ? state : {};
    const recovery = source.authRecovery && typeof source.authRecovery === 'object'
      ? source.authRecovery
      : null;
    if (source.phase !== 'PAUSED_AUTH' || !recovery?.pending) return null;

    const stage = Object.hasOwn(STAGE_PRESENTATION, recovery.stage)
      ? recovery.stage
      : STAGE.WAITING_LOGIN;
    const definition = STAGE_PRESENTATION[stage];
    const groupCount = Math.max(0, Math.floor(Number(options.groupCount) || 0));
    const preserved = groupCount > 0 ? `已保留 ${groupCount} 个课程组。` : '';
    const lastMessage = String(recovery.lastMessage || '').trim();

    return Object.freeze({
      active: true,
      stage,
      manualRequired: stage === STAGE.MANUAL_REQUIRED,
      badge: definition.badge,
      pill: definition.pill,
      title: definition.title,
      subtitle: lastMessage || `${preserved}${definition.defaultMessage}`,
      tone: definition.tone,
      badgeTone: definition.tone === 'active' ? 'info' : definition.tone,
      target: Object.freeze({
        label: definition.targetLabel,
        detail: definition.targetDetail,
        tone: definition.tone
      })
    });
  }

  const exported = Object.freeze({ STAGE, present });
  global.NjuGrabAuthPresentation = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : self);
