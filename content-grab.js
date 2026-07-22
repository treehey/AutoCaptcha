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

const clickCaptchaCapture = {
  enabled: false,
  target: null,
  current: null,
  saving: false,
  refreshing: false,
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

async function refreshClickCaptchaAndResume(sampleId) {
  const previousTarget = clickCaptchaCapture.target;
  const previousFingerprint = getClickCaptchaFingerprint(previousTarget);

  // Some pages refresh automatically after the final valid click. Prefer that result and avoid an unnecessary extra request.
  const pageRefreshedTarget = await waitForRefreshedClickCaptcha(previousTarget, previousFingerprint, CLICK_CAPTCHA_REFRESH_SETTLE_MS);
  if (pageRefreshedTarget) {
    clickCaptchaCapture.target = pageRefreshedTarget;
    clickCaptchaCapture.expectedClicks = inferClickCaptchaTargetCount(pageRefreshedTarget);
    clickCaptchaCapture.enabled = true;
    clickCaptchaCapture.refreshing = false;
    clickCaptchaCapture.status = `样本 ${sampleId} 已保存，已检测到新验证码并继续采样`;
    renderClickCaptchaOverlay();
    notifyClickCaptchaCaptureUpdate('clickCaptchaSampleSaved');
    return;
  }

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

  clickCaptchaCapture.target = refreshedTarget;
  clickCaptchaCapture.expectedClicks = inferClickCaptchaTargetCount(refreshedTarget);
  clickCaptchaCapture.enabled = true;
  clickCaptchaCapture.refreshing = false;
  clickCaptchaCapture.status = `样本 ${sampleId} 已保存，新验证码已就绪，继续采样`;
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
    const source = getClickCaptchaSource(element);
    return source.targetCount;
  } catch {
    return CLICK_CAPTCHA_MAX_TARGET_COUNT;
  }
}

function getClickCaptchaSource(element) {
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
  const sourceUrl = element instanceof HTMLImageElement ? (element.currentSrc || element.src || '') : '';
  return {
    dataUrl: sourceCanvas.toDataURL('image/png'),
    width,
    height,
    targetCount: inferClickCaptchaTargetCountFromCanvas(sourceCanvas),
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
  const data = await storageGet([CLICK_CAPTCHA_SAMPLE_COUNT_KEY]);
  const count = Number(data[CLICK_CAPTCHA_SAMPLE_COUNT_KEY] || 0);
  return {
    enabled: clickCaptchaCapture.enabled,
    refreshing: clickCaptchaCapture.refreshing,
    ready: Boolean(clickCaptchaCapture.target && document.contains(clickCaptchaCapture.target)),
    pendingClicks: clickCaptchaCapture.current?.clicks.length || 0,
    expectedClicks: clickCaptchaCapture.current?.expectedClicks || clickCaptchaCapture.expectedClicks,
    sampleCount: count,
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

  clickCaptchaCapture.enabled = true;
  clickCaptchaCapture.target = target;
  clickCaptchaCapture.current = null;
  clickCaptchaCapture.refreshing = false;
  clickCaptchaCapture.expectedClicks = inferClickCaptchaTargetCount(target);
  clickCaptchaCapture.status = `已锁定验证码，请正常手动点击 ${clickCaptchaCapture.expectedClicks} 个目标字`;
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
      clickCaptchaCapture.current = {
        imageDataUrl: source.dataUrl,
        expectedClicks: source.targetCount,
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
  }
  return true; // 保持消息通道以支持异步sendResponse
});

// 迁移：清除旧版单 key 数组格式的残留数据（v5.0 之前的格式）
storageRemove(['nju_click_captcha_samples_v1']).catch(() => {});
