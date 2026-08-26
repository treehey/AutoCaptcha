const AUTH_URL = 'https://authserver.nju.edu.cn/authserver/login';
const GRAB_ENTRY_URL = 'https://xk.nju.edu.cn/';
const CLICK_CAPTCHA_SAMPLE_COUNT_KEY = 'nju_click_captcha_v1_count';
const CLICK_CAPTCHA_SAMPLE_KEY_PREFIX = 'nju_click_captcha_v1_';
const CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY = 'nju_click_captcha_v1_skipped_three_count';
const CLICK_CAPTCHA_SOLVER_ENABLED_KEY = 'nju_click_captcha_solver_enabled';
const CLICK_CAPTCHA_AUTO_CLICK_KEY = 'nju_click_captcha_auto_click';
const AUTH_PREWARM_ENABLED_KEY = 'nju_auth_prewarm_enabled';
const GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY = 'nju_grab_page_enhancements_enabled';
const grabTaskModel = globalThis.NjuGrabTaskModel;
const grabAuthPresentation = globalThis.NjuGrabAuthPresentation;
const GRAB_TASK_CONFIG_KEY = grabTaskModel.STORAGE_KEY;

const storageKeys = [
  'nju_user',
  'nju_pass',
  'nju_enabled',
  'nju_force',
  'nju_auto_click',
  AUTH_PREWARM_ENABLED_KEY,
  GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY,
  CLICK_CAPTCHA_SOLVER_ENABLED_KEY,
  CLICK_CAPTCHA_AUTO_CLICK_KEY,
  'nju_grab_courses',
  'nju_grab_interval',
  GRAB_TASK_CONFIG_KEY
];

const els = {
  versionBadge: document.getElementById('versionBadge'),
  featureGuide: document.getElementById('featureGuide'),
  featureGuideBackdrop: document.getElementById('featureGuideBackdrop'),
  featureGuideBtn: document.getElementById('featureGuideBtn'),
  featureGuideCloseBtn: document.getElementById('featureGuideCloseBtn'),
  loginStatePill: document.getElementById('loginStatePill'),
  grabStatePill: document.getElementById('grabStatePill'),
  credentialBadge: document.getElementById('credentialBadge'),
  accountCard: document.getElementById('accountCard'),
  accountSummary: document.getElementById('accountSummary'),
  loginModeBadge: document.getElementById('loginModeBadge'),
  loginStatusBadge: document.getElementById('loginStatusBadge'),
  loginStatusTitle: document.getElementById('loginStatusTitle'),
  loginStatusSub: document.getElementById('loginStatusSub'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  togglePassword: document.getElementById('togglePassword'),
  saveBtn: document.getElementById('saveBtn'),
  isEnabled: document.getElementById('isEnabled'),
  authPrewarm: document.getElementById('authPrewarm'),
  authPrewarmDesc: document.getElementById('authPrewarmDesc'),
  forceFill: document.getElementById('forceFill'),
  autoClick: document.getElementById('autoClick'),
  clickCaptchaAutoLogin: document.getElementById('clickCaptchaAutoLogin'),
  captchaTools: document.getElementById('captchaTools'),
  currentCaptchaTitle: document.getElementById('currentCaptchaTitle'),
  currentCaptchaNote: document.getElementById('currentCaptchaNote'),
  currentCaptchaBadge: document.getElementById('currentCaptchaBadge'),
  recognizeAgainBtn: document.getElementById('recognizeAgainBtn'),
  ocrPreviewCode: document.getElementById('ocrPreviewCode'),
  ocrPreviewMeta: document.getElementById('ocrPreviewMeta'),
  ocrPreviewDetails: document.getElementById('ocrPreviewDetails'),
  githubBtn: document.getElementById('githubBtn'),
  authPageBtn: document.getElementById('authPageBtn'),
  grabBadge: document.getElementById('grabBadge'),
  grabSummaryTitle: document.getElementById('grabSummaryTitle'),
  grabSummarySub: document.getElementById('grabSummarySub'),
  grabRoundBadge: document.getElementById('grabRoundBadge'),
  grabSteps: document.getElementById('grabSteps'),
  grabPageEnhancementsEnabled: document.getElementById('grabPageEnhancementsEnabled'),
  courseNames: document.getElementById('courseNames'),
  courseTagContainer: document.getElementById('courseTagContainer'),
  courseTagsWrapper: document.getElementById('courseTagsWrapper'),
  courseNamesInput: document.getElementById('courseNamesInput'),
  courseCount: document.getElementById('courseCount'),
  exactTargets: document.getElementById('exactTargets'),
  exactTargetList: document.getElementById('exactTargetList'),
  courseGroups: document.getElementById('courseGroups'),
  courseGroupList: document.getElementById('courseGroupList'),
  grabInterval: document.getElementById('grabInterval'),
  intervalLabel: document.getElementById('intervalLabel'),
  intervalGrid: document.getElementById('intervalGrid'),
  grabBtn: document.getElementById('grabBtn'),
  importFavoriteCoursesBtn: document.getElementById('importFavoriteCoursesBtn'),
  openGrabPageBtn: document.getElementById('openGrabPageBtn'),
  clickCaptchaCaptureBadge: document.getElementById('clickCaptchaCaptureBadge'),
  clickCaptchaCaptureTitle: document.getElementById('clickCaptchaCaptureTitle'),
  clickCaptchaCaptureSub: document.getElementById('clickCaptchaCaptureSub'),
  clickCaptchaSampleCount: document.getElementById('clickCaptchaSampleCount'),
  clickCaptchaCaptureBtn: document.getElementById('clickCaptchaCaptureBtn'),
  exportClickCaptchaBtn: document.getElementById('exportClickCaptchaBtn'),
  discardClickCaptchaBtn: document.getElementById('discardClickCaptchaBtn'),
  resetClickCaptchaBtn: document.getElementById('resetClickCaptchaBtn'),
  clickCaptchaSolverEnabled: document.getElementById('clickCaptchaSolverEnabled'),
  clickCaptchaAutoClick: document.getElementById('clickCaptchaAutoClick'),
  runClickCaptchaSolverBtn: document.getElementById('runClickCaptchaSolverBtn'),
  clearClickCaptchaSolverBtn: document.getElementById('clearClickCaptchaSolverBtn'),
  grabStatus: document.getElementById('grabStatus'),
  copyLogBtn: document.getElementById('copyLogBtn'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  toast: document.getElementById('toast')
};

const switchKeyMap = {
  forceFill: 'nju_force'
};

let initialCredentials = { user: '', pass: '' };
let grabRunning = false;
let grabConnected = false;
let grabState = null;
let clickCaptchaCaptureState = null;
let clickCaptchaCaptureConnected = false;
let clickCaptchaSolverState = null;
let clickCaptchaSolverConnected = false;
let toastTimer = null;
let syncingGrab = false;
let syncingClickCaptchaCapture = false;
let syncingClickCaptchaSolver = false;
let previewRunning = false;
let clickCaptchaAutoLoginEnabled = true;
let currentCaptchaPage = 'other';
let authPreviewConnected = false;
let authPreviewReady = false;
let captchaTestCapability = { mode: 'none', ready: false };
let authPrewarmState = null;
let grabTaskConfig = grabTaskModel.normalizeTaskConfig(null);
let grabRetryRenderTimer = null;

function setVersion() {
  if (els.versionBadge && chrome.runtime && chrome.runtime.getManifest) {
    els.versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
  }, 1400);
}

function setBadge(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  el.className = `badge ${tone || 'info'}`;
}

function setPill(el, text) {
  if (!el) return;
  const label = el.querySelector('span:last-child');
  if (label) label.textContent = text;
}

function getCourseNames() {
  return els.courseNames.value
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean);
}

function getExactTargets() {
  return grabTaskConfig.targets.filter(target => target.kind === grabTaskModel.TARGET_KIND.TEACHING_CLASS);
}

function getConfiguredTaskConfig() {
  const withKeywords = grabTaskModel.replaceKeywordTargets(
    grabTaskConfig,
    grabTaskModel.keywordTargetsFromText(els.courseNames.value)
  );
  return grabTaskModel.normalizeTaskConfig({
    ...withKeywords,
    intervalMs: Number(els.grabInterval.value) || withKeywords.intervalMs || 5000
  });
}

function getConfiguredTargets() {
  return getConfiguredTaskConfig().targets;
}

