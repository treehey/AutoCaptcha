// content.js
console.log("NJU 验证码识别助手 v3.1.1 已启动...");

const IMG_SELECTOR = "#captchaImg";
const INPUT_SELECTOR = "#captcha";

function createLoadingAnimation() {
    let animationDiv = document.getElementById('nju-loading-animation');
    if (animationDiv) return animationDiv; // 如果已存在则直接返回

    animationDiv = document.createElement('div');
    animationDiv.id = 'nju-loading-animation';
    animationDiv.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 15px 25px;
        border-radius: 10px;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 14px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.3);
    `;

    const spinner = document.createElement('div');
    spinner.style.cssText = `
        border: 4px solid rgba(255, 255, 255, 0.3);
        border-top: 4px solid white;
        border-radius: 50%;
        width: 20px;
        height: 20px;
        animation: spin 1s linear infinite;
    `;

    const text = document.createElement('span');
    text.textContent = '正在识别验证码...';

    animationDiv.appendChild(spinner);
    animationDiv.appendChild(text);
    document.body.appendChild(animationDiv);

    // 添加 CSS 关键帧动画 (直接注入到页面，无需修改 manifest)
    const style = document.createElement('style');
    style.innerHTML = `
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);

    return animationDiv;
}

function showLoadingAnimation() {
    const animation = createLoadingAnimation();
    animation.style.display = 'flex'; // 显示
}

function hideLoadingAnimation() {
    const animation = document.getElementById('nju-loading-animation');
    if (animation) {
        animation.style.display = 'none'; // 隐藏
    }
}

let isSolving = false; // 互斥锁，防止并发重复执行
let retryTimer = null; // 统一管理重试定时器，防止多个定时器堆积

async function solveCaptcha() {
    if (isSolving) {
        console.log("NJU 助手：识别正在进行中，跳过重复调用。");
        return;
    }
    // 清除所有待执行的重试定时器，保证只有一个调用链
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    isSolving = true;

    try {
        await _solveCaptchaImpl();
    } finally {
        isSolving = false;
    }
}

function scheduleRetry(ms) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(solveCaptcha, ms);
}

