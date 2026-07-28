const AUTH_URL = 'https://authserver.nju.edu.cn/';
const GRAB_URL = 'https://xk.nju.edu.cn/xsxkapp/sys/xsxkapp/*default/grablessons.do';
const CLICK_CAPTCHA_SAMPLE_COUNT_KEY = 'nju_click_captcha_v1_count';
const CLICK_CAPTCHA_SAMPLE_KEY_PREFIX = 'nju_click_captcha_v1_';
const CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY = 'nju_click_captcha_v1_skipped_three_count';
const CLICK_CAPTCHA_SOLVER_ENABLED_KEY = 'nju_click_captcha_solver_enabled';
const CLICK_CAPTCHA_AUTO_CLICK_KEY = 'nju_click_captcha_auto_click';

const storageKeys = [
  'nju_user',
  'nju_pass',
  'nju_enabled',
  'nju_force',
  'nju_auto_click',
  CLICK_CAPTCHA_SOLVER_ENABLED_KEY,
  CLICK_CAPTCHA_AUTO_CLICK_KEY,
  'nju_grab_courses',
  'nju_grab_interval'
];

const els = {
  versionBadge: document.getElementById('versionBadge'),
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
  courseNames: document.getElementById('courseNames'),
  courseCount: document.getElementById('courseCount'),
  grabInterval: document.getElementById('grabInterval'),
  intervalLabel: document.getElementById('intervalLabel'),
  intervalGrid: document.getElementById('intervalGrid'),
  grabBtn: document.getElementById('grabBtn'),
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

function updateCourseCount() {
  const count = getCourseNames().length;
  els.courseCount.textContent = `${count} 门`;
  renderGrabControls();
  chrome.storage.local.set({ nju_grab_courses: els.courseNames.value });
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
}

function renderGrabState() {
  const round = grabState?.round || 0;
  const successCount = grabState?.successCourses?.length || 0;
  const targetCount = grabState?.courseNames?.length || getCourseNames().length;
  const interval = grabState?.interval || Number(els.grabInterval.value || 3000);

  els.grabRoundBadge.textContent = `${round} 轮`;

  if (!grabConnected) {
    setBadge(els.grabBadge, '未连接', 'warning');
    setPill(els.grabStatePill, '选课页未连接');
    els.grabSummaryTitle.textContent = '等待连接选课页面';
    els.grabSummarySub.textContent = '打开选课系统后可同步监控状态。';
  } else if (grabRunning) {
    setBadge(els.grabBadge, '监控中', 'success');
    setPill(els.grabStatePill, `监控中 · ${round} 轮`);
    els.grabSummaryTitle.textContent = `监控中，已完成 ${round} 轮`;
    els.grabSummarySub.textContent = `已抢到 ${successCount}/${targetCount || 0}，间隔 ${Math.round(interval / 1000)}s`;
  } else {
    setBadge(els.grabBadge, '已连接', 'info');
    setPill(els.grabStatePill, '选课已连接');
    els.grabSummaryTitle.textContent = successCount > 0 ? `已抢到 ${successCount} 门课程` : '选课页面已连接';
    els.grabSummarySub.textContent = '填写目标课程后即可开始监控。';
  }

  renderGrabControls();
}

function renderGrabControls() {
  const courseCount = getCourseNames().length;

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

function setIntervalValue(value) {
  const normalized = String(value || '3000');
  els.grabInterval.value = normalized;
  els.intervalLabel.textContent = `${Number(normalized) / 1000}s`;
  document.querySelectorAll('.interval-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === normalized);
  });
  chrome.storage.local.set({ nju_grab_interval: normalized });
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
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://xk.nju.edu.cn/*' }, tabs => {
      resolve(tabs && tabs.length > 0 ? tabs[0] : null);
    });
  });
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
  grabRunning = Boolean(state?.running);
  if (state?.courseNames?.length) {
    els.courseNames.value = state.courseNames.join('\n');
    updateCourseCount();
  }
  if (state?.interval) {
    setIntervalValue(state.interval);
  }
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
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
  if (persist) chrome.storage.local.set({ nju_popup_tab: tabName });
  if (tabName === 'grab') {
    syncGrabStatus();
    syncClickCaptchaCaptureStatus();
    syncClickCaptchaSolverStatus();
  }
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
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
    els.forceFill.checked = Boolean(data.nju_force);
    els.autoClick.checked = data.nju_auto_click !== false;
    clickCaptchaAutoLoginEnabled = data[CLICK_CAPTCHA_SOLVER_ENABLED_KEY] !== false
      && data[CLICK_CAPTCHA_AUTO_CLICK_KEY] !== false;
    els.clickCaptchaAutoLogin.checked = clickCaptchaAutoLoginEnabled;
    els.courseNames.value = data.nju_grab_courses || '';
    setIntervalValue(data.nju_grab_interval || '3000');

    renderCredentialState();
    updateCourseCount();
    renderLoginState();
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

function initGrabEvents() {
  els.courseNames.addEventListener('input', updateCourseCount);

  els.intervalGrid.addEventListener('click', event => {
    const btn = event.target.closest('.interval-option');
    if (!btn) return;
    setIntervalValue(btn.dataset.value);
  });

  els.openGrabPageBtn.addEventListener('click', () => {
    window.open(GRAB_URL, '_blank');
  });

  els.grabBtn.addEventListener('click', async () => {
    if (!grabConnected && !grabRunning) {
      window.open(GRAB_URL, '_blank');
      showToast('已打开选课页面');
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

    const courseNames = getCourseNames();
    if (courseNames.length === 0) {
      showToast('请先输入课程名称');
      return;
    }

    const interval = Number(els.grabInterval.value) || 3000;
    const result = await sendGrabMessage({ action: 'startGrab', courseNames, interval });
    if (!result.connected) {
      grabConnected = false;
      appendLog('无法连接页面脚本，请刷新选课页面后重试');
      renderGrabState();
      return;
    }

    grabConnected = true;
    applyGrabSnapshot(result.response.state);
    renderLogs([]);
    appendLog(`已连接到选课页面，监控 ${courseNames.length} 门课程`);
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
  } else if ((msg.action === 'clickCaptchaCaptureUpdate' || msg.action === 'clickCaptchaSampleSaved') && msg.state) {
    clickCaptchaCaptureConnected = true;
    clickCaptchaCaptureState = msg.state;
    renderClickCaptchaCaptureState();
  } else if (msg.action === 'clickCaptchaSolverUpdate' && msg.state) {
    clickCaptchaSolverConnected = true;
    clickCaptchaSolverState = msg.state;
    renderClickCaptchaSolverState();
  }
});

setVersion();
initTabs();
initSettings();
initLoginEvents();
initGrabEvents();
syncClickCaptchaCaptureStatus();
syncClickCaptchaSolverStatus();
