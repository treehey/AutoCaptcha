const AUTH_URL = 'https://authserver.nju.edu.cn/';
const GRAB_URL = 'https://xk.nju.edu.cn/xsxkapp/sys/xsxkapp/*default/grablessons.do';

const storageKeys = [
  'nju_user',
  'nju_pass',
  'nju_enabled',
  'nju_force',
  'nju_auto_click',
  'nju_template_rerank',
  'nju_grab_courses',
  'nju_grab_interval'
];

const els = {
  versionBadge: document.getElementById('versionBadge'),
  loginStatePill: document.getElementById('loginStatePill'),
  templateStatePill: document.getElementById('templateStatePill'),
  grabStatePill: document.getElementById('grabStatePill'),
  credentialBadge: document.getElementById('credentialBadge'),
  loginModeBadge: document.getElementById('loginModeBadge'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  togglePassword: document.getElementById('togglePassword'),
  saveBtn: document.getElementById('saveBtn'),
  isEnabled: document.getElementById('isEnabled'),
  forceFill: document.getElementById('forceFill'),
  autoClick: document.getElementById('autoClick'),
  templateRerank: document.getElementById('templateRerank'),
  ocrPageBadge: document.getElementById('ocrPageBadge'),
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
  grabStatus: document.getElementById('grabStatus'),
  copyLogBtn: document.getElementById('copyLogBtn'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  toast: document.getElementById('toast')
};

const switchKeyMap = {
  isEnabled: 'nju_enabled',
  forceFill: 'nju_force',
  autoClick: 'nju_auto_click',
  templateRerank: 'nju_template_rerank'
};

let initialCredentials = { user: '', pass: '' };
let grabRunning = false;
let grabConnected = false;
let grabState = null;
let toastTimer = null;
let syncingGrab = false;
let previewRunning = false;

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

  if (configured) {
    setBadge(els.credentialBadge, credentialsDirty() ? '有未保存更改' : '已配置', credentialsDirty() ? 'warning' : 'success');
  } else {
    setBadge(els.credentialBadge, '未配置', 'warning');
  }

  els.saveBtn.disabled = !credentialsDirty();
  els.saveBtn.textContent = credentialsDirty() ? '保存更改' : '已保存';
  renderLoginState();
}

function renderLoginState() {
  const enabled = els.isEnabled.checked;
  const autoClick = els.autoClick.checked;
  const template = els.templateRerank.checked;
  const configured = Boolean(els.username.value.trim() && els.password.value);

  if (!configured) {
    setPill(els.loginStatePill, '账号未配置');
  } else if (!enabled) {
    setPill(els.loginStatePill, '自动登录关闭');
  } else {
    setPill(els.loginStatePill, autoClick ? '自动登录已启用' : '仅自动填充');
  }

  setPill(els.templateStatePill, template ? '模板增强开启' : '模板增强关闭');
  setBadge(els.loginModeBadge, enabled ? (autoClick ? '自动登录' : '自动填充') : '已暂停', enabled ? 'info' : 'warning');
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
  if (!connected) {
    setBadge(els.ocrPageBadge, '未连接', 'warning');
    els.recognizeAgainBtn.disabled = true;
    return;
  }

  setBadge(els.ocrPageBadge, ready ? '验证码就绪' : '认证页已连接', ready ? 'success' : 'info');
  els.recognizeAgainBtn.disabled = !ready || previewRunning;
}

function renderOcrPreview(response) {
  const code = response.code || '';
  els.ocrPreviewCode.textContent = code || '未得到四位结果';
  els.ocrPreviewCode.classList.toggle('empty', !code);

  const mode = response.templateEnabled ? '模板增强开启' : '模板增强关闭';
  const elapsed = Number.isFinite(response.elapsedMs) ? ` · ${Math.round(response.elapsedMs)}ms` : '';
  els.ocrPreviewMeta.textContent = `${mode}${elapsed}`;

  const candidates = (response.candidates || [])
    .map(item => `${item.variant}=${item.code || '空'}(${Math.round(item.confidence || 0)})`)
    .join(' | ');
  const rerank = response.templateRerank
    ? `模板：${response.templateRerank.selectedBefore || '空'}=>${response.templateRerank.selectedAfter || '空'} ${response.templateRerank.reason || ''}`
    : '';
  const details = [candidates, rerank].filter(Boolean).join('\n');
  els.ocrPreviewDetails.textContent = details;
  els.ocrPreviewDetails.classList.toggle('has-content', Boolean(details));
}

async function syncOcrPreviewStatus() {
  const result = await sendActiveTabMessage({ action: 'getCaptchaPreviewStatus' });
  if (!result.connected) {
    setPreviewConnection(false);
    return;
  }
  setPreviewConnection(true, Boolean(result.response?.ready));
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
    showToast('账号配置已保存');
  });
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(item => {
        item.classList.remove('active');
        item.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'grab') syncGrabStatus();
    });
  });
}

function initSettings() {
  chrome.storage.local.get(storageKeys, data => {
    els.username.value = data.nju_user || '';
    els.password.value = data.nju_pass || '';
    initialCredentials = { user: els.username.value, pass: els.password.value };

    els.isEnabled.checked = data.nju_enabled !== false;
    els.forceFill.checked = Boolean(data.nju_force);
    els.autoClick.checked = data.nju_auto_click !== false;
    els.templateRerank.checked = data.nju_template_rerank !== false;
    els.courseNames.value = data.nju_grab_courses || '';
    setIntervalValue(data.nju_grab_interval || '3000');

    renderCredentialState();
    updateCourseCount();
    renderLoginState();
    syncGrabStatus();
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

  els.recognizeAgainBtn.addEventListener('click', async () => {
    if (previewRunning) return;

    previewRunning = true;
    els.recognizeAgainBtn.disabled = true;
    els.recognizeAgainBtn.textContent = '识别中...';

    const result = await sendActiveTabMessage({
      action: 'recognizeCaptchaPreview',
      templateRerank: els.templateRerank.checked
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
  }
});

setVersion();
initTabs();
initSettings();
initLoginEvents();
initGrabEvents();
syncOcrPreviewStatus();
