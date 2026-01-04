document.getElementById('saveBtn').addEventListener('click', () => {
  const settings = {
    nju_user: document.getElementById('username').value,
    nju_pass: document.getElementById('password').value,
    nju_enabled: document.getElementById('isEnabled').checked,
    nju_force: document.getElementById('forceFill').checked
  };

  chrome.storage.local.set(settings, () => {
    const btn = document.getElementById('saveBtn');
    btn.textContent = '已保存 ✓';
    btn.style.background = '#28a745';
    setTimeout(() => {
      btn.textContent = '保存配置';
      btn.style.background = '#634798';
    }, 1500);
  });
});

chrome.storage.local.get(['nju_user', 'nju_pass', 'nju_enabled', 'nju_force'], (data) => {
  document.getElementById('username').value = data.nju_user || '';
  document.getElementById('password').value = data.nju_pass || '';
  document.getElementById('isEnabled').checked = data.nju_enabled !== false;
  document.getElementById('forceFill').checked = !!data.nju_force;
});