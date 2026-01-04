// content.js
console.log("NJU 验证码识别助手 v2.2 已启动...");

const IMG_SELECTOR = "#captchaImg"; 
const INPUT_SELECTOR = "#captchaResponse";   

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

async function solveCaptcha() {
    // --- 新增：检查插件是否启用 ---
    const settings = await chrome.storage.local.get(['nju_enabled', 'nju_user', 'nju_pass', 'nju_force']);
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
        // 尝试再次调度，直到所有元素都找到
        setTimeout(solveCaptcha, 1000); 
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
        const canvas = document.createElement('canvas');
        canvas.width = imgElement.naturalWidth;
        canvas.height = imgElement.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgElement, 0, 0);

        // --- 核心图像处理：去噪与二值化 ---
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            // 提取红绿蓝三色
            const r = data[i], g = data[i+1], b = data[i+2];
            // 灰度化处理
            const grayscale = 0.3 * r + 0.59 * g + 0.11 * b;
            
            // 关键阈值：南大验证码字符颜色较深，背景线较浅
            // 尝试将 120-150 之间的值。低于此值的变黑（字符），高于此值的变白（背景）
            const threshold = 130; 
            const v = grayscale < threshold ? 0 : 255;
            
            data[i] = data[i+1] = data[i+2] = v;
        }
        ctx.putImageData(imageData, 0, 0);
        // ------------------------------------

        // 识别处理后的图片
        const result = await Tesseract.recognize(
            canvas, 
            'eng',
            {
                // 强制包含数字，提高 5 的识别率
                tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                logger: m => console.log("识别状态:", m.status)
            }
        );

        let code = result.data.text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        console.log("处理后识别结果:", code);

        if (code) {
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
            setTimeout(() => {
                const loginBtn = document.querySelector("#save") || document.querySelector(".auth_login_btn");
                if (loginBtn) {
                    loginBtn.click();
                } else {
                    console.warn("NJU 助手：未找到登录按钮，请手动点击。");
                }
            }, 600);
        }
    } catch (err) {
        console.error("识别出错:", err);
    }
}

// 稍微增加延迟，等待南大脚本把验证码图片刷出来
setTimeout(solveCaptcha, 2500);

// 点击图片刷新后自动重试
document.querySelector(IMG_SELECTOR)?.addEventListener('load', () => {
    console.log("验证码图片已更新，准备识别...");
    setTimeout(solveCaptcha, 1000);
});