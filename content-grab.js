// content-grab.js - 南京大学选课系统 自动抢课脚本
// 运行在 https://xk.nju.edu.cn/xsxkapp/ 选课页面
console.log('[AutoGrab] 南京大学自动抢课脚本已加载');

// ============ 状态管理 ============
let grabState = {
  running: false,
  courseNames: [],      // 目标课程名称列表（支持模糊匹配）
  interval: 3000,       // 刷新间隔(ms)，最小3秒
  timer: null,
  round: 0,
  successCourses: [],
  log: []
};

function pushLog(msg) {
  const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
  grabState.log.push(entry);
  if (grabState.log.length > 50) grabState.log.shift();
  // 通知popup更新日志
  try {
    chrome.runtime.sendMessage({ action: 'grabLog', message: entry, state: getStateSnapshot() });
  } catch (e) { /* popup可能未打开 */ }
}

function getStateSnapshot() {
  return {
    running: grabState.running,
    round: grabState.round,
    successCourses: grabState.successCourses,
    log: grabState.log.slice(-20)
  };
}

// ============ 核心抢课逻辑 ============

/**
 * 等待确认弹窗出现并点击确认
 */
async function confirmDialog() {
  return new Promise((resolve) => {
    let tries = 0;
    const maxTries = 30; // 最多等3秒

    const check = () => {
      tries++;
      // 查找确认按钮（class含 cv-sure 和 cvBtnFlag）
      const confirmBtn = document.querySelector('.cv-sure.cvBtnFlag') 
                      || document.querySelector('.cv-sure')
                      || document.querySelector('.cvBtnFlag');
      if (confirmBtn && confirmBtn.offsetParent !== null) {
        confirmBtn.click();
        resolve(true);
      } else if (tries >= maxTries) {
        resolve(false);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

/**
 * 尝试对页面上匹配课程名的行点击"选择"按钮
 * @returns {Object} { grabbed: string[], full: string[], notFound: string[] }
 */
async function tryGrabOnce() {
  const result = { grabbed: [], full: [], notFound: [...grabState.courseNames] };

  // 找到所有课程行（table tbody tr）
  const rows = document.querySelectorAll('table tbody tr, .cv-tbody tr, .ant-table-tbody tr');
  if (rows.length === 0) {
    pushLog('⚠️ 未发现课程列表，请确认已打开选课页面');
    return result;
  }

  for (const row of rows) {
    const rowText = row.innerText || row.textContent || '';

    for (let i = result.notFound.length - 1; i >= 0; i--) {
      const target = result.notFound[i];
      if (!rowText.includes(target)) continue;

      // 找到匹配课程所在行
      result.notFound.splice(i, 1);

      // 检查是否已选
      const isSelected = rowText.includes('退选') || rowText.includes('已选');
      if (isSelected) {
        pushLog(`✅ "${target}" 已在选课列表中，无需再抢`);
        grabState.successCourses.push(target);
        continue;
      }

      // 检查是否已满（收藏页面满员时按钮仍可见，需主动判断文字）
      // 匹配"已满"或"已满/N"格式，避免误判课程名中含"满"字
      const isFull = /已满/.test(rowText);

      // 检查是否有"选择"按钮（cv-choice）
      const choiceBtn = row.querySelector('.cv-choice');
      if (!choiceBtn || choiceBtn.disabled || choiceBtn.offsetParent === null || isFull) {
        result.full.push(target);
        continue;
      }

      // 点击选择按钮
      pushLog(`🖱️ 发现"${target}"有空位，正在点击选择...`);
      choiceBtn.click();

      // 等待并确认弹窗
      const confirmed = await confirmDialog();
      if (confirmed) {
        pushLog(`🎉 "${target}" 抢课成功！确认弹窗已点击`);
        result.grabbed.push(target);
        grabState.successCourses.push(target);
      } else {
        // 未出现确认框（如收藏页面可能直接选上，或点击无效）
        // 等待一下再检查行状态是否已变为"已选/退选"
        await sleep(800);
        const updatedText = row.innerText || row.textContent || '';
        if (updatedText.includes('退选') || updatedText.includes('已选')) {
          pushLog(`✅ "${target}" 选课成功（页面直接确认，无弹窗）`);
          result.grabbed.push(target);
          grabState.successCourses.push(target);
        } else {
          // 实际未成功，继续监控
          pushLog(`⚠️ "${target}" 点击选择后未出现确认框，且未检测到选课成功，继续监控`);
          result.full.push(target);
        }
      }

      await sleep(500); // 操作后稍等
    }
  }

  return result;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 点击刷新按钮，等待列表重新渲染
 * 等待策略：先等旧行消失或数量变化，最多等 2 秒
 */
async function refreshList() {
  // 兼容普通选课页和收藏页：先找专属 class，再找文本为"刷新"的按钮
  const refreshBtn = document.querySelector('.cv-btn.refresh-btn')
    || [...document.querySelectorAll('button, .cv-btn')].find(el => el.textContent.trim() === '刷新');
  if (!refreshBtn) return; // 找不到刷新按钮则跳过

  // 视觉反馈：短暂高亮按钮，表明脚本正在点击
  const origStyle = refreshBtn.getAttribute('style') || '';
  refreshBtn.style.cssText += ';outline:3px solid #634798 !important;opacity:0.6 !important;transition:none !important;';
  setTimeout(() => refreshBtn.setAttribute('style', origStyle), 400);

  // 记录刷新前的行数，用于判断渲染完成
  const before = document.querySelectorAll('table tbody tr, .cv-tbody tr, .ant-table-tbody tr').length;
  refreshBtn.click();

  // 等待内容刷新：最多 2000ms，每 100ms 检测一次行数是否有变化
  // 如果行数在刷新后先归零再恢复，或直接恢复，说明渲染完毕
  let waited = 0;
  let zeroSeen = false;
  while (waited < 2000) {
    await sleep(100);
    waited += 100;
    const after = document.querySelectorAll('table tbody tr, .cv-tbody tr, .ant-table-tbody tr').length;
    if (after === 0) { zeroSeen = true; }
    if (zeroSeen && after > 0) break;  // 先空后有，渲染完毕
    if (!zeroSeen && after !== before) break; // 直接变化
  }
}

// ============ 监控主循环 ============
async function grabLoop() {
  if (!grabState.running) return;

  grabState.round++;
  pushLog(`🔄 第 ${grabState.round} 轮检测中... (监控课程: ${grabState.courseNames.join('、')})`);

  try {
    await refreshList(); // 先点击刷新，等待列表更新
    const res = await tryGrabOnce();

    if (res.grabbed.length > 0) {
      pushLog(`✅ 本轮成功: ${res.grabbed.join('、')}`);
    }

    // 如果还有未抢到的课程，过滤掉已成功的继续监控
    const remaining = grabState.courseNames.filter(
      name => !grabState.successCourses.includes(name)
    );

    if (remaining.length === 0) {
      pushLog('🎊 所有目标课程已抢到，监控停止！');
      stopGrab();
      return;
    }

    grabState.courseNames = remaining;

    if (res.full.length > 0) {
      pushLog(`⏳ 以下课程仍满员，继续监控: ${res.full.join('、')}`);
    }
    if (res.notFound.length > 0) {
      pushLog(`🔍 未找到以下课程（检查名称是否正确）: ${res.notFound.join('、')}`);
    }
  } catch (e) {
    pushLog(`❌ 检测出错: ${e.message}`);
  }

  if (grabState.running) {
    grabState.timer = setTimeout(grabLoop, grabState.interval);
  }
}

// ============ 对外控制接口 ============
function startGrab(courseNames, intervalMs) {
  if (grabState.running) stopGrab();

  grabState.courseNames = courseNames.filter(Boolean);
  grabState.interval = Math.max(intervalMs || 3000, 1000); // 最少1秒
  grabState.running = true;
  grabState.round = 0;
  grabState.successCourses = [];
  grabState.log = [];

  pushLog(`🚀 开始监控，共 ${grabState.courseNames.length} 门课，间隔 ${grabState.interval / 1000}s`);
  grabLoop();
}

function stopGrab() {
  grabState.running = false;
  if (grabState.timer) {
    clearTimeout(grabState.timer);
    grabState.timer = null;
  }
  pushLog('⏹️ 监控已停止');
  try {
    chrome.runtime.sendMessage({ action: 'grabStopped', state: getStateSnapshot() });
  } catch (e) { /* popup未打开 */ }
}

// ============ 消息监听（与popup通信）============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startGrab') {
    startGrab(msg.courseNames, msg.interval);
    sendResponse({ ok: true, state: getStateSnapshot() });
  } else if (msg.action === 'stopGrab') {
    stopGrab();
    sendResponse({ ok: true, state: getStateSnapshot() });
  } else if (msg.action === 'getGrabStatus') {
    sendResponse({ ok: true, state: getStateSnapshot() });
  }
  return true; // 保持消息通道以支持异步sendResponse
});
