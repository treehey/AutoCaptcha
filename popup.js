// 保存账号密码
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
const switches = ['isEnabled', 'forceFill', 'autoClick', 'xkEnabled'];
const saveBtn = document.getElementById('saveBtn');

// 1. 初始化加载
chrome.storage.local.get(['nju_user', 'nju_pass', 'nju_enabled', 'nju_force', 'nju_auto_click', 'xk_enabled'], (data) => {
  document.getElementById('username').value = data.nju_user || '';
  document.getElementById('password').value = data.nju_pass || '';
  
  // 开关状态加载
  document.getElementById('isEnabled').checked = data.nju_enabled !== false;
  document.getElementById('xkEnabled').checked = data.xk_enabled !== false;
  document.getElementById('forceFill').checked = !!data.nju_force;
  document.getElementById('autoClick').checked = data.nju_auto_click !== false;
});

// 2. 为开关绑定自动保存事件
switches.forEach(id => {
  document.getElementById(id).addEventListener('change', (e) => {
    const keyMap = {
      'isEnabled': 'nju_enabled',
      'xkEnabled': 'xk_enabled',
      'forceFill': 'nju_force',
      'autoClick': 'nju_auto_click'
    };
    chrome.storage.local.set({ [keyMap[id]]: e.target.checked });
  });
});

// 打开 GitHub 仓库
document.getElementById('githubBtn').addEventListener('click', () => {
  // *** 请将下面的 URL 替换为你的 GitHub 仓库地址 ***
  window.open('https://github.com/treehey/AutoCaptcha', '_blank');
});