// ============ Tab 切换 ============
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ============ 保存账号密码 ============
document.getElementById('saveBtn').addEventListener('click', () => {
  const settings = {
    nju_user: document.getElementById('username').value,
    nju_pass: document.getElementById('password').value,
  };

  chrome.storage.local.set(settings, () => {
    const btn = document.getElementById('saveBtn');
    btn.textContent = '已保存 ✓';
    btn.style.background = '#28a745';
    setTimeout(() => {
      btn.textContent = '保存';
      btn.style.background = '#634798';
    }, 1500);
  });
});

// 绑定元素
const switches = ['isEnabled', 'forceFill', 'autoClick'];
const saveBtn = document.getElementById('saveBtn');

// 1. 初始化加载
chrome.storage.local.get(['nju_user', 'nju_pass', 'nju_enabled', 'nju_force', 'nju_auto_click'], (data) => {
  document.getElementById('username').value = data.nju_user || '';
  document.getElementById('password').value = data.nju_pass || '';
  
  // 开关状态加载
  document.getElementById('isEnabled').checked = data.nju_enabled !== false;
  document.getElementById('forceFill').checked = !!data.nju_force;
  document.getElementById('autoClick').checked = data.nju_auto_click !== false;
  
  // 选课系统自动登录尚未完成，强制禁用
  chrome.storage.local.set({ xk_enabled: false });
});

// 2. 为开关绑定自动保存事件
switches.forEach(id => {
  document.getElementById(id).addEventListener('change', (e) => {
    const keyMap = {
      'isEnabled': 'nju_enabled',
      'forceFill': 'nju_force',
      'autoClick': 'nju_auto_click'
    };
    chrome.storage.local.set({ [keyMap[id]]: e.target.checked });
  });
});

// 打开 GitHub 仓库
document.getElementById('githubBtn').addEventListener('click', () => {
  window.open('https://github.com/treehey/AutoCaptcha', '_blank');
});

// ============ 选课助手 ============
let grabRunning = false;

const grabBtn = document.getElementById('grabBtn');
const grabBadge = document.getElementById('grabBadge');
const grabStatusEl = document.getElementById('grabStatus');

function setGrabRunning(running) {
  grabRunning = running;
  if (running) {
    grabBtn.textContent = '⏹ 停止监控';
    grabBtn.classList.add('running');
    grabBadge.textContent = '监控中';
    grabBadge.className = 'status-badge on';
  } else {
    grabBtn.textContent = '▶ 开始监控';
    grabBtn.classList.remove('running');
    grabBadge.textContent = '未运行';
    grabBadge.className = 'status-badge off';
  }
}

function appendLog(message) {
  // 清除初始占位
  const placeholder = grabStatusEl.querySelector('[style*="color:#888"]');
  if (placeholder && placeholder.textContent === '等待启动...') placeholder.remove();

  const line = document.createElement('div');
  line.className = 'log-line';
  // 根据消息内容给予颜色类
  if (message.includes('成功') || message.includes('🎉') || message.includes('✅') || message.includes('🎊')) {
    line.classList.add('success');
  } else if (message.includes('⚠️') || message.includes('未找到') || message.includes('已满') || message.includes('未运行')) {
    line.classList.add('warn');
  } else if (message.includes('❌') || message.includes('出错')) {
    line.classList.add('error');
  }
  line.textContent = message;
  grabStatusEl.appendChild(line);
  grabStatusEl.scrollTop = grabStatusEl.scrollHeight;

  // 保持最多50条
  while (grabStatusEl.children.length > 50) {
    grabStatusEl.removeChild(grabStatusEl.firstChild);
  }
}

function renderLogs(logs) {
  grabStatusEl.innerHTML = '';
  (logs || []).forEach(appendLog);
}

// 获取当前选课页面 tab
async function getGrabTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://xk.nju.edu.cn/*' }, (tabs) => {
      if (tabs && tabs.length > 0) resolve(tabs[0]);
      else resolve(null);
    });
  });
}

grabBtn.addEventListener('click', async () => {
  if (grabRunning) {
    // 停止
    const tab = await getGrabTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'stopGrab' }, (resp) => {
        if (chrome.runtime.lastError) {
          appendLog('❌ 无法连接选课页面，请刷新选课页面后重试');
          return;
        }
        setGrabRunning(false);
        if (resp && resp.state) renderLogs(resp.state.log);
      });
    } else {
      setGrabRunning(false);
      appendLog('⚠️ 未找到打开的 xk.nju.edu.cn 页面');
    }
    return;
  }

  // 开始
  const rawText = document.getElementById('courseNames').value.trim();
  if (!rawText) {
    appendLog('⚠️ 请先输入目标课程名称');
    return;
  }
  const courseNames = rawText.split('\n').map(s => s.trim()).filter(Boolean);
  const interval = parseInt(document.getElementById('grabInterval').value, 10) || 5000;

  const tab = await getGrabTab();
  if (!tab) {
    appendLog('❌ 未找到打开的选课页面（xk.nju.edu.cn），请先打开选课页面');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: 'startGrab', courseNames, interval }, (resp) => {
    if (chrome.runtime.lastError) {
      appendLog('❌ 无法连接页面脚本，请刷新选课页面后重试（F5）');
      return;
    }
    setGrabRunning(true);
    grabStatusEl.innerHTML = '';
    appendLog('🚀 已连接到选课页面，监控已启动');
  });
});

// 接收来自 content-grab.js 的实时日志
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'grabLog' && msg.message) {
    appendLog(msg.message);
    if (msg.state) {
      setGrabRunning(msg.state.running);
    }
  } else if (msg.action === 'grabStopped') {
    setGrabRunning(false);
    if (msg.state && msg.state.log) renderLogs(msg.state.log);
  }
});

// popup 打开时同步状态
(async () => {
  const tab = await getGrabTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { action: 'getGrabStatus' }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.state) {
      setGrabRunning(resp.state.running);
      if (resp.state.log && resp.state.log.length > 0) renderLogs(resp.state.log);
    }
  });
})();