function persistGrabTaskConfig() {
  grabTaskConfig = {
    ...getConfiguredTaskConfig(),
    updatedAt: Date.now()
  };
  chrome.storage.local.set({
    [GRAB_TASK_CONFIG_KEY]: grabTaskConfig,
    nju_grab_courses: els.courseNames.value,
    nju_grab_interval: String(grabTaskConfig.intervalMs)
  });
}

function createTargetLabelElement(target) {
  const container = document.createElement('div');
  container.className = 'exact-target-label'; // reused for both places
  
  const titleLine = document.createElement('div');
  titleLine.className = 'target-title-line';
  titleLine.textContent = target.name || '教学班';

  const detailsLine = document.createElement('div');
  detailsLine.className = 'target-details-line';
  
  let details = [];
  if (target.kind === grabTaskModel.TARGET_KIND.KEYWORD) {
    const filters = target.filters || {};
    details = [
      filters.teacher ? `教师 ${filters.teacher}` : '',
      filters.time ? `时间 ${filters.time}` : '',
      filters.campus ? `校区 ${filters.campus}` : ''
    ].filter(Boolean);
  } else {
    details = [
      target.teacher,
      target.teachingClassNo || target.teachingClassId,
      target.courseNumber,
      target.campus,
      target.time
    ].filter(Boolean);
  }
  
  if (details.length > 0) {
    detailsLine.innerHTML = details.map(d => `<span class="detail-pill">${d}</span>`).join('');
    container.append(titleLine, detailsLine);
  } else {
    container.append(titleLine);
  }
  
  return container;
}

function renderExactTargets() {
  const targets = getExactTargets();
  els.exactTargets.hidden = targets.length === 0;
  els.exactTargetList.textContent = '';
  for (const target of targets) {
    const item = document.createElement('div');
    item.className = 'exact-target-item';
    
    const label = createTargetLabelElement(target);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'exact-target-remove';
    remove.textContent = '移除';
    remove.disabled = grabRunning;
    remove.setAttribute('aria-label', `移除精确目标：${grabTaskModel.targetLabel(target)}`);
    remove.addEventListener('click', () => {
      if (grabRunning) return;
      grabTaskConfig = grabTaskModel.removeTargetFromTaskConfig(grabTaskConfig, target.targetId);
      persistGrabTaskConfig();
      updateCourseCount({ persist: false });
      showToast('已移除教学班目标');
    });
    item.append(label, remove);
    els.exactTargetList.appendChild(item);
  }
}

function renderCourseGroups(configValue = getConfiguredTaskConfig()) {
  if (!els.courseGroups || !els.courseGroupList) return;
  const config = grabTaskModel.normalizeTaskConfig(configValue);
  const hasKeywordTarget = config.targets.some(target => target.kind === grabTaskModel.TARGET_KIND.KEYWORD);
  const showStrategy = config.targets.length >= 2 || hasKeywordTarget;
  els.courseGroups.hidden = !showStrategy;
  els.courseGroupList.textContent = '';
  if (!showStrategy) return;

  const updateStrategy = (nextConfig, message) => {
    grabTaskConfig = nextConfig;
    persistGrabTaskConfig();
    updateCourseCount({ persist: false });
    showToast(message);
  };

  for (const group of config.groups) {
    const card = document.createElement('div');
    card.className = 'course-group-card';
    card.dataset.groupId = group.groupId;

    const head = document.createElement('div');
    head.className = 'course-group-head';

    const labelField = document.createElement('label');
    labelField.className = 'strategy-field-label';
    labelField.append('组名');
    const labelInput = document.createElement('input');
    labelInput.className = 'strategy-input';
    labelInput.type = 'text';
    labelInput.maxLength = 200;
    labelInput.value = group.label;
    labelInput.disabled = grabRunning;
    labelInput.setAttribute('aria-label', `课程组名称：${group.label}`);
    labelInput.addEventListener('change', () => {
      updateStrategy(
        grabTaskModel.updateCourseGroup(getConfiguredTaskConfig(), group.groupId, { label: labelInput.value }),
        '课程组名称已更新'
      );
    });
    labelField.appendChild(labelInput);

    const requiredField = document.createElement('label');
    requiredField.className = 'strategy-field-label';
    requiredField.append('要求数量');
    const requiredInput = document.createElement('input');
    requiredInput.className = 'strategy-input';
    requiredInput.type = 'number';
    requiredInput.min = '1';
    requiredInput.max = String(group.targets.length);
    requiredInput.step = '1';
    requiredInput.value = String(group.requiredCount);
    requiredInput.disabled = grabRunning;
    requiredInput.setAttribute('aria-label', `课程组“${group.label}”的要求数量`);
    requiredInput.addEventListener('change', () => {
      updateStrategy(
        grabTaskModel.updateCourseGroup(getConfiguredTaskConfig(), group.groupId, {
          requiredCount: Number(requiredInput.value)
        }),
        '要求数量已更新'
      );
    });
    requiredField.appendChild(requiredInput);
    head.append(labelField, requiredField);
    card.appendChild(head);

    for (const target of group.targets) {
      const targetRow = document.createElement('div');
      targetRow.className = 'course-group-target';
      const targetName = createTargetLabelElement(target);
      targetName.className = 'course-group-target-name';

      const controls = document.createElement('div');
      controls.className = 'course-group-target-controls';
      const priorityField = document.createElement('label');
      priorityField.className = 'strategy-field-label';
      priorityField.append('优先级');
      const priorityInput = document.createElement('input');
      priorityInput.className = 'strategy-input';
      priorityInput.type = 'number';
      priorityInput.min = '-1000';
      priorityInput.max = '1000';
      priorityInput.step = '1';
      priorityInput.value = String(target.priority || 0);
      priorityInput.disabled = grabRunning;
      priorityInput.setAttribute('aria-label', `${grabTaskModel.targetLabel(target)}的优先级`);
      priorityInput.addEventListener('change', () => {
        updateStrategy(
          grabTaskModel.updateTargetPriority(getConfiguredTaskConfig(), target.targetId, priorityInput.value),
          '目标优先级已更新'
        );
      });
      priorityField.appendChild(priorityInput);

      const groupField = document.createElement('label');
      groupField.className = 'strategy-field-label';
      groupField.append('归属课程组');
      const groupSelect = document.createElement('select');
      groupSelect.className = 'strategy-select';
      groupSelect.disabled = grabRunning;
      groupSelect.setAttribute('aria-label', `${grabTaskModel.targetLabel(target)}的课程组`);
      for (const optionGroup of config.groups) {
        const option = document.createElement('option');
        option.value = optionGroup.groupId;
        option.textContent = `${optionGroup.label}（${optionGroup.targets.length} 项）`;
        option.selected = optionGroup.groupId === group.groupId;
        groupSelect.appendChild(option);
      }
      if (group.targets.length > 1) {
        const standalone = document.createElement('option');
        standalone.value = '__standalone__';
        standalone.textContent = '单独成组';
        groupSelect.appendChild(standalone);
      }
      groupSelect.addEventListener('change', () => {
        const destination = groupSelect.value === '__standalone__' ? '' : groupSelect.value;
        updateStrategy(
          grabTaskModel.moveTargetToGroup(getConfiguredTaskConfig(), target.targetId, destination),
          destination ? '目标已移入课程组' : '目标已单独成组'
        );
      });
      groupField.appendChild(groupSelect);
      controls.append(priorityField, groupField);
      targetRow.append(targetName, controls);

      if (target.kind === grabTaskModel.TARGET_KIND.KEYWORD) {
        const filterTitle = document.createElement('div');
        filterTitle.className = 'course-target-filter-title';
        filterTitle.textContent = '候选过滤（包含匹配，多个条件同时生效）';
        const filters = document.createElement('div');
        filters.className = 'course-target-filters';
        const filterFields = [
          ['teacher', '教师', '如：王老师'],
          ['time', '时间', '如：周一 3-4节'],
          ['campus', '校区', '如：仙林']
        ];
        for (const [key, label, placeholder] of filterFields) {
          const field = document.createElement('label');
          field.className = 'strategy-field-label';
          field.append(label);
          const input = document.createElement('input');
          input.className = 'strategy-input';
          input.type = 'text';
          input.maxLength = key === 'campus' ? 100 : key === 'time' ? 300 : 200;
          input.placeholder = placeholder;
          input.value = target.filters?.[key] || '';
          input.disabled = grabRunning;
          input.setAttribute('aria-label', `${target.name}的${label}过滤条件`);
          input.addEventListener('change', () => {
            updateStrategy(
              grabTaskModel.updateTargetFilters(getConfiguredTaskConfig(), target.targetId, {
                ...target.filters,
                [key]: input.value
              }),
              `${label}过滤已更新`
            );
          });
          field.appendChild(input);
          filters.appendChild(field);
        }
        targetRow.append(filterTitle, filters);
      }
      card.appendChild(targetRow);
    }
    els.courseGroupList.appendChild(card);
  }
}

