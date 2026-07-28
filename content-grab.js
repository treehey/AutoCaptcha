// content-grab.js - 南京大学选课系统 自动抢课脚本
// 运行在 https://xk.nju.edu.cn/xsxkapp/ 选课页面
console.log('[AutoGrab] 南京大学自动抢课脚本已加载');

// ============ 状态管理 ============
let grabState = {
  running: false,
  courseNames: [],      // 目标课程名称列表（支持模糊匹配）
  interval: 3000,       // 刷新间隔(ms)，最小1秒
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
    courseNames: grabState.courseNames.slice(),
    interval: grabState.interval,
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
 * 公共：点击选择按钮后等待确认弹窗，处理结果
 * @returns {boolean} 是否成功
 */
async function clickAndConfirm(choiceBtn, row, target, result) {
  pushLog(`🖱️ 发现"${target}"有空位，正在点击选择...`);
  choiceBtn.click();

  const confirmed = await confirmDialog();
  if (confirmed) {
    pushLog(`🎉 "${target}" 抢课成功！确认弹窗已点击`);
    result.grabbed.push(target);
    grabState.successCourses.push(target);
    return true;
  }

  // 未出现确认框：等待后检查行状态
  await sleep(800);
  const updatedText = row.innerText || row.textContent || '';
  if (updatedText.includes('退选') || updatedText.includes('已选')) {
    pushLog(`✅ "${target}" 选课成功（页面直接确认，无弹窗）`);
    result.grabbed.push(target);
    grabState.successCourses.push(target);
    return true;
  }

  pushLog(`⚠️ "${target}" 点击选择后未出现确认框，且未检测到选课成功，继续监控`);
  result.full.push(target);
  return false;
}

/**
 * 获取专业课展开后的班级子行
 * 兼容两种渲染方式：行内子元素 / 紧跟的兄弟 tr 行
 */
function getExpandedClassRows(row) {
  // 方式1：展开内容渲染在本行内部（子元素）
  const inner = [...row.querySelectorAll('tr, [class*="class"], [class*="expand"], [class*="child"]')]
    .filter(el => el.querySelector('.cv-choice') || /已满|退选|已选/.test(el.textContent));
  if (inner.length > 0) return inner;

  // 方式2：展开内容作为后续兄弟 tr 插入（直到遇到下一个拥有 cv-zy-expand 的主行）
  const siblings = [];
  let next = row.nextElementSibling;
  while (next && siblings.length < 30) {
    if (next.querySelector('.cv-zy-expand')) break; // 遇到下一门课的主行，停止
    if (next.querySelector('.cv-choice') || /已满|退选|已选/.test(next.textContent)) {
      siblings.push(next);
    }
    next = next.nextElementSibling;
  }
  return siblings;
}

/**
 * 专业课流程：展开班级 → 找有空位的班 → 选择
 */
async function grabZhuanye(row, target, result) {
  const expandBtn = row.querySelector('.cv-zy-expand');
  if (!expandBtn) return false; // 不是专业课，交给普通流程处理

  pushLog(`📂 "${target}" 检测为专业课，正在展开班级列表...`);
  expandBtn.click();

  // 等待班级子行出现，最多 2 秒
  let waited = 0;
  let classRows = [];
  while (waited < 2000) {
    await sleep(100);
    waited += 100;
    classRows = getExpandedClassRows(row);
    if (classRows.length > 0) break;
  }

  if (classRows.length === 0) {
    pushLog(`⚠️ "${target}" 班级列表展开失败或无可用班级，继续等待`);
    result.full.push(target);
    return true;
  }


  for (const classRow of classRows) {
    // 只认有“退选”按钮的班级为已选
    const tuiXuanBtn = Array.from(classRow.querySelectorAll('.cv-choice, .cv-btn')).find(btn => btn.textContent.trim() === '退选');
    if (tuiXuanBtn && tuiXuanBtn.offsetParent !== null && !tuiXuanBtn.disabled) {
      pushLog(`✅ "${target}" 已在选课列表中，无需再抢`);
      grabState.successCourses.push(target);
      return true;
    }

    // 该班满员，跳过
    const classText = classRow.innerText || classRow.textContent || '';
    if (/已满/.test(classText)) continue;

    // 找选择按钮
    const choiceBtn = classRow.querySelector('.cv-choice');
    if (!choiceBtn || choiceBtn.disabled || choiceBtn.offsetParent === null) continue;

    // 有空位，尝试选择
    await clickAndConfirm(choiceBtn, classRow, target, result);
    await sleep(500);
    return true;
  }

  // 所有班级均满员
  result.full.push(target);
  return true;
}

/**
 * 尝试对页面上匹配课程名的行点击"选择"按钮
 * 自动识别普通课 / 收藏页 / 专业课（cv-zy-expand）
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
      if (rowText.includes('退选') || rowText.includes('已选')) {
        pushLog(`✅ "${target}" 已在选课列表中，无需再抢`);
        grabState.successCourses.push(target);
        continue;
      }

      // ---- 专业课分支（有 cv-zy-expand 按钮） ----
      if (row.querySelector('.cv-zy-expand')) {
        await grabZhuanye(row, target, result);
        await sleep(500);
        continue;
      }

      // ---- 普通课 / 收藏页分支 ----
      // 检查是否已满（收藏页面满员时按钮仍可见，需主动判断文字）
      if (/已满/.test(rowText)) {
        result.full.push(target);
        continue;
      }

      const choiceBtn = row.querySelector('.cv-choice');
      if (!choiceBtn || choiceBtn.disabled || choiceBtn.offsetParent === null) {
        result.full.push(target);
        continue;
      }

      await clickAndConfirm(choiceBtn, row, target, result);
      await sleep(500);
    }
  }

  return result;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 点击刷新按钮，等待列表重新渲染
 * 等待策略：MutationObserver 监听表格任意 DOM 变化（含选课人数文字更新），
 * 检测到变化后 50ms 继续；若数据完全未变则最多兜底等 800ms
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

  refreshBtn.click();

  // 用 MutationObserver 监听表格区域任意变化（含文字/属性/子元素）
  // 检测到变化后再等 50ms 让批量更新完成，最多兜底等 800ms
  // 注意：若本轮刷新前后数据完全未变，则安静等待 800ms 后继续，不会卡满 1s
  const tableRoot = document.querySelector('table, .cv-tbody, .ant-table-tbody') || document.body;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 800);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      observer.disconnect();
      setTimeout(resolve, 50); // 等批量更新收尾
    });
    observer.observe(tableRoot, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
  });
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

// ============ 点击式验证码离线采样 ============
// 采样默认关闭。开启后仅旁路记录验证码原图和用户的手动点击，不会阻止、修改或代替页面点击。
const CLICK_CAPTCHA_SAMPLE_COUNT_KEY = 'nju_click_captcha_v1_count';
const CLICK_CAPTCHA_SAMPLE_KEY_PREFIX = 'nju_click_captcha_v1_';
const CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY = 'nju_click_captcha_v1_skipped_three_count';
const CLICK_CAPTCHA_SAMPLE_MAX_COUNT = 30;
const CLICK_CAPTCHA_MIN_TARGET_COUNT = 3;
const CLICK_CAPTCHA_MAX_TARGET_COUNT = 4;
const CLICK_CAPTCHA_REFERENCE_WIDTH = 250;
const CLICK_CAPTCHA_REFERENCE_HEIGHT = 120;
const CLICK_CAPTCHA_FOUR_TARGET_RIGHT_BRACKET = [211, 222];
const CLICK_CAPTCHA_TARGET_TEXT_TOP = 101;
const CLICK_CAPTCHA_TARGET_TEXT_BOTTOM = 119;
const CLICK_CAPTCHA_REFRESH_SETTLE_MS = 450;
const CLICK_CAPTCHA_REFRESH_TIMEOUT_MS = 4000;
const CLICK_CAPTCHA_REQUIRED_TARGET_COUNT = 4;
const CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS = 5;
const CLICK_CAPTCHA_SOLVER_ENABLED_KEY = 'nju_click_captcha_solver_enabled';
const CLICK_CAPTCHA_AUTO_CLICK_KEY = 'nju_click_captcha_auto_click';
const CLICK_CAPTCHA_AUTO_MARGIN = 0.4;
const CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL = 12;
const CLICK_CAPTCHA_MAX_LOW_CONFIDENCE_REFRESH_ATTEMPTS = 5;
const CLICK_CAPTCHA_SOLVER_POLL_MS = 650;
const CLICK_CAPTCHA_LOGIN_SUBMIT_DELAY_MS = 180;

const clickCaptchaSolver = {
  enabled: false,
  autoClick: false,
  running: false,
  target: null,
  fingerprint: '',
  attemptedTarget: null,
  attemptedFingerprint: '',
  submittedTarget: null,
  submittedFingerprint: '',
  autoClickToken: 0,
  lowConfidenceRefreshes: 0,
  result: null,
  loginStatus: '未检测登录表单',
  status: '未启用',
  monitor: null
};

const clickCaptchaWorker = {
  worker: null,
  ready: null,
  requestId: 0,
  requests: new Map()
};

const clickCaptchaCapture = {
  enabled: false,
  target: null,
  current: null,
  saving: false,
  refreshing: false,
  skippedThreeTargetCount: 0,
  expectedClicks: CLICK_CAPTCHA_MAX_TARGET_COUNT,
  status: '未启动'
};

function isVisibleCaptureElement(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

function describeCaptureElement(element) {
  const rect = element.getBoundingClientRect();
  const hint = [element.id, element.className, element.getAttribute('alt'), element.getAttribute('title')]
    .filter(Boolean)
    .join(' ')
    .slice(0, 160);
  return {
    tagName: element.tagName.toLowerCase(),
    hint,
    displayedWidth: Math.round(rect.width),
    displayedHeight: Math.round(rect.height)
  };
}

function findClickCaptchaElement() {
  const candidates = Array.from(document.querySelectorAll('img, canvas'))
    .filter(isVisibleCaptureElement)
    .map(element => {
      const rect = element.getBoundingClientRect();
      const hint = [element.id, element.className, element.getAttribute('alt'), element.getAttribute('title')]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const ratio = rect.width / rect.height;
      const captchaHint = /(captcha|verify|valid|code|yzm|验证码|校验)/.test(hint);
      const sizeMatch = rect.width >= 120 && rect.width <= 520 && rect.height >= 50 && rect.height <= 260;
      const ratioMatch = ratio >= 1.2 && ratio <= 4.5;
      const score = (captchaHint ? 1000 : 0) + (sizeMatch ? 120 : 0) + (ratioMatch ? 80 : 0) - Math.abs(ratio - 2) * 12;
      return { element, score, sizeMatch, ratioMatch };
    })
    .filter(item => item.sizeMatch && item.ratioMatch)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.element || null;
}

function isReadyClickCaptchaElement(element) {
  if (!element || !isVisibleCaptureElement(element)) return false;
  if (element instanceof HTMLImageElement) return element.naturalWidth > 0 && element.naturalHeight > 0;
  if (element instanceof HTMLCanvasElement) return element.width > 0 && element.height > 0;
  return false;
}

function getClickCaptchaFingerprint(element) {
  if (element instanceof HTMLImageElement) {
    return `image:${element.currentSrc || element.src || ''}`;
  }
  if (element instanceof HTMLCanvasElement) {
    try {
      const context = element.getContext('2d', { willReadFrequently: true });
      const { data } = context.getImageData(0, 0, element.width, element.height);
      const stride = Math.max(4, Math.floor(Math.sqrt((element.width * element.height) / 720)));
      let hash = 2166136261;
      for (let y = 0; y < element.height; y += stride) {
        for (let x = 0; x < element.width; x += stride) {
          const offset = (y * element.width + x) * 4;
          hash ^= data[offset];
          hash = Math.imul(hash, 16777619);
          hash ^= data[offset + 1];
          hash = Math.imul(hash, 16777619);
          hash ^= data[offset + 2];
          hash = Math.imul(hash, 16777619);
        }
      }
      return `canvas:${element.width}x${element.height}:${hash >>> 0}`;
    } catch {
      return `canvas:${element.width}x${element.height}`;
    }
  }
  return '';
}

function findClickCaptchaRefreshControl(target) {
  const verifyRefresh = document.querySelector('.verify-refresh');
  if (verifyRefresh && isVisibleCaptureElement(verifyRefresh)) {
    return verifyRefresh;
  }

  const targetRect = target.getBoundingClientRect();
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
    .filter(isVisibleCaptureElement)
    .map(element => {
      const text = [element.textContent, element.getAttribute('title'), element.getAttribute('aria-label'), element.className, element.id]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/(刷新|换一张|看不清|reload|refresh)/i.test(text)) return null;

      const rect = element.getBoundingClientRect();
      const distance = Math.hypot(rect.left - targetRect.left, rect.top - targetRect.top);
      return { element, distance };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);

  return controls[0]?.element || null;
}

async function waitForRefreshedClickCaptcha(previousTarget, previousFingerprint, timeoutMs = CLICK_CAPTCHA_REFRESH_TIMEOUT_MS) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const candidate = findClickCaptchaElement();
    const fingerprint = getClickCaptchaFingerprint(candidate);
    if (candidate && isReadyClickCaptchaElement(candidate) && (candidate !== previousTarget || fingerprint !== previousFingerprint)) {
      // CVVerifyCode briefly clears and redraws the same canvas. Require the new frame to settle before rearming capture.
      await sleep(260);
      const settledCandidate = findClickCaptchaElement();
      if (settledCandidate && isReadyClickCaptchaElement(settledCandidate) && getClickCaptchaFingerprint(settledCandidate) === getClickCaptchaFingerprint(candidate)) {
        return settledCandidate;
      }
    }
    await sleep(80);
  }
  return null;
}

async function requestFreshClickCaptcha(previousTarget) {
  const previousFingerprint = getClickCaptchaFingerprint(previousTarget);
  const refreshControl = previousTarget ? findClickCaptchaRefreshControl(previousTarget) : null;
  if (refreshControl) {
    refreshControl.click();
  } else if (previousTarget instanceof HTMLImageElement) {
    const refreshUrl = new URL(previousTarget.currentSrc || previousTarget.src, location.href);
    refreshUrl.searchParams.set('_njuCaptureRefresh', String(Date.now()));
    previousTarget.src = refreshUrl.toString();
  } else {
    throw new Error('未找到页面刷新控件，且验证码不是图片元素');
  }

  const refreshedTarget = await waitForRefreshedClickCaptcha(previousTarget, previousFingerprint);
  if (!refreshedTarget) {
    throw new Error('等待新验证码超时');
  }

  return refreshedTarget;
}

function isVisibleFormControl(element) {
  return element instanceof HTMLElement
    && !element.disabled
    && isVisibleCaptureElement(element);
}

function getControlHint(element) {
  return [
    element.id,
    element.name,
    element.className,
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
    element.getAttribute('autocomplete'),
    element.getAttribute('type')
  ].filter(Boolean).join(' ').toLowerCase();
}

function getElementDistance(first, second) {
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  return Math.hypot((a.left + a.width / 2) - (b.left + b.width / 2), (a.top + a.height / 2) - (b.top + b.height / 2));
}

function getLoginScopes(target) {
  const scopes = [];
  const form = target.closest('form');
  if (form) scopes.push(form);

  let ancestor = target.parentElement;
  for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
    if (!scopes.includes(ancestor)) scopes.push(ancestor);
  }
  return scopes;
}

function findLoginSubmitControl(scope, target) {
  const controls = Array.from(scope.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
    .filter(isVisibleFormControl)
    .map(element => {
      const label = [element.textContent, element.value, element.getAttribute('title'), element.getAttribute('aria-label'), element.id, element.className]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (/(verify-refresh|captcha-refresh|刷新|换一张|看不清|reload|refresh|重置|reset)/i.test(label)) return null;
      const loginMatch = /(登录|login|sign\s*in|提交|submit|确认)/i.test(label);
      const typeMatch = element.matches('input[type="submit"]') || element.getAttribute('type') === 'submit';
      if (!loginMatch && !typeMatch) return null;
      return {
        element,
        score: (loginMatch ? 1000 : 0) + (typeMatch ? 120 : 0) - getElementDistance(element, target)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return controls[0]?.element || null;
}

function findClickCaptchaLoginContext(target) {
  // The current selection portal has stable login IDs. Prefer this exact
  // container so a later in-page captcha cannot be mistaken for login.
  const loginContainer = document.getElementById('loginDiv');
  const portalCaptcha = document.getElementById('vcodeImg');
  const portalUsername = document.getElementById('loginName');
  const portalPassword = document.getElementById('loginPwd');
  const portalSubmit = document.getElementById('studentLoginBtn');
  if (target === portalCaptcha
    && loginContainer
    && portalUsername
    && portalPassword
    && portalSubmit
    && isVisibleCaptureElement(loginContainer)
    && isVisibleFormControl(portalUsername)
    && isVisibleFormControl(portalPassword)
    && isVisibleFormControl(portalSubmit)) {
    return {
      scope: loginContainer,
      form: null,
      usernameInput: portalUsername,
      passwordInput: portalPassword,
      submitButton: portalSubmit,
      score: Number.POSITIVE_INFINITY
    };
  }

  const contexts = getLoginScopes(target)
    .map(scope => {
      const passwordInput = Array.from(scope.querySelectorAll('input[type="password"]'))
        .filter(isVisibleFormControl)
        .sort((a, b) => getElementDistance(a, target) - getElementDistance(b, target))[0];
      if (!passwordInput) return null;

      const usernameInput = Array.from(scope.querySelectorAll('input'))
        .filter(isVisibleFormControl)
        .filter(input => input !== passwordInput && !/captcha|verify|valid|code|yzm|验证码|校验/.test(getControlHint(input)))
        .filter(input => /^(text|email|tel|number)?$/i.test(input.type || 'text'))
        .map(input => ({
          input,
          score: (/(user|account|student|username|login|xh|学号|账号)/.test(getControlHint(input)) ? 1000 : 0)
            - getElementDistance(input, passwordInput)
        }))
        .sort((a, b) => b.score - a.score)[0]?.input;
      if (!usernameInput) return null;

      const submitButton = findLoginSubmitControl(scope, target);
      const form = scope instanceof HTMLFormElement ? scope : (passwordInput.closest('form') || usernameInput.closest('form'));
      if (!submitButton && !form) return null;
      return {
        scope,
        form,
        usernameInput,
        passwordInput,
        submitButton,
        score: (scope instanceof HTMLFormElement ? 2000 : 0) + (submitButton ? 500 : 0)
          - getElementDistance(passwordInput, target)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return contexts[0] || null;
}

function setNativeInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function prepareClickCaptchaLogin(target) {
  const settings = await storageGet(['nju_user', 'nju_pass', 'nju_force']);

  const context = findClickCaptchaLoginContext(target);
  if (!context) {
    clickCaptchaSolver.loginStatus = '未在验证码附近找到登录表单';
    return null;
  }

  const shouldFill = settings.nju_force || (!context.usernameInput.value && !context.passwordInput.value);
  if (shouldFill && settings.nju_user && settings.nju_pass) {
    setNativeInputValue(context.usernameInput, settings.nju_user);
    setNativeInputValue(context.passwordInput, settings.nju_pass);
  }

  if (!context.usernameInput.value || !context.passwordInput.value) {
    clickCaptchaSolver.loginStatus = '登录表单已找到，但账号或密码未配置';
    return null;
  }

  clickCaptchaSolver.loginStatus = context.submitButton
    ? '登录表单已就绪'
    : '登录表单已就绪，将通过表单提交';
  return context;
}

async function submitClickCaptchaLogin(target, fingerprint, context, autoClickToken) {
  if (!context || !clickCaptchaSolver.enabled || !clickCaptchaSolver.autoClick
    || clickCaptchaSolver.autoClickToken !== autoClickToken) {
    return false;
  }
  if (clickCaptchaSolver.submittedTarget === target && clickCaptchaSolver.submittedFingerprint === fingerprint) {
    clickCaptchaSolver.loginStatus = '当前验证码已提交过登录';
    return false;
  }
  if (!document.contains(target) || getClickCaptchaFingerprint(target) !== fingerprint) {
    clickCaptchaSolver.loginStatus = '验证码已更新，跳过重复提交';
    return false;
  }

  await sleep(CLICK_CAPTCHA_LOGIN_SUBMIT_DELAY_MS);
  if (!document.contains(target) || getClickCaptchaFingerprint(target) !== fingerprint) {
    clickCaptchaSolver.loginStatus = '验证码已验证，页面正在跳转';
    return false;
  }

  clickCaptchaSolver.status = '验证码已点击，正在提交登录';
  notifyClickCaptchaSolverUpdate();
  if (context.submitButton && isVisibleFormControl(context.submitButton)) {
    context.submitButton.click();
  } else if (context.form) {
    if (typeof context.form.requestSubmit === 'function') context.form.requestSubmit();
    else context.form.submit();
  } else {
    clickCaptchaSolver.loginStatus = '登录按钮已不可用，未提交';
    return false;
  }
  clickCaptchaSolver.submittedTarget = target;
  clickCaptchaSolver.submittedFingerprint = fingerprint;
  clickCaptchaSolver.loginStatus = '登录已提交';
  // The portal switches to the user card asynchronously without a full page
  // navigation. The prior captcha canvas can therefore remain in the DOM.
  clearClickCaptchaSolverOverlay();
  return true;
}

async function recordSkippedThreeTargetCaptcha() {
  try {
    const data = await storageGet([CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY]);
    const count = Number(data[CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY] || 0) + 1;
    await storageSet({ [CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY]: count });
    clickCaptchaCapture.skippedThreeTargetCount = count;
  } catch {
    // Telemetry must never prevent the refresh policy from running.
    clickCaptchaCapture.skippedThreeTargetCount += 1;
  }
}

async function ensureFourTargetClickCaptcha(target) {
  let currentTarget = target;
  let refreshCount = 0;

  while (inferClickCaptchaTargetCount(currentTarget) !== CLICK_CAPTCHA_REQUIRED_TARGET_COUNT) {
    if (refreshCount >= CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS) {
      throw new Error(`连续 ${CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS} 次仍为三字验证码`);
    }

    refreshCount += 1;
    await recordSkippedThreeTargetCaptcha();
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.current = null;
    clickCaptchaCapture.target = currentTarget;
    clickCaptchaCapture.refreshing = true;
    clickCaptchaCapture.status = `检测到三字验证码，正在刷新为四字（${refreshCount}/${CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS}）`;
    renderClickCaptchaOverlay();
    notifyClickCaptchaCaptureUpdate();
    currentTarget = await requestFreshClickCaptcha(currentTarget);
  }

  return { target: currentTarget, refreshCount };
}

async function refreshClickCaptchaAndResume(sampleId) {
  const previousTarget = clickCaptchaCapture.target;
  const previousFingerprint = getClickCaptchaFingerprint(previousTarget);

  // Some pages refresh automatically after the final valid click. Prefer that result and avoid an unnecessary extra request.
  let refreshedTarget = await waitForRefreshedClickCaptcha(
    previousTarget,
    previousFingerprint,
    CLICK_CAPTCHA_REFRESH_SETTLE_MS
  );
  const pageRefreshed = Boolean(refreshedTarget);
  if (!refreshedTarget) {
    refreshedTarget = await requestFreshClickCaptcha(previousTarget);
  }

  const prepared = await ensureFourTargetClickCaptcha(refreshedTarget);

  clickCaptchaCapture.target = prepared.target;
  clickCaptchaCapture.expectedClicks = CLICK_CAPTCHA_REQUIRED_TARGET_COUNT;
  clickCaptchaCapture.enabled = true;
  clickCaptchaCapture.refreshing = false;
  clickCaptchaCapture.status = prepared.refreshCount
    ? `样本 ${sampleId} 已保存，已跳过三字验证码并继续采样`
    : pageRefreshed
      ? `样本 ${sampleId} 已保存，已检测到新验证码并继续采样`
      : `样本 ${sampleId} 已保存，新验证码已就绪，继续采样`;
  renderClickCaptchaOverlay();
  notifyClickCaptchaCaptureUpdate('clickCaptchaSampleSaved');
}

function getClickCaptchaOverlay() {
  let overlay = document.getElementById('nju-click-captcha-capture-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'nju-click-captcha-capture-overlay';
  overlay.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'display:none',
    'pointer-events:none',
    'border:2px dashed #634798',
    'border-radius:5px',
    'box-shadow:0 0 0 3px rgba(99,71,152,.16)'
  ].join(';');

  const label = document.createElement('div');
  label.dataset.njuCaptureLabel = 'true';
  label.style.cssText = 'position:absolute;left:0;top:-27px;padding:4px 7px;border-radius:5px;background:#634798;color:#fff;font:700 12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(36,28,55,.24)';
  overlay.appendChild(label);
  document.body.appendChild(overlay);
  return overlay;
}

function renderClickCaptchaOverlay() {
  const overlay = getClickCaptchaOverlay();
  const target = clickCaptchaCapture.target;
  if (!clickCaptchaCapture.enabled || !target || !document.contains(target) || !isVisibleCaptureElement(target)) {
    overlay.style.display = 'none';
    return;
  }

  const rect = target.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.left = `${Math.round(rect.left - 2)}px`;
  overlay.style.top = `${Math.round(rect.top - 2)}px`;
  overlay.style.width = `${Math.round(rect.width + 4)}px`;
  overlay.style.height = `${Math.round(rect.height + 4)}px`;
  const count = clickCaptchaCapture.current?.clicks.length || 0;
  const expected = clickCaptchaCapture.current?.expectedClicks || clickCaptchaCapture.expectedClicks;
  overlay.querySelector('[data-nju-capture-label]').textContent = `采样中：请手动点击（${count}/${expected}）`;
}

function inferClickCaptchaTargetCountFromCanvas(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const xScale = canvas.width / CLICK_CAPTCHA_REFERENCE_WIDTH;
  const yScale = canvas.height / CLICK_CAPTCHA_REFERENCE_HEIGHT;
  const left = Math.floor(CLICK_CAPTCHA_FOUR_TARGET_RIGHT_BRACKET[0] * xScale);
  const right = Math.ceil(CLICK_CAPTCHA_FOUR_TARGET_RIGHT_BRACKET[1] * xScale);
  const top = Math.floor(CLICK_CAPTCHA_TARGET_TEXT_TOP * yScale);
  const bottom = Math.ceil(CLICK_CAPTCHA_TARGET_TEXT_BOTTOM * yScale);
  const pixels = context.getImageData(left, top, Math.max(1, right - left), Math.max(1, bottom - top)).data;
  let brightPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] + pixels[index + 1] + pixels[index + 2] >= 480) brightPixels += 1;
  }

  // The closing bracket sits at x≈213 for four targets and moves left for three.
  // Counting glyph slots is unreliable because that moved bracket overlaps slot four.
  return brightPixels >= 32 ? CLICK_CAPTCHA_MAX_TARGET_COUNT : CLICK_CAPTCHA_MIN_TARGET_COUNT;
}

function inferClickCaptchaTargetCount(element) {
  try {
    return inferClickCaptchaTargetCountFromCanvas(getClickCaptchaFrame(element).canvas);
  } catch {
    return CLICK_CAPTCHA_MAX_TARGET_COUNT;
  }
}

function getClickCaptchaFrame(element) {
  const sourceCanvas = document.createElement('canvas');
  let width = 0;
  let height = 0;

  if (element instanceof HTMLCanvasElement) {
    width = element.width;
    height = element.height;
  } else if (element instanceof HTMLImageElement) {
    width = element.naturalWidth;
    height = element.naturalHeight;
  }

  if (!width || !height) {
    throw new Error('验证码图片尚未加载完成');
  }

  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const context = sourceCanvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(element, 0, 0, width, height);
  return {
    canvas: sourceCanvas,
    context,
    width,
    height,
    imageData: context.getImageData(0, 0, width, height)
  };
}

function getClickCaptchaSource(element) {
  const frame = getClickCaptchaFrame(element);
  const sourceUrl = element instanceof HTMLImageElement ? (element.currentSrc || element.src || '') : '';
  return {
    dataUrl: frame.canvas.toDataURL('image/png'),
    width: frame.width,
    height: frame.height,
    targetCount: inferClickCaptchaTargetCountFromCanvas(frame.canvas),
    sourcePath: sourceUrl ? new URL(sourceUrl, location.href).pathname : '',
    element: describeCaptureElement(element)
  };
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function getClickCaptchaSolverOverlay() {
  let overlay = document.getElementById('nju-click-captcha-solver-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'nju-click-captcha-solver-overlay';
  overlay.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'display:none',
    'pointer-events:none',
    'border:2px solid rgba(37,99,235,.72)',
    'border-radius:5px',
    'box-shadow:0 0 0 3px rgba(37,99,235,.12)'
  ].join(';');

  const label = document.createElement('div');
  label.dataset.njuSolverLabel = 'true';
  label.style.cssText = 'position:absolute;left:0;top:-27px;padding:4px 7px;border-radius:5px;background:#2563eb;color:#fff;font:700 12px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(20,49,109,.22)';
  overlay.appendChild(label);
  document.body.appendChild(overlay);
  return overlay;
}

function renderClickCaptchaSolverOverlay() {
  const overlay = getClickCaptchaSolverOverlay();
  const target = clickCaptchaSolver.target;
  const result = clickCaptchaSolver.result;
  if (!target || !result || !document.contains(target) || !isVisibleCaptureElement(target)) {
    overlay.style.display = 'none';
    return;
  }

  const rect = target.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.left = `${Math.round(rect.left - 2)}px`;
  overlay.style.top = `${Math.round(rect.top - 2)}px`;
  overlay.style.width = `${Math.round(rect.width + 4)}px`;
  overlay.style.height = `${Math.round(rect.height + 4)}px`;
  overlay.querySelector('[data-nju-solver-label]').textContent = clickCaptchaSolver.status;
  overlay.querySelectorAll('[data-nju-solver-point], [data-nju-solver-box]').forEach(node => node.remove());

  result.points.forEach((point, index) => {
    const markerSize = 18;
    const box = point.box || {
      left: point.x - 8,
      top: point.y - 8,
      right: point.x + 8,
      bottom: point.y + 8
    };
    const scaleX = rect.width / result.referenceWidth;
    const scaleY = rect.height / result.referenceHeight;
    const glyphLeft = 2 + (box.left * scaleX);
    const glyphTop = 2 + (box.top * scaleY);
    const glyphRight = 2 + (box.right * scaleX);
    const glyphBottom = 2 + (box.bottom * scaleY);
    const maxMarkerLeft = Math.max(2, rect.width + 2 - markerSize);
    const maxMarkerTop = Math.max(2, rect.height + 2 - markerSize);
    const markerLeft = Math.max(2, Math.min(maxMarkerLeft, glyphRight + 2));
    const markerTop = Math.max(2, Math.min(maxMarkerTop, glyphTop - markerSize - 2));

    const highlight = document.createElement('div');
    highlight.dataset.njuSolverBox = 'true';
    highlight.style.cssText = [
      'position:absolute',
      `left:${Math.round(glyphLeft - 1)}px`,
      `top:${Math.round(glyphTop - 1)}px`,
      `width:${Math.max(2, Math.round(glyphRight - glyphLeft + 2))}px`,
      `height:${Math.max(2, Math.round(glyphBottom - glyphTop + 2))}px`,
      'box-sizing:border-box',
      'border:1px solid rgba(37,99,235,.82)',
      'border-radius:3px',
      'background:rgba(37,99,235,.035)'
    ].join(';');
    overlay.appendChild(highlight);

    const marker = document.createElement('div');
    marker.dataset.njuSolverPoint = 'true';
    marker.textContent = String(index + 1);
    marker.style.cssText = [
      'position:absolute',
      `left:${Math.round(markerLeft)}px`,
      `top:${Math.round(markerTop)}px`,
      `width:${markerSize}px`,
      `height:${markerSize}px`,
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'border-radius:50%',
      'color:#fff',
      'background:#1d4ed8',
      'border:1px solid #fff',
      'box-shadow:0 1px 5px rgba(20,49,109,.32)',
      'font:800 11px/1 system-ui,-apple-system,"Segoe UI",sans-serif'
    ].join(';');
    overlay.appendChild(marker);
  });
}

function clearClickCaptchaSolverOverlay() {
  clickCaptchaSolver.result = null;
  renderClickCaptchaSolverOverlay();
}

function getClickCaptchaSolverState() {
  const result = clickCaptchaSolver.result;
  const backgroundCompatible = Boolean(result
    && result.backgroundResidual <= CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL);
  return {
    enabled: clickCaptchaSolver.enabled,
    autoClick: clickCaptchaSolver.autoClick,
    loginStatus: clickCaptchaSolver.loginStatus,
    running: clickCaptchaSolver.running,
    lowConfidenceRefreshes: clickCaptchaSolver.lowConfidenceRefreshes,
    ready: Boolean(clickCaptchaSolver.target && document.contains(clickCaptchaSolver.target)),
    status: clickCaptchaSolver.status,
    confidenceMargin: result?.margin ?? null,
    backgroundResidual: result?.backgroundResidual ?? null,
    backgroundCompatible,
    headAgreement: result?.headAgreement ?? null,
    autoEligible: isClickCaptchaAutoEligible(result),
    order: result?.order || null,
    elapsedMs: result?.elapsedMs ?? null,
    modelVersion: result?.modelVersion || null
  };
}

function getClickCaptchaManualStatus() {
  const target = findClickCaptchaElement();
  const loginContext = target && findClickCaptchaLoginContext(target);
  const ready = Boolean(loginContext && isReadyClickCaptchaElement(target));
  return {
    ok: true,
    mode: ready ? 'click-mark' : 'none',
    ready,
    state: getClickCaptchaSolverState()
  };
}

function isClickCaptchaAutoEligible(result) {
  return Boolean(result
    && result.margin >= CLICK_CAPTCHA_AUTO_MARGIN
    && result.backgroundResidual <= CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL);
}

function notifyClickCaptchaSolverUpdate() {
  try {
    chrome.runtime.sendMessage({ action: 'clickCaptchaSolverUpdate', state: getClickCaptchaSolverState() });
  } catch {
    // The popup is optional; solving must continue while it is closed.
  }
}

function rejectClickCaptchaWorkerRequests(error) {
  for (const request of clickCaptchaWorker.requests.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  clickCaptchaWorker.requests.clear();
}

function resetClickCaptchaWorker(error) {
  const worker = clickCaptchaWorker.worker;
  clickCaptchaWorker.ready = null;
  clickCaptchaWorker.worker = null;
  if (worker) worker.terminate();
  rejectClickCaptchaWorkerRequests(error);
}

function createClickCaptchaWorker() {
  // A content script's dedicated Worker is created under the page's origin.
  // Bootstrapping from a Blob keeps that initial URL same-origin, then imports
  // the explicitly declared web-accessible extension module with CORS enabled.
  const workerModuleUrl = chrome.runtime.getURL('click-captcha-worker.js');
  const bootstrap = new Blob([
    `import ${JSON.stringify(workerModuleUrl)};`
  ], { type: 'text/javascript' });
  const bootstrapUrl = URL.createObjectURL(bootstrap);
  try {
    return new Worker(bootstrapUrl, { type: 'module' });
  } finally {
    URL.revokeObjectURL(bootstrapUrl);
  }
}

function getClickCaptchaWorker() {
  if (clickCaptchaWorker.ready) return clickCaptchaWorker.ready;

  clickCaptchaWorker.ready = new Promise((resolve, reject) => {
    const worker = createClickCaptchaWorker();
    clickCaptchaWorker.worker = worker;
    worker.onmessage = event => {
      const message = event.data || {};
      if (message.type === 'ready') {
        resolve(worker);
        return;
      }
      if (message.type === 'solved' || message.type === 'error') {
        if (message.type === 'error' && !message.requestId) {
          const error = new Error(message.error || '点击验证码模型初始化失败');
          resetClickCaptchaWorker(error);
          reject(error);
          return;
        }
        const request = clickCaptchaWorker.requests.get(message.requestId);
        if (!request) return;
        clickCaptchaWorker.requests.delete(message.requestId);
        clearTimeout(request.timer);
        if (message.type === 'solved') request.resolve(message.result);
        else request.reject(new Error(message.error || '点击验证码模型执行失败'));
      }
    };
    worker.onerror = event => {
      const error = new Error(event.message || '点击验证码 Worker 启动失败');
      resetClickCaptchaWorker(error);
      reject(error);
    };
    worker.postMessage({
      type: 'init',
      modelUrl: chrome.runtime.getURL('assets/click-captcha-model.onnx'),
      backgroundUrl: chrome.runtime.getURL('assets/click-captcha-background.png'),
      wasmBaseUrl: chrome.runtime.getURL('vendor/onnxruntime/')
    });
  });
  return clickCaptchaWorker.ready;
}

async function solveClickCaptchaFrame(frame, targetCount) {
  const worker = await getClickCaptchaWorker();
  const requestId = ++clickCaptchaWorker.requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (clickCaptchaWorker.requests.delete(requestId)) {
        reject(new Error('点击验证码识别超时'));
      }
    }, 6000);
    clickCaptchaWorker.requests.set(requestId, { resolve, reject, timer });
    worker.postMessage({
      type: 'solve',
      requestId,
      width: frame.width,
      height: frame.height,
      targetCount,
      pixels: frame.imageData.data.buffer
    }, [frame.imageData.data.buffer]);
  });
}

async function prepareFourTargetClickCaptchaForSolver(target) {
  let current = target;
  for (let attempts = 0; attempts < CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS; attempts += 1) {
    if (inferClickCaptchaTargetCount(current) === CLICK_CAPTCHA_REQUIRED_TARGET_COUNT) return current;
    clickCaptchaSolver.status = `检测到三字验证码，正在刷新（${attempts + 1}/${CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS}）`;
    notifyClickCaptchaSolverUpdate();
    current = await requestFreshClickCaptcha(current);
  }
  throw new Error('连续刷新后仍未获得四字验证码');
}

function dispatchClickCaptchaPointer(target, clientX, clientY, type) {
  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0
  };
  if (type.startsWith('pointer') && window.PointerEvent) {
    target.dispatchEvent(new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  } else {
    target.dispatchEvent(new MouseEvent(type, common));
  }
}

function createClickCaptchaAutoClickCancelledError() {
  const error = new Error('自动点击已取消');
  error.code = 'AUTO_CLICK_CANCELLED';
  return error;
}

async function dispatchClickCaptchaPoints(target, result, autoClickToken) {
  const fingerprint = getClickCaptchaFingerprint(target);
  for (const point of result.points) {
    if (!clickCaptchaSolver.enabled
      || !clickCaptchaSolver.autoClick
      || clickCaptchaSolver.autoClickToken !== autoClickToken) {
      throw createClickCaptchaAutoClickCancelledError();
    }
    if (!document.contains(target) || getClickCaptchaFingerprint(target) !== fingerprint) {
      throw new Error('验证码在点击过程中已刷新');
    }
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + ((point.x / result.referenceWidth) * rect.width);
    const clientY = rect.top + ((point.y / result.referenceHeight) * rect.height);
    dispatchClickCaptchaPointer(target, clientX, clientY, 'pointerdown');
    dispatchClickCaptchaPointer(target, clientX, clientY, 'mousedown');
    dispatchClickCaptchaPointer(target, clientX, clientY, 'pointerup');
    dispatchClickCaptchaPointer(target, clientX, clientY, 'mouseup');
    dispatchClickCaptchaPointer(target, clientX, clientY, 'click');
    await sleep(80);
  }
}

async function runClickCaptchaSolver({ allowAutoClick = false, force = false } = {}) {
  if (clickCaptchaCapture.enabled) {
    clickCaptchaSolver.status = '采样进行中，识别已暂停';
    notifyClickCaptchaSolverUpdate();
    return getClickCaptchaSolverState();
  }
  if (clickCaptchaSolver.running) return getClickCaptchaSolverState();

  const initialTarget = findClickCaptchaElement();
  if (!initialTarget) {
    clickCaptchaSolver.target = null;
    clickCaptchaSolver.status = '未找到点击验证码';
    clearClickCaptchaSolverOverlay();
    notifyClickCaptchaSolverUpdate();
    return getClickCaptchaSolverState();
  }

  const initialFingerprint = getClickCaptchaFingerprint(initialTarget);
  if (!force
    && initialTarget === clickCaptchaSolver.attemptedTarget
    && initialFingerprint === clickCaptchaSolver.attemptedFingerprint) {
    return getClickCaptchaSolverState();
  }

  clickCaptchaSolver.running = true;
  clickCaptchaSolver.lowConfidenceRefreshes = 0;
  clickCaptchaSolver.target = initialTarget;
  clickCaptchaSolver.status = '正在识别点击验证码';
  notifyClickCaptchaSolverUpdate();
  try {
    let target = initialTarget;
    const canAutoClickNow = () => allowAutoClick
      && clickCaptchaSolver.enabled
      && clickCaptchaSolver.autoClick;

    while (true) {
      if (clickCaptchaSolver.lowConfidenceRefreshes > 0 && !canAutoClickNow()) {
        clickCaptchaSolver.status = '自动点击已关闭，已停止换图重试';
        break;
      }
      target = await prepareFourTargetClickCaptchaForSolver(target);
      const fingerprint = getClickCaptchaFingerprint(target);
      clickCaptchaSolver.attemptedTarget = target;
      clickCaptchaSolver.attemptedFingerprint = fingerprint;
      const frame = getClickCaptchaFrame(target);
      if (frame.width !== CLICK_CAPTCHA_REFERENCE_WIDTH || frame.height !== CLICK_CAPTCHA_REFERENCE_HEIGHT) {
        throw new Error(`当前验证码尺寸 ${frame.width}x${frame.height} 与本地模型不兼容`);
      }
      const result = await solveClickCaptchaFrame(frame, CLICK_CAPTCHA_REQUIRED_TARGET_COUNT);
      if (!document.contains(target) || getClickCaptchaFingerprint(target) !== fingerprint) {
        throw new Error('验证码在识别过程中已刷新');
      }

      clickCaptchaSolver.target = target;
      clickCaptchaSolver.fingerprint = fingerprint;
      clickCaptchaSolver.result = result;
      const autoEligible = isClickCaptchaAutoEligible(result);
      if (canAutoClickNow() && autoEligible) {
        const loginContext = await prepareClickCaptchaLogin(target);
        if (!loginContext) {
          clickCaptchaSolver.status = `${clickCaptchaSolver.loginStatus}，已标出识别顺序供人工处理`;
          renderClickCaptchaSolverOverlay();
          notifyClickCaptchaSolverUpdate();
          break;
        }
        clickCaptchaSolver.status = '正在按识别顺序点击';
        renderClickCaptchaSolverOverlay();
        notifyClickCaptchaSolverUpdate();
        await dispatchClickCaptchaPoints(target, result, clickCaptchaSolver.autoClickToken);
        const submitted = await submitClickCaptchaLogin(target, fingerprint, loginContext, clickCaptchaSolver.autoClickToken);
        clickCaptchaSolver.status = submitted
          ? `已提交登录，等待页面验证（分差 ${result.margin.toFixed(2)}）`
          : `已发送点击，等待页面验证（分差 ${result.margin.toFixed(2)}；${clickCaptchaSolver.loginStatus}）`;
        break;
      }

      if (result.backgroundResidual > CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL) {
        clickCaptchaSolver.status = `页面背景与模型不匹配，已标点待人工确认（残差 ${result.backgroundResidual.toFixed(1)}）`;
        break;
      }

      if (autoEligible) {
        clickCaptchaSolver.status = `已标出识别顺序（分差 ${result.margin.toFixed(2)}）`;
        break;
      }

      if (canAutoClickNow()
        && clickCaptchaSolver.lowConfidenceRefreshes < CLICK_CAPTCHA_MAX_LOW_CONFIDENCE_REFRESH_ATTEMPTS) {
        clickCaptchaSolver.lowConfidenceRefreshes += 1;
        clickCaptchaSolver.status = `候选顺序接近，正在换图重试（${clickCaptchaSolver.lowConfidenceRefreshes}/${CLICK_CAPTCHA_MAX_LOW_CONFIDENCE_REFRESH_ATTEMPTS}，分差 ${result.margin.toFixed(2)}）`;
        clickCaptchaSolver.result = null;
        renderClickCaptchaSolverOverlay();
        notifyClickCaptchaSolverUpdate();
        target = await requestFreshClickCaptcha(target);
        continue;
      }

      clickCaptchaSolver.status = clickCaptchaSolver.lowConfidenceRefreshes > 0
        ? `连续换图后仍未达到自动点击门槛，已标点待人工确认（分差 ${result.margin.toFixed(2)}）`
        : `已生成候选顺序，但与次优方案接近，已标点待人工确认（分差 ${result.margin.toFixed(2)}）`;
      break;
    }
    renderClickCaptchaSolverOverlay();
  } catch (error) {
    if (error?.code === 'AUTO_CLICK_CANCELLED') {
      clickCaptchaSolver.status = '自动点击已取消，已保留标点供人工确认';
      renderClickCaptchaSolverOverlay();
    } else {
      clickCaptchaSolver.status = `识别未执行：${error.message}`;
      clearClickCaptchaSolverOverlay();
    }
  } finally {
    clickCaptchaSolver.running = false;
    notifyClickCaptchaSolverUpdate();
  }
  return getClickCaptchaSolverState();
}

async function pollClickCaptchaSolver() {
  if (!clickCaptchaSolver.enabled || clickCaptchaSolver.running || clickCaptchaCapture.enabled) return;
  const target = findClickCaptchaElement();
  if (!target || !isReadyClickCaptchaElement(target)) return;
  const fingerprint = getClickCaptchaFingerprint(target);
  if (target === clickCaptchaSolver.attemptedTarget && fingerprint === clickCaptchaSolver.attemptedFingerprint) return;
  await runClickCaptchaSolver({ allowAutoClick: true });
}

function startClickCaptchaSolverMonitor() {
  if (clickCaptchaSolver.monitor) return;
  clickCaptchaSolver.monitor = setInterval(() => {
    pollClickCaptchaSolver().catch(error => {
      clickCaptchaSolver.status = `识别监控异常：${error.message}`;
      notifyClickCaptchaSolverUpdate();
    });
  }, CLICK_CAPTCHA_SOLVER_POLL_MS);
  pollClickCaptchaSolver().catch(() => {});
}

async function setClickCaptchaSolverEnabled(enabled) {
  clickCaptchaSolver.enabled = enabled;
  if (enabled) {
    clickCaptchaSolver.target = null;
    clickCaptchaSolver.fingerprint = '';
    clickCaptchaSolver.attemptedTarget = null;
    clickCaptchaSolver.attemptedFingerprint = '';
    clickCaptchaSolver.submittedTarget = null;
    clickCaptchaSolver.submittedFingerprint = '';
    clickCaptchaSolver.lowConfidenceRefreshes = 0;
    clickCaptchaSolver.result = null;
    clickCaptchaSolver.loginStatus = '未检测登录表单';
    clickCaptchaSolver.status = '等待点击验证码';
    startClickCaptchaSolverMonitor();
  } else {
    clickCaptchaSolver.autoClickToken += 1;
    clickCaptchaSolver.status = '识别已暂停';
    clearClickCaptchaSolverOverlay();
  }
  await storageSet({ [CLICK_CAPTCHA_SOLVER_ENABLED_KEY]: enabled });
  notifyClickCaptchaSolverUpdate();
  return getClickCaptchaSolverState();
}

async function setClickCaptchaAutoClick(enabled) {
  if (!enabled) clickCaptchaSolver.autoClickToken += 1;
  clickCaptchaSolver.autoClick = enabled;
  await storageSet({ [CLICK_CAPTCHA_AUTO_CLICK_KEY]: enabled });
  clickCaptchaSolver.status = enabled
    ? '自动点击与自动登录已开启，低置信会换图重试'
    : '仅标出识别顺序，不会自动点击';
  notifyClickCaptchaSolverUpdate();
  return getClickCaptchaSolverState();
}

async function initializeClickCaptchaSolver() {
  try {
    const settings = await storageGet([CLICK_CAPTCHA_SOLVER_ENABLED_KEY, CLICK_CAPTCHA_AUTO_CLICK_KEY]);
    // 自动登录是发布版默认行为；只有用户显式关闭时才暂停。
    clickCaptchaSolver.enabled = settings[CLICK_CAPTCHA_SOLVER_ENABLED_KEY] !== false;
    clickCaptchaSolver.autoClick = settings[CLICK_CAPTCHA_AUTO_CLICK_KEY] !== false;
    clickCaptchaSolver.status = clickCaptchaSolver.enabled ? '等待点击验证码' : '未启用';
    if (clickCaptchaSolver.enabled) startClickCaptchaSolverMonitor();
    notifyClickCaptchaSolverUpdate();
  } catch {
    clickCaptchaSolver.status = '本地设置读取失败';
  }
}

async function getClickCaptchaSamples() {
  const data = await storageGet([CLICK_CAPTCHA_SAMPLE_COUNT_KEY]);
  const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
  if (count === 0) return [];
  const keys = Array.from({ length: count }, (_, i) =>
    CLICK_CAPTCHA_SAMPLE_KEY_PREFIX + String(i + 1).padStart(4, '0'));
  const result = await storageGet(keys);
  return keys.map(k => result[k]).filter(Boolean);
}

async function getClickCaptchaCaptureState() {
  const data = await storageGet([
    CLICK_CAPTCHA_SAMPLE_COUNT_KEY,
    CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY
  ]);
  const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
  clickCaptchaCapture.skippedThreeTargetCount = Number(data[CLICK_CAPTCHA_SKIPPED_THREE_COUNT_KEY] || 0);
  return {
    enabled: clickCaptchaCapture.enabled,
    refreshing: clickCaptchaCapture.refreshing,
    ready: Boolean(clickCaptchaCapture.target && document.contains(clickCaptchaCapture.target)),
    pendingClicks: clickCaptchaCapture.current?.clicks.length || 0,
    expectedClicks: clickCaptchaCapture.current?.expectedClicks || clickCaptchaCapture.expectedClicks,
    sampleCount: count,
    skippedThreeTargetCount: clickCaptchaCapture.skippedThreeTargetCount,
    maxSampleCount: CLICK_CAPTCHA_SAMPLE_MAX_COUNT,
    status: clickCaptchaCapture.status,
    target: clickCaptchaCapture.target ? describeCaptureElement(clickCaptchaCapture.target) : null
  };
}

function notifyClickCaptchaCaptureUpdate(action = 'clickCaptchaCaptureUpdate') {
  getClickCaptchaCaptureState()
    .then(state => chrome.runtime.sendMessage({ action, state }))
    .catch(() => {});
}

async function saveClickCaptchaSample() {
  const current = clickCaptchaCapture.current;
  if (!current || current.clicks.length !== current.expectedClicks) return;

  const data = await storageGet([CLICK_CAPTCHA_SAMPLE_COUNT_KEY]);
  const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
  if (count >= CLICK_CAPTCHA_SAMPLE_MAX_COUNT) {
    clickCaptchaCapture.status = `已达到 ${CLICK_CAPTCHA_SAMPLE_MAX_COUNT} 条上限，请先导出`;
    clickCaptchaCapture.current = null;
    clickCaptchaCapture.enabled = false;
    renderClickCaptchaOverlay();
    notifyClickCaptchaCaptureUpdate();
    return;
  }

  const id = String(count + 1).padStart(4, '0');
  const key = CLICK_CAPTCHA_SAMPLE_KEY_PREFIX + id;
  await storageSet({
    [CLICK_CAPTCHA_SAMPLE_COUNT_KEY]: count + 1,
    [key]: {
      id,
      createdAt: new Date().toISOString(),
      imageDataUrl: current.imageDataUrl,
      image: current.image,
      targetCount: current.expectedClicks,
      clicks: current.clicks
    }
  });
  clickCaptchaCapture.current = null;
  clickCaptchaCapture.enabled = false;
  clickCaptchaCapture.refreshing = true;
  clickCaptchaCapture.status = `样本 ${id} 已保存，正在刷新验证码`;
  renderClickCaptchaOverlay();
  notifyClickCaptchaCaptureUpdate('clickCaptchaSampleSaved');
  try {
    await refreshClickCaptchaAndResume(id);
  } catch (error) {
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.refreshing = false;
    clickCaptchaCapture.current = null;
    clickCaptchaCapture.status = `样本 ${id} 已保存，自动刷新失败：${error.message}`;
    renderClickCaptchaOverlay();
    notifyClickCaptchaCaptureUpdate('clickCaptchaSampleSaved');
  }
}

async function setClickCaptchaCaptureEnabled(enabled) {
  if (!enabled) {
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.current = null;
    clickCaptchaCapture.refreshing = false;
    clickCaptchaCapture.status = '采样已停止';
    renderClickCaptchaOverlay();
    return await getClickCaptchaCaptureState();
  }

  const target = findClickCaptchaElement();
  if (!target) {
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.target = null;
    clickCaptchaCapture.status = '未找到可采样的验证码图片';
    renderClickCaptchaOverlay();
    return await getClickCaptchaCaptureState();
  }

  clickCaptchaCapture.enabled = false;
  clickCaptchaCapture.target = target;
  clickCaptchaCapture.current = null;
  clickCaptchaCapture.refreshing = false;
  let prepared;
  try {
    prepared = await ensureFourTargetClickCaptcha(target);
  } catch (error) {
    clickCaptchaCapture.enabled = false;
    clickCaptchaCapture.refreshing = false;
    clickCaptchaCapture.status = `准备四字验证码失败：${error.message}`;
    renderClickCaptchaOverlay();
    return await getClickCaptchaCaptureState();
  }

  clickCaptchaCapture.enabled = true;
  clickCaptchaCapture.target = prepared.target;
  clickCaptchaCapture.refreshing = false;
  clickCaptchaCapture.expectedClicks = CLICK_CAPTCHA_REQUIRED_TARGET_COUNT;
  clickCaptchaCapture.status = prepared.refreshCount
    ? '已跳过三字验证码，请正常手动点击 4 个目标字'
    : '已锁定验证码，请正常手动点击 4 个目标字';
  renderClickCaptchaOverlay();
  return await getClickCaptchaCaptureState();
}

async function discardLastClickCaptchaSample() {
  const data = await storageGet([CLICK_CAPTCHA_SAMPLE_COUNT_KEY]);
  const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
  if (count === 0) return await getClickCaptchaCaptureState();
  const key = CLICK_CAPTCHA_SAMPLE_KEY_PREFIX + String(count).padStart(4, '0');
  await storageRemove([key]);
  await storageSet({ [CLICK_CAPTCHA_SAMPLE_COUNT_KEY]: count - 1 });
  clickCaptchaCapture.status = '已删除最近一条样本';
  return await getClickCaptchaCaptureState();
}

// 在页面自身的点击处理前记录图像，避免最后一次点击触发验证码刷新后丢失原图。
document.addEventListener('pointerdown', event => {
  if (!clickCaptchaCapture.enabled || clickCaptchaCapture.saving || event.button !== 0 || !event.isPrimary) return;
  let target = clickCaptchaCapture.target;
  if (!target || !document.contains(target) || !isVisibleCaptureElement(target)) {
    target = findClickCaptchaElement();
    clickCaptchaCapture.target = target;
  }
  if (!target) {
    clickCaptchaCapture.status = '验证码图片已变化，请重新开始采样';
    clickCaptchaCapture.enabled = false;
    renderClickCaptchaOverlay();
    notifyClickCaptchaCaptureUpdate();
    return;
  }

  const rect = target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
    return;
  }

  try {
    if (!clickCaptchaCapture.current) {
      const source = getClickCaptchaSource(target);
      if (source.targetCount !== CLICK_CAPTCHA_REQUIRED_TARGET_COUNT) {
        clickCaptchaCapture.enabled = false;
        clickCaptchaCapture.refreshing = true;
        clickCaptchaCapture.status = '检测到三字验证码，正在刷新为四字';
        renderClickCaptchaOverlay();
        notifyClickCaptchaCaptureUpdate();
        ensureFourTargetClickCaptcha(target)
          .then(prepared => {
            clickCaptchaCapture.target = prepared.target;
            clickCaptchaCapture.expectedClicks = CLICK_CAPTCHA_REQUIRED_TARGET_COUNT;
            clickCaptchaCapture.enabled = true;
            clickCaptchaCapture.refreshing = false;
            clickCaptchaCapture.status = '已跳过三字验证码，请正常手动点击 4 个目标字';
            renderClickCaptchaOverlay();
            notifyClickCaptchaCaptureUpdate();
          })
          .catch(error => {
            clickCaptchaCapture.enabled = false;
            clickCaptchaCapture.refreshing = false;
            clickCaptchaCapture.status = `准备四字验证码失败：${error.message}`;
            renderClickCaptchaOverlay();
            notifyClickCaptchaCaptureUpdate();
          });
        return;
      }
      clickCaptchaCapture.current = {
        imageDataUrl: source.dataUrl,
        expectedClicks: CLICK_CAPTCHA_REQUIRED_TARGET_COUNT,
        image: {
          width: source.width,
          height: source.height,
          displayedWidth: Math.round(rect.width),
          displayedHeight: Math.round(rect.height),
          sourcePath: source.sourcePath,
          element: source.element
        },
        clicks: []
      };
    }

    const image = clickCaptchaCapture.current.image;
    const relativeX = (event.clientX - rect.left) / rect.width;
    const relativeY = (event.clientY - rect.top) / rect.height;
    clickCaptchaCapture.current.clicks.push({
      order: clickCaptchaCapture.current.clicks.length + 1,
      x: Math.round(relativeX * image.width),
      y: Math.round(relativeY * image.height),
      relativeX: Number(relativeX.toFixed(6)),
      relativeY: Number(relativeY.toFixed(6))
    });
    clickCaptchaCapture.status = `已记录 ${clickCaptchaCapture.current.clicks.length}/${clickCaptchaCapture.current.expectedClicks} 次点击`;
    renderClickCaptchaOverlay();

    if (clickCaptchaCapture.current.clicks.length === clickCaptchaCapture.current.expectedClicks) {
      clickCaptchaCapture.saving = true;
      saveClickCaptchaSample()
        .catch(error => {
          clickCaptchaCapture.status = `保存失败：${error.message}`;
          notifyClickCaptchaCaptureUpdate();
        })
        .finally(() => {
          clickCaptchaCapture.saving = false;
        });
    } else {
      notifyClickCaptchaCaptureUpdate();
    }
  } catch (error) {
    clickCaptchaCapture.status = `采样失败：${error.message}`;
    clickCaptchaCapture.current = null;
    notifyClickCaptchaCaptureUpdate();
  }
}, true);

window.addEventListener('scroll', renderClickCaptchaOverlay, true);
window.addEventListener('resize', renderClickCaptchaOverlay);
window.addEventListener('scroll', renderClickCaptchaSolverOverlay, true);
window.addEventListener('resize', renderClickCaptchaSolverOverlay);

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
  } else if (msg.action === 'getClickCaptchaCaptureStatus') {
    getClickCaptchaCaptureState().then(state => sendResponse({ ok: true, state }));
    return true;
  } else if (msg.action === 'setClickCaptchaCaptureEnabled') {
    setClickCaptchaCaptureEnabled(Boolean(msg.enabled))
      .then(state => sendResponse({ ok: true, state }));
    return true;
  } else if (msg.action === 'discardLastClickCaptchaSample') {
    discardLastClickCaptchaSample().then(state => sendResponse({ ok: true, state }));
    return true;
  } else if (msg.action === 'getClickCaptchaSolverStatus') {
    sendResponse({ ok: true, state: getClickCaptchaSolverState() });
  } else if (msg.action === 'getClickCaptchaManualStatus') {
    sendResponse(getClickCaptchaManualStatus());
  } else if (msg.action === 'setClickCaptchaSolverEnabled') {
    setClickCaptchaSolverEnabled(Boolean(msg.enabled))
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: error.message, state: getClickCaptchaSolverState() }));
    return true;
  } else if (msg.action === 'setClickCaptchaAutoClick') {
    setClickCaptchaAutoClick(Boolean(msg.enabled))
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: error.message, state: getClickCaptchaSolverState() }));
    return true;
  } else if (msg.action === 'runClickCaptchaSolver') {
    // 手动“重新识别”只标出顺序，不触发点击或提交。
    runClickCaptchaSolver({ allowAutoClick: false, force: true })
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: error.message, state: getClickCaptchaSolverState() }));
    return true;
  } else if (msg.action === 'clearClickCaptchaSolverOverlay') {
    clearClickCaptchaSolverOverlay();
    sendResponse({ ok: true, state: getClickCaptchaSolverState() });
  }
  return true; // 保持消息通道以支持异步sendResponse
});

// 迁移：清除旧版单 key 数组格式的残留数据（v5.0 之前的格式）
storageRemove(['nju_click_captcha_samples_v1']).catch(() => {});
initializeClickCaptchaSolver();