async function _solveCaptchaImpl() {
    // --- 新增：检查插件是否启用 ---
    const settings = await chrome.storage.local.get(['nju_enabled', 'nju_user', 'nju_pass', 'nju_force', 'nju_auto_click']);
    if (settings.nju_enabled === false) {
        console.log("NJU 助手：当前处于关闭状态。");
        return;
    }
    // ----------------------------

    const imgElement = document.querySelector(IMG_SELECTOR);
    const inputElement = document.querySelector(INPUT_SELECTOR);
    const userInput = document.querySelector("#username");
    const passInput = document.querySelector("#password")
    if (!imgElement || !inputElement || !userInput || !passInput) {
        console.log("NJU 助手：未找到所有登录元素，或页面未加载完成。");
        scheduleRetry(1000);
        return;
    }

    // 图片尚未加载完（naturalWidth 为 0），等待后重试
    if (imgElement.naturalWidth === 0) {
        console.log("NJU 助手：验证码图片尚未加载完，等待中...");
        scheduleRetry(800);
        return;
    }

    // 检查验证码是否已经填入，避免重复识别
    if (inputElement.value.length >= 4) {
        console.log("NJU 助手：验证码已填入，跳过识别。");
        return;
    }

    // --- 在识别开始时显示动画 ---
    showLoadingAnimation();
    // ----------------------------

    try {
        const imgElement = document.querySelector(IMG_SELECTOR);

        // --- 优化1: 放大图片 (Upscaling) ---
        // 放大 4 倍，使用平滑插值保留笔画细节（尤其弧线）
        const scale = 4;
        const canvas = document.createElement('canvas');
        canvas.width = imgElement.naturalWidth * scale;
        canvas.height = imgElement.naturalHeight * scale;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);

        const width = canvas.width;
        const height = canvas.height;

        // --- 优化2: 颜色感知的二值化 ---
        // 验证码文字通常是带颜色的（如绿/蓝/红），干扰线通常更浅或低饱和度
        // 利用饱和度+亮度综合判断，比纯灰度阈值更精确
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];

            // 亮度
            const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

            // 饱和度 (HSV 模型)：有颜色的文字饱和度较高
            const maxC = Math.max(r, g, b);
            const minC = Math.min(r, g, b);
            const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;

            // 文字判定：
            //   1. 有明显颜色(饱和度>0.15) 且 亮度不太高(<170)  → 彩色文字
            //   2. 亮度很低(<80) → 深色/黑色文字
            const isText = (saturation > 0.15 && luminance < 170) || luminance < 80;

            const v = isText ? 0 : 255;
            data[i] = data[i + 1] = data[i + 2] = v;
        }

        // --- 优化3: 形态学闭运算 (先膨胀再腐蚀) ---
        // 目的：修复因二值化造成的笔画断裂（例如 U 的弧线变断）

        // 3a. 膨胀：将黑色像素向 8 邻域扩展 1 像素
        const afterDilate = new Uint8ClampedArray(data);
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = (y * width + x) * 4;
                if (data[idx] === 0) { // 原来是黑
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const ni = ((y + dy) * width + (x + dx)) * 4;
                            afterDilate[ni] = afterDilate[ni + 1] = afterDilate[ni + 2] = 0;
                        }
                    }
                }
            }
        }

        // 3b. 腐蚀：只保留 8 邻域全黑的像素，恢复原始粗细
        const afterErode = new Uint8ClampedArray(afterDilate);
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = (y * width + x) * 4;
                if (afterDilate[idx] === 0) {
                    let allBlack = true;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            if (afterDilate[((y + dy) * width + (x + dx)) * 4] !== 0) {
                                allBlack = false;
                                break;
                            }
                        }
                        if (!allBlack) break;
                    }
                    if (!allBlack) {
                        afterErode[idx] = afterErode[idx + 1] = afterErode[idx + 2] = 255;
                    }
                }
            }
        }

        // 写回
        for (let i = 0; i < data.length; i++) data[i] = afterErode[i];

        // --- 优化4: 噪点清理 (8 邻域，仅删除极度孤立的点) ---
        const cleanRef = new Uint8ClampedArray(data);
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = (y * width + x) * 4;
                if (cleanRef[idx] === 0) { // 如果是黑点
                    let blackNeighbors = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            if (dy === 0 && dx === 0) continue;
                            if (cleanRef[((y + dy) * width + (x + dx)) * 4] === 0) {
                                blackNeighbors++;
                            }
                        }
                    }
                    // 8 邻域中黑色邻居 ≤ 1 才视为噪点（比原来宽容很多）
                    if (blackNeighbors <= 1) {
                        data[idx] = data[idx + 1] = data[idx + 2] = 255;
                    }
                }
            }
        }

        ctx.putImageData(imageData, 0, 0);

        // ============= v5 核心修改开始 =============

        // 在 v5 中，createWorker 直接接收语言和参数，不需要 loadLanguage/initialize
        const worker = await Tesseract.createWorker('eng', 1, {
            workerPath: chrome.runtime.getURL('langs/worker.min.js'),
            corePath: chrome.runtime.getURL('langs/tesseract-core.wasm.js'),
            langPath: chrome.runtime.getURL('langs/'), // 这里只需指向文件夹目录，不要带文件名
            gzip: false,
            errorHandler: m => console.error(m),
            logger: m => { } // 空函数，屏蔽进度日志防止跨域报错
        });

        // 设置白名单和识别模式
        await worker.setParameters({
            tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
            // PSM 7 = Treat the image as a single text line. (视为单行文本)
            // 这对于验证码至关重要，否则 Tesseract 可能会把稀疏的字符当成两行或者图形忽略掉
            tessedit_pageseg_mode: '7',
        });

        // 识别
        const { data: { text } } = await worker.recognize(canvas);

        // 销毁
        await worker.terminate();

        // ============= v5 核心修改结束 =============

        // 6. 处理结果
        let code = text.replace(/[^a-zA-Z0-9]/g, '').substring(0, 4);

        if (code && code.length === 4) {
            // 1. 填入验证码
            inputElement.value = code;
            inputElement.dispatchEvent(new Event('input', { bubbles: true }));

            // 2. 智能填充账号密码
            // 判断逻辑：(如果开启了强制填充) 或者 (账号和密码框目前都是空的)
            const shouldFill = settings.nju_force || (!userInput.value && !passInput.value);

            if (shouldFill && settings.nju_user && settings.nju_pass) {
                console.log("NJU助手：执行账号密码填充");
                userInput.value = settings.nju_user;
                passInput.value = settings.nju_pass;
                userInput.dispatchEvent(new Event('input', { bubbles: true }));
                passInput.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                console.log("NJU助手：检测到浏览器已自动填充或未开启强制填充，跳过账号填入");
            }

            // --- 在识别结束后隐藏动画 ---
            hideLoadingAnimation();
            // ---------------------------

            // 3. 自动登录
            if (settings.nju_auto_click !== false) {
                console.log("NJU助手：自动登录开关已开启，准备点击登录...");
                setTimeout(() => {
                    const loginBtn = document.querySelector("#login_submit") || document.querySelector(".auth_login_btn");
                    if (loginBtn) {
                        loginBtn.click();
                    } else {
                        console.warn("NJU 助手：未找到登录按钮，请手动点击。");
                    }
                }, 600);
            } else {
                console.log("NJU助手：自动登录开关关闭，请手动检查后点击。");
            }
        } else {
            console.log("识别结果不完整，重试中...");
            hideLoadingAnimation();
            imgElement.click(); // 触发图片刷新，load 事件会调度下一次识别
            // 保底：如果 load 事件未触发（图片URL不变等情况），2秒后直接重试
            scheduleRetry(2000);
        }
    } catch (err) {
        console.error("识别出错:", err);
        hideLoadingAnimation();
        scheduleRetry(2000); // 出错后也保底重试
    }
}

// 稍微增加延迟，等待南大脚本把验证码图片刷出来
scheduleRetry(2500);

// 使用捕获阶段事件委托监听验证码图片刷新
// load 事件不冒泡，必须用 capture:true；同时避免元素未就绪时 ?. 静默失败
document.addEventListener('load', (e) => {
    if (e.target && e.target.matches && e.target.matches(IMG_SELECTOR)) {
        console.log("验证码图片已更新，准备识别...");
        scheduleRetry(500); // 用 scheduleRetry 取代旧定时器，防止与保底重试叠加
    }
}, true);