function updateCourseCount({ persist = true } = {}) {
  const config = getConfiguredTaskConfig();
  const count = config.targets.length;
  els.courseCount.textContent = `${count} 项 · ${config.groups.length} 组`;
  renderExactTargets();
  renderCourseGroups(config);
  renderGrabControls();
  if (persist) persistGrabTaskConfig();
}

function credentialsDirty() {
  return els.username.value !== initialCredentials.user || els.password.value !== initialCredentials.pass;
}

function renderCredentialState() {
  const hasUser = Boolean(els.username.value.trim());
  const hasPass = Boolean(els.password.value);
  const configured = hasUser && hasPass;
  const hadSavedCredentials = Boolean(initialCredentials.user.trim() && initialCredentials.pass);
  const dirty = credentialsDirty();

  if (configured) {
    setBadge(els.credentialBadge, dirty ? '有未保存更改' : '已配置', dirty ? 'warning' : 'success');
    els.accountSummary.textContent = dirty ? '账号信息有未保存更改。' : `已配置 · ${maskUsername(els.username.value)}`;
  } else {
    setBadge(els.credentialBadge, '未配置', 'warning');
    els.accountSummary.textContent = '首次使用时配置，之后可随时修改。';
  }

  els.saveBtn.disabled = !dirty || (!configured && !hadSavedCredentials);
  els.saveBtn.textContent = configured
    ? (dirty ? '保存更改' : '已保存')
    : hadSavedCredentials ? '保存更改' : (hasUser || hasPass ? '请填写完整账号' : '请填写账号');
  renderLoginState();
}

