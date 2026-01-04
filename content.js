// content.js
console.log("NJU 验证码识别助手 v2.0 已启动...");

const IMG_SELECTOR = "#captchaImg"; 
const INPUT_SELECTOR = "#captchaResponse";   

async function solveCaptcha() {
    const imgElement = document.querySelector(IMG_SELECTOR);
    const inputElement = document.querySelector(INPUT_SELECTOR);
    if (!imgElement || !inputElement) return;

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
            // 1. 格式化并填入
            const finalCode = code.length > 4 ? code.substring(0, 4) : code;
            inputElement.value = finalCode;
            
            // 2. 模拟人工输入触发验证事件
            ['input', 'change', 'blur'].forEach(ev => {
                inputElement.dispatchEvent(new Event(ev, { bubbles: true }));
            });
            
            console.log("已填入验证码:", finalCode);

            // 3. 延迟一小会儿后自动点击登录 (给网页脚本留一点响应时间)
            setTimeout(() => {
                // 南大登录按钮的 ID 通常是 #save，也可能是 .auth_login_btn
                const loginBtn = document.querySelector(".auth_login_btn") ||
                                 document.querySelector("button[type='submit']");
                
                if (loginBtn) {
                    console.log("检测到登录按钮，正在自动登录...");
                    loginBtn.click();
                } else {
                    console.warn("未找到登录按钮，请手动点击。");
                }
            }, 1000); // 延迟 1000 毫秒点击，稳定性更高
        }
    } catch (err) {
        console.error("识别过程出错:", err);
    }
}

// 稍微增加延迟，等待南大脚本把验证码图片刷出来
setTimeout(solveCaptcha, 2500);

// 点击图片刷新后自动重试
document.querySelector(IMG_SELECTOR)?.addEventListener('load', () => {
    console.log("验证码图片已更新，准备识别...");
    setTimeout(solveCaptcha, 1000);
});