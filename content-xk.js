// content-xk.js - 南京大学选课系统 (xk.nju.edu.cn) 完全自动登录脚本 v3.0
// 完全自动化：自动填充账号密码 + 自动识别并点击验证码
console.log("=== 南京大学选课系统 - 完全自动登录 v3.0 已启动 ===");

// ============ 配置常量 ============
const CONFIG = {
    captchaImg: "#vcodeImg",
    loginNameInput: "#loginName",
    loginPwdInput: "#loginPwd",
    loginBtn: "#studentLoginBtn",
    loginDiv: "#loginDiv",
    refreshBtn: ".verify-refresh",
    errorMsg: "#errorMsg",
    // 验证码相关配置
    captchaClickCount: 4,  // 需要点击4次
    clickDelay: 200,       // 每次点击间隔(ms)
    ocrRetries: 3,         // OCR重试次数
};

// ============ UI 动画函数 ============
function createLoadingAnimation() {
    let animDiv = document.getElementById('xk-loader');
    if (animDiv) return animDiv;

    animDiv = document.createElement('div');
    animDiv.id = 'xk-loader';
    animDiv.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 25px 35px;
        border-radius: 12px;
        z-index: 100000;
        display: none;
        flex-direction: column;
        align-items: center;
        gap: 15px;
        font-size: 14px;
        font-family: Arial, sans-serif;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        min-width: 200px;
    `;

    const spinner = document.createElement('div');
    spinner.style.cssText = `
        width: 28px;
        height: 28px;
        border: 4px solid rgba(255,255,255,0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: xk-spin 1s linear infinite;
    `;

    const text = document.createElement('span');
    text.id = 'xk-loader-text';
    text.textContent = '正在处理...';
    text.style.fontWeight = '500';
    text.style.textAlign = 'center';

    animDiv.appendChild(spinner);
    animDiv.appendChild(text);
    document.body.appendChild(animDiv);

    if (!document.getElementById('xk-loader-style')) {
        const style = document.createElement('style');
        style.id = 'xk-loader-style';
        style.textContent = '@keyframes xk-spin { to { transform: rotate(360deg); } }';
        document.head.appendChild(style);
    }

    return animDiv;
}

function showLoader(text = '正在处理...') {
    const loader = createLoadingAnimation();
    document.getElementById('xk-loader-text').textContent = text;
    loader.style.display = 'flex';
}

function hideLoader() {
    const loader = document.getElementById('xk-loader');
    if (loader) loader.style.display = 'none';
}

function showMessage(text, type = 'info') {
    const colors = {
        info: '#2196F3',
        success: '#4CAF50',
        error: '#F44336',
        warning: '#FF9800'
    };
    
    let msgDiv = document.getElementById('xk-message');
    if (!msgDiv) {
        msgDiv = document.createElement('div');
        msgDiv.id = 'xk-message';
        msgDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 8px;
            z-index: 100001;
            font-size: 14px;
            font-family: Arial, sans-serif;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
            transition: opacity 0.3s;
        `;
        document.body.appendChild(msgDiv);
    }
    
    msgDiv.style.background = colors[type];
    msgDiv.style.color = 'white';
    msgDiv.textContent = text;
    msgDiv.style.opacity = '1';
    
    setTimeout(() => {
        msgDiv.style.opacity = '0';
    }, 3000);
}