function maskUsername(value) {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, 2)}****${trimmed.slice(-2)}`;
}

function renderLoginState() {
  const enabled = els.isEnabled.checked;
  const configured = Boolean(els.username.value.trim() && els.password.value);

  if (!configured) {
    setPill(els.loginStatePill, '账号未配置');
    setBadge(els.loginStatusBadge, '待配置', 'warning');
    els.loginStatusTitle.textContent = '先配置账号';
    els.loginStatusSub.textContent = '保存账号后，统一认证与选课系统会按默认策略自动登录。';
  } else if (!enabled) {
    setPill(els.loginStatePill, '统一认证已暂停');
    setBadge(els.loginStatusBadge, '已暂停', 'warning');
    els.loginStatusTitle.textContent = '统一认证自动登录已暂停';
    els.loginStatusSub.textContent = '账号仍保存在浏览器本地；选课系统自动登录不受影响。';
  } else {
    setPill(els.loginStatePill, '统一认证已开启');
    setBadge(els.loginStatusBadge, '已开启', 'success');
    els.loginStatusTitle.textContent = '统一认证自动登录已开启';
    els.loginStatusSub.textContent = '认证页会自动填写、识别验证码并提交。';
  }

  setBadge(els.loginModeBadge, enabled ? '已开启' : '已暂停', enabled ? 'success' : 'warning');
  renderAuthPrewarmState();
}

function renderAuthPrewarmState() {
  if (!els.authPrewarm || !els.authPrewarmDesc) return;
  const configured = Boolean(els.username.value.trim() && els.password.value);
  if (!els.authPrewarm.checked) {
    els.authPrewarmDesc.textContent = '默认关闭；开启后在扩展后台准备会话，不新增标签页。';
    return;
  }
  if (!els.isEnabled.checked || !els.autoClick.checked) {
    els.authPrewarmDesc.textContent = '等待开启统一认证自动提交后生效。';
    return;
  }
  if (!configured) {
    els.authPrewarmDesc.textContent = '等待保存完整账号和密码后生效。';
    return;
  }

  const phase = authPrewarmState?.phase;
  const copy = {
    running: '正在后台建立统一认证会话。',
    ready: '本次浏览器会话的统一认证已准备。',
    attention: authPrewarmState?.reason || '后台认证需要人工处理，本次不会重试。',
    failed: authPrewarmState?.reason || '本次后台认证未完成，不会自动重试。',
    cancelled: authPrewarmState?.reason || '后台认证已取消。',
    disabled: '默认关闭；开启后在扩展后台准备会话，不新增标签页。',
    idle: authPrewarmState?.reason || '将在满足条件时从扩展后台准备认证会话。'
  };
  els.authPrewarmDesc.textContent = copy[phase] || '将在浏览器启动后从扩展后台准备认证会话。';
}

async function syncAuthPrewarmStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getAuthPrewarmStatus' });
    authPrewarmState = response?.ok ? response.state : null;
  } catch {
    authPrewarmState = null;
  }
  renderAuthPrewarmState();
}

function formatGrabScanStatus(scan) {
  if (!scan || typeof scan !== 'object') return '';
  const queried = Math.max(0, Number(scan.queriedTargetCount) || 0);
  const deferred = Math.max(0, Number(scan.deferredTargetCount) || 0);
  const scopeDeferred = Math.max(0, Number(scan.scopeDeferredTargetCount) || 0);
  const materialized = Math.max(0, Number(scan.materializedQueryCount) || 0);
  const shadowCompared = Math.max(0, Number(scan.shadowComparison?.comparisonCount) || 0);
  const shadowMismatched = Math.max(0, Number(scan.shadowComparison?.mismatchedComparisonCount) || 0);
  const shadowSuffix = shadowCompared > 0
    ? `；累计核对 ${shadowCompared} 次${shadowMismatched > 0 ? `，${shadowMismatched} 次有差异` : '，结果一致'}`
    : '';
  if (scan.mode === 'NETWORK') {
    const waits = [
      deferred > 0 ? `${deferred} 个下轮分批查询` : '',
      scopeDeferred > 0 ? `${scopeDeferred} 个等待对应分类` : ''
    ].filter(Boolean);
    const base = `接口查询 ${queried} 个目标${waits.length > 0 ? `，${waits.join('，')}` : ''}`;
    return `${base}${shadowSuffix}`;
  }
  if (scan.mode === 'NETWORK_WITH_DOM') {
    return materialized > 0
      ? `接口发现候选，已精确物化 ${materialized} 次${shadowSuffix}`
      : `接口查询后已用当前页面校验${shadowSuffix}`;
  }
  if (scan.mode === 'DOM_FALLBACK') return '接口模板未就绪，已用 DOM 兼容扫描';
  if (scan.mode === 'ERROR') {
    return {
      AUTH_EXPIRED: '查询发现登录失效',
      RATE_LIMITED: '查询触发限流',
      NETWORK_ERROR: '查询遇到网络异常',
      SERVER_ERROR: '查询遇到服务端异常'
    }[scan.outcome] || '本轮查询未完成';
  }
  return '';
}

function renderGrabState() {
  if (grabRetryRenderTimer) clearTimeout(grabRetryRenderTimer);
  grabRetryRenderTimer = null;
  const round = grabState?.round || 0;
  const selectedCount = grabState?.successTargets?.length
    ?? grabState?.successCourses?.length
    ?? 0;
  const completedCount = grabState?.completedGroups ?? selectedCount;
  const groupCount = grabState?.totalGroups
    ?? grabState?.initialTargetCount
    ?? grabState?.configuredCourseNames?.length
    ?? grabState?.courseNames?.length
    ?? getCourseNames().length;
  const authRecoveryView = grabAuthPresentation.present(grabState, { groupCount });
  const progressText = `已完成 ${completedCount}/${groupCount || 0} 个课程组，确认 ${selectedCount} 门课程`;
  const interval = grabState?.interval || Number(els.grabInterval.value || 5000);
  const currentTime = Date.now();
  const globalRetryMs = Math.max(0, Number(grabState?.globalRetryAt || 0) - currentTime);
  const nextRetryMs = Math.max(0, Number(grabState?.nextRetryAt || 0) - currentTime);
  const retryingTargetCount = nextRetryMs > 0 ? Number(grabState?.retryingTargetCount || 0) : 0;
  const retrySeconds = Math.max(1, Math.ceil((globalRetryMs || nextRetryMs) / 1000));
  const scanStatusText = formatGrabScanStatus(grabState?.lastScan);
  if (grabRunning && (globalRetryMs > 0 || nextRetryMs > 0)) {
    grabRetryRenderTimer = setTimeout(renderGrabState, Math.min(1000, globalRetryMs || nextRetryMs));
  }

  els.grabRoundBadge.textContent = `${round} 轮`;
  if (els.grabSteps) els.grabSteps.hidden = grabConnected || grabRunning;

  if (!grabConnected) {
    setBadge(els.grabBadge, '未连接', 'warning');
    setPill(els.grabStatePill, '选课页未连接');
    els.grabSummaryTitle.textContent = '等待连接选课页面';
    els.grabSummarySub.textContent = '打开选课系统后可同步监控状态。';
  } else if (authRecoveryView) {
    setBadge(els.grabBadge, authRecoveryView.badge, authRecoveryView.badgeTone);
    setPill(els.grabStatePill, authRecoveryView.pill);
    els.grabSummaryTitle.textContent = authRecoveryView.title;
    els.grabSummarySub.textContent = authRecoveryView.subtitle;
  } else if (grabRunning) {
    if (globalRetryMs > 0) {
      const reason = {
        RATE_LIMITED: '触发限流',
        SERVER_ERROR: '服务端暂时异常',
        NETWORK_ERROR: '网络暂时异常'
      }[grabState?.lastTransientOutcome] || '请求暂时异常';
      setBadge(els.grabBadge, '退避中', 'warning');
      setPill(els.grabStatePill, `退避中 · ${retrySeconds}s`);
      els.grabSummaryTitle.textContent = `${reason}，${retrySeconds} 秒后恢复`;
      els.grabSummarySub.textContent = `${progressText}；退避期间不会继续提交请求。`;
    } else {
      setBadge(els.grabBadge, retryingTargetCount > 0 ? '部分退避' : '监控中', retryingTargetCount > 0 ? 'warning' : 'success');
      setPill(els.grabStatePill, `监控中 · ${round} 轮`);
      els.grabSummaryTitle.textContent = `监控中，已完成 ${round} 轮`;
      els.grabSummarySub.textContent = retryingTargetCount > 0
        ? `${progressText}；${retryingTargetCount} 个目标等待重试，其余目标继续监控${scanStatusText ? `；${scanStatusText}` : ''}。`
        : `${progressText}${scanStatusText ? `；${scanStatusText}` : ''}；间隔 ${Math.round(interval / 1000)}s`;
    }
  } else if (grabState?.phase === 'COMPLETED') {
    setBadge(els.grabBadge, '已完成', 'success');
    setPill(els.grabStatePill, '课程组已满足');
    els.grabSummaryTitle.textContent = `已完成 ${completedCount}/${groupCount || 0} 个课程组`;
    els.grabSummarySub.textContent = `已二次确认 ${selectedCount} 门课程${scanStatusText ? `；${scanStatusText}` : ''}，任务已自动停止。`;
  } else if (grabState?.phase === 'FAILED') {
    setBadge(els.grabBadge, '需处理', 'warning');
    setPill(els.grabStatePill, '任务未完成');
    els.grabSummaryTitle.textContent = '课程组存在不可恢复限制';
    els.grabSummarySub.textContent = `${progressText}；请查看日志并调整目标。`;
  } else {
    setBadge(els.grabBadge, '已连接', 'info');
    setPill(els.grabStatePill, '选课已连接');
    els.grabSummaryTitle.textContent = selectedCount > 0 ? `已确认 ${selectedCount} 门课程` : '选课页面已连接';
    els.grabSummarySub.textContent = scanStatusText
      ? `最近一次：${scanStatusText}。填写目标课程后可重新开始。`
      : '填写目标课程后即可开始监控。';
  }

  renderGrabControls();
}

function renderGrabControls() {
  const courseCount = getConfiguredTargets().length;
  els.importFavoriteCoursesBtn.disabled = grabRunning;

  if (grabRunning) {
    els.grabBtn.textContent = '停止监控';
    els.grabBtn.className = 'danger-btn';
    els.grabBtn.disabled = false;
    return;
  }

  els.grabBtn.className = 'primary-btn';

  if (!grabConnected) {
    els.grabBtn.textContent = '打开选课页面';
    els.grabBtn.disabled = false;
    return;
  }

  els.grabBtn.textContent = '开始监控';
  els.grabBtn.disabled = courseCount === 0;
}

function renderClickCaptchaCaptureState() {
  const state = clickCaptchaCaptureState;
  const count = Number(state?.sampleCount || 0);
  const max = Number(state?.maxSampleCount || 30);
  const active = Boolean(state?.enabled);
  const refreshing = Boolean(state?.refreshing);
  const ready = Boolean(state?.ready);

  els.clickCaptchaSampleCount.textContent = `${count} 条`;
  els.exportClickCaptchaBtn.disabled = count === 0;
  els.discardClickCaptchaBtn.disabled = count === 0;
  els.resetClickCaptchaBtn.disabled = count === 0;

  if (!clickCaptchaCaptureConnected) {
    setBadge(els.clickCaptchaCaptureBadge, '未连接', 'warning');
    els.clickCaptchaCaptureTitle.textContent = '等待连接选课页面';
    els.clickCaptchaCaptureSub.textContent = '打开选课页后可启用本地采样。';
    els.clickCaptchaCaptureBtn.textContent = '开始采样';
    els.clickCaptchaCaptureBtn.className = 'primary-btn';
    els.clickCaptchaCaptureBtn.disabled = true;
    return;
  }

  if (refreshing) {
    setBadge(els.clickCaptchaCaptureBadge, '刷新中', 'info');
    els.clickCaptchaCaptureTitle.textContent = '正在准备下一张验证码';
    els.clickCaptchaCaptureSub.textContent = state.status || '等待页面刷新完成。';
    els.clickCaptchaCaptureBtn.textContent = '刷新中...';
    els.clickCaptchaCaptureBtn.className = 'secondary-btn';
    els.clickCaptchaCaptureBtn.disabled = true;
    return;
  }

  if (active) {
    setBadge(els.clickCaptchaCaptureBadge, '采样中', 'success');
    els.clickCaptchaCaptureTitle.textContent = `正在记录手动点击 ${state.pendingClicks || 0}/${state.expectedClicks || 4}`;
    els.clickCaptchaCaptureSub.textContent = state.status || '请在紫色虚线框内正常完成验证码。';
    els.clickCaptchaCaptureBtn.textContent = '停止采样';
    els.clickCaptchaCaptureBtn.className = 'danger-btn';
    els.clickCaptchaCaptureBtn.disabled = false;
    return;
  }

  setBadge(els.clickCaptchaCaptureBadge, ready ? '就绪' : '待验证码', ready ? 'info' : 'warning');
  els.clickCaptchaCaptureTitle.textContent = count >= max ? '请先导出当前样本' : '仅记录手动点击';
  els.clickCaptchaCaptureSub.textContent = state?.status || '完成当前验证码要求的点击后自动保存并继续采样。';
  els.clickCaptchaCaptureBtn.textContent = '开始采样';
  els.clickCaptchaCaptureBtn.className = 'primary-btn';
  els.clickCaptchaCaptureBtn.disabled = count >= max;
}

function renderClickCaptchaSolverState() {
  const state = clickCaptchaSolverState;
  const connected = clickCaptchaSolverConnected;
  const running = Boolean(state?.running);
  const enabled = Boolean(state?.enabled);
  const autoClick = Boolean(state?.autoClick);
  const hasResult = Array.isArray(state?.order);

  const configured = connected ? enabled && autoClick : clickCaptchaAutoLoginEnabled;
  els.clickCaptchaAutoLogin.checked = configured;
  els.clickCaptchaSolverEnabled.checked = connected ? enabled : configured;
  els.clickCaptchaAutoClick.checked = connected ? autoClick : configured;
  els.clickCaptchaAutoClick.disabled = !connected || !enabled;
  els.runClickCaptchaSolverBtn.disabled = !connected || running;
  els.clearClickCaptchaSolverBtn.disabled = !connected || !hasResult;
  renderCurrentCaptchaPanel();
}

function setIntervalValue(value, { persist = true } = {}) {
  const normalized = String(value || '3000');
  els.grabInterval.value = normalized;
  els.intervalLabel.textContent = `${Number(normalized) / 1000}s`;
  document.querySelectorAll('.interval-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === normalized);
  });
  if (persist) persistGrabTaskConfig();
}

function appendLog(message) {
  const empty = els.grabStatus.querySelector('.empty-log');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = 'log-line';
  if (/成功|已抢到|已在选课|🎉|✅|🎊/.test(message)) {
    line.classList.add('success');
  } else if (/警告|未找到|已满|未运行|继续|⚠️|⏳|🔍/.test(message)) {
    line.classList.add('warn');
  } else if (/失败|出错|无法|❌/.test(message)) {
    line.classList.add('error');
  }
  line.textContent = message;
  els.grabStatus.appendChild(line);
  els.grabStatus.scrollTop = els.grabStatus.scrollHeight;

  while (els.grabStatus.children.length > 30) {
    els.grabStatus.removeChild(els.grabStatus.firstChild);
  }
}

function renderLogs(logs) {
  els.grabStatus.innerHTML = '';
  if (!logs || logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-log';
    empty.textContent = '等待启动...';
    els.grabStatus.appendChild(empty);
    return;
  }
  logs.forEach(appendLog);
}

async function getGrabTab() {
  const tabs = await new Promise(resolve => {
    chrome.tabs.query({ url: 'https://xk.nju.edu.cn/*' }, tabs => {
      resolve(tabs || []);
    });
  });
  let connectedFallback = null;
  for (const tab of tabs) {
    const response = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { action: 'getGrabStatus' }, result => {
        if (chrome.runtime.lastError || !result?.state) {
          resolve(null);
          return;
        }
        resolve(result);
      });
    });
    if (!response) continue;
    connectedFallback ||= tab;
    if (response.state.running || response.state.authRecovery?.pending) return tab;
  }
  return connectedFallback || tabs[0] || null;
}

async function sendGrabMessage(message) {
  const tab = await getGrabTab();
  if (!tab) return { connected: false, response: null };

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, message, response => {
      if (chrome.runtime.lastError || !response) {
        resolve({ connected: false, response: null });
        return;
      }
      resolve({ connected: true, response });
    });
  });
}

async function sendActiveTabMessage(message) {
  const tab = await new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs && tabs.length > 0 ? tabs[0] : null);
    });
  });
  if (!tab || !tab.id) return { connected: false, response: null };

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, message, response => {
      if (chrome.runtime.lastError || !response) {
        resolve({ connected: false, response: null });
        return;
      }
      resolve({ connected: true, response });
    });
  });
}

function setPreviewConnection(connected, ready = false) {
  authPreviewConnected = connected;
  authPreviewReady = ready;
  renderCurrentCaptchaPanel();
}

function setCaptchaTestCapability(capability) {
  captchaTestCapability = {
    mode: capability?.mode || 'none',
    ready: Boolean(capability?.ready)
  };
  renderCurrentCaptchaPanel();
}

function setCaptchaPreviewContent(code, meta, details = '') {
  els.ocrPreviewCode.textContent = code;
  els.ocrPreviewCode.classList.toggle('empty', !code || code.startsWith('等待') || code.startsWith('未'));
  els.ocrPreviewMeta.textContent = meta;
  els.ocrPreviewDetails.textContent = details;
  els.ocrPreviewDetails.classList.toggle('has-content', Boolean(details));
}

function renderCurrentCaptchaPanel() {
  const mode = captchaTestCapability.mode;
  const visible = mode === 'legacy-ocr' || mode === 'click-mark';
  els.captchaTools.hidden = !visible;
  if (!visible) return;

  if (mode === 'legacy-ocr') {
    els.currentCaptchaTitle.textContent = '验证码测试';
    els.currentCaptchaNote.textContent = '仅重新识别并填入当前图形验证码，不会提交登录。';
    setBadge(els.currentCaptchaBadge, authPreviewReady ? '验证码就绪' : authPreviewConnected ? '认证页已连接' : '未连接', authPreviewReady ? 'success' : authPreviewConnected ? 'info' : 'warning');
    els.recognizeAgainBtn.textContent = previewRunning ? '识别中...' : '重新识别';
    els.recognizeAgainBtn.disabled = !authPreviewReady || previewRunning;
    return;
  }

  if (mode === 'click-mark') {
    const state = clickCaptchaSolverState;
    const running = Boolean(state?.running);
    const orderCount = Array.isArray(state?.order) ? state.order.length : 0;
    els.currentCaptchaTitle.textContent = '验证码测试';
    els.currentCaptchaNote.textContent = '仅标出点击顺序，不会自动点击或提交。';
    setBadge(els.currentCaptchaBadge, !clickCaptchaSolverConnected ? '未连接' : running ? '识别中' : '选课页已连接', !clickCaptchaSolverConnected ? 'warning' : running ? 'info' : 'success');
    setCaptchaPreviewContent(
      orderCount ? `已识别 ${orderCount} 个点击点` : running ? '正在识别' : '等待点击验证码',
      state?.status || '验证码加载完成后可重新识别。'
    );
    els.recognizeAgainBtn.textContent = running ? '识别中...' : '识别并标点';
    els.recognizeAgainBtn.disabled = !captchaTestCapability.ready || running;
  }
}

function renderOcrPreview(response) {
  const code = response.code || '';
  const mode = response.cnnEnabled ? 'CNN 增强开启' : 'CNN 增强关闭';
  const elapsed = Number.isFinite(response.elapsedMs) ? ` · ${Math.round(response.elapsedMs)}ms` : '';

  const candidates = (response.candidates || [])
    .map(item => `${item.variant}=${item.code || '空'}(${Math.round(item.confidence || 0)})`)
    .join(' | ');
  const rerank = response.cnnFusion?.fallbacks?.length
    ? `CNN 回退：${response.cnnFusion.fallbacks.map(item => `第${item.position + 1}位 ${item.reason}`).join('，')}`
    : response.templateRerank
    ? `模板：${response.templateRerank.selectedBefore || '空'}=>${response.templateRerank.selectedAfter || '空'} ${response.templateRerank.reason || ''}`
    : '';
  const details = [candidates, rerank].filter(Boolean).join('\n');
  setCaptchaPreviewContent(code || '未得到四位结果', `${mode}${elapsed}`, details);
}

async function syncOcrPreviewStatus() {
  const result = await sendActiveTabMessage({ action: 'getCaptchaPreviewStatus' });
  if (!result.connected) {
    setPreviewConnection(false);
    setCaptchaTestCapability();
    return;
  }
  const response = result.response || {};
  setPreviewConnection(true, Boolean(response.ready));
  setCaptchaTestCapability({
    mode: response.mode === 'legacy-ocr' ? 'legacy-ocr' : 'none',
    ready: response.ready
  });
}

async function syncCurrentCaptchaTestCapability() {
  if (currentCaptchaPage === 'auth') {
    await syncOcrPreviewStatus();
    return;
  }

  if (currentCaptchaPage !== 'grab') {
    setCaptchaTestCapability();
    return;
  }

  const result = await sendActiveTabMessage({ action: 'getClickCaptchaManualStatus' });
  if (!result.connected) {
    clickCaptchaSolverConnected = false;
    setCaptchaTestCapability();
    return;
  }

  const response = result.response || {};
  clickCaptchaSolverConnected = true;
  clickCaptchaSolverState = response.state || null;
  setCaptchaTestCapability({
    mode: response.mode === 'click-mark' ? 'click-mark' : 'none',
    ready: response.ready
  });
}

function applyGrabSnapshot(state) {
  grabState = state || null;
  grabRunning = Boolean(state?.running || state?.authRecovery?.pending);
  if (state?.interval) {
    setIntervalValue(state.interval, { persist: false });
  }
  updateCourseCount({ persist: false });
  renderGrabState();
  if (state?.log && state.log.length > 0) {
    renderLogs(state.log);
  }
}

async function syncGrabStatus() {
  if (syncingGrab) return;
  syncingGrab = true;
  const result = await sendGrabMessage({ action: 'getGrabStatus' });
  grabConnected = result.connected;
  if (result.connected && result.response?.state) {
    applyGrabSnapshot(result.response.state);
  } else {
    grabRunning = false;
    grabState = null;
    renderGrabState();
  }
  syncingGrab = false;
}

async function syncClickCaptchaCaptureStatus() {
  if (syncingClickCaptchaCapture) return;
  syncingClickCaptchaCapture = true;
  const result = await sendGrabMessage({ action: 'getClickCaptchaCaptureStatus' });
  clickCaptchaCaptureConnected = result.connected;
  clickCaptchaCaptureState = result.connected ? result.response?.state || null : null;
  renderClickCaptchaCaptureState();
  syncingClickCaptchaCapture = false;
}

async function syncClickCaptchaSolverStatus() {
  if (syncingClickCaptchaSolver) return;
  syncingClickCaptchaSolver = true;
  const result = await sendGrabMessage({ action: 'getClickCaptchaSolverStatus' });
  clickCaptchaSolverConnected = result.connected;
  clickCaptchaSolverState = result.connected ? result.response?.state || null : null;
  renderClickCaptchaSolverState();
  syncingClickCaptchaSolver = false;
}

function exportClickCaptchaSamples() {
  chrome.storage.local.get([
    CLICK_CAPTCHA_SAMPLE_COUNT_KEY,
    CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY
  ], data => {
    const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
    const skippedThreeTargetCount = Number(data[CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY] || 0);
    if (count === 0) {
      showToast('暂无可导出的样本');
      return;
    }

    const keys = Array.from({ length: count }, (_, i) =>
      CLICK_CAPTCHA_SAMPLE_KEY_PREFIX + String(i + 1).padStart(4, '0'));
    chrome.storage.local.get(keys, data => {
      const samples = keys.map(k => data[k]).filter(Boolean);
      if (samples.length === 0) {
        showToast('暂无可导出的样本');
        return;
      }

      const payload = {
        format: 'nju-click-captcha-samples/v1',
        exportedAt: new Date().toISOString(),
        clickCountMode: 'per-sample',
        capturePolicy: {
          requiredTargetCount: 4,
          skippedThreeTargetCount
        },
        samples
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      anchor.href = url;
      anchor.download = `nju-click-captcha-samples-${stamp}.json`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      // 清除所有独立 key + 计数器
      const allKeys = [
        ...keys,
        CLICK_CAPTCHA_SAMPLE_COUNT_KEY,
        CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY
      ];
      chrome.storage.local.remove(allKeys, () => {
        showToast(`已导出 ${samples.length} 条样本，计数已重置`);
        syncClickCaptchaCaptureStatus();
      });
    });
  });
}

async function saveCredentials() {
  const settings = {
    nju_user: els.username.value,
    nju_pass: els.password.value
  };

  els.saveBtn.disabled = true;
  els.saveBtn.textContent = '保存中...';
  chrome.storage.local.set(settings, () => {
    initialCredentials = { user: settings.nju_user, pass: settings.nju_pass };
    renderCredentialState();
    els.accountCard.open = false;
    showToast('账号配置已保存');
  });
}

function activateTab(tabName, persist = true) {
  document.querySelectorAll('.tab-btn').forEach((btn, index) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
    if (active) {
      btn.closest('.tab-list').dataset.activeIndex = index;
    }
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    const active = panel.id === `tab-${tabName}`;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  closeContextualHelp();
  setFeatureGuideOpen(false);
  if (persist) chrome.storage.local.set({ nju_popup_tab: tabName });
  if (tabName === 'grab') {
    syncGrabStatus();
    syncClickCaptchaCaptureStatus();
    syncClickCaptchaSolverStatus();
  }
}

function initTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab-btn'));
  tabs.forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    btn.addEventListener('keydown', event => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      const currentIndex = tabs.indexOf(btn);
      let nextIndex = currentIndex;
      if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      activateTab(nextTab.dataset.tab);
      nextTab.focus();
    });
  });
}

function closeContextualHelp({ restoreFocus = false } = {}) {
  let activeTrigger = null;
  document.querySelectorAll('[data-help-target]').forEach(trigger => {
    const panel = document.getElementById(trigger.dataset.helpTarget);
    if (trigger.getAttribute('aria-expanded') === 'true') activeTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'false');
    if (panel) panel.hidden = true;
  });
  if (restoreFocus && activeTrigger) activeTrigger.focus();
}

function setFeatureGuideOpen(open, { restoreFocus = false } = {}) {
  if (!els.featureGuide || !els.featureGuideBtn) return;
  els.featureGuide.hidden = !open;
  if (els.featureGuideBackdrop) els.featureGuideBackdrop.hidden = !open;
  els.featureGuideBtn.setAttribute('aria-expanded', String(open));
  if (restoreFocus && !open) els.featureGuideBtn.focus();
}

function initHelpEvents() {
  document.querySelectorAll('[data-help-target]').forEach(trigger => {
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      const panel = document.getElementById(trigger.dataset.helpTarget);
      if (!panel) return;
      const open = trigger.getAttribute('aria-expanded') !== 'true';
      closeContextualHelp();
      setFeatureGuideOpen(false);
      trigger.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
    });
  });

  els.featureGuideBtn?.addEventListener('click', event => {
    event.stopPropagation();
    const open = els.featureGuideBtn.getAttribute('aria-expanded') !== 'true';
    closeContextualHelp();
    setFeatureGuideOpen(open);
  });
  els.featureGuideCloseBtn?.addEventListener('click', () => setFeatureGuideOpen(false, { restoreFocus: true }));

  document.addEventListener('click', event => {
    if (!event.target.closest('.help-panel, [data-help-target], .feature-guide, #featureGuideBtn')) {
      closeContextualHelp();
      setFeatureGuideOpen(false);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const guideOpen = els.featureGuideBtn?.getAttribute('aria-expanded') === 'true';
    const hasContextualHelp = Boolean(document.querySelector('[data-help-target][aria-expanded="true"]'));
    if (!guideOpen && !hasContextualHelp) return;
    event.preventDefault();
    closeContextualHelp({ restoreFocus: hasContextualHelp });
    setFeatureGuideOpen(false, { restoreFocus: guideOpen });
  });
}

function syncTabToCurrentPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const url = tabs?.[0]?.url || '';
    if (url.includes('xk.nju.edu.cn')) {
      currentCaptchaPage = 'grab';
      activateTab('grab', false);
      renderCurrentCaptchaPanel();
      syncCurrentCaptchaTestCapability();
      
      const accountCard = document.getElementById('accountCard');
      if (accountCard && els.username.value && els.password.value) {
        accountCard.open = false;
      }
      return;
    }
    if (url.includes('authserver.nju.edu.cn')) {
      currentCaptchaPage = 'auth';
      activateTab('login', false);
      renderCurrentCaptchaPanel();
      syncCurrentCaptchaTestCapability();
      return;
    }
    currentCaptchaPage = 'other';
    renderCurrentCaptchaPanel();
    syncCurrentCaptchaTestCapability();
    chrome.storage.local.get(['nju_popup_tab'], data => {
      activateTab(data.nju_popup_tab === 'grab' ? 'grab' : 'login', false);
    });
  });
}

function initSettings() {
  chrome.storage.local.get(storageKeys, data => {
    els.username.value = data.nju_user || '';
    els.password.value = data.nju_pass || '';
    initialCredentials = { user: els.username.value, pass: els.password.value };

    els.isEnabled.checked = data.nju_enabled !== false && data.nju_auto_click !== false;
    els.authPrewarm.checked = data[AUTH_PREWARM_ENABLED_KEY] === true;
    els.forceFill.checked = Boolean(data.nju_force);
    els.autoClick.checked = data.nju_auto_click !== false;
    clickCaptchaAutoLoginEnabled = data[CLICK_CAPTCHA_SOLVER_ENABLED_KEY] !== false
      && data[CLICK_CAPTCHA_AUTO_CLICK_KEY] !== false;
    els.clickCaptchaAutoLogin.checked = clickCaptchaAutoLoginEnabled;
    els.grabPageEnhancementsEnabled.checked = data[GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY] !== false;
    grabTaskConfig = grabTaskModel.normalizeTaskConfig(data[GRAB_TASK_CONFIG_KEY], {
      legacyCourseText: data.nju_grab_courses,
      intervalMs: data.nju_grab_interval
    });
    els.courseNames.value = grabTaskModel.keywordTextFromTargets(grabTaskConfig.targets);
    renderCourseTags();
    setIntervalValue(grabTaskConfig.intervalMs || data.nju_grab_interval || '5000', { persist: false });

    renderCredentialState();
    updateCourseCount();
    renderLoginState();
    syncAuthPrewarmStatus();
    syncGrabStatus();
    syncTabToCurrentPage();
  });
}

function initLoginEvents() {
  els.username.addEventListener('input', renderCredentialState);
  els.password.addEventListener('input', renderCredentialState);
  els.saveBtn.addEventListener('click', saveCredentials);

  els.togglePassword.addEventListener('click', () => {
    const hidden = els.password.type === 'password';
    els.password.type = hidden ? 'text' : 'password';
    els.togglePassword.textContent = hidden ? '隐藏' : '显示';
  });

  Object.keys(switchKeyMap).forEach(id => {
    const el = els[id];
    el.addEventListener('change', event => {
      chrome.storage.local.set({ [switchKeyMap[id]]: event.target.checked }, () => {
        renderLoginState();
        showToast('设置已更新');
      });
    });
  });

  els.isEnabled.addEventListener('change', event => {
    const enabled = event.target.checked;
    els.autoClick.checked = enabled;
    chrome.storage.local.set({ nju_enabled: enabled, nju_auto_click: enabled }, () => {
      renderLoginState();
      showToast(enabled ? '统一认证自动登录已开启' : '统一认证自动登录已暂停');
    });
  });

  els.authPrewarm.addEventListener('change', event => {
    const enabled = event.target.checked;
    chrome.storage.local.set({ [AUTH_PREWARM_ENABLED_KEY]: enabled }, () => {
      authPrewarmState = null;
      renderAuthPrewarmState();
      syncAuthPrewarmStatus();
      showToast(enabled ? '启动时预认证已开启' : '启动时预认证已关闭');
    });
  });

  els.autoClick.addEventListener('change', event => {
    const enabled = event.target.checked;
    els.isEnabled.checked = enabled;
    chrome.storage.local.set({ nju_enabled: true, nju_auto_click: enabled }, () => {
      renderLoginState();
      showToast(enabled ? '统一认证自动提交已开启' : '已切换为仅自动填写');
    });
  });

  els.clickCaptchaAutoLogin.addEventListener('change', async event => {
    const enabled = event.target.checked;
    clickCaptchaAutoLoginEnabled = enabled;
    chrome.storage.local.set({
      [CLICK_CAPTCHA_SOLVER_ENABLED_KEY]: enabled,
      [CLICK_CAPTCHA_AUTO_CLICK_KEY]: enabled
    });
    const actions = enabled
      ? [
          { action: 'setClickCaptchaSolverEnabled', enabled: true },
          { action: 'setClickCaptchaAutoClick', enabled: true }
        ]
      : [
          { action: 'setClickCaptchaAutoClick', enabled: false },
          { action: 'setClickCaptchaSolverEnabled', enabled: false }
        ];

    for (const message of actions) {
      const result = await sendGrabMessage(message);
      if (!result.connected) continue;
      clickCaptchaSolverConnected = true;
      clickCaptchaSolverState = result.response?.state || clickCaptchaSolverState;
    }
    renderClickCaptchaSolverState();
    showToast(enabled ? '选课系统自动登录已开启' : '选课系统自动登录已暂停');
  });

  els.recognizeAgainBtn.addEventListener('click', async () => {
    if (captchaTestCapability.mode === 'click-mark') {
      els.recognizeAgainBtn.disabled = true;
      els.recognizeAgainBtn.textContent = '识别中...';
      const result = await sendActiveTabMessage({ action: 'runClickCaptchaSolver' });
      if (!result.connected) {
        clickCaptchaSolverConnected = false;
        clickCaptchaSolverState = null;
        setCaptchaTestCapability();
        showToast('请切换到选课页面后重试');
        return;
      }
      clickCaptchaSolverConnected = true;
      clickCaptchaSolverState = result.response?.state || null;
      renderClickCaptchaSolverState();
      showToast(result.response?.ok === false ? (result.response.error || '识别未完成') : '已标出识别顺序');
      return;
    }

    if (captchaTestCapability.mode !== 'legacy-ocr') return;
    if (previewRunning) return;

    previewRunning = true;
    els.recognizeAgainBtn.disabled = true;
    els.recognizeAgainBtn.textContent = '识别中...';

    const result = await sendActiveTabMessage({
      action: 'recognizeCaptchaPreview',
      templateRerank: true
    });

    previewRunning = false;
    els.recognizeAgainBtn.textContent = '重新识别';

    if (!result.connected) {
      setPreviewConnection(false);
      showToast('请切换到统一认证页后重试');
      return;
    }

    const response = result.response || {};
    setPreviewConnection(true, Boolean(response.ready));
    if (!response.ok) {
      showToast(response.error || '验证码尚未加载完成');
      return;
    }

    renderOcrPreview(response);
    showToast(response.code ? `识别结果：${response.code}` : '未得到四位结果');
  });


  els.githubBtn.addEventListener('click', () => {
    window.open('https://github.com/treehey/AutoCaptcha', '_blank');
  });

  els.authPageBtn.addEventListener('click', () => {
    window.open(AUTH_URL, '_blank');
  });
}

function renderCourseTags() {
  // Clear existing tags but keep the input element
  const inputEl = els.courseNamesInput;
  els.courseTagsWrapper.innerHTML = '';
  
  const text = els.courseNames.value.trim();
  const names = text ? text.split('\n').map(n => n.trim()).filter(Boolean) : [];
  
  names.forEach(name => {
    const tag = document.createElement('span');
    tag.className = 'course-tag';
    tag.textContent = name;
    
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.innerHTML = '&times;';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      // Remove this name from textarea and re-render
      const currentNames = els.courseNames.value.split('\n').map(n => n.trim()).filter(Boolean);
      const newNames = currentNames.filter(n => n !== name);
      els.courseNames.value = newNames.join('\n');
      els.courseNames.dispatchEvent(new Event('input', { bubbles: true }));
      renderCourseTags();
    };
    
    tag.appendChild(delBtn);
    els.courseTagsWrapper.appendChild(tag);
  });
  
  els.courseTagsWrapper.appendChild(inputEl);
  updateCourseCount();
}

function initCourseTagsEvents() {
  els.courseTagContainer.addEventListener('click', () => {
    els.courseNamesInput.focus();
  });

  const commitTag = () => {
    const val = els.courseNamesInput.value.trim();
    if (val) {
      const currentNames = els.courseNames.value.split('\n').map(n => n.trim()).filter(Boolean);
      if (!currentNames.includes(val)) {
        currentNames.push(val);
        els.courseNames.value = currentNames.join('\n');
        els.courseNames.dispatchEvent(new Event('input', { bubbles: true }));
      }
      els.courseNamesInput.value = '';
      renderCourseTags();
    }
  };

  els.courseNamesInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitTag();
    } else if (e.key === 'Backspace' && els.courseNamesInput.value === '') {
      // Remove last tag on backspace if input is empty
      const currentNames = els.courseNames.value.split('\n').map(n => n.trim()).filter(Boolean);
      if (currentNames.length > 0) {
        currentNames.pop();
        els.courseNames.value = currentNames.join('\n');
        els.courseNames.dispatchEvent(new Event('input', { bubbles: true }));
        renderCourseTags();
      }
    }
  });

  els.courseNamesInput.addEventListener('blur', commitTag);
  
  // To handle manual or external updates to courseNames (like imports)
  els.courseNames.addEventListener('input', renderCourseTags);
}

function initGrabEvents() {
  initCourseTagsEvents();
  els.courseNames.addEventListener('input', updateCourseCount);

  els.grabPageEnhancementsEnabled.addEventListener('change', event => {
    const enabled = event.target.checked;
    chrome.storage.local.set({ [GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY]: enabled }, () => {
      showToast(enabled ? '选课页增强控件已开启' : '选课页增强控件已隐藏');
    });
  });

  els.intervalGrid.addEventListener('click', event => {
    const btn = event.target.closest('.interval-option');
    if (!btn) return;
    setIntervalValue(btn.dataset.value);
  });

  els.openGrabPageBtn.addEventListener('click', () => {
    window.open(GRAB_ENTRY_URL, '_blank');
  });

  els.importFavoriteCoursesBtn.addEventListener('click', async () => {
    if (grabRunning) {
      showToast('请先停止当前监控');
      return;
    }
    const button = els.importFavoriteCoursesBtn;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '正在导入…';
    try {
      const result = await sendActiveTabMessage({ action: 'importFavoriteCourses' });
      if (!result.connected) {
        showToast('请切换到已打开“收藏”的选课页面');
        return;
      }
      const response = result.response || {};
      if (!response.ok) {
        showToast(response.message || '未能导入收藏课程');
        return;
      }
      const stored = await chrome.storage.local.get([GRAB_TASK_CONFIG_KEY]);
      grabTaskConfig = grabTaskModel.normalizeTaskConfig(stored[GRAB_TASK_CONFIG_KEY]);
      els.courseNames.value = grabTaskModel.keywordTextFromTargets(grabTaskConfig.targets);
      renderCourseTags();
      updateCourseCount({ persist: false });
      if (response.capacitySkippedCount > 0) {
        showToast(`已导入 ${response.addedCount} 门，${response.capacitySkippedCount} 门超过目标上限`);
      } else if (response.addedCount > 0 && response.enrichedCount > 0) {
        showToast(`已导入 ${response.addedCount} 门，并更新 ${response.enrichedCount} 门收藏课程`);
      } else if (response.addedCount > 0) {
        showToast(`已导入 ${response.addedCount} 门收藏课程`);
      } else if (response.enrichedCount > 0) {
        showToast(`已更新 ${response.enrichedCount} 门收藏课程的查询分类`);
      } else {
        showToast(`当前 ${response.existingCount} 门收藏课程均已加入`);
      }
    } catch (error) {
      showToast(error?.message || '导入收藏课程失败');
    } finally {
      button.textContent = originalText;
      renderGrabControls();
    }
  });

  els.grabBtn.addEventListener('click', async () => {
    if (!grabConnected && !grabRunning) {
      window.open(GRAB_ENTRY_URL, '_blank');
      showToast('已打开选课系统入口');
      return;
    }

    if (grabRunning) {
      const result = await sendGrabMessage({ action: 'stopGrab' });
      if (!result.connected) {
        grabConnected = false;
        grabRunning = false;
        appendLog('无法连接选课页面，请刷新页面后重试');
        renderGrabState();
        return;
      }
      grabConnected = true;
      applyGrabSnapshot(result.response.state);
      showToast('监控已停止');
      return;
    }

    const taskConfig = getConfiguredTaskConfig();
    const targets = taskConfig.targets;
    if (targets.length === 0) {
      showToast('请先添加课程目标');
      return;
    }

    const interval = Number(els.grabInterval.value) || 3000;
    const result = await sendGrabMessage({
      action: 'startGrab',
      taskConfig,
      targets,
      courseNames: getCourseNames(),
      interval
    });
    if (!result.connected) {
      grabConnected = false;
      appendLog('无法连接页面脚本，请刷新选课页面后重试');
      renderGrabState();
      return;
    }

    grabConnected = true;
    applyGrabSnapshot(result.response.state);
    renderLogs([]);
    appendLog(`已连接到选课页面，监控 ${taskConfig.groups.length} 个课程组、${targets.length} 个课程目标`);
    showToast('监控已启动');
  });

  els.clickCaptchaCaptureBtn.addEventListener('click', async () => {
    const enable = !clickCaptchaCaptureState?.enabled;
    const result = await sendGrabMessage({ action: 'setClickCaptchaCaptureEnabled', enabled: enable });
    if (!result.connected) {
      clickCaptchaCaptureConnected = false;
      clickCaptchaCaptureState = null;
      renderClickCaptchaCaptureState();
      showToast('请先打开选课页面');
      return;
    }
    clickCaptchaCaptureConnected = true;
    clickCaptchaCaptureState = result.response?.state || null;
    renderClickCaptchaCaptureState();
    showToast(enable ? (clickCaptchaCaptureState?.ready ? '采样已开启' : '未找到验证码图片') : '采样已停止');
  });

  els.clickCaptchaSolverEnabled.addEventListener('change', async event => {
    const result = await sendGrabMessage({ action: 'setClickCaptchaSolverEnabled', enabled: event.target.checked });
    if (!result.connected) {
      clickCaptchaSolverConnected = false;
      clickCaptchaSolverState = null;
      renderClickCaptchaSolverState();
      showToast('请先打开选课页面');
      return;
    }
    clickCaptchaSolverConnected = true;
    clickCaptchaSolverState = result.response?.state || null;
    renderClickCaptchaSolverState();
    showToast(event.target.checked ? '点击验证码识别已开启' : '点击验证码识别已暂停');
  });

  els.clickCaptchaAutoClick.addEventListener('change', async event => {
    const result = await sendGrabMessage({ action: 'setClickCaptchaAutoClick', enabled: event.target.checked });
    if (!result.connected) {
      clickCaptchaSolverConnected = false;
      clickCaptchaSolverState = null;
      renderClickCaptchaSolverState();
      showToast('请先打开选课页面');
      return;
    }
    clickCaptchaSolverConnected = true;
    clickCaptchaSolverState = result.response?.state || null;
    renderClickCaptchaSolverState();
    showToast(event.target.checked ? '自动点击并提交已开启' : '已切换为只标出顺序');
  });

  els.runClickCaptchaSolverBtn.addEventListener('click', async () => {
    const result = await sendGrabMessage({ action: 'runClickCaptchaSolver' });
    if (!result.connected) {
      clickCaptchaSolverConnected = false;
      clickCaptchaSolverState = null;
      renderClickCaptchaSolverState();
      showToast('请先打开选课页面');
      return;
    }
    clickCaptchaSolverConnected = true;
    clickCaptchaSolverState = result.response?.state || null;
    renderClickCaptchaSolverState();
    showToast(result.response?.ok === false ? (result.response.error || '识别未完成') : '识别已完成');
  });

  els.clearClickCaptchaSolverBtn.addEventListener('click', async () => {
    const result = await sendGrabMessage({ action: 'clearClickCaptchaSolverOverlay' });
    if (!result.connected) return;
    clickCaptchaSolverConnected = true;
    clickCaptchaSolverState = result.response?.state || null;
    renderClickCaptchaSolverState();
  });

  els.exportClickCaptchaBtn.addEventListener('click', exportClickCaptchaSamples);

  els.discardClickCaptchaBtn.addEventListener('click', async () => {
    const result = await sendGrabMessage({ action: 'discardLastClickCaptchaSample' });
    if (!result.connected) {
      showToast('请先连接选课页面后操作');
      return;
    }
    clickCaptchaCaptureConnected = true;
    clickCaptchaCaptureState = result.response?.state || null;
    renderClickCaptchaCaptureState();
    showToast('已删除最近一条样本');
  });

  els.resetClickCaptchaBtn.addEventListener('click', async () => {
    // 先获取当前计数，构造所有要清除的 key
    chrome.storage.local.get([
      CLICK_CAPTCHA_SAMPLE_COUNT_KEY,
      CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY
    ], data => {
      const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
      const keys = Array.from({ length: count }, (_, i) =>
        CLICK_CAPTCHA_SAMPLE_KEY_PREFIX + String(i + 1).padStart(4, '0'));
      // 同时清除新格式 keys + 计数器 + 旧格式残留 key
      const allKeys = [
        ...keys,
        CLICK_CAPTCHA_SAMPLE_COUNT_KEY,
        CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY,
        'nju_click_captcha_samples_v1'
      ];
      chrome.storage.local.remove(allKeys, () => {
        showToast('采样数据已全部清除');
        syncClickCaptchaCaptureStatus();
      });
    });
  });

  els.clearLogBtn.addEventListener('click', () => {
    renderLogs([]);
    showToast('日志已清空');
  });

  els.copyLogBtn.addEventListener('click', async () => {
    const text = Array.from(els.grabStatus.querySelectorAll('.log-line'))
      .map(line => line.textContent)
      .join('\n');
    if (!text) {
      showToast('暂无日志可复制');
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      showToast('日志已复制');
    } catch (err) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      showToast('日志已复制');
    }
  });
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === 'grabLog' && msg.message) {
    appendLog(msg.message);
    if (msg.state) {
      grabConnected = true;
      applyGrabSnapshot(msg.state);
    }
  } else if (msg.action === 'grabStopped') {
    grabConnected = true;
    applyGrabSnapshot(msg.state);
  } else if (msg.action === 'grabTargetAdded') {
    showToast('已加入精确教学班');
  } else if ((msg.action === 'clickCaptchaCaptureUpdate' || msg.action === 'clickCaptchaSampleSaved') && msg.state) {
    clickCaptchaCaptureConnected = true;
    clickCaptchaCaptureState = msg.state;
    renderClickCaptchaCaptureState();
  } else if (msg.action === 'clickCaptchaSolverUpdate' && msg.state) {
    clickCaptchaSolverConnected = true;
    clickCaptchaSolverState = msg.state;
    renderClickCaptchaSolverState();
  } else if (msg.action === 'authPrewarmStatusChanged' && msg.state) {
    authPrewarmState = msg.state;
    renderAuthPrewarmState();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[GRAB_TASK_CONFIG_KEY]) return;
  grabTaskConfig = grabTaskModel.normalizeTaskConfig(changes[GRAB_TASK_CONFIG_KEY].newValue);
  els.courseNames.value = grabTaskModel.keywordTextFromTargets(grabTaskConfig.targets);
  updateCourseCount({ persist: false });
});

setVersion();
initTabs();
initHelpEvents();
initSettings();
initLoginEvents();
initGrabEvents();
syncClickCaptchaCaptureStatus();
syncClickCaptchaSolverStatus();
syncAuthPrewarmStatus();