// ============ 工具函数 ============
function waitFor(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);

        const observer = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el) {
                observer.disconnect();
                resolve(el);
            }
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Timeout waiting for ${selector}`));
        }, timeout);
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============ 图像预处理 ============
function preprocessImage(imgElement, scale = 2, region = null) {
    const canvas = document.createElement('canvas');
    const srcW = imgElement.naturalWidth;
    const srcH = imgElement.naturalHeight;
    
    // region: {x, y, w, h} 可选裁剪区域（原始坐标）
    if (region) {
        canvas.width = region.w * scale;
        canvas.height = region.h * scale;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(imgElement, 
            region.x, region.y, region.w, region.h,
            0, 0, canvas.width, canvas.height);
        return canvas;
    }
    
    canvas.width = srcW * scale;
    canvas.height = srcH * scale;
    
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);
    
    return canvas;
}

// ============ 裁剪底部提示区域 ============
function cropHintRegion(imgElement) {
    // 验证码底部约25%是提示文字区域（深色背景白字）
    const h = imgElement.naturalHeight;
    const w = imgElement.naturalWidth;
    const hintHeight = Math.floor(h * 0.28);
    
    return {
        x: 0,
        y: h - hintHeight,
        w: w,
        h: hintHeight
    };
}

// ============ 从提示区域提取颜色顺序 ============
function extractHintColors(imgElement) {
    const canvas = document.createElement('canvas');
    const w = imgElement.naturalWidth;
    const h = imgElement.naturalHeight;
    
    // 提示区域：底部28%
    const hintY = Math.floor(h * 0.72);
    const hintHeight = h - hintY;
    
    canvas.width = w;
    canvas.height = hintHeight;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgElement, 0, hintY, w, hintHeight, 0, 0, w, hintHeight);
    
    const imageData = ctx.getImageData(0, 0, w, hintHeight);
    const data = imageData.data;
    
    // 收集彩色像素（提示区域的字符是彩色的）
    const colorPixels = [];
    
    for (let y = 0; y < hintHeight; y++) {
        for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            
            // 彩色像素（排除灰色、白色、黑色背景）
            if (isColoredPixel(r, g, b)) {
                colorPixels.push({ x, y, r, g, b });
            }
        }
    }
    
    console.log(`提示区域彩色像素: ${colorPixels.length} 个`);
    
    if (colorPixels.length < 20) {
        console.log("提示区域未找到足够彩色像素");
        return null;
    }
    
    // 按X坐标分组（每个字符是一个组）
    colorPixels.sort((a, b) => a.x - b.x);
    
    // 聚类：按X坐标间隔分组
    const groups = [];
    let currentGroup = [colorPixels[0]];
    
    for (let i = 1; i < colorPixels.length; i++) {
        const pixel = colorPixels[i];
        const lastPixel = currentGroup[currentGroup.length - 1];
        
        // 如果X坐标差距大于15，认为是新字符
        if (pixel.x - lastPixel.x > 15) {
            if (currentGroup.length >= 5) {  // 至少5个像素才算有效字符
                groups.push(currentGroup);
            }
            currentGroup = [pixel];
        } else {
            currentGroup.push(pixel);
        }
    }
    if (currentGroup.length >= 5) {
        groups.push(currentGroup);
    }
    
    console.log(`提示区域找到 ${groups.length} 个彩色字符组`);
    
    // 提取每个组的代表颜色
    const hintColors = groups.map(group => {
        // 计算该组的平均颜色
        let sumR = 0, sumG = 0, sumB = 0;
        for (const p of group) {
            sumR += p.r;
            sumG += p.g;
            sumB += p.b;
        }
        const n = group.length;
        const avgX = group.reduce((s, p) => s + p.x, 0) / n;
        return {
            r: Math.round(sumR / n),
            g: Math.round(sumG / n),
            b: Math.round(sumB / n),
            x: avgX,
            pixelCount: n
        };
    });
    
    // 按X坐标排序（从左到右）
    hintColors.sort((a, b) => a.x - b.x);
    
    console.log("提示区域颜色顺序:", hintColors.map(c => `rgb(${c.r},${c.g},${c.b})`).join(' -> '));
    
    return hintColors;
}

// ============ 基于颜色匹配的验证码解决方案 ============
async function solveByColorMatching(imgElement) {
    console.log("\n>>> 开始颜色匹配识别 <<<");
    
    // 1. 提取提示区域的颜色顺序
    const hintColors = extractHintColors(imgElement);
    if (!hintColors || hintColors.length < 4) {
        console.log("✗ 无法提取提示区域颜色");
        return null;
    }
    
    // 取前4个颜色
    const targetColors = hintColors.slice(0, 4);
    console.log(`目标颜色数: ${targetColors.length}`);
    
    // 2. 分割主图区域的颜色区域
    const regions = segmentColorRegions(imgElement);
    console.log(`主图区域数: ${regions.length}`);
    
    if (regions.length < 4) {
        console.log("✗ 主图区域不足");
        return null;
    }
    
    // 3. 按颜色匹配：为每个目标颜色找到最匹配的区域
    const positions = [];
    const usedRegions = new Set();
    
    for (let i = 0; i < targetColors.length; i++) {
        const targetColor = targetColors[i];
        let bestMatch = null;
        let bestDistance = Infinity;
        
        for (let j = 0; j < regions.length; j++) {
            if (usedRegions.has(j)) continue;
            
            const region = regions[j];
            const dist = colorDistance(targetColor, region.color);
            
            if (dist < bestDistance) {
                bestDistance = dist;
                bestMatch = { region, index: j };
            }
        }
        
        if (bestMatch && bestDistance < 80) {  // 颜色距离阈值
            usedRegions.add(bestMatch.index);
            positions.push({
                left: bestMatch.region.centerX,
                top: bestMatch.region.centerY,
                colorDist: bestDistance.toFixed(0)
            });
            console.log(`颜色${i+1} rgb(${targetColor.r},${targetColor.g},${targetColor.b}) -> 区域(${bestMatch.region.centerX},${bestMatch.region.centerY}) 距离:${bestDistance.toFixed(0)}`);
        } else {
            console.log(`✗ 颜色${i+1} 未找到匹配区域`);
        }
    }
    
    console.log(`\n颜色匹配结果: ${positions.length}/4`);
    return positions.length === 4 ? positions : null;
}


// ============ 颜色分割：找到验证码区域的彩色字符 ============
function segmentColorRegions(imgElement) {
    const canvas = document.createElement('canvas');
    const w = imgElement.naturalWidth;
    const h = imgElement.naturalHeight;
    
    // 只处理上方72%区域（排除提示区域）
    const captchaHeight = Math.floor(h * 0.72);
    canvas.width = w;
    canvas.height = captchaHeight;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgElement, 0, 0, w, captchaHeight, 0, 0, w, captchaHeight);
    
    const imageData = ctx.getImageData(0, 0, w, captchaHeight);
    const data = imageData.data;
    
    // 收集彩色像素（排除灰色、白色、接近白色的背景）
    const colorPixels = [];
    
    for (let y = 0; y < captchaHeight; y++) {
        for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            
            // 判断是否为彩色像素
            if (isColoredPixel(r, g, b)) {
                colorPixels.push({ x, y, r, g, b });
            }
        }
    }
    
    console.log(`找到彩色像素: ${colorPixels.length} 个`);
    
    if (colorPixels.length < 50) {
        console.log("彩色像素太少，无法分割");
        return [];
    }
    
    // 使用简单的颜色聚类：按颜色相似度分组
    const regions = clusterByColor(colorPixels);
    console.log(`颜色聚类结果: ${regions.length} 个区域`);
    
    // 计算每个区域的中心点和边界框
    return regions.map(region => {
        const minX = Math.min(...region.pixels.map(p => p.x));
        const maxX = Math.max(...region.pixels.map(p => p.x));
        const minY = Math.min(...region.pixels.map(p => p.y));
        const maxY = Math.max(...region.pixels.map(p => p.y));
        
        const centerX = Math.round((minX + maxX) / 2);
        const centerY = Math.round((minY + maxY) / 2);
        
        return {
            color: region.color,
            centerX,
            centerY,
            bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
            pixelCount: region.pixels.length
        };
    }).filter(r => r.pixelCount > 20); // 过滤太小的区域
}

// 判断是否为彩色像素（非灰色、非白色、非黑色）
function isColoredPixel(r, g, b) {
    // 排除太暗的像素（黑色/深色背景）
    if (r < 50 && g < 50 && b < 50) return false;
    
    // 排除太亮的像素（白色/浅色背景）
    if (r > 220 && g > 220 && b > 220) return false;
    
    // 排除灰色像素（R≈G≈B）
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max > 0 ? (max - min) / max : 0;
    
    // 饱和度大于0.2才算彩色
    return saturation > 0.2;
}

// 按颜色+空间距离聚类
function clusterByColor(pixels, colorThreshold = 50) {
    const clusters = [];
    
    for (const pixel of pixels) {
        let foundCluster = false;
        
        for (const cluster of clusters) {
            // 计算与簇中心颜色的距离
            const dist = colorDistance(pixel, cluster.color);
            // 同时检查空间距离（同色字符可能相距较远）
            const spatialDist = Math.sqrt(
                Math.pow(pixel.x - cluster.centerX, 2) + 
                Math.pow(pixel.y - cluster.centerY, 2)
            );
            
            // 颜色相近且空间距离不太远才合并
            if (dist < colorThreshold && spatialDist < 40) {
                cluster.pixels.push(pixel);
                // 更新簇中心位置和颜色
                const n = cluster.pixels.length;
                cluster.color.r = Math.round((cluster.color.r * (n-1) + pixel.r) / n);
                cluster.color.g = Math.round((cluster.color.g * (n-1) + pixel.g) / n);
                cluster.color.b = Math.round((cluster.color.b * (n-1) + pixel.b) / n);
                cluster.centerX = Math.round((cluster.centerX * (n-1) + pixel.x) / n);
                cluster.centerY = Math.round((cluster.centerY * (n-1) + pixel.y) / n);
                foundCluster = true;
                break;
            }
        }
        
        if (!foundCluster) {
            clusters.push({
                color: { r: pixel.r, g: pixel.g, b: pixel.b },
                pixels: [pixel],
                centerX: pixel.x,
                centerY: pixel.y
            });
        }
    }
    
    // 合并太小的相邻簇到最近的大簇
    const validClusters = clusters.filter(c => c.pixels.length >= 15);
    
    // 按像素数量排序，取前8个最大的簇（可能有4个以上字符）
    validClusters.sort((a, b) => b.pixels.length - a.pixels.length);
    return validClusters.slice(0, 8);
}

// 计算颜色距离（RGB欧氏距离）
function colorDistance(c1, c2) {
    const dr = c1.r - c2.r;
    const dg = c1.g - c2.g;
    const db = c1.b - c2.b;
    return Math.sqrt(dr*dr + dg*dg + db*db);
}

// ============ 图像预处理增强 ============
function preprocessCanvas(ctx, width, height, mode = 'normal') {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    
    if (mode === 'highContrast') {
        // 高对比度 + 二值化
        for (let i = 0; i < data.length; i += 4) {
            const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
            const val = gray > 180 ? 255 : 0;  // 二值化阈值
            data[i] = data[i+1] = data[i+2] = val;
        }
    } else if (mode === 'inverted') {
        // 反色（某些字符反色后更容易识别）
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 255 - data[i];
            data[i+1] = 255 - data[i+1];
            data[i+2] = 255 - data[i+2];
        }
    } else if (mode === 'grayscale') {
        // 灰度增强
        for (let i = 0; i < data.length; i += 4) {
            const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
            // 增强对比度
            const enhanced = Math.min(255, Math.max(0, (gray - 128) * 1.5 + 128));
            data[i] = data[i+1] = data[i+2] = enhanced;
        }
    }
    
    ctx.putImageData(imageData, 0, 0);
}

// ============ 多角度OCR识别单个区域 ============
async function multiAngleOCR(imgElement, region, targetChars, sharedWorker = null) {
    // 角度列表
    const angles = [];
    for (let a = 0; a <= 180; a += 30) {
        angles.push(a);
        if (a !== 0 && a !== 180) angles.push(-a);
    }
    
    const preprocessModes = ['normal', 'highContrast'];
    
    // 先从原图提取该区域，只保留彩色像素（字符），背景设为白色
    const extractCanvas = document.createElement('canvas');
    const scale = 3;
    const bbox = region.bbox;
    extractCanvas.width = bbox.w * scale;
    extractCanvas.height = bbox.h * scale;
    const extractCtx = extractCanvas.getContext('2d', { willReadFrequently: true });
    
    // 先绘制原图区域
    extractCtx.drawImage(imgElement, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, bbox.w * scale, bbox.h * scale);
    
    // 获取像素数据，只保留彩色像素
    const imgData = extractCtx.getImageData(0, 0, extractCanvas.width, extractCanvas.height);
    const data = imgData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        // 如果不是彩色像素，设为白色
        if (!isColoredPixel(r, g, b)) {
            data[i] = data[i+1] = data[i+2] = 255;
        }
    }
    extractCtx.putImageData(imgData, 0, 0);
    
    // 用于旋转的canvas
    const padding = 15;
    const size = (Math.max(bbox.w, bbox.h) + padding * 2) * scale;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    let worker = sharedWorker;
    let shouldTerminate = false;
    
    if (!worker) {
        try {
            worker = await Tesseract.createWorker('chi_sim', 1, {
                workerPath: chrome.runtime.getURL('langs/worker.min.js'),
                corePath: chrome.runtime.getURL('langs/tesseract-core.wasm.js'),
                langPath: chrome.runtime.getURL('langs/'),
                gzip: false
            });
            await worker.setParameters({
                tessedit_pageseg_mode: '10',
            });
            shouldTerminate = true;
        } catch (e) {
            console.warn("创建OCR worker失败:", e);
            return null;
        }
    }
    
    let bestResult = null;
    let bestConfidence = 0;
    let allRecognized = new Set();
    
    // 对每个角度尝试不同的预处理
    outerLoop:
    for (const angle of angles) {
        for (const mode of preprocessModes) {
            // 白色背景
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, size, size);
            
            // 旋转并绘制已提取的字符图像（无背景干扰）
            ctx.save();
            ctx.translate(size/2, size/2);
            ctx.rotate(angle * Math.PI / 180);
            ctx.drawImage(
                extractCanvas,
                0, 0, extractCanvas.width, extractCanvas.height,
                -extractCanvas.width / 2, -extractCanvas.height / 2, 
                extractCanvas.width, extractCanvas.height
            );
            ctx.restore();

            
            // 应用预处理
            if (mode !== 'normal') {
                preprocessCanvas(ctx, size, size, mode);
            }
            
            try {
                const result = await worker.recognize(canvas);
                const text = result.data.text.trim();
                const confidence = result.data.confidence;
                
                const chineseMatch = text.match(/[\u4e00-\u9fff]/);
                const firstChar = chineseMatch ? chineseMatch[0] : null;
                
                if (firstChar && confidence > 40) {
                    allRecognized.add(firstChar);
                    
                    if (targetChars.includes(firstChar) && confidence > bestConfidence) {
                        bestResult = firstChar;
                        bestConfidence = confidence;
                        console.log(`${angle}°/${mode}: "${firstChar}" (${confidence.toFixed(0)}%) ✓`);
                        
                        if (confidence > 80) break outerLoop;
                    }
                }
            } catch (e) {}
        }
    }
    
    if (shouldTerminate) {
        await worker.terminate();
    }
    
    const others = [...allRecognized].filter(c => c !== bestResult).slice(0, 4).join(',');
    if (bestResult) {
        console.log(`区域识别: "${bestResult}" (${bestConfidence.toFixed(0)}%)${others ? ', 其他: ' + others : ''}`);
    } else if (allRecognized.size > 0) {
        console.log(`区域未匹配，识别到: ${[...allRecognized].slice(0, 5).join(', ')}`);
    }
    
    return bestResult;
}

// ============ 颜色分割+多角度OCR 主函数 ============
async function solveByColorSegmentation(imgElement, targetChars) {
    console.log("\n>>> 开始颜色分割识别 <<<");
    console.log("目标字符:", targetChars);
    
    // 1. 颜色分割
    const regions = segmentColorRegions(imgElement);
    console.log(`分割出 ${regions.length} 个颜色区域`);
    
    if (regions.length < targetChars.length) {
        console.log("✗ 分割区域数量不足");
        return null;
    }
    
    // 2. 对每个区域进行多角度OCR
    const charPositions = {};  // { 字符: {x, y} }
    const usedRegions = new Set();  // 已匹配的区域索引
    
    for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        console.log(`\n--- 识别区域 ${i+1}/${regions.length} ---`);
        console.log(`位置: (${region.centerX}, ${region.centerY}), 像素数: ${region.pixelCount}`);
        
        const char = await multiAngleOCR(imgElement, region, targetChars);
        
        if (char && !charPositions[char]) {
            charPositions[char] = { left: region.centerX, top: region.centerY };
            usedRegions.add(i);
            console.log(`✓ 识别到 "${char}" 在 (${region.centerX}, ${region.centerY})`);
        }
    }
    
    // 3. 兜底策略：只有识别率>=50%时才猜测，否则放弃让用户刷新
    const missingChars = targetChars.filter(c => !charPositions[c]);
    const recognizedCount = targetChars.length - missingChars.length;
    const recognitionRate = recognizedCount / targetChars.length;
    
    console.log(`识别率: ${recognizedCount}/${targetChars.length} (${(recognitionRate*100).toFixed(0)}%)`);
    
    // 只有识别率>=50%时才尝试猜测
    if (missingChars.length > 0 && recognitionRate >= 0.5) {
        console.log(`\n>>> 兜底策略：${missingChars.length}个字符未识别，尝试位置推测 <<<`);
        
        // 获取未使用的区域，只考虑较大的区域（>100像素），按X坐标排序
        const unusedRegions = regions
            .map((r, i) => ({ ...r, index: i }))
            .filter((r, i) => !usedRegions.has(i) && r.pixelCount > 100)
            .sort((a, b) => a.centerX - b.centerX);
        
        // 按目标顺序填充未识别字符
        let unusedIndex = 0;
        for (const char of targetChars) {
            if (!charPositions[char] && unusedIndex < unusedRegions.length) {
                const region = unusedRegions[unusedIndex++];
                charPositions[char] = { left: region.centerX, top: region.centerY };
                console.log(`⚡ 猜测 "${char}" 在 (${region.centerX}, ${region.centerY}) [像素:${region.pixelCount}]`);
            }
        }
    } else if (missingChars.length > 0) {
        console.log(`识别率不足50%，放弃猜测，建议刷新验证码`);
    }

    
    // 4. 按目标顺序生成点击位置
    const positions = [];
    for (const char of targetChars) {
        if (charPositions[char]) {
            positions.push({ ...charPositions[char], char });
        } else {
            console.log(`✗ 未找到字符 "${char}" 的位置`);
        }
    }
    
    console.log(`\n找到 ${positions.length}/${targetChars.length} 个字符位置`);
    return positions.length === targetChars.length ? positions : null;

}

// ============ OCR识别带位置信息 ============
async function ocrWithBoundingBoxes(imgElement) {
    if (typeof Tesseract === 'undefined') {
        console.error("Tesseract未加载");
        return null;
    }

    try {
        const canvas = preprocessImage(imgElement, 2);
        
        // 尝试加载中文训练数据，失败则使用英文
        let worker;
        try {
            worker = await Tesseract.createWorker('chi_sim', 1, {
                workerPath: chrome.runtime.getURL('langs/worker.min.js'),
                corePath: chrome.runtime.getURL('langs/tesseract-core.wasm.js'),
                langPath: chrome.runtime.getURL('langs/'),
                gzip: false
            });
            console.log("使用中文OCR引擎");
        } catch (e) {
            console.warn("中文OCR加载失败，尝试英文:", e);
            worker = await Tesseract.createWorker('eng', 1, {
                workerPath: chrome.runtime.getURL('langs/worker.min.js'),
                corePath: chrome.runtime.getURL('langs/tesseract-core.wasm.js'),
                langPath: chrome.runtime.getURL('langs/'),
                gzip: false
            });
        }

        // 设置识别参数
        await worker.setParameters({
            tessedit_pageseg_mode: '6',  // 假设统一文本块
        });

        const result = await worker.recognize(canvas);
        await worker.terminate();

        console.log("OCR识别文本:", result.data.text);
        
        // 提取每个字符的位置信息
        // Tesseract.js结构: data.words[].symbols[] 或 直接 data.symbols
        const charInfos = [];
        const scale = 2;
        
        // 尝试从words中提取symbols
        const allSymbols = [];
        if (result.data.words && result.data.words.length > 0) {
            for (const word of result.data.words) {
                if (word.symbols) {
                    allSymbols.push(...word.symbols);
                }
            }
        }
        // 如果words中没有，尝试直接从symbols获取
        if (allSymbols.length === 0 && result.data.symbols) {
            allSymbols.push(...result.data.symbols);
        }
        
        console.log("找到symbols数量:", allSymbols.length);
        
        for (const symbol of allSymbols) {
            if (symbol.text && symbol.text.trim() && symbol.bbox) {
                charInfos.push({
                    char: symbol.text,
                    bbox: {
                        x0: symbol.bbox.x0 / scale,
                        y0: symbol.bbox.y0 / scale,
                        x1: symbol.bbox.x1 / scale,
                        y1: symbol.bbox.y1 / scale
                    },
                    confidence: symbol.confidence
                });
            }
        }
        
        console.log("识别到字符数:", charInfos.length);
        console.log("字符列表:", charInfos.map(c => c.char).join(', '));
        
        return {
            text: result.data.text,
            chars: charInfos
        };
        
    } catch (err) {
        console.error("OCR识别失败:", err);
        return null;
    }
}

// ============ 仅识别底部提示文字 ============
async function ocrHintText(imgElement) {
    if (typeof Tesseract === 'undefined') {
        console.error("Tesseract未加载");
        return null;
    }

    try {
        // 裁剪底部提示区域
        const hintRegion = cropHintRegion(imgElement);
        const canvas = preprocessImage(imgElement, 4, hintRegion);  // 放大4倍
        
        // 反色处理 + 二值化（深色背景白字 -> 白色背景黑字）
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            // 先反色
            const r = 255 - data[i];
            const g = 255 - data[i+1];
            const b = 255 - data[i+2];
            // 计算灰度
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            // 二值化：清晰的黑白对比
            const val = gray > 100 ? 255 : 0;
            data[i] = data[i+1] = data[i+2] = val;
        }
        ctx.putImageData(imageData, 0, 0);
        
        let worker;
        try {
            worker = await Tesseract.createWorker('chi_sim', 1, {
                workerPath: chrome.runtime.getURL('langs/worker.min.js'),
                corePath: chrome.runtime.getURL('langs/tesseract-core.wasm.js'),
                langPath: chrome.runtime.getURL('langs/'),
                gzip: false
            });
        } catch (e) {
            console.warn("中文OCR加载失败:", e);
            return null;
        }

        await worker.setParameters({
            tessedit_pageseg_mode: '7',  // 单行文字
        });

        const result = await worker.recognize(canvas);
        await worker.terminate();

        console.log("提示区域OCR:", result.data.text);
        return result.data.text;
        
    } catch (err) {
        console.error("提示文字OCR失败:", err);
        return null;
    }
}


// ============ 提取验证码提示文字 ============
function extractHintChars(ocrText) {
    // 验证码提示格式: "依次点击【定 传 特 被】" 或类似格式
    // OCR可能把【】识别成其他字符如E、了、[、]等
    
    if (!ocrText) return null;
    
    // 清理文本
    let text = ocrText.replace(/\s+/g, ' ').trim();
    console.log("清理后的OCR文本:", text);
    
    // 方法1: 标准括号匹配
    const patterns = [
        /依次点击[【\[](.*?)[】\]]/,
        /请点击[【\[](.*?)[】\]]/,
        /点击[【\[](.*?)[】\]]/,
    ];
    
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            const chars = match[1].replace(/\s+/g, '').split('');
            if (chars.length >= 3) {
                console.log("标准匹配提取的目标字符:", chars);
                return chars;
            }
        }
    }
    
    // 方法2: 更宽松的匹配 - "依次点击"或"点击"后面的所有中文字符
    // OCR可能把【】识别成E、了、(、)等非中文字符，或类似的中文如"口"、"日"等
    const bracketLikeChars = /[【】\[\]口日曰囗\(\)E了「」『』]/g;
    
    const afterClick = text.match(/(?:依次)?点击(.+)/);
    if (afterClick) {
        // 提取所有中文字符
        let content = afterClick[1];
        // 移除末尾可能的误识别字符
        content = content.replace(/[了」】\]]+$/, '');
        // 移除括号类字符
        content = content.replace(bracketLikeChars, '');
        const chineseChars = content.match(/[\u4e00-\u9fff]/g);
        if (chineseChars && chineseChars.length >= 3 && chineseChars.length <= 6) {
            // 取前4个有效字符
            const result = chineseChars.slice(0, 4);
            console.log("宽松匹配提取的目标字符:", result);
            return result;
        }
    }

    
    // 方法3: 直接从"点击"后提取所有中文
    const clickMatch = text.match(/点击.{0,2}([\u4e00-\u9fff][\u4e00-\u9fff\s]*[\u4e00-\u9fff])/);
    if (clickMatch) {
        const chineseChars = clickMatch[1].match(/[\u4e00-\u9fff]/g);
        if (chineseChars && chineseChars.length >= 3 && chineseChars.length <= 6) {
            console.log("点击后匹配提取的目标字符:", chineseChars);
            return chineseChars;
        }
    }
    
    // 方法4: 最后手段 - 提取文本中所有中文，排除"依次点击"和可能的误识别字符
    let cleanText = text.replace(/依次点击|请点击|点击/g, '');
    // 去除常见的括号误识别字符（通常在开头或结尾）
    cleanText = cleanText.replace(/^[E\[\]【】\(\)了]+|[E\[\]【】\(\)了]+$/g, '');
    const allChinese = cleanText.match(/[\u4e00-\u9fff]/g);
    if (allChinese && allChinese.length >= 3 && allChinese.length <= 6) {
        console.log("全文提取的目标字符:", allChinese);
        return allChinese;
    }
    
    console.log("无法提取目标字符");
    return null;
}

// ============ 计算点击坐标 ============
function calculateClickPositions(targetChars, ocrChars) {
    const positions = [];
    
    for (const targetChar of targetChars) {
        let bestMatch = null;
        let bestConfidence = 0;
        
        for (const charInfo of ocrChars) {
            if (charInfo.char === targetChar && charInfo.confidence > bestConfidence) {
                bestMatch = charInfo;
                bestConfidence = charInfo.confidence;
            }
        }
        
        if (bestMatch) {
            const centerX = Math.round((bestMatch.bbox.x0 + bestMatch.bbox.x1) / 2);
            const centerY = Math.round((bestMatch.bbox.y0 + bestMatch.bbox.y1) / 2);
            positions.push({ left: centerX, top: centerY, char: targetChar });
            console.log(`字符 "${targetChar}" 位置: (${centerX}, ${centerY})`);
        } else {
            console.warn(`未找到字符 "${targetChar}" 的位置`);
        }
    }
    
    return positions;
}

// ============ 模拟点击验证码 ============
async function simulateClicks(imgElement, positions) {
    console.log("开始模拟点击，共", positions.length, "个位置");
    
    const rect = imgElement.getBoundingClientRect();
    
    for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        
        // 创建点击事件，关键是offsetX/offsetY
        const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.left + pos.left,
            clientY: rect.top + pos.top,
        });
        
        // 网页使用offsetX/offsetY记录点击位置
        Object.defineProperty(clickEvent, 'offsetX', { value: pos.left, writable: false });
        Object.defineProperty(clickEvent, 'offsetY', { value: pos.top, writable: false });
        
        imgElement.dispatchEvent(clickEvent);
        
        console.log(`点击 ${i+1}/${positions.length}: "${pos.char}" at (${pos.left}, ${pos.top})`);
        showLoader(`点击验证码 ${i+1}/${positions.length}`);
        
        await sleep(CONFIG.clickDelay);
    }
    
    console.log("所有点击完成");
    return true;
}

// ============ 自动填充账号密码 ============
async function autoFillCredentials() {
    try {
        // 使用统一身份认证的账号密码，但检查选课系统独立开关
        const settings = await chrome.storage.local.get(['nju_user', 'nju_pass', 'xk_enabled']);
        if (settings.xk_enabled === false) {
            console.log("✗ 选课系统自动登录未启用");
            return false;
        }

        const nameInput = document.querySelector(CONFIG.loginNameInput);
        const pwdInput = document.querySelector(CONFIG.loginPwdInput);

        if (!nameInput || !pwdInput) {
            console.log("✗ 未找到输入框");
            return false;
        }

        if (nameInput.value.trim()) {
            console.log("✓ 账号已填充");
            return true;
        }

        if (!settings.nju_user || !settings.nju_pass) {
            console.log("✗ 未配置账号密码，请在插件弹窗中设置");
            showMessage('请先在插件中配置账号密码', 'warning');
            return false;
        }

        nameInput.value = settings.nju_user;
        pwdInput.value = settings.nju_pass;
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        pwdInput.dispatchEvent(new Event('input', { bubbles: true }));

        console.log("✓ 已填充账号密码");
        return true;

    } catch (err) {
        console.error("填充凭证失败:", err);
        return false;
    }
}

// ============ 等待验证码加载 ============
async function waitCaptchaLoad(timeout = 5000) {
    const img = document.querySelector(CONFIG.captchaImg);
    if (!img) return false;

    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (img.src && img.src.length > 50 && img.src.startsWith('data:')) {
            if (img.complete && img.naturalWidth > 0) {
                return true;
            }
            
            await new Promise(resolve => {
                img.onload = resolve;
                img.onerror = resolve;
                setTimeout(resolve, 500);
            });
            
            if (img.naturalWidth > 0) return true;
        }
        await sleep(100);
    }
    return false;
}

// ============ 刷新验证码 ============
async function refreshCaptcha() {
    const refreshBtn = document.querySelector(CONFIG.refreshBtn);
    if (refreshBtn) {
        refreshBtn.click();
        await sleep(600);
        return await waitCaptchaLoad();
    }
    return false;
}

// ============ 完全自动化处理验证码 ============
async function autoSolveCaptcha() {
    console.log("\n>>> 开始自动识别验证码 <<<\n");
    
    const img = document.querySelector(CONFIG.captchaImg);
    if (!img || !img.src) {
        console.error("验证码图片未找到");
        return false;
    }

    // 标记是否已经尝试过，避免无限循环
    if (window._captchaAttempts === undefined) {
        window._captchaAttempts = 0;
    }
    window._captchaAttempts++;
    
    if (window._captchaAttempts > CONFIG.ocrRetries) {
        console.log("✗ 已达到最大重试次数，停止自动识别");
        showMessage('验证码识别失败，请手动完成', 'warning');
        hideLoader();
        return false;
    }

    showLoader(`识别验证码中... (${window._captchaAttempts}/${CONFIG.ocrRetries})`);
    console.log(`=== 第 ${window._captchaAttempts} 次尝试 ===`);
    
    try {
        // 步骤1: 识别底部提示文字获取目标字符
        console.log("尝试识别底部提示区域...");
        const hintText = await ocrHintText(img);
        let targetChars = null;
        
        if (hintText) {
            targetChars = extractHintChars(hintText);
            console.log("从提示区域提取的目标字符:", targetChars);
        }
        
        // 如果提示区域失败，尝试整图识别提取目标字符
        if (!targetChars || targetChars.length !== CONFIG.captchaClickCount) {
            console.log("提示区域识别失败，尝试整图识别...");
            const ocrResult = await ocrWithBoundingBoxes(img);
            
            if (ocrResult && ocrResult.text) {
                targetChars = extractHintChars(ocrResult.text);
                console.log("从整图提取的目标字符:", targetChars);
            }
        }
        
        // 如果仍然没有获取到目标字符，放弃自动识别
        if (!targetChars || targetChars.length !== CONFIG.captchaClickCount) {
            console.log("✗ 无法识别目标字符，验证码可能过于复杂");
            showMessage('验证码过于复杂，请手动点击', 'warning');
            hideLoader();
            return false;
        }
        
        // 步骤2: 使用颜色分割 + 多角度OCR 定位字符位置（新方案）
        console.log("\n>>> 使用颜色分割方案定位字符 <<<");
        showLoader('颜色分割识别中...');
        
        const colorPositions = await solveByColorSegmentation(img, targetChars);
        
        if (colorPositions && colorPositions.length === CONFIG.captchaClickCount) {
            console.log("✓ 颜色分割方案成功！");
            await simulateClicks(img, colorPositions);
            console.log("✓ 验证码自动点击完成");
            window._captchaAttempts = 0;
            return true;
        }
        
        // 识别失败，检查是否还可以重试
        console.log("✗ 识别失败");
        if (window._captchaAttempts < CONFIG.ocrRetries) {
            console.log(`刷新验证码重试 (${window._captchaAttempts}/${CONFIG.ocrRetries})...`);
            showLoader('识别失败，刷新重试...');
            await refreshCaptcha();
            await sleep(800);
            return autoSolveCaptcha();
        } else {
            console.log("✗ 已达最大重试次数，停止");
            showMessage('验证码识别失败，请手动点击', 'warning');
            hideLoader();
            window._captchaAttempts = 0;
            return false;
        }
        
    } catch (err) {
        console.error("处理验证码出错:", err);
        if (window._captchaAttempts < CONFIG.ocrRetries) {
            console.log("出错，刷新重试...");
            await refreshCaptcha();
            await sleep(800);
            return autoSolveCaptcha();
        } else {
            console.log("✗ 已达最大重试次数，停止");
            showMessage('验证码处理出错，请手动完成', 'error');
            hideLoader();
            window._captchaAttempts = 0;
            return false;
        }
    }
}



// ============ 点击登录按钮 ============
async function clickLoginButton() {
    const btn = document.querySelector(CONFIG.loginBtn);
    if (btn) {
        btn.click();
        console.log("✓ 已点击登录按钮");
        return true;
    }
    return false;
}

// ============ 主要登录流程 ============
async function startAutoLogin() {
    console.log("\n========================================");
    console.log(">>> 开始完全自动登录流程 <<<");
    console.log("========================================\n");

    try {
        // 1. 检查是否在登录页面
        showLoader('检查登录状态...');
        
        const loginDiv = document.querySelector(CONFIG.loginDiv);
        if (!loginDiv || getComputedStyle(loginDiv).display === 'none') {
            console.log("✓ 当前不在登录界面，可能已登录");
            hideLoader();
            return;
        }

        console.log("✓ 检测到登录表单");

        // 2. 自动填充账号密码
        showLoader('填充账号密码...');
        const filled = await autoFillCredentials();
        if (!filled) {
            hideLoader();
            return;
        }
        
        await sleep(300);

        // 3. 等待验证码加载
        showLoader('等待验证码加载...');
        const imgLoaded = await waitCaptchaLoad();
        if (!imgLoaded) {
            console.log("✗ 验证码加载超时");
            showMessage('验证码加载失败', 'error');
            hideLoader();
            return;
        }

        console.log("✓ 验证码已加载");
        await sleep(500);

        // 4. 自动识别并点击验证码
        const captchaSolved = await autoSolveCaptcha();
        
        if (captchaSolved) {
            await sleep(500);
            
            // 5. 点击登录按钮
            showLoader('正在登录...');
            // await clickLoginButton();
            
            showMessage('自动登录完成！', 'success');
        }

        hideLoader();

    } catch (err) {
        console.error("自动登录出错:", err);
        showMessage('自动登录出错: ' + err.message, 'error');
        hideLoader();
    }
}

// ============ 监听登录失败并重试 ============
function setupErrorWatcher() {
    const errorEl = document.querySelector(CONFIG.errorMsg);
    if (!errorEl) return;
    
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList' || mutation.type === 'characterData') {
                const text = errorEl.textContent || errorEl.innerText;
                if (text && text.includes('验证码')) {
                    console.log("检测到验证码错误");
                    // 不自动重试，让用户手动刷新
                    showMessage('验证码错误，请点击刷新重试', 'warning');
                }
            }
        }
    });
    
    observer.observe(errorEl, { 
        childList: true, 
        characterData: true, 
        subtree: true 
    });
}

// ============ 页面初始化 ============
function initAutoLogin() {
    console.log("初始化完全自动登录模块 v3.0");

    // 页面加载完成后执行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(startAutoLogin, 1000);
        });
    } else {
        setTimeout(startAutoLogin, 1000);
    }

    // 设置错误监听
    setTimeout(setupErrorWatcher, 2000);

    // 监听验证码刷新按钮
    setTimeout(() => {
        const refreshBtn = document.querySelector(CONFIG.refreshBtn);
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                console.log("🔄 验证码已刷新");
                window._captchaAttempts = 0;  // 重置计数器
                setTimeout(autoSolveCaptcha, 800);
            });
        }
    }, 1000);
}

// 启动脚本
initAutoLogin();
