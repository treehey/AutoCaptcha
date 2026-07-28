// content.js
const EXTENSION_VERSION = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest().version
    : 'dev';
const AUTH_LOGIN_PATH = '/authserver/login';
const IMG_SELECTOR = "#captchaImg";
const INPUT_SELECTOR = "#captcha";
if (window.location.pathname === AUTH_LOGIN_PATH) {
    console.log(`NJU 验证码识别助手 v${EXTENSION_VERSION} 已启动...`);
}
// Labeled samples indicate the captcha alphabet excludes 0/1/o/O/z/Z.
const CAPTCHA_CHAR_WHITELIST = '23456789abcdefghijklmnpqrstuvwxyABCDEFGHIJKLMNPQRSTUVWXY';
let captchaWorkerPromise = null;
const CAPTCHA_OCR_MAX_WORKERS = 2;
const CAPTCHA_TEMPLATE_FEATURE_WIDTH = 24;
const CAPTCHA_TEMPLATE_FEATURE_HEIGHT = 32;
const CAPTCHA_TEMPLATE_MODEL_PATH = 'assets/captcha-template-model.json';
const CAPTCHA_TEMPLATE_RERANK_DEFAULTS = {
    enabled: false,
    mode: 'thin',
    k: 3,
    margin: 10,
    ocrWeight: 0,
    supportWeight: 0,
    allTemplateLabels: true,
    protectWeakSingleVariant: true,
    weakSingleVariantMargin: 30,
    weakSingleVariantConfidence: 0,
    protectHighConfidence: false,
    highConfidenceThreshold: 88,
    highConfidenceMargin: 18,
    debug: false
};
let captchaTemplateModelPromise = null;
let captchaTemplateRuntimeConfigPromise = null;
let captchaTemplateModelWarned = false;
let captchaCnnEnabledPromise = null;
const CAPTCHA_OCR_VARIANTS = [
    {
        name: 'color-cluster',
        colorCluster: true,
        scale: 6,
        priority: 2,
        fallbackOnly: true
    },
    {
        name: 'strict-color',
        minSaturation: 0.24,
        minChroma: 34,
        maxLuminance: 190,
        darkLuminance: 48,
        darkMinSaturation: 0.12,
        lineMaxSaturation: 0.30,
        lineMinLuminance: 95,
        scale: 6,
        priority: 2
    },
    {
        name: 'balanced-color',
        minSaturation: 0.17,
        minChroma: 24,
        maxLuminance: 185,
        darkLuminance: 68,
        darkMinSaturation: 0.08,
        lineMaxSaturation: 0.26,
        lineMinLuminance: 80,
        scale: 6,
        priority: 4,
        fallbackOnly: true
    },
    {
        name: 'loose-color',
        minSaturation: 0.10,
        minChroma: 12,
        maxLuminance: 205,
        darkLuminance: 95,
        darkMinSaturation: 0.02,
        lineMaxSaturation: 0.22,
        lineMinLuminance: 120,
        scale: 6,
        priority: 3
    },
    {
        name: 'thin-line-clean',
        thinLineClean: true,
        minSaturation: 0.10,
        minChroma: 12,
        maxLuminance: 205,
        darkLuminance: 95,
        darkMinSaturation: 0.02,
        lineMaxSaturation: 0.22,
        lineMinLuminance: 120,
        scale: 6,
        priority: 3
    },
    {
        name: 'aggressive-line-clean',
        aggressiveLineClean: true,
        minSaturation: 0.09,
        minChroma: 10,
        maxLuminance: 210,
        darkLuminance: 100,
        darkMinSaturation: 0.02,
        lineMaxSaturation: 0.36,
        lineMinLuminance: 88,
        scale: 6,
        priority: 2,
        fallbackOnly: true
    },
    {
        name: 'simple-threshold',
        simpleThreshold: true,
        threshold: 180,
        scale: 6,
        priority: 2
    },
    {
        name: 'legacy-fallback',
        legacy: true,
        scale: 4,
        priority: 1
    }
];

function normalizeCaptchaCode(text) {
    return (text || '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 4);
}

function getPixelStats(data, pixelIndex) {
    const idx = pixelIndex * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const chroma = maxC - minC;
    return {
        luminance: 0.299 * r + 0.587 * g + 0.114 * b,
        saturation: maxC > 0 ? chroma / maxC : 0,
        chroma
    };
}

function getPixelHue(data, pixelIndex) {
    const idx = pixelIndex * 4;
    const r = data[idx] / 255;
    const g = data[idx + 1] / 255;
    const b = data[idx + 2] / 255;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const delta = maxC - minC;
    if (delta === 0) return 0;

    let hue;
    if (maxC === r) {
        hue = ((g - b) / delta) % 6;
    } else if (maxC === g) {
        hue = (b - r) / delta + 2;
    } else {
        hue = (r - g) / delta + 4;
    }

    hue *= 60;
    return hue < 0 ? hue + 360 : hue;
}

async function readCaptchaBitmap(imgElement) {
    const bitmap = await createImageBitmap(imgElement);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    return {
        canvas,
        width: canvas.width,
        height: canvas.height,
        imageData: ctx.getImageData(0, 0, canvas.width, canvas.height)
    };
}

function buildTextMask(base, variant) {
    const { imageData, width, height } = base;
    const { data } = imageData;
    const mask = new Uint8Array(width * height);

    for (let p = 0; p < mask.length; p++) {
        const stats = getPixelStats(data, p);
        const coloredText = stats.saturation >= variant.minSaturation
            && stats.chroma >= variant.minChroma
            && stats.luminance <= variant.maxLuminance;
        const darkText = stats.luminance <= variant.darkLuminance
            && stats.saturation >= variant.darkMinSaturation;
        mask[p] = coloredText || darkText ? 1 : 0;
    }

    return mask;
}

function countRun(mask, width, height, x, y, dx, dy) {
    let count = 0;
    while (x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x]) {
        count++;
        x += dx;
        y += dy;
    }
    return count;
}

function suppressInterferenceLines(mask, base, variant) {
    const { imageData, width, height } = base;
    const ref = mask.slice();
    const horizontalRun = Math.max(14, Math.floor(width * 0.26));
    const diagonalRun = Math.max(10, Math.floor(width * 0.18));
    const veryLongHorizontalRun = Math.max(22, Math.floor(width * 0.40));
    const veryLongDiagonalRun = Math.max(16, Math.floor(width * 0.30));

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            if (!ref[p]) continue;

            const stats = getPixelStats(imageData.data, p);
            const weakColor = stats.saturation <= variant.lineMaxSaturation || stats.luminance >= variant.lineMinLuminance;

            const hRun = countRun(ref, width, height, x, y, -1, 0) + countRun(ref, width, height, x + 1, y, 1, 0);
            const vRun = countRun(ref, width, height, x, y, 0, -1) + countRun(ref, width, height, x, y + 1, 0, 1);
            const d1Run = countRun(ref, width, height, x, y, -1, -1) + countRun(ref, width, height, x + 1, y + 1, 1, 1);
            const d2Run = countRun(ref, width, height, x, y, -1, 1) + countRun(ref, width, height, x + 1, y - 1, 1, -1);
            const horizontalThinness = hRun / Math.max(vRun, 1);

            const isHorizontalLine = hRun >= horizontalRun && vRun <= 4 && horizontalThinness >= 4;
            const isDiagonalLine = (d1Run >= diagonalRun || d2Run >= diagonalRun) && hRun <= horizontalRun;
            const isVeryLongHorizontalLine = hRun >= veryLongHorizontalRun && horizontalThinness >= 4;
            const isVeryLongDiagonalLine = (d1Run >= veryLongDiagonalRun || d2Run >= veryLongDiagonalRun) && hRun <= horizontalRun;
            if ((weakColor && (isHorizontalLine || isDiagonalLine)) || isVeryLongHorizontalLine || isVeryLongDiagonalLine) {
                mask[p] = 0;
            }
        }
    }
}

function countLocalInk(mask, width, height, x, y, radius) {
    let count = 0;
    const x0 = Math.max(0, x - radius);
    const x1 = Math.min(width - 1, x + radius);
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);

    for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
            if (mask[yy * width + xx]) count++;
        }
    }

    return count;
}

function filterSmallComponents(mask, width, height) {
    const seen = new Uint8Array(mask.length);
    const stack = [];

    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || seen[start]) continue;

        let minX = width, minY = height, maxX = 0, maxY = 0;
        const pixels = [];
        stack.push(start);
        seen[start] = 1;

        while (stack.length) {
            const p = stack.pop();
            pixels.push(p);
            const x = p % width;
            const y = Math.floor(p / width);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const np = ny * width + nx;
                    if (mask[np] && !seen[np]) {
                        seen[np] = 1;
                        stack.push(np);
                    }
                }
            }
        }

        const boxW = maxX - minX + 1;
        const boxH = maxY - minY + 1;
        const density = pixels.length / (boxW * boxH);
        const tooSmall = pixels.length <= 2;
        const longThinNoise = (boxW >= width * 0.45 || boxH >= height * 0.70)
            && (Math.min(boxW, boxH) <= 2 || density < 0.18)
            && pixels.length <= width * height * 0.10;

        if (tooSmall || longThinNoise) {
            for (const p of pixels) mask[p] = 0;
        }
    }
}

function mergeColorBucketComponents(target, source, width, height) {
    const seen = new Uint8Array(source.length);
    const stack = [];
    const slotWidth = width / 4;

    for (let start = 0; start < source.length; start++) {
        if (!source[start] || seen[start]) continue;

        let minX = width, minY = height, maxX = 0, maxY = 0;
        const pixels = [];
        stack.push(start);
        seen[start] = 1;

        while (stack.length) {
            const p = stack.pop();
            pixels.push(p);
            const x = p % width;
            const y = Math.floor(p / width);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const np = ny * width + nx;
                    if (source[np] && !seen[np]) {
                        seen[np] = 1;
                        stack.push(np);
                    }
                }
            }
        }

        const boxW = maxX - minX + 1;
        const boxH = maxY - minY + 1;
        const density = pixels.length / Math.max(1, boxW * boxH);
        const crossesManySlots = boxW >= slotWidth * 1.65;
        const veryLong = boxW >= width * 0.42;
        const thinHorizontal = boxW >= slotWidth * 0.95 && boxH <= Math.max(2, height * 0.16);
        const thinDiagonalOrLine = boxW >= slotWidth * 1.20 && density <= 0.24 && pixels.length <= width * height * 0.12;
        const tinyNoise = pixels.length <= 2;

        if (tinyNoise || veryLong || crossesManySlots || thinHorizontal || thinDiagonalOrLine) continue;
        for (const p of pixels) target[p] = 1;
    }
}

function buildColorClusterMask(base) {
    const { imageData, width, height } = base;
    const { data } = imageData;
    const bucketCount = 18;
    const buckets = Array.from({ length: bucketCount + 1 }, () => new Uint8Array(width * height));
    const merged = new Uint8Array(width * height);

    for (let p = 0; p < merged.length; p++) {
        const stats = getPixelStats(data, p);
        const coloredText = stats.saturation >= 0.11
            && stats.chroma >= 14
            && stats.luminance <= 215;
        const darkText = stats.luminance <= 82
            && stats.chroma >= 8;
        if (!coloredText && !darkText) continue;

        const bucket = darkText && stats.saturation < 0.18
            ? bucketCount
            : Math.min(bucketCount - 1, Math.floor(getPixelHue(data, p) / (360 / bucketCount)));
        buckets[bucket][p] = 1;
    }

    for (const bucket of buckets) {
        mergeColorBucketComponents(merged, bucket, width, height);
    }

    bridgeOnePixelGaps(merged, width, height);
    filterSmallComponents(merged, width, height);
    return merged;
}

function removeDenseHorizontalRows(mask, width, height) {
    const ref = mask.slice();
    const minRun = Math.max(18, Math.floor(width * 0.34));

    for (let y = 1; y < height - 1; y++) {
        let currentRun = 0;
        let longestRun = 0;

        for (let x = 0; x < width; x++) {
            if (ref[y * width + x]) {
                currentRun++;
                if (currentRun > longestRun) longestRun = currentRun;
            } else {
                currentRun = 0;
            }
        }

        if (longestRun < minRun) continue;

        for (let x = 0; x < width; x++) {
            if (ref[y * width + x]) {
                mask[y * width + x] = 0;
            }
        }
    }
}

function bridgeOnePixelGaps(mask, width, height) {
    const ref = mask.slice();
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            if (ref[p]) continue;
            const left = ref[y * width + x - 1];
            const right = ref[y * width + x + 1];
            const up = ref[(y - 1) * width + x];
            const down = ref[(y + 1) * width + x];
            if ((left && right) || (up && down)) {
                mask[p] = 1;
            }
        }
    }
}

function getMaskBounds(mask, width, height) {
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    return { minX, minY, maxX, maxY };
}

function renderMaskToCanvas(mask, width, height, scale) {
    const bounds = getMaskBounds(mask, width, height) || {
        minX: 0,
        minY: 0,
        maxX: width - 1,
        maxY: height - 1
    };
    const sourcePad = 1;
    const minX = Math.max(0, bounds.minX - sourcePad);
    const minY = Math.max(0, bounds.minY - sourcePad);
    const maxX = Math.min(width - 1, bounds.maxX + sourcePad);
    const maxY = Math.min(height - 1, bounds.maxY + sourcePad);
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    const outputPad = 12;

    const canvas = document.createElement('canvas');
    canvas.width = cropW * scale + outputPad * 2;
    canvas.height = cropH * scale + outputPad * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            if (mask[y * width + x]) {
                ctx.fillRect(outputPad + (x - minX) * scale, outputPad + (y - minY) * scale, scale, scale);
            }
        }
    }

    return canvas;
}

function createColorPreprocessedCanvas(base, variant) {
    const mask = buildTextMask(base, variant);
    suppressInterferenceLines(mask, base, variant);
    removeDenseHorizontalRows(mask, base.width, base.height);
    filterSmallComponents(mask, base.width, base.height);
    bridgeOnePixelGaps(mask, base.width, base.height);
    return renderMaskToCanvas(mask, base.width, base.height, variant.scale);
}

function removeOnePixelInterference(mask, base) {
    const { imageData, width, height } = base;
    const ref = mask.slice();

    const at = (x, y) => {
        return x >= 0 && x < width && y >= 0 && y < height
            ? ref[y * width + x]
            : 0;
    };

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            if (!ref[p]) continue;

            const stats = getPixelStats(imageData.data, p);
            const weakColor = stats.saturation <= 0.34 || stats.luminance >= 90 || stats.chroma <= 25;
            const denseBody = countLocalInk(ref, width, height, x, y, 1) >= 6
                || countLocalInk(ref, width, height, x, y, 2) >= 14;
            const horizontalThin = !at(x, y - 1) && !at(x, y + 1) && (at(x - 1, y) || at(x + 1, y));
            const verticalThin = !at(x - 1, y) && !at(x + 1, y) && (at(x, y - 1) || at(x, y + 1));
            const diagonalDownThin = !at(x - 1, y + 1) && !at(x + 1, y - 1) && (at(x - 1, y - 1) || at(x + 1, y + 1));
            const diagonalUpThin = !at(x - 1, y - 1) && !at(x + 1, y + 1) && (at(x - 1, y + 1) || at(x + 1, y - 1));

            if ((horizontalThin || verticalThin || diagonalDownThin || diagonalUpThin) && (!denseBody || weakColor)) {
                mask[p] = 0;
            }
        }
    }
}

function removeDirectionalInterference(mask, base) {
    const { imageData, width, height } = base;
    const ref = mask.slice();
    const horizontalRun = Math.max(11, Math.floor(width * 0.20));
    const diagonalRun = Math.max(8, Math.floor(width * 0.15));
    const veryLongRun = Math.max(18, Math.floor(width * 0.34));

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            if (!ref[p]) continue;

            const stats = getPixelStats(imageData.data, p);
            const weakLineColor = stats.saturation <= 0.36 || stats.chroma <= 30 || stats.luminance >= 88;
            const hRun = countRun(ref, width, height, x, y, -1, 0) + countRun(ref, width, height, x + 1, y, 1, 0);
            const vRun = countRun(ref, width, height, x, y, 0, -1) + countRun(ref, width, height, x, y + 1, 0, 1);
            const d1Run = countRun(ref, width, height, x, y, -1, -1) + countRun(ref, width, height, x + 1, y + 1, 1, 1);
            const d2Run = countRun(ref, width, height, x, y, -1, 1) + countRun(ref, width, height, x + 1, y - 1, 1, -1);
            const localInk1 = countLocalInk(ref, width, height, x, y, 1);
            const localInk2 = countLocalInk(ref, width, height, x, y, 2);

            const thinLocal = localInk1 <= 5 || localInk2 <= 13;
            const horizontalLine = hRun >= horizontalRun && vRun <= 4 && hRun >= vRun * 3.5;
            const diagonalLine = (d1Run >= diagonalRun || d2Run >= diagonalRun)
                && Math.max(d1Run, d2Run) >= Math.max(hRun, vRun) + 3;
            const veryLongLine = Math.max(hRun, d1Run, d2Run) >= veryLongRun;

            if ((horizontalLine || diagonalLine || veryLongLine)
                && (weakLineColor || veryLongLine)
                && (thinLocal || veryLongLine)) {
                mask[p] = 0;
            }
        }
    }
}

function createThinLineCleanPreprocessedCanvas(base, variant) {
    const mask = buildTextMask(base, variant);
    suppressInterferenceLines(mask, base, variant);
    removeOnePixelInterference(mask, base);
    removeDenseHorizontalRows(mask, base.width, base.height);
    filterSmallComponents(mask, base.width, base.height);
    bridgeOnePixelGaps(mask, base.width, base.height);
    return renderMaskToCanvas(mask, base.width, base.height, variant.scale);
}

function createAggressiveLineCleanPreprocessedCanvas(base, variant) {
    const mask = buildTextMask(base, variant);
    suppressInterferenceLines(mask, base, variant);
    removeDirectionalInterference(mask, base);
    removeOnePixelInterference(mask, base);
    removeDenseHorizontalRows(mask, base.width, base.height);
    filterSmallComponents(mask, base.width, base.height);
    bridgeOnePixelGaps(mask, base.width, base.height);
    bridgeOnePixelGaps(mask, base.width, base.height);
    return renderMaskToCanvas(mask, base.width, base.height, variant.scale);
}

function createColorClusterPreprocessedCanvas(base, variant) {
    const mask = buildColorClusterMask(base);
    return renderMaskToCanvas(mask, base.width, base.height, variant.scale);
}

function createLegacyPreprocessedCanvas(base, variant) {
    const scale = variant.scale;
    const canvas = document.createElement('canvas');
    canvas.width = base.width * scale;
    canvas.height = base.height * scale;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base.canvas, 0, 0, canvas.width, canvas.height);

    const width = canvas.width;
    const height = canvas.height;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;
        const isText = (saturation > 0.15 && luminance < 170) || luminance < 80;
        const v = isText ? 0 : 255;
        data[i] = data[i + 1] = data[i + 2] = v;
    }

    const afterDilate = new Uint8ClampedArray(data);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = (y * width + x) * 4;
            if (data[idx] === 0) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const ni = ((y + dy) * width + (x + dx)) * 4;
                        afterDilate[ni] = afterDilate[ni + 1] = afterDilate[ni + 2] = 0;
                    }
                }
            }
        }
    }

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

    for (let i = 0; i < data.length; i++) data[i] = afterErode[i];

    const cleanRef = new Uint8ClampedArray(data);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const idx = (y * width + x) * 4;
            if (cleanRef[idx] === 0) {
                let blackNeighbors = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dy === 0 && dx === 0) continue;
                        if (cleanRef[((y + dy) * width + (x + dx)) * 4] === 0) {
                            blackNeighbors++;
                        }
                    }
                }
                if (blackNeighbors <= 1) {
                    data[idx] = data[idx + 1] = data[idx + 2] = 255;
                }
            }
        }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
}

function createThresholdPreprocessedCanvas(base, variant) {
    const { imageData, width, height } = base;
    const { data } = imageData;
    const mask = new Uint8Array(width * height);
    const threshold = variant.threshold || 180;

    for (let p = 0; p < mask.length; p++) {
        const idx = p * 4;
        const luminance = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        mask[p] = luminance < threshold ? 1 : 0;
    }

    removeDenseHorizontalRows(mask, width, height);
    filterSmallComponents(mask, width, height);
    bridgeOnePixelGaps(mask, width, height);
    return renderMaskToCanvas(mask, width, height, variant.scale);
}

function createPreprocessedCanvas(base, variant) {
    if (variant.colorCluster) return createColorClusterPreprocessedCanvas(base, variant);
    if (variant.aggressiveLineClean) return createAggressiveLineCleanPreprocessedCanvas(base, variant);
    if (variant.thinLineClean) return createThinLineCleanPreprocessedCanvas(base, variant);
    if (variant.legacy) return createLegacyPreprocessedCanvas(base, variant);
    if (variant.simpleThreshold) return createThresholdPreprocessedCanvas(base, variant);
    return createColorPreprocessedCanvas(base, variant);
}

function getTemplateRerankConfig(override = null) {
    const runtimeConfig = typeof window !== 'undefined'
        ? (window.NJU_TEMPLATE_RERANK_CONFIG || null)
        : null;
    return {
        ...CAPTCHA_TEMPLATE_RERANK_DEFAULTS,
        ...(runtimeConfig || {}),
        ...(override || {})
    };
}

async function loadCaptchaTemplateModel() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) return null;
    const url = chrome.runtime.getURL(CAPTCHA_TEMPLATE_MODEL_PATH);
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) {
        throw new Error(`Template model unavailable: ${response.status}`);
    }
    return await response.json();
}

async function getCaptchaTemplateModel() {
    if (!captchaTemplateModelPromise) {
        captchaTemplateModelPromise = loadCaptchaTemplateModel().catch(err => {
            if (!captchaTemplateModelWarned) {
                console.warn('NJU 助手：模板 OCR 模型加载失败，已回退旧 OCR 流程:', err);
                captchaTemplateModelWarned = true;
            }
            return null;
        });
    }
    return await captchaTemplateModelPromise;
}

async function getCaptchaTemplateRuntimeConfig() {
    if (typeof window !== 'undefined' && window.NJU_TEMPLATE_RERANK_CONFIG) {
        return getTemplateRerankConfig();
    }

    if (captchaTemplateRuntimeConfigPromise) {
        return await captchaTemplateRuntimeConfigPromise;
    }

    captchaTemplateRuntimeConfigPromise = buildCaptchaTemplateRuntimeConfig();
    return await captchaTemplateRuntimeConfigPromise;
}

async function buildCaptchaTemplateRuntimeConfig() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        return getTemplateRerankConfig({ enabled: false });
    }

    const settings = await chrome.storage.local.get(['nju_template_rerank', 'nju_template_debug']);
    if (settings.nju_template_rerank === false) {
        return getTemplateRerankConfig({ enabled: false });
    }

    const model = await getCaptchaTemplateModel();
    if (!model) {
        return getTemplateRerankConfig({ enabled: false });
    }

    return getTemplateRerankConfig({
        ...(model.recommended || {}),
        enabled: true,
        model,
        debug: Boolean(settings.nju_template_debug)
    });
}

function normalizeTemplateLabel(char) {
    return /[a-zA-Z]/.test(char || '') ? char.toLowerCase() : (char || '');
}

function getTemplateMaskVariant(mode) {
    if (mode === 'aggressive') {
        return {
            minSaturation: 0.09,
            minChroma: 10,
            maxLuminance: 210,
            darkLuminance: 100,
            darkMinSaturation: 0.02,
            lineMaxSaturation: 0.36,
            lineMinLuminance: 88
        };
    }

    return {
        minSaturation: 0.10,
        minChroma: 12,
        maxLuminance: 205,
        darkLuminance: 95,
        darkMinSaturation: 0.02,
        lineMaxSaturation: 0.22,
        lineMinLuminance: 120
    };
}

function buildTemplateRerankMask(base, mode = 'thin') {
    if (mode === 'color') return buildColorClusterMask(base);

    const variant = getTemplateMaskVariant(mode);
    const mask = buildTextMask(base, variant);
    suppressInterferenceLines(mask, base, variant);
    if (mode === 'aggressive') {
        removeDirectionalInterference(mask, base);
    }
    removeOnePixelInterference(mask, base);
    removeDenseHorizontalRows(mask, base.width, base.height);
    filterSmallComponents(mask, base.width, base.height);
    bridgeOnePixelGaps(mask, base.width, base.height);
    if (mode === 'aggressive') bridgeOnePixelGaps(mask, base.width, base.height);
    return mask;
}

function getTemplateColumnCounts(mask, width, height, y0, y1) {
    const counts = new Array(width).fill(0);
    for (let x = 0; x < width; x++) {
        let count = 0;
        for (let y = y0; y <= y1; y++) {
            if (mask[y * width + x]) count++;
        }
        counts[x] = count;
    }
    return counts;
}

function getSmoothedTemplateColumn(counts, x) {
    let total = 0;
    let weight = 0;
    for (let dx = -2; dx <= 2; dx++) {
        const index = x + dx;
        if (index < 0 || index >= counts.length) continue;
        const w = 3 - Math.abs(dx);
        total += counts[index] * w;
        weight += w;
    }
    return total / Math.max(1, weight);
}

function segmentTemplateRerankMask(mask, width, height) {
    const bounds = getMaskBounds(mask, width, height) || {
        minX: 0,
        minY: 0,
        maxX: width - 1,
        maxY: height - 1
    };
    const xMin = Math.max(0, bounds.minX - 2);
    const xMax = Math.min(width - 1, bounds.maxX + 2);
    const yMin = Math.max(0, bounds.minY - 2);
    const yMax = Math.min(height - 1, bounds.maxY + 2);
    const totalW = xMax - xMin + 1;
    const minSeg = Math.max(10, Math.floor(totalW * 0.14));
    const maxSeg = Math.max(minSeg + 4, Math.floor(totalW * 0.36));
    const counts = getTemplateColumnCounts(mask, width, height, yMin, yMax);
    const expected = [0.25, 0.50, 0.75].map(ratio => xMin + totalW * ratio);
    let best = null;

    const c1End = Math.min(xMax - minSeg * 3, xMin + Math.floor(totalW * 0.38));
    for (let c1 = xMin + minSeg; c1 <= c1End; c1++) {
        const c2Start = Math.max(c1 + minSeg, xMin + Math.floor(totalW * 0.34));
        const c2End = Math.min(xMax - minSeg * 2, xMin + Math.floor(totalW * 0.64));
        for (let c2 = c2Start; c2 <= c2End; c2++) {
            const c3Start = Math.max(c2 + minSeg, xMin + Math.floor(totalW * 0.58));
            const c3End = Math.min(xMax - minSeg, xMin + Math.floor(totalW * 0.86));
            for (let c3 = c3Start; c3 <= c3End; c3++) {
                const cuts = [c1, c2, c3];
                const edges = [xMin, c1, c2, c3, xMax + 1];
                const widths = [
                    edges[1] - edges[0],
                    edges[2] - edges[1],
                    edges[3] - edges[2],
                    edges[4] - edges[3]
                ];
                if (widths.some(w => w < minSeg || w > maxSeg)) continue;

                let score = 0;
                for (let i = 0; i < 3; i++) {
                    score += getSmoothedTemplateColumn(counts, cuts[i]) * 6;
                    score += Math.abs(cuts[i] - expected[i]) * 0.10;
                }
                const idealW = totalW / 4;
                for (const w of widths) score += Math.abs(w - idealW) * 0.12;

                for (let i = 0; i < 4; i++) {
                    let ink = 0;
                    for (let x = edges[i]; x < edges[i + 1]; x++) {
                        ink += counts[x] || 0;
                    }
                    if (ink < 6) score += 200;
                }

                if (!best || score < best.score) {
                    best = { score, cuts, edges, bounds: { xMin, xMax, yMin, yMax } };
                }
            }
        }
    }

    if (!best) {
        const step = totalW / 4;
        const cuts = [1, 2, 3].map(index => Math.round(xMin + step * index));
        best = { cuts, edges: [xMin, ...cuts, xMax + 1], bounds: { xMin, xMax, yMin, yMax }, score: 9999 };
    }

    const boxes = [];
    for (let i = 0; i < 4; i++) {
        const sx0 = Math.max(0, best.edges[i] - 2);
        const sx1 = Math.min(width - 1, best.edges[i + 1] + 1);
        let minX = sx1, minY = height - 1, maxX = sx0, maxY = 0;

        for (let y = 0; y < height; y++) {
            for (let x = sx0; x <= sx1; x++) {
                if (!mask[y * width + x]) continue;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }

        if (maxX < minX) {
            minX = sx0;
            maxX = sx1;
            minY = best.bounds.yMin;
            maxY = best.bounds.yMax;
        }

        boxes.push({
            x0: Math.max(0, minX - 2),
            y0: Math.max(0, minY - 2),
            x1: Math.min(width - 1, maxX + 2),
            y1: Math.min(height - 1, maxY + 2)
        });
    }

    return { ...best, boxes };
}

function extractTemplateFeatureFromBox(mask, width, height, box) {
    const featureW = CAPTCHA_TEMPLATE_FEATURE_WIDTH;
    const featureH = CAPTCHA_TEMPLATE_FEATURE_HEIGHT;
    const vector = new Array(featureW * featureH).fill(0);
    const col = new Array(featureW).fill(0);
    const row = new Array(featureH).fill(0);
    const boxW = Math.max(1, box.x1 - box.x0 + 1);
    const boxH = Math.max(1, box.y1 - box.y0 + 1);
    const scale = Math.min((featureW - 4) / boxW, (featureH - 4) / boxH);
    const drawW = boxW * scale;
    const drawH = boxH * scale;
    const ox = Math.floor((featureW - drawW) / 2);
    const oy = Math.floor((featureH - drawH) / 2);

    for (let y = box.y0; y <= box.y1; y++) {
        for (let x = box.x0; x <= box.x1; x++) {
            if (!mask[y * width + x]) continue;
            const fx = Math.max(0, Math.min(featureW - 1, Math.floor(ox + (x - box.x0) * scale)));
            const fy = Math.max(0, Math.min(featureH - 1, Math.floor(oy + (y - box.y0) * scale)));
            vector[fy * featureW + fx] = 1;
        }
    }

    for (let y = 0; y < featureH; y++) {
        for (let x = 0; x < featureW; x++) {
            if (!vector[y * featureW + x]) continue;
            col[x] += 1 / featureH;
            row[y] += 1 / featureW;
        }
    }

    return { vector, col, row };
}

function extractCaptchaTemplateFeatures(base, mode = 'thin') {
    const mask = buildTemplateRerankMask(base, mode);
    const segmentation = segmentTemplateRerankMask(mask, base.width, base.height);
    return {
        mode,
        segmentation,
        chars: segmentation.boxes.map(box => extractTemplateFeatureFromBox(mask, base.width, base.height, box))
    };
}

function getShiftedTemplateDistance(a, b, dx, dy) {
    const featureW = CAPTCHA_TEMPLATE_FEATURE_WIDTH;
    const featureH = CAPTCHA_TEMPLATE_FEATURE_HEIGHT;
    let diff = 0;
    let union = 0;

    for (let y = 0; y < featureH; y++) {
        const by = y + dy;
        for (let x = 0; x < featureW; x++) {
            const bx = x + dx;
            const av = a.vector[y * featureW + x] ? 1 : 0;
            const bv = bx >= 0 && bx < featureW && by >= 0 && by < featureH
                ? (b.vector[by * featureW + bx] ? 1 : 0)
                : 0;
            if (av || bv) union++;
            if (av !== bv) diff++;
        }
    }

    return union ? diff / union : 1;
}

function getTemplateFeatureDistance(a, b, useShiftDistance = false) {
    let best = getShiftedTemplateDistance(a, b, 0, 0);
    if (useShiftDistance) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const distance = getShiftedTemplateDistance(a, b, dx, dy);
                if (distance < best) best = distance;
            }
        }
    }

    let projection = 0;
    for (let i = 0; i < CAPTCHA_TEMPLATE_FEATURE_WIDTH; i++) {
        projection += Math.abs((a.col[i] || 0) - (b.col[i] || 0));
    }
    for (let i = 0; i < CAPTCHA_TEMPLATE_FEATURE_HEIGHT; i++) {
        projection += Math.abs((a.row[i] || 0) - (b.row[i] || 0));
    }

    return best + projection * 0.04;
}

function scoreTemplateLabels(feature, training, k = 5, useShiftDistance = false, allowedLabels = null) {
    const scopedTraining = allowedLabels && allowedLabels.size
        ? training.filter(item => allowedLabels.has(item.label))
        : training;
    const sourceTraining = scopedTraining.length ? scopedTraining : training;
    const neighbors = [];
    const limit = Math.max(1, k || 5);

    for (const item of sourceTraining) {
        const distance = getTemplateFeatureDistance(feature, item, useShiftDistance);
        if (neighbors.length < limit) {
            neighbors.push({ label: item.label, distance });
            neighbors.sort((a, b) => a.distance - b.distance);
            continue;
        }
        if (distance >= neighbors[neighbors.length - 1].distance) continue;
        neighbors[neighbors.length - 1] = { label: item.label, distance };
        neighbors.sort((a, b) => a.distance - b.distance);
    }

    const scores = new Map();
    for (const item of neighbors) {
        scores.set(item.label, (scores.get(item.label) || 0) + 1 / Math.max(0.02, item.distance));
    }
    return scores;
}

function getTemplateCodeScore(code, labelScores) {
    if (!code || code.length !== 4) return -Infinity;
    let score = 0;
    for (let i = 0; i < 4; i++) {
        const label = normalizeTemplateLabel(code[i]);
        score += labelScores[i].get(label) ?? -8;
    }
    return score;
}

function getTemplateTrainingSamples(model, mode) {
    const samples = model && Array.isArray(model.samples) ? model.samples : [];
    if (!model || !samples.length) return [];

    const cacheKey = mode || '__all__';
    if (!model._trainingCache) {
        Object.defineProperty(model, '_trainingCache', {
            value: Object.create(null),
            enumerable: false
        });
    }
    if (model._trainingCache[cacheKey]) return model._trainingCache[cacheKey];

    model._trainingCache[cacheKey] = samples
        .filter(item => !item.mode || item.mode === mode)
        .filter(item => item.label && item.vector && item.col && item.row);
    return model._trainingCache[cacheKey];
}

function getCandidateOcrEvidence(results, code) {
    const exact = results.filter(result => result.code && isSameCaptchaCode(result.code, code));
    const maxConfidence = exact.reduce((max, result) => Math.max(max, result.confidence || 0), 0);
    const support = exact.reduce((sum, result) => sum + (result.priority || 0) + Math.max(0, result.confidence || 0) / 25, 0);
    const variants = exact.map(result => result.variant);
    return { maxConfidence, support, variants };
}

function rerankCaptchaCodeWithTemplate(base, results, selectedCode, override = null) {
    const config = getTemplateRerankConfig(override);
    const model = config.model;
    const mode = config.mode || 'thin';
    const training = getTemplateTrainingSamples(model, mode);
    const debug = {
        enabled: Boolean(config.enabled),
        selectedBefore: selectedCode || '',
        selectedAfter: selectedCode || '',
        overridden: false,
        reason: 'disabled',
        candidates: []
    };

    if (!config.enabled) return debug;
    if (!training.length) {
        debug.reason = 'no-template-model';
        return debug;
    }

    const candidateMap = new Map();
    if (selectedCode && selectedCode.length === 4) {
        candidateMap.set(selectedCode, { code: selectedCode, source: 'selected' });
    }
    for (const result of results) {
        if (!result.code || result.code.length !== 4) continue;
        if (!candidateMap.has(result.code)) {
            candidateMap.set(result.code, { code: result.code, source: result.variant });
        }
    }
    if (!candidateMap.size) {
        debug.reason = 'no-whole-candidates';
        return debug;
    }

    const candidateLabels = [new Set(), new Set(), new Set(), new Set()];
    for (const item of candidateMap.values()) {
        for (let i = 0; i < 4; i++) {
            candidateLabels[i].add(normalizeTemplateLabel(item.code[i]));
        }
    }

    const features = extractCaptchaTemplateFeatures(base, mode);
    const labelScores = features.chars.map((feature, index) => {
        return scoreTemplateLabels(
            feature,
            training,
            Math.max(1, config.k || 5),
            Boolean(config.shiftDistance),
            config.allTemplateLabels ? null : candidateLabels[index]
        );
    });

    const selectedEvidence = getCandidateOcrEvidence(results, selectedCode || '');
    const currentTemplateScore = getTemplateCodeScore(selectedCode || '', labelScores);
    let best = {
        code: selectedCode || '',
        source: 'selected',
        templateScore: currentTemplateScore,
        ocrScore: selectedEvidence.maxConfidence * (config.ocrWeight || 0)
            + selectedEvidence.support * (config.supportWeight || 0),
        evidence: selectedEvidence
    };
    best.combinedScore = best.templateScore + best.ocrScore;

    for (const item of candidateMap.values()) {
        const evidence = getCandidateOcrEvidence(results, item.code);
        const templateScore = getTemplateCodeScore(item.code, labelScores);
        const ocrScore = evidence.maxConfidence * (config.ocrWeight || 0)
            + evidence.support * (config.supportWeight || 0);
        const candidate = {
            ...item,
            templateScore,
            ocrScore,
            combinedScore: templateScore + ocrScore,
            evidence
        };
        debug.candidates.push(candidate);
        if (candidate.combinedScore > best.combinedScore) best = candidate;
    }

    debug.candidates.sort((a, b) => b.combinedScore - a.combinedScore);
    const margin = Number(config.margin ?? 10);
    const currentCombinedScore = currentTemplateScore
        + selectedEvidence.maxConfidence * (config.ocrWeight || 0)
        + selectedEvidence.support * (config.supportWeight || 0);
    const advantage = best.combinedScore - currentCombinedScore;

    if (!best.code || best.code === selectedCode) {
        debug.reason = 'selected-still-best';
        return debug;
    }

    if (advantage < margin) {
        debug.reason = `margin-not-met:${advantage.toFixed(2)}<${margin}`;
        return debug;
    }

    if (config.protectHighConfidence
        && selectedEvidence.maxConfidence >= (config.highConfidenceThreshold || 88)
        && advantage < (config.highConfidenceMargin || 18)) {
        debug.reason = `protected-high-confidence:${Math.round(selectedEvidence.maxConfidence)}`;
        return debug;
    }

    const weakSingleVariantMargin = Number(config.weakSingleVariantMargin ?? 30);
    const weakSingleVariantConfidence = Number(config.weakSingleVariantConfidence ?? 0);
    if (config.protectWeakSingleVariant !== false
        && selectedCode
        && best.evidence
        && (best.evidence.maxConfidence || 0) <= weakSingleVariantConfidence
        && (best.evidence.variants || []).length <= 1
        && (best.evidence.support || 0) < (selectedEvidence.support || 0)
        && advantage < weakSingleVariantMargin) {
        debug.reason = `protected-weak-single-variant:${advantage.toFixed(2)}<${weakSingleVariantMargin}`;
        return debug;
    }

    debug.selectedAfter = best.code;
    debug.overridden = true;
    debug.reason = `template-rerank:${advantage.toFixed(2)}`;
    return debug;
}

function getCorrectionMask(base) {
    const variant = CAPTCHA_OCR_VARIANTS.find(item => item.name === 'loose-color') || CAPTCHA_OCR_VARIANTS[0];
    const mask = buildTextMask(base, variant);
    suppressInterferenceLines(mask, base, variant);
    removeDenseHorizontalRows(mask, base.width, base.height);
    filterSmallComponents(mask, base.width, base.height);
    bridgeOnePixelGaps(mask, base.width, base.height);
    return mask;
}

function collectRegionComponents(mask, width, height, x0, x1) {
    const seen = new Uint8Array(mask.length);
    const components = [];
    const stack = [];

    for (let y = 0; y < height; y++) {
        for (let x = x0; x <= x1; x++) {
            const start = y * width + x;
            if (!mask[start] || seen[start]) continue;

            let minX = x, maxX = x, minY = y, maxY = y;
            let area = 0;
            stack.push(start);
            seen[start] = 1;

            while (stack.length) {
                const p = stack.pop();
                area++;
                const px = p % width;
                const py = Math.floor(p / width);
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;

                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = px + dx, ny = py + dy;
                        if (nx < x0 || nx > x1 || ny < 0 || ny >= height) continue;
                        const np = ny * width + nx;
                        if (mask[np] && !seen[np]) {
                            seen[np] = 1;
                            stack.push(np);
                        }
                    }
                }
            }

            components.push({
                minX,
                maxX,
                minY,
                maxY,
                area,
                width: maxX - minX + 1,
                height: maxY - minY + 1
            });
        }
    }

    return components;
}

function isLikelyLowercaseJ(mask, width, height, charIndex, charCount) {
    const slotWidth = width / charCount;
    const x0 = Math.max(0, Math.floor(charIndex * slotWidth - slotWidth * 0.12));
    const x1 = Math.min(width - 1, Math.ceil((charIndex + 1) * slotWidth + slotWidth * 0.12));
    const components = collectRegionComponents(mask, width, height, x0, x1)
        .filter(component => component.area >= 2);

    if (!components.length) return false;

    const totalArea = components.reduce((sum, component) => sum + component.area, 0);
    const minY = Math.min(...components.map(component => component.minY));
    const maxY = Math.max(...components.map(component => component.maxY));
    const minX = Math.min(...components.map(component => component.minX));
    const maxX = Math.max(...components.map(component => component.maxX));
    const regionWidth = maxX - minX + 1;

    const topDot = components
        .filter(component => component.maxY <= height * 0.36)
        .filter(component => component.height <= height * 0.22)
        .filter(component => component.width <= slotWidth * 0.42)
        .filter(component => component.area <= Math.max(12, totalArea * 0.28))
        .sort((a, b) => b.area - a.area)[0];

    const mainComponents = topDot
        ? components.filter(component => component !== topDot)
        : components;
    const main = mainComponents.slice().sort((a, b) => b.area - a.area)[0];
    if (!main) return false;

    const reachesLow = maxY >= height * 0.70;
    const startsHigh = minY <= height * 0.42;
    const narrowBody = regionWidth <= slotWidth * 0.82;
    const separatedDot = topDot && topDot.maxY + 1 < main.minY;
    const dotAboveBody = topDot && topDot.maxY <= main.minY + height * 0.08;
    let midMinX = Infinity;
    let bottomMinX = Infinity;
    const midY0 = Math.max(0, Math.floor(minY + (maxY - minY + 1) * 0.36));
    const midY1 = Math.min(height - 1, Math.floor(minY + (maxY - minY + 1) * 0.66));
    const bottomY0 = Math.max(0, Math.floor(maxY - height * 0.14));

    for (let y = midY0; y <= midY1; y++) {
        for (let x = x0; x <= x1; x++) {
            if (mask[y * width + x] && x < midMinX) midMinX = x;
        }
    }
    for (let y = bottomY0; y <= maxY; y++) {
        for (let x = x0; x <= x1; x++) {
            if (mask[y * width + x] && x < bottomMinX) bottomMinX = x;
        }
    }

    const hasBottomHook = Number.isFinite(midMinX)
        && Number.isFinite(bottomMinX)
        && bottomMinX + 1 < midMinX;

    return reachesLow && startsHigh && narrowBody && hasBottomHook && (separatedDot || dotAboveBody);
}

function correctJFromShape(code, base, results, existingMask = null) {
    if (!/[pPiI]/.test(code)) return code;

    const mask = existingMask || getCorrectionMask(base);
    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === code.length);

    for (let i = 0; i < chars.length; i++) {
        if (!['p', 'P', 'i', 'I'].includes(chars[i])) continue;

        const candidateVotesJ = valid
            .filter(result => result.code[i] === 'j' || result.code[i] === 'J')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesP = valid
            .filter(result => result.code[i] === 'p' || result.code[i] === 'P')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (candidateVotesJ > candidateVotesP) {
            chars[i] = 'j';
            continue;
        }

        if (isLikelyLowercaseJ(mask, base.width, base.height, i, chars.length)) {
            chars[i] = 'j';
        }
    }

    return chars.join('');
}

function getCharRegion(mask, width, height, charIndex, charCount) {
    const slotWidth = width / charCount;
    const x0 = Math.max(0, Math.floor(charIndex * slotWidth - slotWidth * 0.10));
    const x1 = Math.min(width - 1, Math.ceil((charIndex + 1) * slotWidth + slotWidth * 0.10));
    const components = collectRegionComponents(mask, width, height, x0, x1)
        .filter(component => component.area >= 3);

    if (!components.length) return null;

    return {
        x0,
        x1,
        minX: Math.min(...components.map(component => component.minX)),
        maxX: Math.max(...components.map(component => component.maxX)),
        minY: Math.min(...components.map(component => component.minY)),
        maxY: Math.max(...components.map(component => component.maxY)),
        area: components.reduce((sum, component) => sum + component.area, 0)
    };
}

function getPrimaryCharRegion(mask, width, height, charIndex, charCount) {
    const slotWidth = width / charCount;
    const x0 = Math.max(0, Math.floor(charIndex * slotWidth - slotWidth * 0.10));
    const x1 = Math.min(width - 1, Math.ceil((charIndex + 1) * slotWidth + slotWidth * 0.10));
    const component = collectRegionComponents(mask, width, height, x0, x1)
        .filter(item => item.area >= 3)
        .sort((a, b) => b.area - a.area)[0];

    if (!component) return null;

    return {
        x0,
        x1,
        minX: component.minX,
        maxX: component.maxX,
        minY: component.minY,
        maxY: component.maxY,
        area: component.area
    };
}

function countPixelsInBox(mask, width, x0, x1, y0, y1) {
    let count = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            if (mask[y * width + x]) count++;
        }
    }
    return count;
}

function getRelativeBox(region, rx0, rx1, ry0, ry1) {
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    return {
        x0: region.minX + Math.floor((charW - 1) * rx0),
        x1: region.minX + Math.floor((charW - 1) * rx1),
        y0: region.minY + Math.floor((charH - 1) * ry0),
        y1: region.minY + Math.floor((charH - 1) * ry1)
    };
}

function countPixelsInRelativeBox(mask, width, region, rx0, rx1, ry0, ry1) {
    const box = getRelativeBox(region, rx0, rx1, ry0, ry1);
    if (box.x0 > box.x1 || box.y0 > box.y1) return 0;
    return countPixelsInBox(mask, width, box.x0, box.x1, box.y0, box.y1);
}

function getRelativeDensity(mask, width, region, rx0, rx1, ry0, ry1) {
    const box = getRelativeBox(region, rx0, rx1, ry0, ry1);
    if (box.x0 > box.x1 || box.y0 > box.y1) return 0;
    const area = (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1);
    return countPixelsInBox(mask, width, box.x0, box.x1, box.y0, box.y1) / Math.max(area, 1);
}

function getLongestHorizontalRun(mask, width, region, ry0, ry1) {
    const charH = region.maxY - region.minY + 1;
    const y0 = region.minY + Math.floor(charH * ry0);
    const y1 = region.minY + Math.floor(charH * ry1);
    let longest = 0;

    for (let y = y0; y <= y1; y++) {
        let run = 0;
        for (let x = region.minX; x <= region.maxX; x++) {
            if (mask[y * width + x]) {
                run++;
                if (run > longest) longest = run;
            } else {
                run = 0;
            }
        }
    }

    return longest;
}

function countColumnInkClusters(mask, width, region, ry0, ry1) {
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    const y0 = region.minY + Math.floor(charH * ry0);
    const y1 = region.minY + Math.floor(charH * ry1);
    const bandH = y1 - y0 + 1;
    const counts = [];

    for (let x = region.minX; x <= region.maxX; x++) {
        counts.push(countPixelsInBox(mask, width, x, x, y0, y1));
    }

    const threshold = Math.max(2, Math.ceil(bandH * 0.20));
    const minClusterWidth = Math.max(1, Math.floor(charW * 0.07));
    let clusters = 0;
    let currentWidth = 0;

    for (let i = 0; i <= counts.length; i++) {
        const left = i >= counts.length ? 0 : (counts[i - 1] || 0);
        const center = i >= counts.length ? 0 : (counts[i] || 0);
        const right = i >= counts.length ? 0 : (counts[i + 1] || 0);
        const smoothed = (left + center * 2 + right) / 4;

        if (smoothed >= threshold) {
            currentWidth++;
        } else {
            if (currentWidth >= minClusterWidth) clusters++;
            currentWidth = 0;
        }
    }

    return clusters;
}

function isLikelyDigitFive(mask, width, height, charIndex, charCount) {
    const region = getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.42 || charW < slotWidth * 0.28) return false;

    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.25);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.36, 0.62);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.72, 1);
    const topDensity = getRelativeDensity(mask, width, region, 0.10, 0.92, 0, 0.24);
    const midDensity = getRelativeDensity(mask, width, region, 0.08, 0.92, 0.38, 0.60);
    const upperLeft = getRelativeDensity(mask, width, region, 0, 0.38, 0.18, 0.48);
    const upperRight = getRelativeDensity(mask, width, region, 0.62, 1, 0.18, 0.50);
    const lowerLeft = getRelativeDensity(mask, width, region, 0, 0.40, 0.54, 0.84);
    const lowerRight = getRelativeDensity(mask, width, region, 0.60, 1, 0.50, 0.90);

    const hasTopBar = topRun >= charW * 0.42 && topDensity >= 0.12;
    const hasMiddleBar = midRun >= charW * 0.36 && midDensity >= 0.10;
    const hasBottomCurve = bottomRun >= charW * 0.26;
    const fiveSidePattern = upperLeft >= Math.max(0.11, upperRight + 0.025)
        && lowerRight >= Math.max(0.10, lowerLeft + 0.01);

    return hasTopBar && hasMiddleBar && hasBottomCurve && fiveSidePattern;
}

function isLikelyRightHeavyDigitFive(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount)
        || getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.42 || charW < slotWidth * 0.28) return false;

    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.25);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.36, 0.62);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.72, 1);
    const upperLeft = getRelativeDensity(mask, width, region, 0, 0.38, 0.18, 0.48);
    const upperRight = getRelativeDensity(mask, width, region, 0.62, 1, 0.18, 0.50);
    const lowerLeft = getRelativeDensity(mask, width, region, 0, 0.40, 0.54, 0.84);
    const lowerRight = getRelativeDensity(mask, width, region, 0.60, 1, 0.50, 0.90);

    return topRun >= charW * 0.42
        && midRun >= charW * 0.34
        && bottomRun >= charW * 0.26
        && lowerRight >= 0.50
        && lowerLeft <= 0.24
        && lowerRight >= lowerLeft + 0.28
        && (upperLeft <= 0.28 || upperRight <= 0.25);
}

function isLikelyDigitSeven(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.38 || charW < slotWidth * 0.30) return false;

    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.24);
    const leftUpper = getRelativeDensity(mask, width, region, 0, 0.34, 0.18, 0.58);
    const rightUpper = getRelativeDensity(mask, width, region, 0.60, 1, 0.18, 0.58);
    const lowerLeft = getRelativeDensity(mask, width, region, 0, 0.42, 0.58, 1);
    const lowerRight = getRelativeDensity(mask, width, region, 0.58, 1, 0.58, 1);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.36, 0.64);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.76, 1);

    return topRun >= charW * 0.45
        && rightUpper >= Math.max(0.10, leftUpper + 0.02)
        && lowerLeft >= Math.max(0.08, lowerRight - 0.02)
        && midRun <= charW * 0.48
        && bottomRun <= charW * 0.42;
}

function isLikelyDigitSix(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount)
        || getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.42 || charW < slotWidth * 0.30) return false;

    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.24);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.36, 0.64);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.70, 1);
    const left = getRelativeDensity(mask, width, region, 0, 0.30, 0.10, 0.90);
    const right = getRelativeDensity(mask, width, region, 0.70, 1, 0.10, 0.90);
    const upperLeft = getRelativeDensity(mask, width, region, 0, 0.38, 0.18, 0.48);
    const upperRight = getRelativeDensity(mask, width, region, 0.62, 1, 0.18, 0.50);
    const lowerLeft = getRelativeDensity(mask, width, region, 0, 0.40, 0.54, 0.84);
    const lowerRight = getRelativeDensity(mask, width, region, 0.60, 1, 0.50, 0.90);

    return topRun >= charW * 0.42
        && midRun >= charW * 0.48
        && bottomRun >= charW * 0.42
        && left >= 0.55
        && upperLeft >= upperRight + 0.35
        && upperRight <= 0.25
        && lowerLeft >= 0.58
        && lowerRight >= 0.45
        && left >= right + 0.18;
}

function correctDigitSixFromShape(code, base, mask) {
    if (!/[bB]/.test(code)) return code;

    const chars = code.split('');
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'b' && chars[i] !== 'B') continue;

        if (isLikelyDigitSix(mask, base.width, base.height, i, chars.length)) {
            chars[i] = '6';
        }
    }

    return chars.join('');
}

function isLikelyRightSideUppercaseB(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount)
        || getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.42 || charW < slotWidth * 0.28) return false;

    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.24);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.36, 0.64);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.70, 1);
    const left = getRelativeDensity(mask, width, region, 0, 0.30, 0.10, 0.90);
    const right = getRelativeDensity(mask, width, region, 0.70, 1, 0.10, 0.90);
    const upperRight = getRelativeDensity(mask, width, region, 0.62, 1, 0.18, 0.50);
    const lowerRight = getRelativeDensity(mask, width, region, 0.60, 1, 0.50, 0.90);
    const center = getRelativeDensity(mask, width, region, 0.36, 0.64, 0.18, 0.82);

    return right >= 0.55
        && left <= 0.22
        && upperRight >= 0.55
        && lowerRight >= 0.52
        && center >= 0.70
        && topRun >= charW * 0.50
        && bottomRun >= charW * 0.55
        && midRun <= bottomRun + 2;
}

function correctUppercaseBFromShape(code, base, mask) {
    if (!/8/.test(code)) return code;

    const chars = code.split('');
    let colorMask = null;
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== '8') continue;

        let shapeLooksLikeB = isLikelyRightSideUppercaseB(mask, base.width, base.height, i, chars.length);
        if (!shapeLooksLikeB) {
            colorMask = colorMask || buildColorClusterMask(base);
            shapeLooksLikeB = isLikelyRightSideUppercaseB(colorMask, base.width, base.height, i, chars.length);
        }
        if (shapeLooksLikeB) {
            chars[i] = 'B';
        }
    }

    return chars.join('');
}

function isLikelyDigitFour(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount)
        || getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.42 || charW < slotWidth * 0.30) return false;

    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.24);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.36, 0.64);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.70, 1);
    const midCenter = getRelativeDensity(mask, width, region, 0.22, 0.78, 0.36, 0.64);
    const bottomCenter = getRelativeDensity(mask, width, region, 0.22, 0.78, 0.70, 1);

    return midRun >= charW * 0.62
        && topRun <= charW * 0.45
        && bottomRun <= charW * 0.36
        && midCenter >= 0.65
        && bottomCenter <= 0.42;
}

function isLikelyStrongDigitFour(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount)
        || getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.42 || charW < slotWidth * 0.30) return false;

    const midRun = getLongestHorizontalRun(mask, width, region, 0.36, 0.64);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.70, 1);
    const midCenter = getRelativeDensity(mask, width, region, 0.22, 0.78, 0.36, 0.64);
    const bottomCenter = getRelativeDensity(mask, width, region, 0.22, 0.78, 0.70, 1);

    return midRun >= charW * 0.62
        && bottomRun <= charW * 0.36
        && midCenter >= 0.64
        && bottomCenter <= 0.30;
}

function correctDigitFourFromShape(code, base, results, mask) {
    if (!/[dD]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);
    let colorMask = null;

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'd' && chars[i] !== 'D') continue;

        let shapeLooksLikeFour = isLikelyDigitFour(mask, base.width, base.height, i, chars.length);
        let strongShapeLooksLikeFour = isLikelyStrongDigitFour(mask, base.width, base.height, i, chars.length);
        if (!shapeLooksLikeFour && !strongShapeLooksLikeFour) {
            colorMask = colorMask || buildColorClusterMask(base);
            shapeLooksLikeFour = isLikelyDigitFour(colorMask, base.width, base.height, i, chars.length);
            strongShapeLooksLikeFour = isLikelyStrongDigitFour(colorMask, base.width, base.height, i, chars.length);
        }

        const hasFourProxyCandidate = valid.some(result => {
            return (result.code[i] === 'A' || result.code[i] === '4')
                && countSameOtherPositions(chars, result.code, i) >= 2;
        });
        if ((shapeLooksLikeFour && hasFourProxyCandidate) || strongShapeLooksLikeFour) {
            chars[i] = '4';
        }
    }

    return chars.join('');
}

function correctDigitFiveFromShape(code, base, results, mask) {
    if (!/[SsZz]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);
    let colorMask = null;

    for (let i = 0; i < chars.length; i++) {
        if (!['S', 's', 'Z', 'z'].includes(chars[i])) continue;

        const candidateVotes5 = valid
            .filter(result => result.code[i] === '5')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotes7 = valid
            .filter(result => result.code[i] === '7')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesS = valid
            .filter(result => result.code[i] === 'S' || result.code[i] === 's' || result.code[i] === 'Z' || result.code[i] === 'z')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (candidateVotes7 > candidateVotesS + 1 || isLikelyDigitSeven(mask, base.width, base.height, i, chars.length)) {
            chars[i] = '7';
            continue;
        }

        if (candidateVotes5 > candidateVotesS) {
            chars[i] = '5';
            continue;
        }

        const shapeLooksLikeFive = isLikelyDigitFive(mask, base.width, base.height, i, chars.length);
        let strongShapeLooksLikeFive = isLikelyRightHeavyDigitFive(mask, base.width, base.height, i, chars.length);
        if (!strongShapeLooksLikeFive) {
            colorMask = colorMask || buildColorClusterMask(base);
            strongShapeLooksLikeFive = isLikelyRightHeavyDigitFive(colorMask, base.width, base.height, i, chars.length);
        }
        const hasUsefulCandidate = candidateVotes5 > 0 && candidateVotes5 + 1.5 >= candidateVotesS;
        if ((shapeLooksLikeFive || strongShapeLooksLikeFive)
            && hasUsefulCandidate) {
            chars[i] = '5';
        }
    }

    return chars.join('');
}

function isLikelyUppercaseD(mask, width, height, charIndex, charCount) {
    const region = getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.45 || charW < (width / charCount) * 0.36) return false;

    const leftX1 = Math.min(region.maxX, region.minX + Math.max(1, Math.floor(charW * 0.28)));
    const rightX0 = Math.max(region.minX, region.maxX - Math.max(1, Math.floor(charW * 0.26)));
    const innerX0 = Math.min(region.maxX, region.minX + Math.max(1, Math.floor(charW * 0.36)));
    const innerX1 = Math.max(region.minX, region.maxX - Math.max(1, Math.floor(charW * 0.30)));
    const midY0 = region.minY + Math.floor(charH * 0.38);
    const midY1 = region.minY + Math.floor(charH * 0.62);

    if (innerX0 > innerX1 || midY0 > midY1) return false;

    const leftPixels = countPixelsInBox(mask, width, region.minX, leftX1, region.minY, region.maxY);
    const rightMidPixels = countPixelsInBox(mask, width, rightX0, region.maxX, midY0, midY1);
    const innerMidPixels = countPixelsInBox(mask, width, innerX0, innerX1, midY0, midY1);

    const leftArea = (leftX1 - region.minX + 1) * charH;
    const rightMidArea = (region.maxX - rightX0 + 1) * (midY1 - midY0 + 1);
    const innerMidArea = (innerX1 - innerX0 + 1) * (midY1 - midY0 + 1);

    const hasLeftStem = leftPixels / Math.max(leftArea, 1) >= 0.22;
    const hasRightCurve = rightMidPixels / Math.max(rightMidArea, 1) >= 0.18;
    const sparseWaist = innerMidPixels / Math.max(innerMidArea, 1) <= 0.22;

    return hasLeftStem && hasRightCurve && sparseWaist;
}

function correctDFromShape(code, base, results, mask) {
    if (!/[Bb]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);
    let colorMask = null;

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'B' && chars[i] !== 'b') continue;

        const candidateVotesD = valid
            .filter(result => result.code[i] === 'D' || result.code[i] === 'd')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesB = valid
            .filter(result => result.code[i] === 'B' || result.code[i] === 'b')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (chars[i] === 'B') {
            if (candidateVotesD > candidateVotesB + 1.5) {
                chars[i] = 'D';
            }
            continue;
        }

        const looseLooksLikeD = isLikelyUppercaseD(mask, base.width, base.height, i, chars.length);
        if (!colorMask && candidateVotesD > 0) {
            colorMask = buildColorClusterMask(base);
        }
        const colorLooksLikeD = colorMask
            ? isLikelyUppercaseD(colorMask, base.width, base.height, i, chars.length)
            : false;

        if (candidateVotesD > candidateVotesB + 1 || (candidateVotesD > 0 && (looseLooksLikeD || colorLooksLikeD))) {
            chars[i] = 'D';
        }
    }

    return chars.join('');
}

function isLikelyLowercaseM(mask, width, height, charIndex, charCount) {
    const region = getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.32 || charW < slotWidth * 0.46) return false;

    const lowerClusters = countColumnInkClusters(mask, width, region, 0.36, 1);
    const lowerLeft = getRelativeDensity(mask, width, region, 0, 0.30, 0.36, 1);
    const lowerMiddle = getRelativeDensity(mask, width, region, 0.34, 0.64, 0.36, 1);
    const lowerRight = getRelativeDensity(mask, width, region, 0.68, 1, 0.36, 1);
    const centerStem = getRelativeDensity(mask, width, region, 0.38, 0.58, 0.42, 1);
    const wideEnough = charW >= Math.max(slotWidth * 0.50, charH * 0.56);

    return wideEnough
        && lowerClusters >= 3
        && lowerLeft >= 0.10
        && lowerMiddle >= 0.08
        && lowerRight >= 0.08
        && centerStem >= 0.09;
}

function correctMFromShape(code, base, results, mask) {
    if (!/[Nn]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'n' && chars[i] !== 'N') continue;

        const candidateVotesM = valid
            .filter(result => result.code[i] === 'm' || result.code[i] === 'M')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesN = valid
            .filter(result => result.code[i] === 'n' || result.code[i] === 'N')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (candidateVotesM > candidateVotesN) {
            chars[i] = chars[i] === 'N' ? 'M' : 'm';
            continue;
        }

        if (candidateVotesM > 0 && isLikelyLowercaseM(mask, base.width, base.height, i, chars.length)) {
            chars[i] = chars[i] === 'N' ? 'M' : 'm';
        }
    }

    return chars.join('');
}

function isLikelyUppercaseU(mask, width, height, charIndex, charCount) {
    const region = getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.45 || charW < slotWidth * 0.42) return false;

    const leftStem = getRelativeDensity(mask, width, region, 0, 0.28, 0.12, 0.82);
    const rightStem = getRelativeDensity(mask, width, region, 0.72, 1, 0.12, 0.82);
    const topCenter = getRelativeDensity(mask, width, region, 0.32, 0.68, 0, 0.28);
    const midCenter = getRelativeDensity(mask, width, region, 0.34, 0.66, 0.30, 0.70);
    const bottomBridge = getRelativeDensity(mask, width, region, 0.18, 0.82, 0.72, 1);
    const upperSideClusters = countColumnInkClusters(mask, width, region, 0.12, 0.68);

    return region.minY <= height * 0.26
        && region.maxY >= height * 0.62
        && leftStem >= 0.12
        && rightStem >= 0.12
        && bottomBridge >= 0.13
        && topCenter <= 0.16
        && midCenter <= 0.16
        && upperSideClusters >= 2;
}

function correctUFromShape(code, base, results, mask) {
    if (!/[tT]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 't' && chars[i] !== 'T') continue;

        const candidateVotesU = valid
            .filter(result => result.code[i] === 'U' || result.code[i] === 'u')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesT = valid
            .filter(result => result.code[i] === 't' || result.code[i] === 'T')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (candidateVotesU > candidateVotesT + 1 || isLikelyUppercaseU(mask, base.width, base.height, i, chars.length)) {
            chars[i] = 'U';
        }
    }

    return chars.join('');
}

function isLikelyUppercaseJ(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.46 || charW > slotWidth * 0.72) return false;

    const topCenter = getRelativeDensity(mask, width, region, 0.22, 0.88, 0, 0.22);
    const upperLeft = getRelativeDensity(mask, width, region, 0, 0.34, 0.10, 0.58);
    const upperRight = getRelativeDensity(mask, width, region, 0.58, 1, 0.10, 0.70);
    const bottomLeft = getRelativeDensity(mask, width, region, 0, 0.46, 0.66, 1);
    const bottomRight = getRelativeDensity(mask, width, region, 0.54, 1, 0.66, 1);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.70, 1);
    const lowerClusters = countColumnInkClusters(mask, width, region, 0.18, 1);

    return region.minY <= height * 0.24
        && region.maxY >= height * 0.64
        && upperRight >= Math.max(0.10, upperLeft + 0.02)
        && bottomLeft >= 0.10
        && bottomRight >= 0.10
        && bottomRun >= charW * 0.32
        && topCenter >= 0.08
        && lowerClusters <= 2;
}

function correctUppercaseJFromShape(code, base, results, mask) {
    if (!/[iIl1]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (!['i', 'I', 'l', '1'].includes(chars[i])) continue;

        const candidateVotesJ = valid
            .filter(result => result.code[i] === 'J' || result.code[i] === 'j')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesI = valid
            .filter(result => result.code[i] === 'i' || result.code[i] === 'I' || result.code[i] === 'l' || result.code[i] === '1')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (candidateVotesJ > candidateVotesI + 1 || isLikelyUppercaseJ(mask, base.width, base.height, i, chars.length)) {
            chars[i] = 'J';
        }
    }

    return chars.join('');
}

function isLikelyUppercaseP(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.48 || charW < slotWidth * 0.34) return false;

    const leftStem = getRelativeDensity(mask, width, region, 0, 0.30, 0, 1);
    const upperRight = getRelativeDensity(mask, width, region, 0.52, 1, 0, 0.48);
    const lowerRight = getRelativeDensity(mask, width, region, 0.54, 1, 0.56, 1);
    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.24);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.34, 0.60);

    return region.minY <= height * 0.24
        && region.maxY >= height * 0.60
        && leftStem >= 0.16
        && upperRight >= 0.11
        && lowerRight <= upperRight + 0.08
        && topRun >= charW * 0.32
        && midRun >= charW * 0.30;
}

function isLikelyLowercaseH(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.42 || charW < slotWidth * 0.30) return false;

    const leftStem = getRelativeDensity(mask, width, region, 0, 0.30, 0, 1);
    const topRight = getRelativeDensity(mask, width, region, 0.52, 1, 0, 0.28);
    const midRight = getRelativeDensity(mask, width, region, 0.48, 1, 0.32, 0.72);
    const lowerRight = getRelativeDensity(mask, width, region, 0.54, 1, 0.62, 1);
    const midBridge = getRelativeDensity(mask, width, region, 0.28, 0.72, 0.34, 0.64);
    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.24);

    return leftStem >= 0.15
        && midBridge >= 0.08
        && midRight >= 0.10
        && lowerRight >= 0.08
        && topRight <= midRight + 0.04
        && topRun <= charW * 0.58
        && region.maxY >= height * 0.58;
}

function correctPAndHFromShape(code, base, results, mask) {
    if (!/[pPFrR]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] === 'F') {
            const candidateVotesP = valid
                .filter(result => result.code[i] === 'P' || result.code[i] === 'p')
                .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
            const candidateVotesF = valid
                .filter(result => result.code[i] === 'F' || result.code[i] === 'f')
                .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

            if (candidateVotesP > candidateVotesF + 1
                || (candidateVotesP > 0 && isLikelyUppercaseP(mask, base.width, base.height, i, chars.length))) {
                chars[i] = 'P';
            }
            continue;
        }

        if (chars[i] === 'p') {
            const candidateVotesP = valid
                .filter(result => result.code[i] === 'P')
                .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
            const candidateVotesLowerP = valid
                .filter(result => result.code[i] === 'p')
                .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

            if (candidateVotesP > candidateVotesLowerP + 1 || isLikelyUppercaseP(mask, base.width, base.height, i, chars.length)) {
                chars[i] = 'P';
            }
            continue;
        }

        if (chars[i] === 'P') {
            const candidateVotesH = valid
                .filter(result => result.code[i] === 'h' || result.code[i] === 'H')
                .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
            const candidateVotesP = valid
                .filter(result => result.code[i] === 'P' || result.code[i] === 'p')
                .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

            if (candidateVotesH > candidateVotesP + 1 || isLikelyLowercaseH(mask, base.width, base.height, i, chars.length)) {
                chars[i] = 'h';
            }
            continue;
        }

        // r/R 可能被误识别为 P：当多个候选投票给 P 且形状也像 P 时纠正
        if (chars[i] === 'r' || chars[i] === 'R') {
            const candidateVotesP = valid
                .filter(result => result.code[i] === 'P' || result.code[i] === 'p')
                .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
            const candidateVotesR = valid
                .filter(result => result.code[i] === 'r' || result.code[i] === 'R')
                .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

            if (candidateVotesP > candidateVotesR
                && isLikelyUppercaseP(mask, base.width, base.height, i, chars.length)) {
                chars[i] = 'P';
            }
        }
    }

    return chars.join('');
}

function isLikelyUppercaseF(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    const leftStem = getRelativeDensity(mask, width, region, 0, 0.30, 0, 1);
    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.24);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.34, 0.62);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.74, 1);
    const lowerRight = getRelativeDensity(mask, width, region, 0.52, 1, 0.62, 1);

    return charH >= height * 0.42
        && leftStem >= 0.14
        && topRun >= charW * 0.34
        && midRun >= charW * 0.28
        && bottomRun <= charW * 0.36
        && lowerRight <= 0.14;
}

function isLikelyUppercaseL(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    const leftStem = getRelativeDensity(mask, width, region, 0, 0.32, 0, 1);
    const topRun = getLongestHorizontalRun(mask, width, region, 0, 0.24);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.34, 0.62);
    const bottomRun = getLongestHorizontalRun(mask, width, region, 0.70, 1);
    const upperRight = getRelativeDensity(mask, width, region, 0.52, 1, 0, 0.52);

    return charH >= height * 0.42
        && leftStem >= 0.14
        && bottomRun >= charW * 0.36
        && topRun <= charW * 0.40
        && midRun <= charW * 0.36
        && upperRight <= 0.16;
}

function isLikelyDigitEight(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    const left = getRelativeDensity(mask, width, region, 0, 0.30, 0.10, 0.90);
    const right = getRelativeDensity(mask, width, region, 0.70, 1, 0.10, 0.90);
    const top = getRelativeDensity(mask, width, region, 0.20, 0.80, 0, 0.25);
    const middle = getRelativeDensity(mask, width, region, 0.20, 0.80, 0.36, 0.64);
    const bottom = getRelativeDensity(mask, width, region, 0.20, 0.80, 0.72, 1);
    const centerGap = getRelativeDensity(mask, width, region, 0.36, 0.64, 0.18, 0.82);

    return charH >= height * 0.42
        && charW >= (width / charCount) * 0.30
        && left >= 0.12
        && right >= 0.12
        && top >= 0.10
        && middle >= 0.09
        && bottom >= 0.10
        && centerGap <= 0.36;
}

function isLikelyDenseDigitEight(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    const slotWidth = width / charCount;
    const right = getRelativeDensity(mask, width, region, 0.70, 1, 0.10, 0.90);
    const middle = getRelativeDensity(mask, width, region, 0.20, 0.80, 0.36, 0.64);
    const bottom = getRelativeDensity(mask, width, region, 0.20, 0.80, 0.72, 1);
    const lowerLeft = getRelativeDensity(mask, width, region, 0, 0.45, 0.55, 1);
    const lowerRight = getRelativeDensity(mask, width, region, 0.55, 1, 0.55, 1);

    return charH >= height * 0.36
        && charW >= slotWidth * 0.44
        && right >= 0.62
        && middle >= 0.70
        && bottom >= 0.66
        && lowerLeft >= 0.62
        && lowerRight >= 0.62;
}

function correctEFamilyFromShape(code, base, results, mask) {
    if (!/[EBe]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);
    let colorMask = null;

    for (let i = 0; i < chars.length; i++) {
        if (!['E', 'B', 'e'].includes(chars[i])) continue;

        const candidateVotesF = valid
            .filter(result => result.code[i] === 'F' || result.code[i] === 'f')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesL = valid
            .filter(result => result.code[i] === 'L' || result.code[i] === 'l')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotes8 = valid
            .filter(result => result.code[i] === '8')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesCurrent = valid
            .filter(result => result.code[i] === chars[i])
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (candidateVotesF > candidateVotesCurrent + 1
            || (candidateVotesF > 0 && isLikelyUppercaseF(mask, base.width, base.height, i, chars.length))) {
            chars[i] = 'F';
            continue;
        }
        let shapeLooksLikeL = isLikelyUppercaseL(mask, base.width, base.height, i, chars.length);
        if (!shapeLooksLikeL) {
            colorMask = colorMask || buildColorClusterMask(base);
            shapeLooksLikeL = isLikelyUppercaseL(colorMask, base.width, base.height, i, chars.length);
        }
        if (candidateVotesL > candidateVotesCurrent + 1
            || (candidateVotesL > 0 && shapeLooksLikeL && candidateVotesL >= candidateVotesCurrent - 1.5)) {
            chars[i] = 'L';
            continue;
        }
        const shapeLooksLikeEight = isLikelyDigitEight(mask, base.width, base.height, i, chars.length);
        if (candidateVotes8 > candidateVotesCurrent + 1
            || (candidateVotes8 > 0 && shapeLooksLikeEight && candidateVotes8 >= candidateVotesCurrent - 1.5)) {
            chars[i] = '8';
        }
    }

    return chars.join('');
}

function correctDenseEightFromShape(code, base, results = []) {
    if (!/[EBe]/.test(code)) return code;

    const mask = buildColorClusterMask(base);
    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (!['E', 'B', 'e'].includes(chars[i])) continue;

        const candidateVotes8 = valid
            .filter(result => result.code[i] === '8')
            .reduce((score, result) => score + getVariantEvidenceScore(result), 0);
        const candidateVotesCurrent = valid
            .filter(result => isSameCaptchaChar(result.code[i], chars[i]))
            .reduce((score, result) => score + getVariantEvidenceScore(result), 0);
        const hasNearEightCandidate = valid.some(result => {
            return result.code[i] === '8'
                && countSameOtherPositions(chars, result.code, i) >= 2;
        });

        if (hasNearEightCandidate
            && candidateVotes8 >= candidateVotesCurrent - 1.5
            && isLikelyDenseDigitEight(mask, base.width, base.height, i, chars.length)) {
            chars[i] = '8';
        }
    }

    return chars.join('');
}

function isLikelyUppercaseSimpleShape(mask, width, height, charIndex, charCount) {
    const region = getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const charHeight = region.maxY - region.minY + 1;

    return region.minY <= height * 0.25
        && region.maxY >= height * 0.62
        && charHeight >= height * 0.48;
}

function isLikelyLowercaseI(mask, width, height, charIndex, charCount) {
    const slotWidth = width / charCount;
    const x0 = Math.max(0, Math.floor(charIndex * slotWidth - slotWidth * 0.10));
    const x1 = Math.min(width - 1, Math.ceil((charIndex + 1) * slotWidth + slotWidth * 0.10));
    const components = collectRegionComponents(mask, width, height, x0, x1)
        .filter(component => component.area >= 2);

    if (!components.length) return false;

    const totalArea = components.reduce((sum, component) => sum + component.area, 0);
    const topDot = components
        .filter(component => component.maxY <= height * 0.34)
        .filter(component => component.height <= height * 0.20)
        .filter(component => component.width <= slotWidth * 0.38)
        .filter(component => component.area <= Math.max(10, totalArea * 0.30))
        .sort((a, b) => b.area - a.area)[0];

    const bodyComponents = topDot ? components.filter(component => component !== topDot) : components;
    const body = bodyComponents.slice().sort((a, b) => b.area - a.area)[0];
    if (!body) return false;

    const region = {
        minX: Math.min(...bodyComponents.map(component => component.minX)),
        maxX: Math.max(...bodyComponents.map(component => component.maxX)),
        minY: Math.min(...bodyComponents.map(component => component.minY)),
        maxY: Math.max(...bodyComponents.map(component => component.maxY)),
        area: bodyComponents.reduce((sum, component) => sum + component.area, 0)
    };
    const bodyWidth = region.maxX - region.minX + 1;
    const bodyHeight = region.maxY - region.minY + 1;
    const lowerClusters = countColumnInkClusters(mask, width, region, 0.20, 1);
    const centerDensity = getRelativeDensity(mask, width, region, 0.34, 0.66, 0.05, 1);
    const leftDensity = getRelativeDensity(mask, width, region, 0, 0.26, 0.05, 1);
    const rightDensity = getRelativeDensity(mask, width, region, 0.74, 1, 0.05, 1);
    const bottomLeft = getRelativeDensity(mask, width, region, 0, 0.40, 0.72, 1);
    const bottomRight = getRelativeDensity(mask, width, region, 0.60, 1, 0.72, 1);

    const narrowBody = bodyWidth <= slotWidth * 0.48;
    const reachesBaseline = region.maxY >= height * 0.58;
    const startsBelowDot = !topDot || body.minY >= topDot.maxY;
    const mostlyOneStem = bodyWidth <= 4
        ? lowerClusters <= 2 && centerDensity >= 0.10
        : lowerClusters <= 2
            && centerDensity >= Math.max(0.10, leftDensity + 0.015)
            && centerDensity >= Math.max(0.10, rightDensity + 0.015);
    const noJHook = bottomLeft <= bottomRight + 0.08;

    return Boolean(topDot)
        && narrowBody
        && bodyHeight >= height * 0.28
        && reachesBaseline
        && startsBelowDot
        && mostlyOneStem
        && noJHook;
}

function correctIFromShape(code, base, results, mask) {
    if (!/[HErR]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (!['H', 'E', 'r', 'R'].includes(chars[i])) continue;

        const candidateVotesI = valid
            .filter(result => result.code[i] === 'i' || result.code[i] === 'I' || result.code[i] === 'l' || result.code[i] === '1')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesCurrent = valid
            .filter(result => result.code[i] === chars[i])
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (candidateVotesI > candidateVotesCurrent + 1) {
            chars[i] = 'i';
            continue;
        }

        if (isLikelyLowercaseI(mask, base.width, base.height, i, chars.length)) {
            chars[i] = 'i';
        }
    }

    return chars.join('');
}

function correctCaseFromCandidates(code, results) {
    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (!/[a-zA-Z]/.test(chars[i])) continue;

        let upperScore = 0;
        let lowerScore = 0;
        for (const result of valid) {
            const candidate = result.code[i];
            if (!candidate || candidate.toLowerCase() !== chars[i].toLowerCase()) continue;

            const score = result.priority + Math.max(0, result.confidence || 0) / 25;
            if (candidate === candidate.toUpperCase()) {
                upperScore += score;
            } else {
                lowerScore += score;
            }
        }

        if (upperScore > lowerScore + 1) chars[i] = chars[i].toUpperCase();
        if (lowerScore > upperScore + 1) chars[i] = chars[i].toLowerCase();
    }

    return chars.join('');
}

function countSameOtherPositions(code, candidate, charIndex) {
    let matches = 0;
    for (let i = 0; i < code.length; i++) {
        if (i === charIndex) continue;
        if (isSameCaptchaChar(code[i], candidate[i])) matches++;
    }
    return matches;
}

function correctGFromSimilarCandidate(code, results) {
    if (!/[Cc]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'C' && chars[i] !== 'c') continue;

        const similarG = valid.some(result => {
            return (result.code[i] === 'G' || result.code[i] === 'g')
                && countSameOtherPositions(chars, result.code, i) >= 3;
        });
        const similarC = valid.some(result => {
            return result.code !== code
                && (result.code[i] === 'C' || result.code[i] === 'c')
                && countSameOtherPositions(chars, result.code, i) >= 3;
        });

        if (similarG && !similarC) {
            chars[i] = 'G';
        }
    }

    return chars.join('');
}

function isCompatibleCaptchaChar(a, b) {
    if (isSameCaptchaChar(a, b)) return true;
    const pair = `${a}${b}`;
    return pair === 'PF' || pair === 'FP' || pair === 'pF' || pair === 'Fp';
}

function countCompatibleOtherPositions(code, candidate, charIndex) {
    let matches = 0;
    for (let i = 0; i < code.length; i++) {
        if (i === charIndex) continue;
        if (isCompatibleCaptchaChar(code[i], candidate[i])) matches++;
    }
    return matches;
}

function correctQFromCompatibleCandidate(code, results) {
    if (!/g/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'g') continue;

        const compatibleQ = valid.some(result => {
            return result.code[i] === 'q'
                && countCompatibleOtherPositions(chars, result.code, i) >= 3;
        });

        if (compatibleQ) {
            chars[i] = 'q';
        }
    }

    return chars.join('');
}

function correctQFromSimilarCandidate(code, results) {
    if (!/[yY]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'y' && chars[i] !== 'Y') continue;

        const similarQ = valid.some(result => {
            return (result.code[i] === 'q' || result.code[i] === 'Q')
                && countSameOtherPositions(chars, result.code, i) >= 3;
        });

        if (similarQ) {
            chars[i] = 'q';
        }
    }

    return chars.join('');
}

function correctPFromSimilarCandidate(code, results) {
    if (!/[EF]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'E' && chars[i] !== 'F') continue;

        const similarP = valid.some(result => {
            return (result.code[i] === 'P' || result.code[i] === 'p')
                && countSameOtherPositions(chars, result.code, i) >= 3;
        });

        if (similarP) {
            chars[i] = 'P';
        }
    }

    return chars.join('');
}

function correctDigitSevenFromSimilarCandidate(code, results) {
    if (!/[AZ]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'A' && chars[i] !== 'Z') continue;

        const similarSeven = valid.some(result => {
            return result.code[i] === '7'
                && countSameOtherPositions(chars, result.code, i) >= 3;
        });

        if (similarSeven) {
            chars[i] = '7';
        }
    }

    return chars.join('');
}

function correctTFromSimilarCandidate(code, results) {
    if (!/[rR]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'r' && chars[i] !== 'R') continue;

        const similarT = valid.filter(result => {
            return (result.code[i] === 'T' || result.code[i] === 't')
                && countSameOtherPositions(chars, result.code, i) >= 2;
        });
        if (!similarT.length) continue;

        const tScore = similarT.reduce((score, result) => {
            return score
                + result.priority
                + Math.max(0, result.confidence || 0) / 25
                + Math.max(0, countSameOtherPositions(chars, result.code, i) - 2);
        }, 0);
        const currentScore = valid
            .filter(result => result.code[i] === chars[i])
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const hasNearWholeMatch = similarT.some(result => countSameOtherPositions(chars, result.code, i) >= 3);

        if ((similarT.length >= 2 || hasNearWholeMatch) && tScore >= currentScore - 0.5) {
            chars[i] = 'T';
        }
    }

    return chars.join('');
}

function isLikelyUppercaseWShape(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount)
        || getCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.40 || charW < slotWidth * 0.45) return false;

    const midRun = getLongestHorizontalRun(mask, width, region, 0.36, 0.64);
    const lowerLeft = getRelativeDensity(mask, width, region, 0, 0.40, 0.54, 0.84);
    const lowerRight = getRelativeDensity(mask, width, region, 0.60, 1, 0.50, 0.90);
    const bottomLeft = getRelativeDensity(mask, width, region, 0, 0.46, 0.66, 1);
    const bottomRight = getRelativeDensity(mask, width, region, 0.54, 1, 0.66, 1);

    return midRun >= charW * 0.38
        && lowerLeft >= 0.30
        && lowerRight >= 0.33
        && bottomLeft >= 0.28
        && bottomRight >= 0.30;
}

function correctWFromSimilarCandidate(code, base, results, mask) {
    if (!/[nN]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);
    let colorMask = null;

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'n' && chars[i] !== 'N') continue;

        const similarW = valid.filter(result => {
            return (result.code[i] === 'W' || result.code[i] === 'w')
                && countSameOtherPositions(chars, result.code, i) >= 3;
        });
        if (!similarW.length) continue;

        const wScore = similarW.reduce((score, result) => {
            return score + result.priority + Math.max(0, result.confidence || 0) / 25;
        }, 0);
        const currentScore = valid
            .filter(result => result.code[i] === chars[i])
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        let shapeLooksLikeW = isLikelyUppercaseWShape(mask, base.width, base.height, i, chars.length);
        if (!shapeLooksLikeW) {
            colorMask = colorMask || buildColorClusterMask(base);
            shapeLooksLikeW = isLikelyUppercaseWShape(colorMask, base.width, base.height, i, chars.length);
        }

        if (shapeLooksLikeW && wScore >= currentScore - 1.5) {
            chars[i] = 'W';
        }
    }

    return chars.join('');
}

function correctUppercaseKFromShape(code, base, results, mask) {
    if (!/k/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'k') continue;

        const hasUpperKCandidate = valid.some(result => result.code[i] === 'K');
        if (hasUpperKCandidate && isLikelyUppercaseSimpleShape(mask, base.width, base.height, i, chars.length)) {
            chars[i] = 'K';
        }
    }

    return chars.join('');
}

function correctUppercaseLFromShape(code, base, mask) {
    if (!/l/.test(code)) return code;

    const chars = code.split('');
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'l') continue;

        if (isLikelyUppercaseL(mask, base.width, base.height, i, chars.length)) {
            chars[i] = 'L';
        }
    }

    return chars.join('');
}

function correctLFromThinLineCandidate(code, results) {
    if (!/[EBe]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);
    const thinCandidates = valid.filter(result => result.variant === 'thin-line-clean');

    for (let i = 0; i < chars.length; i++) {
        if (!['E', 'B', 'e'].includes(chars[i])) continue;

        const thinL = thinCandidates.some(result => {
            return (result.code[i] === 'L' || result.code[i] === 'l')
                && countSameOtherPositions(chars, result.code, i) >= 2;
        });

        if (thinL) {
            chars[i] = 'L';
        }
    }

    return chars.join('');
}

function getVariantEvidenceScore(result) {
    return result.priority + Math.max(0, result.confidence || 0) / 25;
}

function getCharCandidateEvidence(valid, chars, charIndex, targetChar, minSame = 2) {
    return valid
        .filter(result => isSameCaptchaChar(result.code[charIndex], targetChar))
        .map(result => ({
            result,
            sameOther: countSameOtherPositions(chars, result.code, charIndex),
            score: getVariantEvidenceScore(result)
        }))
        .filter(item => item.sameOther >= minSame)
        .sort((a, b) => {
            const scoreA = a.sameOther * 8 + itemConfidence(a) / 5 + a.score;
            const scoreB = b.sameOther * 8 + itemConfidence(b) / 5 + b.score;
            return scoreB - scoreA;
        });
}

function itemConfidence(item) {
    return Math.max(0, item.result.confidence || 0);
}

function getCurrentCharEvidence(valid, currentChar, charIndex) {
    return valid
        .filter(result => isSameCaptchaChar(result.code[charIndex], currentChar))
        .reduce((score, result) => score + getVariantEvidenceScore(result), 0);
}

function isSupportedShapeTarget(targetChar, base, mask, colorMask, charIndex, charCount) {
    const width = base.width;
    const height = base.height;
    const lower = targetChar.toLowerCase();

    if (targetChar === '5') {
        return isLikelyDigitFive(mask, width, height, charIndex, charCount)
            || isLikelyRightHeavyDigitFive(mask, width, height, charIndex, charCount)
            || isLikelyRightHeavyDigitFive(colorMask, width, height, charIndex, charCount);
    }
    if (targetChar === '6') {
        return isLikelyDigitSix(mask, width, height, charIndex, charCount)
            || isLikelyDigitSix(colorMask, width, height, charIndex, charCount);
    }
    if (targetChar === '7') {
        return isLikelyDigitSeven(mask, width, height, charIndex, charCount)
            || isLikelyDigitSeven(colorMask, width, height, charIndex, charCount);
    }
    if (targetChar === '8') {
        return isLikelyDigitEight(mask, width, height, charIndex, charCount)
            || isLikelyDigitEight(colorMask, width, height, charIndex, charCount)
            || isLikelyDenseDigitEight(colorMask, width, height, charIndex, charCount);
    }
    if (lower === 'b') {
        return isLikelyRightSideUppercaseB(mask, width, height, charIndex, charCount)
            || isLikelyRightSideUppercaseB(colorMask, width, height, charIndex, charCount);
    }
    if (lower === 'l') {
        return isLikelyUppercaseL(mask, width, height, charIndex, charCount)
            || isLikelyUppercaseL(colorMask, width, height, charIndex, charCount);
    }
    if (lower === 'j') {
        return isLikelyUppercaseJ(mask, width, height, charIndex, charCount)
            || isLikelyUppercaseJ(colorMask, width, height, charIndex, charCount);
    }
    if (lower === 'p') {
        return isLikelyUppercaseP(mask, width, height, charIndex, charCount)
            || isLikelyUppercaseP(colorMask, width, height, charIndex, charCount);
    }
    if (lower === 'h') {
        return isLikelyLowercaseH(mask, width, height, charIndex, charCount)
            || isLikelyLowercaseH(colorMask, width, height, charIndex, charCount);
    }
    if (lower === 'd') {
        return isLikelyUppercaseD(mask, width, height, charIndex, charCount)
            || isLikelyUppercaseD(colorMask, width, height, charIndex, charCount);
    }
    if (lower === 'w') {
        return isLikelyUppercaseWShape(mask, width, height, charIndex, charCount)
            || isLikelyUppercaseWShape(colorMask, width, height, charIndex, charCount);
    }
    if (lower === 'f') {
        return isLikelyUppercaseF(mask, width, height, charIndex, charCount)
            || isLikelyUppercaseF(colorMask, width, height, charIndex, charCount);
    }
    if (targetChar === '4') {
        return isLikelyDigitFour(mask, width, height, charIndex, charCount)
            || isLikelyStrongDigitFour(mask, width, height, charIndex, charCount)
            || isLikelyDigitFour(colorMask, width, height, charIndex, charCount)
            || isLikelyStrongDigitFour(colorMask, width, height, charIndex, charCount);
    }

    return false;
}

function isShapeBackedConfusionPair(fromChar, targetChar) {
    const from = fromChar.toLowerCase();
    const target = targetChar.toLowerCase();
    const pair = `${from}${target}`;

    return pair === 's5'
        || pair === 'z5'
        || pair === 's7'
        || pair === 'z7'
        || pair === 'a7'
        || pair === 'b8'
        || pair === 'e8'
        || pair === 's8'
        || pair === '8b'
        || pair === 'e6'
        || pair === 'b6'
        || pair === 's6'
        || pair === 'o6'
        || pair === 'el'
        || pair === 'il'
        || pair === 'ol'
        || pair === 'tl'
        || pair === '1j'
        || pair === 'ij'
        || pair === 'lj'
        || pair === 'fj'
        || pair === 'hp'
        || pair === 'rp'
        || pair === 'ep'
        || pair === 'fp'
        || pair === 'lh'
        || pair === 'id'
        || pair === 'ld'
        || pair === 'aw'
        || pair === 'iw'
        || pair === 'yw'
        || pair === '74'
        || pair === 'a4';
}

function correctFromShapeBackedCandidates(code, base, results, mask) {
    if (!code) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);
    if (!valid.length) return code;

    const colorMask = buildColorClusterMask(base);

    for (let i = 0; i < chars.length; i++) {
        const currentChar = chars[i];
        const targetChars = [...new Set(valid
            .map(result => result.code[i])
            .filter(target => target && !isSameCaptchaChar(target, currentChar))
            .filter(target => isShapeBackedConfusionPair(currentChar, target)))];

        let bestTarget = '';
        let bestScore = -Infinity;
        for (const targetChar of targetChars) {
            const evidence = getCharCandidateEvidence(valid, chars, i, targetChar, 2);
            if (!evidence.length) continue;

            const bestEvidence = evidence[0];
            const confidence = itemConfidence(bestEvidence);
            const shapeSupported = isSupportedShapeTarget(targetChar, base, mask, colorMask, i, chars.length);
            if (!shapeSupported) continue;

            const currentEvidence = getCurrentCharEvidence(valid, currentChar, i);
            const pair = `${currentChar.toLowerCase()}${targetChar.toLowerCase()}`;
            const needsCurrentEvidenceCheck = pair === 'b8' || pair === '8b';
            if (needsCurrentEvidenceCheck && currentEvidence > bestEvidence.score + 4) continue;

            const strongWholePeer = bestEvidence.sameOther >= 3 && confidence >= 20;
            const strongShapePeer = bestEvidence.sameOther >= 2 && confidence >= 35;
            const rightHeavyFivePeer = targetChar === '5'
                && bestEvidence.sameOther >= 2
                && isLikelyRightHeavyDigitFive(colorMask, base.width, base.height, i, chars.length);
            const lowConfidenceExactPeer = bestEvidence.sameOther >= 3
                && confidence === 0
                && evidence.length >= 2;

            if (!strongWholePeer && !strongShapePeer && !rightHeavyFivePeer && !lowConfidenceExactPeer) continue;

            const targetScore = bestEvidence.sameOther * 10
                + confidence / 4
                + bestEvidence.score
                - Math.max(0, currentEvidence - bestEvidence.score) / 4;
            if (targetScore > bestScore) {
                bestScore = targetScore;
                bestTarget = targetChar;
            }
        }

        if (bestTarget) {
            chars[i] = bestTarget;
        }
    }

    return chars.join('');
}

function getHighConfidenceSingleCharThreshold(fromChar, targetChar) {
    const pair = `${fromChar.toLowerCase()}${targetChar.toLowerCase()}`;
    switch (pair) {
        case 's5':
        case 'z5':
            return 35;
        case 'yv':
        case 'tf':
        case 'a9':
        case 'jb':
        case '43':
        case '8b':
            return 50;
        case 'b8':
            return 19;
        case 'yf':
            return 35;
        case '8s':
            return 70;
        case 'om':
            return 35;
        case 'ec':
            return 30;
        case 'e6':
            return 1;
        case 'sk':
            return 15;
        case 'od':
            return 18;
        case '34':
            return 1;
        default:
            return 0;
    }
}

function correctFromHighConfidenceSingleCharCandidate(code, results) {
    if (!code) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);
    if (!valid.length) return code;

    for (let i = 0; i < chars.length; i++) {
        const currentChar = chars[i];
        const grouped = new Map();

        for (const result of valid) {
            const targetChar = result.code[i];
            if (!targetChar || isSameCaptchaChar(targetChar, currentChar)) continue;
            if (countSameOtherPositions(chars, result.code, i) < 3) continue;

            const threshold = getHighConfidenceSingleCharThreshold(currentChar, targetChar);
            if (!threshold) continue;

            const key = targetChar;
            const item = grouped.get(key) || {
                targetChar,
                threshold,
                pair: `${currentChar.toLowerCase()}${targetChar.toLowerCase()}`,
                count: 0,
                confidence: 0,
                score: 0,
                hasTrustedVariant: false
            };
            item.count++;
            item.confidence = Math.max(item.confidence, result.confidence || 0);
            item.score += getVariantEvidenceScore(result);
            if (['loose-color', 'simple-threshold', 'thin-line-clean', 'aggressive-line-clean'].includes(result.variant)) {
                item.hasTrustedVariant = true;
            }
            grouped.set(key, item);
        }

        const currentScore = getCurrentCharEvidence(valid, currentChar, i);
        const best = [...grouped.values()]
            .filter(item => item.confidence >= item.threshold)
            .filter(item => item.count >= 2 || item.confidence >= item.threshold + 7 || item.hasTrustedVariant)
            .filter(item => {
                if (item.score >= currentScore - 5 || item.confidence >= 70) return true;
                if ((item.pair === 's5' || item.pair === 'z5') && item.count >= 2) return true;
                if (item.pair === 'a9' && item.count >= 2) return true;
                if (item.pair === '8b' && item.count >= 2) return true;
                if (item.pair === 'b8' && item.confidence >= item.threshold + 7 && item.hasTrustedVariant) return true;
                if (item.pair === 'ec' && item.confidence >= 30 && item.hasTrustedVariant) return true;
                if (item.pair === 'e6' && item.count >= 2) return true;
                if (item.pair === 'sk' && item.confidence >= item.threshold + 7) return true;
                if (item.pair === 'od' && item.confidence >= item.threshold + 7) return true;
                if (item.pair === '34' && item.confidence >= item.threshold + 7) return true;
                return false;
            })
            .sort((a, b) => {
                const scoreA = a.score * 8 + a.confidence + a.count * 4;
                const scoreB = b.score * 8 + b.confidence + b.count * 4;
                return scoreB - scoreA;
            })[0];

        if (best) {
            chars[i] = best.targetChar;
        }
    }

    return chars.join('');
}

function correctWFromThinLineCandidate(code, results) {
    if (!/[iIl1]/.test(code)) return code;

    const chars = code.split('');
    const thinCandidates = results
        .filter(result => result.variant === 'thin-line-clean')
        .filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (!['i', 'I', 'l', '1'].includes(chars[i])) continue;

        const thinW = thinCandidates.some(result => {
            return (result.code[i] === 'W' || result.code[i] === 'w')
                && countSameOtherPositions(chars, result.code, i) >= 3;
        });

        if (thinW) {
            chars[i] = 'W';
        }
    }

    return chars.join('');
}

function correctSimpleUppercaseFromShape(code, base, results, mask) {
    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'u' && chars[i] !== 'c') continue;

        const lowerVotes = valid
            .filter(result => result.code[i] === chars[i])
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const upperVotes = valid
            .filter(result => result.code[i] === chars[i].toUpperCase())
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        if (lowerVotes > 0 && upperVotes <= lowerVotes + 1) continue;

        if (isLikelyUppercaseSimpleShape(mask, base.width, base.height, i, chars.length)) {
            chars[i] = chars[i].toUpperCase();
        }
    }
    return chars.join('');
}

function correctTallUppercaseFromShape(code, base, results, mask) {
    if (!/[csvw]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (!['c', 's', 'v', 'w'].includes(chars[i])) continue;
        if (!isLikelyUppercaseSimpleShape(mask, base.width, base.height, i, chars.length)) continue;

        const upper = chars[i].toUpperCase();
        const upperVotes = valid
            .filter(result => result.code[i] === upper)
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const lowerVotes = valid
            .filter(result => result.code[i] === chars[i])
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        const hasUpperCandidate = upperVotes > 0;
        const strongLowerConsensus = lowerVotes > upperVotes + 5;
        if (hasUpperCandidate && !strongLowerConsensus) {
            chars[i] = upper;
        }
    }

    return chars.join('');
}

function correctCaseFromWholeCandidate(code, results) {
    if (!/[a-zA-Z]/.test(code)) return code;

    const valid = results.filter(result => result.code && result.code.length === code.length);
    const sameLetters = valid
        .filter(result => {
            for (let i = 0; i < code.length; i++) {
                if (/[a-zA-Z]/.test(code[i]) || /[a-zA-Z]/.test(result.code[i])) {
                    if (code[i].toLowerCase() !== result.code[i].toLowerCase()) return false;
                } else if (code[i] !== result.code[i]) {
                    return false;
                }
            }
            return true;
        })
        .sort((a, b) => {
            const scoreA = a.priority * 10 + (a.confidence || 0);
            const scoreB = b.priority * 10 + (b.confidence || 0);
            return scoreB - scoreA;
        });

    return sameLetters.length ? sameLetters[0].code : code;
}

function correctCaseFromColorClusterCandidate(code, results) {
    if (!/[a-zA-Z]/.test(code)) return code;

    const color = results
        .filter(result => result.variant === 'color-cluster')
        .filter(result => result.code && result.code.length === code.length)
        .filter(result => (result.confidence || 0) >= 35)
        .filter(result => {
            for (let i = 0; i < code.length; i++) {
                if (/[a-zA-Z]/.test(code[i]) || /[a-zA-Z]/.test(result.code[i])) {
                    if (code[i].toLowerCase() !== result.code[i].toLowerCase()) return false;
                } else if (code[i] !== result.code[i]) {
                    return false;
                }
            }
            return result.code !== code;
        })
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];

    return color ? color.code : code;
}

function correctDigitTwoFromCandidates(code, results) {
    if (!/[vV]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'v' && chars[i] !== 'V') continue;

        const twoCandidates = valid
            .filter(result => result.code[i] === '2')
            .filter(result => countSameOtherPositions(chars, result.code, i) >= 2);
        if (twoCandidates.length >= 2 || twoCandidates.some(result => (result.confidence || 0) >= 20)) {
            chars[i] = '2';
            continue;
        }

        const twoEvidence = valid
            .filter(result => result.code[i] === '2')
            .filter(result => countSameOtherPositions(chars, result.code, i) >= 2)
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const vEvidence = valid
            .filter(result => result.code[i] === chars[i])
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (twoEvidence >= Math.max(2.5, vEvidence - 1)) {
            chars[i] = '2';
        }
    }

    return chars.join('');
}

function correctFromAgreementCandidates(code, results) {
    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        const votes = new Map();
        for (const result of valid) {
            const candidate = result.code[i];
            if (!candidate || candidate === chars[i]) continue;

            const sameOther = countSameOtherPositions(chars, result.code, i);
            if (sameOther < 2) continue;

            const score = result.priority
                + Math.max(0, result.confidence || 0) / 25
                + Math.max(0, sameOther - 2) * 2;
            votes.set(candidate, (votes.get(candidate) || 0) + score);
        }

        let bestChar = '';
        let bestScore = 0;
        for (const [char, score] of votes) {
            if (score > bestScore) {
                bestChar = char;
                bestScore = score;
            }
        }

        const currentScore = valid
            .filter(result => result.code[i] === chars[i])
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (bestChar && bestScore >= 5 && bestScore >= currentScore + 2.5) {
            chars[i] = bestChar;
        }
    }

    return chars.join('');
}

function isTrustedExactWhole(code, results) {
    return results.some(result => {
        if (result.code !== code) return false;
        const confidence = result.confidence || 0;
        return (result.variant === 'thin-line-clean' && confidence >= 58)
            || (result.variant === 'legacy-fallback' && confidence >= 58);
    });
}

function hasSupportedSingleCharCandidate(original, expectedChar, charIndex, results, minSame = 3) {
    return results
        .filter(result => result.code && result.code.length === original.length)
        .some(result => {
            return isSameCaptchaChar(result.code[charIndex], expectedChar)
                && countSameOtherPositions(original, result.code, charIndex) >= minSame;
        });
}

function hasHighConfidenceSingleCharCandidate(original, expectedChar, charIndex, results) {
    const threshold = getHighConfidenceSingleCharThreshold(original[charIndex], expectedChar);
    if (!threshold) return false;

    return results
        .filter(result => result.code && result.code.length === original.length)
        .some(result => {
            return isSameCaptchaChar(result.code[charIndex], expectedChar)
                && countSameOtherPositions(original, result.code, charIndex) >= 3
                && (result.confidence || 0) >= threshold
                && ['loose-color', 'simple-threshold', 'thin-line-clean', 'aggressive-line-clean'].includes(result.variant);
        });
}

function allowsTrustedShapeOverride(original, corrected, base, mask, results = []) {
    if (!original || !corrected || original.length !== corrected.length) return false;

    let diffIndex = -1;
    let diffCount = 0;
    for (let i = 0; i < original.length; i++) {
        if (isSameCaptchaChar(original[i], corrected[i])) continue;
        diffIndex = i;
        diffCount++;
    }
    if (diffCount !== 1) return false;

    const from = original[diffIndex];
    const to = corrected[diffIndex];
    if (/[SsZz]/.test(from) && to === '5') {
        return isLikelyRightHeavyDigitFive(mask, base.width, base.height, diffIndex, original.length)
            || isLikelyRightHeavyDigitFive(buildColorClusterMask(base), base.width, base.height, diffIndex, original.length)
            || hasHighConfidenceSingleCharCandidate(original, to, diffIndex, results);
    }
    if (from === '8' && (to === 'B' || to === 'b')) {
        return isLikelyRightSideUppercaseB(mask, base.width, base.height, diffIndex, original.length)
            || isLikelyRightSideUppercaseB(buildColorClusterMask(base), base.width, base.height, diffIndex, original.length)
            || hasHighConfidenceSingleCharCandidate(original, to, diffIndex, results);
    }
    if ((from === 'y' || from === 'Y') && (to === 'q' || to === 'Q')) {
        return hasSupportedSingleCharCandidate(original, to, diffIndex, results);
    }
    if (['i', 'I', 'l', '1'].includes(from) && (to === 'J' || to === 'j')) {
        return isLikelyUppercaseJ(mask, base.width, base.height, diffIndex, original.length)
            || isLikelyUppercaseJ(buildColorClusterMask(base), base.width, base.height, diffIndex, original.length);
    }
    if ((from === 'd' || from === 'D') && to === '4') {
        return isLikelyStrongDigitFour(mask, base.width, base.height, diffIndex, original.length)
            || isLikelyStrongDigitFour(buildColorClusterMask(base), base.width, base.height, diffIndex, original.length);
    }
    if (hasHighConfidenceSingleCharCandidate(original, to, diffIndex, results)) {
        return true;
    }

    return false;
}

// 检测字符是否更像小写 c（无中横线）而非 e（有中横线）
function isLikelyLowercaseC(mask, width, height, charIndex, charCount) {
    const region = getPrimaryCharRegion(mask, width, height, charIndex, charCount);
    if (!region) return false;

    const slotWidth = width / charCount;
    const charW = region.maxX - region.minX + 1;
    const charH = region.maxY - region.minY + 1;
    if (charH < height * 0.28 || charW < slotWidth * 0.24) return false;

    // e 的特征：中部有一条水平线穿过，中央区域密度较高
    // c 的特征：中部是空心的（开口），中央密度低
    const midDensity = getRelativeDensity(mask, width, region, 0.22, 0.88, 0.36, 0.64);
    const midRun = getLongestHorizontalRun(mask, width, region, 0.36, 0.64);
    const centerMidDensity = getRelativeDensity(mask, width, region, 0.38, 0.78, 0.38, 0.62);

    // 左弧密度：c 和 e 都有左侧弧
    const leftArc = getRelativeDensity(mask, width, region, 0, 0.30, 0.20, 0.80);
    // 右侧中部：c 是空的，e 有横线
    const rightMid = getRelativeDensity(mask, width, region, 0.55, 1, 0.36, 0.64);

    // c 的中部基本为空（无横线），e 有明显横线
    const hasNoMidBar = midDensity <= 0.28 && midRun <= charW * 0.62 && centerMidDensity <= 0.20;
    const hasLeftArc = leftArc >= 0.10;
    const rightMidEmpty = rightMid <= 0.22;

    return hasNoMidBar && hasLeftArc && rightMidEmpty;
}

function correctCFromShape(code, base, results, mask) {
    // 当识别结果为 e/E 时，检查是否更像 c/C
    if (!/[eE]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'e' && chars[i] !== 'E') continue;

        const candidateVotesC = valid
            .filter(result => result.code[i] === 'c' || result.code[i] === 'C')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesE = valid
            .filter(result => result.code[i] === 'e' || result.code[i] === 'E')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        // 条件1：有候选投票给 c，且形状检测也倾向于 c
        const shapeLooksLikeC = isLikelyLowercaseC(mask, base.width, base.height, i, chars.length);
        if (candidateVotesC > 0 && shapeLooksLikeC) {
            chars[i] = chars[i] === 'E' ? 'C' : 'c';
            continue;
        }

        // 条件2：多个候选强烈支持 c，即使形状检测不明确
        if (candidateVotesC > candidateVotesE + 1.5) {
            chars[i] = chars[i] === 'E' ? 'C' : 'c';
        }
    }

    return chars.join('');
}

function correctVisualConfusions(code, base, results) {
    if (!code) return code;

    const preserveOriginal = isTrustedExactWhole(code, results);
    const mask = getCorrectionMask(base);
    let corrected = correctCaseFromCandidates(code, results);
    corrected = correctWFromThinLineCandidate(corrected, results);
    corrected = correctGFromSimilarCandidate(corrected, results);
    corrected = correctQFromCompatibleCandidate(corrected, results);
    corrected = correctQFromSimilarCandidate(corrected, results);
    corrected = correctPFromSimilarCandidate(corrected, results);
    corrected = correctDigitSevenFromSimilarCandidate(corrected, results);
    corrected = correctTFromSimilarCandidate(corrected, results);
    corrected = correctWFromSimilarCandidate(corrected, base, results, mask);
    corrected = correctJFromShape(corrected, base, results, mask);
    corrected = correctDFromShape(corrected, base, results, mask);
    corrected = correctDigitFiveFromShape(corrected, base, results, mask);
    corrected = correctDigitSixFromShape(corrected, base, mask);
    corrected = correctDigitFourFromShape(corrected, base, results, mask);
    corrected = correctMFromShape(corrected, base, results, mask);
    corrected = correctUFromShape(corrected, base, results, mask);
    corrected = correctUppercaseJFromShape(corrected, base, results, mask);
    corrected = correctPAndHFromShape(corrected, base, results, mask);
    corrected = correctEFamilyFromShape(corrected, base, results, mask);
    corrected = correctCFromShape(corrected, base, results, mask);
    corrected = correctDenseEightFromShape(corrected, base, results);
    corrected = correctIFromShape(corrected, base, results, mask);
    corrected = correctUppercaseKFromShape(corrected, base, results, mask);
    corrected = correctUppercaseLFromShape(corrected, base, mask);
    corrected = correctLFromThinLineCandidate(corrected, results);
    corrected = correctFromShapeBackedCandidates(corrected, base, results, mask);
    corrected = correctFromHighConfidenceSingleCharCandidate(corrected, results);
    corrected = correctSimpleUppercaseFromShape(corrected, base, results, mask);
    corrected = correctTallUppercaseFromShape(corrected, base, results, mask);
    corrected = correctCaseFromWholeCandidate(corrected, results);
    corrected = correctCaseFromColorClusterCandidate(corrected, results);
    corrected = correctDigitTwoFromCandidates(corrected, results);
    if (preserveOriginal
        && countSameOtherPositions(code, corrected, -1) < 4
        && !allowsTrustedShapeOverride(code, corrected, base, mask, results)) {
        return code;
    }
    return corrected;
}

function isSameCaptchaChar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return /[a-zA-Z]/.test(a)
        && /[a-zA-Z]/.test(b)
        && a.toLowerCase() === b.toLowerCase();
}

function countCandidateSupport(result, candidates) {
    let support = 0;
    for (let i = 0; i < result.code.length; i++) {
        support += candidates.filter(other => {
            return other !== result
                && other.code
                && other.code.length === result.code.length
                && isSameCaptchaChar(other.code[i], result.code[i]);
        }).length;
    }
    return support;
}

function getVariantTieBreakBonus(variant) {
    switch (variant) {
        case 'legacy-fallback':
            return 4;
        case 'loose-color':
            return 2;
        case 'thin-line-clean':
            return 2;
        case 'simple-threshold':
            return 1;
        case 'balanced-color':
            return 1;
        default:
            return 0;
    }
}

function hasConfidentAlternative(results, code, minConfidence = 35) {
    return results.some(result => {
        return result.code
            && result.code.length === code.length
            && result.code !== code
            && (result.confidence || 0) >= minConfidence;
    });
}

function findComplementaryPartialCode(results, valid) {
    const partials = results.filter(result => result.code.length === 3);
    const rankedWhole = valid.slice().sort((a, b) => {
        const scoreA = a.priority * 10 + (a.confidence || 0);
        const scoreB = b.priority * 10 + (b.confidence || 0);
        return scoreB - scoreA;
    });

    for (const whole of rankedWhole) {
        for (const partial of partials) {
            if (!isSameCaptchaChar(whole.code[0], partial.code[0])) continue;
            if (!isSameCaptchaChar(whole.code[3], partial.code[2])) continue;
            if (isSameCaptchaChar(whole.code[1], partial.code[1])) continue;

            return `${whole.code[0]}${partial.code[1]}${whole.code[2]}${whole.code[3]}`;
        }
    }

    return '';
}

function differsOnlyByCE(a, b) {
    if (!a || !b || a.length !== b.length) return false;

    let diffCount = 0;
    for (let i = 0; i < a.length; i++) {
        if (isSameCaptchaChar(a[i], b[i])) continue;

        const pair = `${a[i].toLowerCase()}${b[i].toLowerCase()}`;
        if (pair !== 'ce' && pair !== 'ec') return false;
        diffCount++;
    }

    return diffCount === 1;
}

function findTrustedCEFallback(valid) {
    const legacy = valid
        .filter(result => result.variant === 'legacy-fallback')
        .filter(result => (result.confidence || 0) >= 68)
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];

    if (!legacy) return '';
    const hasCEPeer = valid.some(result => result !== legacy && differsOnlyByCE(legacy.code, result.code));
    if (!hasCEPeer) return '';

    const hasStrongerOpponent = valid.some(result => {
        return result !== legacy
            && result.code !== legacy.code
            && !differsOnlyByCE(legacy.code, result.code)
            && (result.confidence || 0) >= (legacy.confidence || 0) + 15;
    });

    return hasStrongerOpponent ? '' : legacy.code;
}

function findRepeatedPConsensus(valid) {
    const candidateCodes = [...new Set(valid.map(result => result.code))];

    for (const code of candidateCodes) {
        const exact = valid.filter(result => result.code === code);
        if (exact.length < 2) continue;

        const pIndex = code.split('').findIndex(char => char === 'P' || char === 'p');
        if (pIndex < 0) continue;

        const pVotes = valid.filter(result => result.code[pIndex] === 'P' || result.code[pIndex] === 'p').length;
        const otherGroups = new Map();
        for (const result of valid) {
            const key = result.code[pIndex].toLowerCase();
            if (key === 'p') continue;
            otherGroups.set(key, (otherGroups.get(key) || 0) + 1);
        }
        let strongestOther = 0;
        for (const count of otherGroups.values()) {
            if (count > strongestOther) strongestOther = count;
        }
        const otherPositionsStable = [0, 1, 2, 3]
            .filter(index => index !== pIndex)
            .every(index => valid.filter(result => isSameCaptchaChar(result.code[index], code[index])).length >= 3);

        if (pVotes >= 3 && pVotes > strongestOther && otherPositionsStable) {
            return code;
        }
    }

    return '';
}

function findTrustedVariantWhole(valid, selected) {
    const trusted = valid
        .map(result => ({
            result,
            support: countCandidateSupport(result, valid),
            hasClosePeer: valid.some(other => {
                return other !== result
                    && other.code
                    && other.code.length === result.code.length
                    && countSameOtherPositions(result.code, other.code, -1) >= 3;
            })
        }))
        .filter(item => {
            const confidence = item.result.confidence || 0;
            if (item.result.code === selected) return false;
            if (item.result.variant === 'thin-line-clean') {
                return confidence >= 58;
            }
            if (item.result.variant === 'legacy-fallback') {
                return confidence >= 55 && item.support >= 5 && item.hasClosePeer;
            }
            return false;
        })
        .sort((a, b) => {
            const scoreA = a.support * 10 + getVariantTieBreakBonus(a.result.variant) + (a.result.confidence || 0) / 10;
            const scoreB = b.support * 10 + getVariantTieBreakBonus(b.result.variant) + (b.result.confidence || 0) / 10;
            return scoreB - scoreA;
        });

    return trusted.length ? trusted[0].result.code : '';
}

function findSupportedLowConfidenceWhole(valid) {
    const supported = valid
        .map(result => ({
            result,
            support: countCandidateSupport(result, valid)
        }))
        .filter(item => ['simple-threshold', 'loose-color', 'balanced-color'].includes(item.result.variant))
        .filter(item => (item.result.confidence || 0) >= 1)
        .filter(item => item.support >= 5)
        .sort((a, b) => {
            const scoreA = a.support * 10 + getVariantTieBreakBonus(a.result.variant) + (a.result.confidence || 0) / 10;
            const scoreB = b.support * 10 + getVariantTieBreakBonus(b.result.variant) + (b.result.confidence || 0) / 10;
            return scoreB - scoreA;
        });

    return supported.length ? supported[0].result.code : '';
}

function getConsensusCandidates(valid) {
    const stable = valid.filter(result => result.variant !== 'aggressive-line-clean');
    return stable.length ? stable : valid;
}

function getCaptchaCodeKey(code) {
    return (code || '').split('').map(char => {
        return /[a-zA-Z]/.test(char) ? char.toLowerCase() : char;
    }).join('');
}

function getCaptchaCharVoteKey(char) {
    return /[a-zA-Z]/.test(char) ? char.toLowerCase() : char;
}

function isSameCaptchaCode(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (!isSameCaptchaChar(a[i], b[i])) return false;
    }
    return true;
}

function getWholeCandidateEvidenceWeight(result) {
    const confidence = Math.max(0, result.confidence || 0);
    switch (result.variant) {
        case 'balanced-color':
            return 4 + Math.min(confidence, 65) / 25;
        case 'loose-color':
            return 3 + Math.min(confidence, 65) / 25;
        case 'simple-threshold':
        case 'strict-color':
        case 'color-cluster':
            return 2 + Math.min(confidence, 65) / 25;
        case 'legacy-fallback':
            return 2 + Math.min(confidence, 60) / 25;
        case 'thin-line-clean':
            return 2 + Math.min(confidence, 45) / 25;
        case 'aggressive-line-clean':
            return 0.75 + Math.min(confidence, 25) / 25;
        default:
            return 1 + Math.min(confidence, 45) / 25;
    }
}

function buildWholeCandidateGroups(valid) {
    const groups = new Map();

    for (const result of valid) {
        const key = getCaptchaCodeKey(result.code);
        if (!key) continue;

        const group = groups.get(key) || {
            key,
            results: [],
            variants: new Set(),
            score: 0,
            stableCount: 0,
            lineCount: 0,
            bestConfidence: 0,
            maxStableConfidence: 0,
            maxLegacyConfidence: 0,
            maxAggressiveConfidence: 0,
            representative: result
        };

        const weight = getWholeCandidateEvidenceWeight(result);
        group.results.push(result);
        group.variants.add(result.variant);
        group.score += weight;
        group.bestConfidence = Math.max(group.bestConfidence, result.confidence || 0);

        if (result.variant === 'aggressive-line-clean' || result.variant === 'thin-line-clean') {
            group.lineCount++;
        } else {
            group.stableCount++;
            group.maxStableConfidence = Math.max(group.maxStableConfidence, result.confidence || 0);
        }

        if (result.variant === 'legacy-fallback') {
            group.maxLegacyConfidence = Math.max(group.maxLegacyConfidence, result.confidence || 0);
        }
        if (result.variant === 'aggressive-line-clean') {
            group.maxAggressiveConfidence = Math.max(group.maxAggressiveConfidence, result.confidence || 0);
        }
        if (weight > getWholeCandidateEvidenceWeight(group.representative)) {
            group.representative = result;
        }

        groups.set(key, group);
    }

    for (const group of groups.values()) {
        const representative = group.representative.code;
        group.closeStablePeerCount = valid.filter(result => {
            return result.variant !== 'aggressive-line-clean'
                && getCaptchaCodeKey(result.code) !== group.key
                && countSameOtherPositions(representative, result.code, -1) >= 3;
        }).length;
    }

    return [...groups.values()];
}

function hasStrongCompetingWholeGroup(groups, selectedGroup) {
    return groups.some(group => {
        return group.key !== selectedGroup.key
            && (group.variants.has('thin-line-clean') || group.variants.has('legacy-fallback'))
            && group.bestConfidence >= selectedGroup.maxStableConfidence + 18
            && group.score >= selectedGroup.score - 4;
    });
}

function findStableWholeCandidate(valid, selected) {
    const selectedKey = getCaptchaCodeKey(selected);
    const groups = buildWholeCandidateGroups(valid);
    const selectedGroup = groups.find(group => group.key === selectedKey);
    const selectedScore = selectedGroup ? selectedGroup.score : 0;
    const selectedIsExactCandidate = Boolean(selectedGroup);
    if (selectedGroup) {
        const hasLooseBalancedAgreement = selectedGroup.variants.has('loose-color')
            && selectedGroup.variants.has('balanced-color');
        const hasStrongCompetitor = hasStrongCompetingWholeGroup(groups, selectedGroup);
        if (!hasStrongCompetitor
            && ((selectedGroup.stableCount >= 3 && selectedGroup.maxStableConfidence >= 50)
                || (hasLooseBalancedAgreement && selectedGroup.maxStableConfidence >= 48))) {
            return selected;
        }
    }

    const ranked = groups
        .filter(group => group.key !== selectedKey)
        .sort((a, b) => {
            const scoreA = a.score + a.stableCount * 1.5 + a.closeStablePeerCount * 0.75;
            const scoreB = b.score + b.stableCount * 1.5 + b.closeStablePeerCount * 0.75;
            return scoreB - scoreA;
        });

    for (const group of ranked) {
        const hasColorFamily = ['strict-color', 'loose-color', 'simple-threshold', 'color-cluster', 'balanced-color']
            .some(variant => group.variants.has(variant));
        const hasLineFamily = group.variants.has('thin-line-clean') || group.variants.has('aggressive-line-clean');

        if (group.stableCount >= 3
            && group.score >= selectedScore - 2
            && group.maxStableConfidence >= 18
            && (!selectedGroup
                || selectedGroup.bestConfidence < group.maxStableConfidence + 18
                || group.score >= selectedScore + 4)) {
            return group.representative.code;
        }

        if (group.stableCount >= 2
            && group.variants.has('balanced-color')
            && hasColorFamily
            && group.maxStableConfidence >= 45
            && group.score >= selectedScore + 0.75
            && (!selectedGroup
                || selectedGroup.bestConfidence < group.maxStableConfidence + 18
                || group.score >= selectedScore + 4)) {
            return group.representative.code;
        }

        if (group.maxLegacyConfidence >= 60
            && group.closeStablePeerCount >= 2
            && (!selectedGroup
                || (selectedGroup.maxStableConfidence < 55 && selectedGroup.bestConfidence < 75)
                || group.score >= selectedScore - 3.5)) {
            return group.representative.code;
        }

        if (group.lineCount >= 2
            && group.closeStablePeerCount >= 3
            && group.bestConfidence >= 45
            && selectedGroup
            && selectedGroup.stableCount <= 2
            && !selectedGroup.variants.has('balanced-color')
            && group.score + group.closeStablePeerCount * 1.5 >= selectedScore - 2.5) {
            return group.representative.code;
        }

        if (!selectedIsExactCandidate
            && group.stableCount >= 1
            && group.lineCount >= 1
            && hasLineFamily
            && group.bestConfidence >= 45
            && group.score >= 5.5) {
            return group.representative.code;
        }
    }

    return '';
}

function findTrustedAggressiveLineVariant(valid, selected) {
    const diffCount = (a, b) => {
        if (!a || !b || a.length !== b.length) return 99;
        let count = 0;
        for (let i = 0; i < a.length; i++) {
            if (!isSameCaptchaChar(a[i], b[i])) count++;
        }
        return count;
    };

    const supported = valid
        .filter(result => result.variant === 'aggressive-line-clean')
        .filter(result => result.code && result.code !== selected)
        .filter(result => (result.confidence || 0) >= 55)
        .map(result => ({
            result,
            exactPeerCount: valid.filter(other => {
                return other !== result
                    && other.variant !== 'aggressive-line-clean'
                    && other.code === result.code;
            }).length,
            closePeerCount: valid.filter(other => {
                return other !== result
                    && other.variant !== 'aggressive-line-clean'
                    && other.code
                    && other.code.length === result.code.length
                    && countSameOtherPositions(result.code, other.code, -1) >= 3;
            }).length,
            support: countCandidateSupport(result, valid.filter(other => other.variant !== 'aggressive-line-clean')),
            distanceFromSelected: diffCount(result.code, selected)
        }))
        .filter(item => {
            const confidence = item.result.confidence || 0;
            if (item.distanceFromSelected > 2
                && !(item.distanceFromSelected <= 3 && item.exactPeerCount >= 2 && confidence >= 60)) {
                return false;
            }
            if (item.exactPeerCount >= 2 && confidence >= 55 && (item.support >= 5 || item.closePeerCount >= 1)) return true;
            if (item.exactPeerCount === 1 && confidence >= 64 && (item.support >= 5 || item.closePeerCount >= 1)) return true;
            return confidence >= 64 && item.closePeerCount >= 1 && item.support >= 5;
        })
        .filter(item => !valid.some(other => {
            return other.variant !== 'aggressive-line-clean'
                && other.code === selected
                && (other.confidence || 0) >= (item.result.confidence || 0) + 18;
        }))
        .sort((a, b) => {
            const scoreA = a.support * 10 + a.closePeerCount * 6 + (a.result.confidence || 0);
            const scoreB = b.support * 10 + b.closePeerCount * 6 + (b.result.confidence || 0);
            return scoreB - scoreA;
        })[0];

    return supported ? supported.result.code : '';
}

function isDigitLetterCorrection(from, to) {
    const pair = `${from}${to}`;
    return pair === 'S5'
        || pair === 's5'
        || pair === 'Z5'
        || pair === 'z5';
}

function findTrustedThinDigitVariant(valid, selected) {
    if (!selected) return '';

    const trusted = valid
        .filter(result => result.variant === 'thin-line-clean')
        .filter(result => (result.confidence || 0) >= 75)
        .filter(result => result.code && result.code.length === selected.length)
        .filter(result => {
            let diffIndex = -1;
            let diffCount = 0;
            for (let i = 0; i < selected.length; i++) {
                if (isSameCaptchaChar(selected[i], result.code[i])) continue;
                diffIndex = i;
                diffCount++;
            }
            return diffCount === 1
                && isDigitLetterCorrection(selected[diffIndex], result.code[diffIndex])
                && !valid.some(other => {
                    return other.variant === 'legacy-fallback'
                        && other.code === selected
                        && (other.confidence || 0) >= (result.confidence || 0) + 8;
                });
        })
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];

    return trusted ? trusted.code : '';
}

function isSubsequenceCode(shorter, longer) {
    if (!shorter || !longer || shorter.length >= longer.length) return false;

    let j = 0;
    for (let i = 0; i < longer.length && j < shorter.length; i++) {
        if (isSameCaptchaChar(shorter[j], longer[i])) j++;
    }
    return j === shorter.length;
}

function hasMissingCharacterSupport(candidate, results) {
    if (!candidate || !candidate.code || candidate.code.length !== 4) return false;
    if (!['simple-threshold', 'loose-color', 'thin-line-clean', 'aggressive-line-clean'].includes(candidate.variant)) {
        return false;
    }

    const support = results
        .filter(result => result.code && result.code.length === 3)
        .filter(result => isSubsequenceCode(result.code, candidate.code))
        .reduce((score, result) => {
            const confidence = Math.max(0, result.confidence || 0);
            return score + result.priority + confidence / 25;
        }, 0);

    return support >= 7;
}

function selectCaptchaCode(results) {
    const valid = results.filter(result => result.code.length === 4);
    if (!valid.length) return '';
    if (valid.length === 1) {
        return (valid[0].confidence || 0) >= 45 || hasMissingCharacterSupport(valid[0], results) ? valid[0].code : '';
    }

    const consensusCandidates = getConsensusCandidates(valid);
    const totals = Array.from({ length: 4 }, () => new Map());
    for (const result of consensusCandidates) {
        const confidenceBonus = Math.min(3, Math.max(0, result.confidence || 0) / 25);
        const weight = result.priority + confidenceBonus;
        for (let i = 0; i < 4; i++) {
            const voteKey = getCaptchaCharVoteKey(result.code[i]);
            const item = totals[i].get(voteKey) || {
                char: result.code[i],
                weight: 0,
                bestSingleWeight: 0
            };
            item.weight += weight;
            if (weight > item.bestSingleWeight) {
                item.char = result.code[i];
                item.bestSingleWeight = weight;
            }
            totals[i].set(voteKey, item);
        }
    }

    const consensus = totals.map(positionVotes => {
        let bestChar = '';
        let bestWeight = -1;
        for (const item of positionVotes.values()) {
            if (item.weight > bestWeight) {
                bestChar = item.char;
                bestWeight = item.weight;
            }
        }
        return bestChar;
    }).join('');

    const bestWhole = valid.slice().sort((a, b) => {
        const scoreA = a.priority * 10 + (a.confidence || 0);
        const scoreB = b.priority * 10 + (b.confidence || 0);
        return scoreB - scoreA;
    })[0];

    const selected = consensus.length === 4 ? consensus : bestWhole.code;
    const exactMatches = consensusCandidates.filter(result => isSameCaptchaCode(result.code, selected));
    const maxConfidence = exactMatches.reduce((max, result) => Math.max(max, result.confidence || 0), 0);
    const reliableExactMajority = exactMatches.length >= 3
        && (maxConfidence >= 20 || !hasConfidentAlternative(valid, selected, 70));
    const reliableExactPair = exactMatches.length >= 2
        && (
            (maxConfidence >= 30 && !hasConfidentAlternative(valid, selected, Math.max(40, maxConfidence - 8)))
            || !hasConfidentAlternative(valid, selected, 45)
        );
    const reliable = reliableExactMajority || reliableExactPair;

    const trustedCEFallback = findTrustedCEFallback(valid);
    if (trustedCEFallback) return trustedCEFallback;

    const stableWholeCandidate = findStableWholeCandidate(valid, selected);
    if (stableWholeCandidate) return stableWholeCandidate;

    const trustedThinDigit = findTrustedThinDigitVariant(valid, selected);
    if (trustedThinDigit) return trustedThinDigit;

    const trustedAggressiveLine = findTrustedAggressiveLineVariant(valid, selected);
    if (trustedAggressiveLine) return trustedAggressiveLine;

    if (reliable) return selected;

    const directTrustedThinLine = valid
        .filter(result => result.variant === 'thin-line-clean')
        .filter(result => (result.confidence || 0) >= 55)
        .filter(result => !valid.some(other => {
            return other.variant === 'legacy-fallback'
                && (other.confidence || 0) >= 55
                && countSameOtherPositions(result.code, other.code, -1) >= 2;
        }))
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    if (directTrustedThinLine) return directTrustedThinLine.code;

    const trustedVariantWhole = findTrustedVariantWhole(valid, selected);
    if (trustedVariantWhole) return trustedVariantWhole;

    const standoutThinLine = valid
        .filter(result => result.variant === 'thin-line-clean')
        .filter(result => (result.confidence || 0) >= Math.max(78, maxConfidence + 8))
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
    const trustedHighConfidence = valid
        .map(result => {
            const support = countCandidateSupport(result, valid);
            const variantBonus = result.variant === 'thin-line-clean'
                ? 8
                : (result.variant === 'loose-color' || result.variant === 'simple-threshold')
                    ? 5
                    : result.variant === 'balanced-color'
                        ? 2
                        : 0;
            return {
                result,
                score: support * 8 + (result.confidence || 0) / 5 + variantBonus
            };
        })
        .filter(item => ['balanced-color', 'loose-color', 'thin-line-clean', 'simple-threshold', 'legacy-fallback'].includes(item.result.variant))
        .filter(item => (item.result.confidence || 0) >= 72)
        .sort((a, b) => b.score - a.score)[0];

    if (standoutThinLine) return standoutThinLine.code;
    if (trustedHighConfidence) return trustedHighConfidence.result.code;

    const repeatedPConsensus = findRepeatedPConsensus(valid);
    if (repeatedPConsensus) return repeatedPConsensus;

    const supportedWhole = valid
        .map(result => {
            const support = countCandidateSupport(result, valid);
            return {
                result,
                support,
                score: support * 10
                    + getVariantTieBreakBonus(result.variant)
                    + Math.max(0, result.confidence || 0) / 10
            };
        })
        .filter(item => item.support >= 6)
        .filter(item => item.result.variant !== 'aggressive-line-clean')
        .filter(item => (item.result.confidence || 0) >= (item.support >= 7 ? 40 : 50))
        .sort((a, b) => b.score - a.score)[0];

    if (supportedWhole) return supportedWhole.result.code;

    const moderatelyTrusted = valid
        .map(result => ({
            result,
            support: countCandidateSupport(result, valid)
        }))
        .filter(item => ['loose-color', 'simple-threshold'].includes(item.result.variant))
        .filter(item => (item.result.confidence || 0) >= 55)
        .filter(item => item.support >= 3)
        .sort((a, b) => {
            const scoreA = a.support * 10 + (a.result.confidence || 0);
            const scoreB = b.support * 10 + (b.result.confidence || 0);
            return scoreB - scoreA;
        })[0];

    if (moderatelyTrusted) return moderatelyTrusted.result.code;

    const supportedThinLine = valid
        .map(result => ({
            result,
            support: countCandidateSupport(result, valid)
        }))
        .filter(item => item.result.variant === 'thin-line-clean')
        .filter(item => item.support >= 3)
        .filter(item => valid.some(other => {
            return other !== item.result
                && other.code
                && other.code.length === item.result.code.length
                && countSameOtherPositions(item.result.code, other.code, -1) >= 3;
        }))
        .sort((a, b) => {
            const scoreA = a.support * 10 + (a.result.confidence || 0);
            const scoreB = b.support * 10 + (b.result.confidence || 0);
            return scoreB - scoreA;
        })[0];

    if (supportedThinLine) return supportedThinLine.result.code;

    const supportedLegacy = valid
        .map(result => ({
            result,
            support: countCandidateSupport(result, valid)
        }))
        .filter(item => item.result.variant === 'legacy-fallback')
        .filter(item => item.support >= 6)
        .filter(item => valid.some(other => {
            return other !== item.result
                && other.code
                && other.code.length === item.result.code.length
                && countSameOtherPositions(item.result.code, other.code, -1) >= 3;
        }))
        .sort((a, b) => {
            const scoreA = a.support * 10 + (a.result.confidence || 0);
            const scoreB = b.support * 10 + (b.result.confidence || 0);
            return scoreB - scoreA;
        })[0];

    if (supportedLegacy) return supportedLegacy.result.code;

    const supportedLowConfidence = findSupportedLowConfidenceWhole(valid);
    if (supportedLowConfidence) return supportedLowConfidence;

    const complementaryPartial = findComplementaryPartialCode(results, valid);
    return complementaryPartial || '';
}

async function createCaptchaWorker() {
    const pageSegMode = typeof window !== 'undefined' && window.NJU_OCR_PSM
        ? String(window.NJU_OCR_PSM)
        : '13';
    const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: chrome.runtime.getURL('langs/worker.min.js'),
        corePath: chrome.runtime.getURL('langs/tesseract-core.wasm.js'),
        langPath: chrome.runtime.getURL('langs/'),
        gzip: false,
        errorHandler: m => console.error(m),
        logger: m => { }
    });

    await worker.setParameters({
        tessedit_char_whitelist: CAPTCHA_CHAR_WHITELIST,
        tessedit_pageseg_mode: pageSegMode,
        user_defined_dpi: '300'
    });

    return worker;
}

function getCaptchaWorkerTargetCount() {
    if (!Tesseract.createScheduler) return 1;

    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : CAPTCHA_OCR_MAX_WORKERS;
    return Math.max(1, Math.min(CAPTCHA_OCR_MAX_WORKERS, cores));
}

async function createCaptchaOcrEngine() {
    if (!Tesseract.createScheduler) {
        const worker = await createCaptchaWorker();
        return {
            parallel: false,
            workerCount: 1,
            recognize: image => worker.recognize(image),
            terminate: () => worker.terminate()
        };
    }

    const scheduler = Tesseract.createScheduler();
    let terminated = false;
    let extraWorkersPromise = Promise.resolve();
    const firstWorker = await createCaptchaWorker();
    scheduler.addWorker(firstWorker);

    const engine = {
        parallel: true,
        workerCount: 1,
        recognize: image => scheduler.addJob('recognize', image),
        terminate: async () => {
            terminated = true;
            await extraWorkersPromise.catch(() => { });
            await scheduler.terminate();
        }
    };

    const extraWorkerCount = getCaptchaWorkerTargetCount() - 1;
    if (extraWorkerCount > 0) {
        extraWorkersPromise = Promise.all(
            Array.from({ length: extraWorkerCount }, () => createCaptchaWorker())
        ).then(workers => {
            for (const worker of workers) {
                if (terminated) {
                    worker.terminate().catch(() => { });
                } else {
                    scheduler.addWorker(worker);
                    engine.workerCount++;
                }
            }
        }).catch(err => {
            console.warn("NJU 助手：并行 OCR worker 初始化失败，已降级为单 worker:", err);
        });
    }

    return engine;
}

function getCaptchaWorker() {
    if (!captchaWorkerPromise) {
        captchaWorkerPromise = createCaptchaOcrEngine().catch(err => {
            captchaWorkerPromise = null;
            throw err;
        });
    }
    return captchaWorkerPromise;
}

async function resetCaptchaWorker() {
    if (!captchaWorkerPromise) return;
    try {
        const engine = await captchaWorkerPromise;
        await engine.terminate();
    } catch (err) {
        console.warn("NJU 助手：重置 OCR worker 时出现异常:", err);
    } finally {
        captchaWorkerPromise = null;
    }
}

async function recognizeCaptchaVariant(engine, base, variant) {
    const canvas = createPreprocessedCanvas(base, variant);
    const { data } = await engine.recognize(canvas);
    return {
        variant: variant.name,
        text: data.text || '',
        code: normalizeCaptchaCode(data.text),
        confidence: data.confidence || 0,
        priority: variant.priority
    };
}

async function recognizeCaptchaVariants(engine, base, variants = CAPTCHA_OCR_VARIANTS) {
    if (engine.parallel) {
        return Promise.all(
            variants.map(variant => recognizeCaptchaVariant(engine, base, variant))
        );
    }

    const results = [];
    for (const variant of variants) {
        results.push(await recognizeCaptchaVariant(engine, base, variant));
    }
    return results;
}

async function isCaptchaCnnEnabled(options = {}) {
    if (typeof options.templateRerank === 'boolean') {
        return options.templateRerank;
    }
    if (captchaCnnEnabledPromise) return await captchaCnnEnabledPromise;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return true;
    captchaCnnEnabledPromise = chrome.storage.local.get(['nju_template_rerank'])
        .then(settings => settings.nju_template_rerank !== false)
        .catch(() => true);
    return await captchaCnnEnabledPromise;
}

function shouldRunLegacyOcrForCnn(cnnResult) {
    if (!cnnResult || !cnnResult.code || cnnResult.code.length !== 4) return true;
    if (cnnResult.code[0] === 'c' || cnnResult.code[0] === 'e') return true;
    return cnnResult.chars.some(item => (item.confidence || 0) < 0.5);
}

function fuseCaptchaCnnWithOcr(cnnResult, ocrCode) {
    if (!cnnResult || !cnnResult.code || cnnResult.code.length !== 4) {
        return { code: ocrCode || '', fallbacks: [] };
    }
    if (!ocrCode || ocrCode.length !== 4) {
        return { code: cnnResult.code, fallbacks: [] };
    }

    const output = [...cnnResult.code];
    const candidates = [];
    const cnnFirst = output[0].toLowerCase();
    const ocrFirst = ocrCode[0].toLowerCase();
    const protectFirstCE = cnnFirst !== ocrFirst
        && [cnnFirst, ocrFirst].every(char => char === 'c' || char === 'e');
    if (protectFirstCE) {
        candidates.push({ position: 0, reason: 'first-ce', confidence: cnnResult.chars[0].confidence || 0 });
    }
    for (let position = 0; position < 4; position++) {
        if (output[position].toLowerCase() === ocrCode[position].toLowerCase()) continue;
        const confidence = cnnResult.chars[position].confidence || 0;
        if (confidence < 0.5) {
            candidates.push({ position, reason: 'low-confidence', confidence });
        }
    }
    candidates.sort((left, right) => {
        if (left.reason !== right.reason) return left.reason === 'first-ce' ? -1 : 1;
        return left.confidence - right.confidence;
    });

    const selected = candidates.slice(0, 1);
    for (const item of selected) output[item.position] = ocrCode[item.position];
    return { code: output.join(''), fallbacks: selected };
}

function getFastCaptchaVariants() {
    return CAPTCHA_OCR_VARIANTS.filter(variant => !variant.fallbackOnly);
}

function getFallbackCaptchaVariants() {
    return CAPTCHA_OCR_VARIANTS.filter(variant => variant.fallbackOnly);
}

function shouldRunFallbackVariants(results, selectedCode) {
    if (!selectedCode) return true;

    const valid = results.filter(result => result.code.length === 4);
    if (valid.length < 3) return false;

    const compatibleExactMatches = valid.filter(result => isSameCaptchaCode(result.code, selectedCode));
    const strongCloseDisagreement = valid.some(result => {
        return result.code
            && result.code.length === selectedCode.length
            && !isSameCaptchaCode(result.code, selectedCode)
            && ['thin-line-clean', 'legacy-fallback'].includes(result.variant)
            && (result.confidence || 0) >= 50
            && countSameOtherPositions(selectedCode, result.code, -1) >= 2;
    });
    if (compatibleExactMatches.length <= 2 && strongCloseDisagreement) return true;

    const exactMatches = valid.filter(result => result.code === selectedCode);
    const maxConfidence = exactMatches.reduce((max, result) => Math.max(max, result.confidence || 0), 0);
    return maxConfidence < 65;
}

async function recognizeCaptchaCode(imgElement, options = {}) {
    const cnnEnabled = await isCaptchaCnnEnabled(options);
    let cnnResult = null;
    if (cnnEnabled && typeof window !== 'undefined' && window.NjuCaptchaCnn) {
        try {
            cnnResult = await window.NjuCaptchaCnn.recognize(imgElement);
            if (!shouldRunLegacyOcrForCnn(cnnResult)) {
                const cnnCandidate = {
                    variant: 'raw-cnn',
                    code: cnnResult.code,
                    confidence: Math.min(...cnnResult.chars.map(item => item.confidence || 0)) * 100
                };
                console.log(
                    'NJU 助手：CNN识别：',
                    cnnResult.code,
                    `(${Math.round(cnnCandidate.confidence)})`,
                    '=>',
                    cnnResult.code
                );
                if (options.includeDetails) {
                    return {
                        code: cnnResult.code,
                        selectedCode: cnnResult.code,
                        templateEnabled: true,
                        cnnEnabled: true,
                        cnnResult,
                        cnnFusion: { code: cnnResult.code, fallbacks: [] },
                        templateRerank: null,
                        candidates: [cnnCandidate]
                    };
                }
                return cnnResult.code;
            }
        } catch (err) {
            console.warn('NJU 助手：CNN 识别失败，已回退 Tesseract OCR:', err);
        }
    }

    const base = await readCaptchaBitmap(imgElement);
    const engine = await getCaptchaWorker();
    let results = [];

    try {
        results = await recognizeCaptchaVariants(engine, base, getFastCaptchaVariants());
        let selectedCode = selectCaptchaCode(results);
        if (shouldRunFallbackVariants(results, selectedCode)) {
            const fallbackResults = await recognizeCaptchaVariants(engine, base, getFallbackCaptchaVariants());
            results = results.concat(fallbackResults);
            selectedCode = selectCaptchaCode(results);
        }

        let code = selectedCode ? correctVisualConfusions(selectedCode, base, results) : '';
        let templateRerankConfig = await getCaptchaTemplateRuntimeConfig();
        if (typeof options.templateRerank === 'boolean') {
            if (options.templateRerank && !templateRerankConfig.model) {
                const model = await getCaptchaTemplateModel();
                templateRerankConfig = getTemplateRerankConfig({
                    ...(model?.recommended || {}),
                    enabled: Boolean(model),
                    model
                });
            } else {
                templateRerankConfig = getTemplateRerankConfig({
                    ...templateRerankConfig,
                    enabled: options.templateRerank
                });
            }
        }
        const templateRerank = rerankCaptchaCodeWithTemplate(base, results, code, templateRerankConfig);
        if (templateRerank.overridden) {
            code = templateRerank.selectedAfter;
        }
        const templateRerankEnabled = templateRerank.enabled;
        const cnnFusion = cnnEnabled && cnnResult
            ? fuseCaptchaCnnWithOcr(cnnResult, code)
            : null;
        if (cnnFusion) code = cnnFusion.code;
        const outputResults = cnnResult
            ? [{
                variant: 'raw-cnn',
                code: cnnResult.code,
                confidence: Math.min(...cnnResult.chars.map(item => item.confidence || 0)) * 100
            }, ...results]
            : results;
        console.log(
            "NJU 助手：OCR候选：",
            outputResults.map(r => `${r.variant}${r.variant === 'balanced-color' ? '*' : ''}=${r.code || '空'}(${Math.round(r.confidence)})`).join(' | '),
            templateRerankEnabled
                ? `| 模板重排：${templateRerank.selectedBefore || '空'}=>${templateRerank.selectedAfter || '空'} ${templateRerank.reason}`
                : '',
            cnnFusion && cnnFusion.fallbacks.length
                ? `| CNN回退：${cnnFusion.fallbacks.map(item => `${item.position + 1}:${item.reason}`).join(',')}`
                : '',
            "=>",
            code || '无有效结果'
        );
        if (options.includeDetails) {
            return {
                code,
                selectedCode,
                templateEnabled: cnnEnabled || templateRerank.enabled,
                cnnEnabled,
                cnnResult,
                cnnFusion,
                templateRerank,
                candidates: outputResults.map(result => ({
                    variant: result.variant,
                    code: result.code || '',
                    confidence: result.confidence || 0
                }))
            };
        }
        return code;
    } catch (err) {
        await resetCaptchaWorker();
        throw err;
    }
}

function shouldPrewarmLegacyCaptchaRuntime() {
    if (!isAuthserverLoginPage()) return false;
    return !window.NjuAuthLoginFastPath?.getSnapshot?.().sliderDetected;
}

chrome.storage.local.get(['nju_enabled', 'nju_template_rerank']).then(settings => {
    if (settings.nju_enabled !== false && shouldPrewarmLegacyCaptchaRuntime()) {
        if (settings.nju_template_rerank !== false && window.NjuCaptchaCnn) {
            window.NjuCaptchaCnn.loadModel()
                .catch(err => console.warn('NJU 助手：预热 CNN 模型失败:', err));
        } else {
            getCaptchaWorker().catch(err => console.warn("NJU 助手：预热 OCR worker 失败:", err));
        }
    }
});

if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.nju_template_rerank || changes.nju_template_debug) {
            captchaTemplateRuntimeConfigPromise = null;
            captchaCnnEnabledPromise = null;
        }
    });
}

window.addEventListener('beforeunload', () => {
    resetCaptchaWorker();
});

let captchaStatusTimer = null;

function getCaptchaStatusNotice() {
    let notice = document.getElementById('nju-captcha-status-notice');
    if (notice) return notice;

    notice = document.createElement('div');
    notice.id = 'nju-captcha-status-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.style.cssText = [
        'position:fixed',
        'top:16px',
        'right:16px',
        'z-index:2147483647',
        'display:none',
        'align-items:center',
        'gap:10px',
        'max-width:min(340px,calc(100vw - 32px))',
        'padding:11px 14px',
        'border:1px solid rgba(99,71,152,.24)',
        'border-radius:8px',
        'background:#ffffff',
        'color:#252033',
        'font:600 13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif',
        'box-shadow:0 12px 28px rgba(36,28,55,.20)',
        'opacity:0',
        'transform:translateY(-8px)',
        'transition:opacity .18s ease,transform .18s ease'
    ].join(';');

    const indicator = document.createElement('span');
    indicator.dataset.njuCaptchaStatusIcon = 'true';
    indicator.style.cssText = 'flex:0 0 auto;width:18px;height:18px;border:2px solid #c8bedc;border-top-color:#634798;border-radius:50%;animation:njuCaptchaStatusSpin .75s linear infinite';

    const text = document.createElement('span');
    text.dataset.njuCaptchaStatusText = 'true';
    notice.append(indicator, text);
    document.body.appendChild(notice);

    const style = document.createElement('style');
    style.textContent = '@keyframes njuCaptchaStatusSpin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
    return notice;
}

function showCaptchaStatus(message, state = 'loading', autoHideMs = 0) {
    if (captchaStatusTimer) {
        clearTimeout(captchaStatusTimer);
        captchaStatusTimer = null;
    }

    const notice = getCaptchaStatusNotice();
    const indicator = notice.querySelector('[data-nju-captcha-status-icon]');
    const text = notice.querySelector('[data-nju-captcha-status-text]');
    const colors = {
        loading: '#634798',
        success: '#14804a',
        warning: '#9a6700',
        error: '#b42318'
    };

    text.textContent = message;
    if (state === 'loading') {
        indicator.textContent = '';
        indicator.style.cssText = 'flex:0 0 auto;width:18px;height:18px;border:2px solid #c8bedc;border-top-color:#634798;border-radius:50%;animation:njuCaptchaStatusSpin .75s linear infinite';
    } else {
        indicator.textContent = state === 'success' ? '\u2713' : state === 'warning' ? '!' : '\u00d7';
        indicator.style.cssText = `display:grid;place-items:center;flex:0 0 auto;width:18px;height:18px;border-radius:50%;background:${colors[state]};color:#fff;font:700 12px/18px system-ui`;
    }

    notice.style.display = 'flex';
    requestAnimationFrame(() => {
        notice.style.opacity = '1';
        notice.style.transform = 'translateY(0)';
    });

    if (autoHideMs > 0) {
        captchaStatusTimer = setTimeout(hideCaptchaStatus, autoHideMs);
    }
}

function hideCaptchaStatus() {
    const notice = document.getElementById('nju-captcha-status-notice');
    if (!notice) return;
    notice.style.opacity = '0';
    notice.style.transform = 'translateY(-8px)';
    captchaStatusTimer = setTimeout(() => {
        notice.style.display = 'none';
    }, 180);
}

let isSolving = false; // 互斥锁，防止并发重复执行
let retryTimer = null; // 统一管理重试定时器，防止多个定时器堆积
let autoRefreshCount = 0; // 自动刷新次数计数，防止无限循环
let isProgrammaticRefresh = false; // 标记是否为程序触发的图片刷新

async function previewCaptchaRecognition(templateRerank) {
    if (isSolving) {
        return { ok: false, ready: true, error: '当前自动识别正在进行中' };
    }

    const imgElement = document.querySelector(IMG_SELECTOR);
    const inputElement = document.querySelector(INPUT_SELECTOR);
    if (!imgElement || !inputElement || imgElement.naturalWidth === 0) {
        return { ok: false, ready: false, error: '验证码尚未加载完成' };
    }

    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    isSolving = true;
    try {
        showCaptchaStatus('正在重新识别验证码...', 'loading');
        const started = performance.now();
        const result = await recognizeCaptchaCode(imgElement, {
            includeDetails: true,
            templateRerank: typeof templateRerank === 'boolean' ? templateRerank : undefined
        });
        if (result.code && result.code.length === 4) {
            inputElement.value = result.code;
            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
            showCaptchaStatus('验证码已重新识别并填入', 'success', 2600);
        }
        return {
            ok: true,
            ready: true,
            elapsedMs: performance.now() - started,
            ...result
        };
    } catch (err) {
        console.error('NJU 助手：手动重新识别失败:', err);
        return { ok: false, ready: true, error: '识别失败，请刷新验证码后重试' };
    } finally {
        isSolving = false;
    }
}

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

function isAuthserverLoginPage() {
    return window.location.pathname === AUTH_LOGIN_PATH;
}

function isVisibleElement(element) {
    if (!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    return element.getClientRects().length > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
}

function findPasswordLoginContext() {
    // The live authserver page contains two forms with the same pwdFromId.
    // Select the rendered one and keep all duplicate-ID field queries form-scoped.
    const forms = Array.from(document.querySelectorAll('form#pwdFromId'));
    for (const form of forms) {
        if (!isVisibleElement(form)) continue;
        const username = form.querySelector('input[name="username"]');
        const password = form.querySelector('#password');
        const encryptedPassword = form.querySelector('#saltPassword');
        const passwordSalt = form.querySelector('#pwdEncryptSalt');
        const submitButton = form.querySelector('#login_submit');
        if (username && password && encryptedPassword && passwordSalt && submitButton) {
            return { form, username, password, encryptedPassword, passwordSalt, submitButton };
        }
    }
    return null;
}

function isSliderCaptchaPage() {
    const sliderContainer = document.getElementById('sliderCaptchaDiv');
    if (!sliderContainer) return false;
    return Array.from(document.scripts).some(script => /captchaSwitch\s*=\s*["']2["']/.test(script.textContent || ''));
}

function setNativeFieldValue(element, value) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillPasswordLoginContext(context, settings) {
    const force = Boolean(settings.nju_force);
    if ((force || !context.username.value.trim()) && settings.nju_user) {
        setNativeFieldValue(context.username, settings.nju_user);
    }
    if ((force || !context.password.value) && settings.nju_pass) {
        context.password.removeAttribute('readonly');
        setNativeFieldValue(context.password, settings.nju_pass);
    }
    return Boolean(context.username.value.trim() && context.password.value);
}

async function checkAuthserverNeedsCaptcha(username) {
    const endpoint = new URL(`/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(username)}`, window.location.origin);
    const request = await fetch(endpoint.href, {
        method: 'GET',
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!request.ok) throw new Error(`验证码状态检查失败 (${request.status})`);
    const result = await request.json();
    return Boolean(result?.isNeed);
}

async function submitPasswordLoginContext(context) {
    const sliderRuntime = window.NjuAuthSliderCaptcha;
    if (!sliderRuntime?.encryptForPage) throw new Error('滑块认证运行时未加载');
    const encrypted = await sliderRuntime.encryptForPage(context.password.value, context.passwordSalt.value);
    setNativeFieldValue(context.encryptedPassword, encrypted);
    context.password.setAttribute('disabled', 'disabled');
    HTMLFormElement.prototype.submit.call(context.form);
}

function openManualSliderFallback(context, reason) {
    showCaptchaStatus(reason || '安全验证需要手动完成', 'warning', 5200);
    context.password.removeAttribute('disabled');
    context.submitButton.click();
}

async function submitAuthenticatedPassword(context) {
    try {
        await submitPasswordLoginContext(context);
        return true;
    } catch (error) {
        console.warn('NJU 助手：无法提交新版认证表单:', error);
        openManualSliderFallback(context, '自动提交失败，已打开官方滑块');
        return false;
    }
}

async function solveSliderAuthentication(settings, context) {
    const hasCredentials = fillPasswordLoginContext(context, settings);
    const username = context.username.value.trim();
    if (!hasCredentials || !username) {
        showCaptchaStatus('请先在插件中保存账号和密码', 'warning', 4200);
        return;
    }
    if (settings.nju_auto_click === false) {
        showCaptchaStatus('账号已填入，自动登录已暂停', 'success', 3600);
        return;
    }

    let needsCaptcha;
    try {
        showCaptchaStatus('正在检查登录状态...', 'loading');
        needsCaptcha = await checkAuthserverNeedsCaptcha(username);
    } catch (error) {
        console.warn('NJU 助手：无法检查新版验证码状态:', error);
        openManualSliderFallback(context, '无法检查安全验证，请使用页面滑块');
        return;
    }

    if (!needsCaptcha) {
        showCaptchaStatus('无需安全验证，正在登录...', 'success');
        await submitAuthenticatedPassword(context);
        return;
    }

    const sliderRuntime = window.NjuAuthSliderCaptcha;
    if (!sliderRuntime?.solve) {
        openManualSliderFallback(context, '滑块识别模块未加载，请使用页面滑块');
        return;
    }

    showCaptchaStatus('正在完成安全验证...', 'loading');
    const result = await sliderRuntime.solve({
        attempts: 3,
        onStatus: state => {
            if (state.phase === 'matching') showCaptchaStatus(`正在定位拼图缺口（${state.attempt}/3）...`, 'loading');
            if (state.phase === 'verifying') showCaptchaStatus(`正在验证安全校验（${state.attempt}/3）...`, 'loading');
        }
    });
    if (!result.ok) {
        console.warn('NJU 助手：滑块自动验证未通过:', result.error);
        openManualSliderFallback(context, '自动安全验证未通过，已打开官方滑块');
        return;
    }

    console.log(
        `NJU 助手：滑块验证通过，缺口 ${result.match.moveLength}px，`
        + `score ${result.match.confidence.toFixed(3)}，margin ${result.match.margin.toFixed(3)}`
    );
    showCaptchaStatus('安全验证通过，正在登录...', 'success');
    await submitAuthenticatedPassword(context);
}

async function consumeFastAuthLogin(settings, context) {
    const fastPath = window.NjuAuthLoginFastPath;
    if (!fastPath?.getResult || !isSliderCaptchaPage()) return false;

    const snapshot = fastPath.getSnapshot?.();
    if (snapshot?.phase && !['ready', 'failed', 'error', 'not-slider', 'skipped'].includes(snapshot.phase)) {
        showCaptchaStatus('正在完成安全验证...', 'loading');
    }

    const outcome = await fastPath.getResult();
    if (!outcome || ['ignored', 'skipped', 'not-slider', 'error'].includes(outcome.kind)) return false;

    const hasCredentials = fillPasswordLoginContext(context, settings);
    if (!hasCredentials || settings.nju_auto_click === false) return false;
    if (outcome.username && context.username.value.trim() !== outcome.username) return false;

    if (outcome.kind === 'no-captcha') {
        showCaptchaStatus('无需安全验证，正在登录...', 'success');
        await submitAuthenticatedPassword(context);
        return true;
    }

    if (outcome.kind === 'slider') {
        if (!outcome.sliderResult?.ok) {
            console.warn('NJU 助手：快速滑块验证未通过:', outcome.sliderResult?.error);
            openManualSliderFallback(context, '自动安全验证未通过，已打开官方滑块');
            return true;
        }
        showCaptchaStatus('安全验证通过，正在登录...', 'success');
        await submitAuthenticatedPassword(context);
        return true;
    }

    return false;
}

async function _solveCaptchaImpl() {
    // --- 新增：检查插件是否启用 ---
    const settings = await chrome.storage.local.get(['nju_enabled', 'nju_user', 'nju_pass', 'nju_force', 'nju_auto_click']);
    if (settings.nju_enabled === false) {
        console.log("NJU 助手：当前处于关闭状态。");
        return;
    }
    // ----------------------------

    const passwordLoginContext = findPasswordLoginContext();
    if (passwordLoginContext && isSliderCaptchaPage()) {
        if (await consumeFastAuthLogin(settings, passwordLoginContext)) return;
        await solveSliderAuthentication(settings, passwordLoginContext);
        return;
    }

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

    showCaptchaStatus('正在识别验证码...', 'loading');

    try {
        const code = await recognizeCaptchaCode(imgElement);

        if (code && code.length === 4) {
            autoRefreshCount = 0; // 识别成功，重置刷新计数
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

            // 3. 自动登录
            if (settings.nju_auto_click !== false) {
                console.log("NJU助手：自动登录开关已开启，准备点击登录...");
                showCaptchaStatus('验证码已填入，正在登录...', 'success');
                setTimeout(() => {
                    const loginBtn = document.querySelector("#login_submit") || document.querySelector(".auth_login_btn");
                    if (loginBtn) {
                        loginBtn.click();
                    } else {
                        console.warn("NJU 助手：未找到登录按钮，请手动点击。");
                    }
                }, 350);
            } else {
                console.log("NJU助手：自动登录开关关闭，请手动检查后点击。");
                showCaptchaStatus('验证码已识别并填入，请确认后登录', 'success', 3600);
            }
        } else {
            const MAX_AUTO_REFRESHES = 5;
            if (autoRefreshCount < MAX_AUTO_REFRESHES) {
                autoRefreshCount++;
                console.log(`NJU 助手：识别结果不完整，自动刷新重试 (${autoRefreshCount}/${MAX_AUTO_REFRESHES})...`);
                showCaptchaStatus(`识别不完整，正在刷新重试（${autoRefreshCount}/${MAX_AUTO_REFRESHES}）`, 'warning');
                isProgrammaticRefresh = true;
                // 点击页面自带的"刷新"链接，触发 reloadCaptcha(true)，正确刷新验证码图片
                const refreshBtn = document.querySelector('.captcha-refresh');
                if (refreshBtn) {
                    refreshBtn.click();
                } else if (typeof window.reloadCaptcha === 'function') {
                    window.reloadCaptcha(true);
                } else {
                    // 最终保底：直接修改 src
                    imgElement.src = imgElement.src.replace(/\?\d+$/, '') + '?' + Date.now();
                }
                scheduleRetry(1200); // 保底：如果 load 事件未触发，1.2秒后直接重试
            } else {
                console.warn("NJU 助手：连续多次识别失败，已停止自动刷新，请手动点击\"刷新\"后重试。");
                showCaptchaStatus('识别未完成，请刷新验证码后重试', 'error', 5000);
                autoRefreshCount = 0;
                isProgrammaticRefresh = false; // 重置，防止状态卡住导致手动刷新不生效
            }
        }
    } catch (err) {
        console.error("识别出错:", err);
        showCaptchaStatus('识别暂时失败，正在重试...', 'error', 2600);
        scheduleRetry(2000); // 出错后也保底重试
    }
}

// Only the login route owns automatic recognition. The content script also
// matches post-login authserver pages, where retrying would be pointless.
if (isAuthserverLoginPage()) {
    // document_idle 时登录表单通常已就绪；图片若未完成加载，识别流程会自行短轮询。
    void solveCaptcha();
}

// 使用捕获阶段事件委托监听验证码图片刷新
// load 事件不冒泡，必须用 capture:true；同时避免元素未就绪时 ?. 静默失败
document.addEventListener('load', (e) => {
    if (e.target && e.target.matches && e.target.matches(IMG_SELECTOR)) {
        console.log("验证码图片已更新，准备识别...");
        // 清空验证码输入框，防止旧值触发"已填入，跳过识别"的逻辑
        const inputEl = document.querySelector(INPUT_SELECTOR);
        if (inputEl) {
            inputEl.value = '';
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (isProgrammaticRefresh) {
            // 程序触发的刷新：不重置计数，继续计数逻辑
            isProgrammaticRefresh = false;
        } else {
            // 用户手动点击刷新：重置自动刷新计数，给新一轮完整的重试机会
            console.log("NJU 助手：检测到用户手动刷新验证码，重置自动刷新计数。");
            autoRefreshCount = 0;
        }
        scheduleRetry(250); // 用 scheduleRetry 取代旧定时器，防止与保底重试叠加
    }
}, true);

if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'getCaptchaPreviewStatus') {
            const image = document.querySelector(IMG_SELECTOR);
            const sliderCaptcha = isSliderCaptchaPage();
            sendResponse({
                ok: true,
                mode: sliderCaptcha ? 'slider' : 'legacy-ocr',
                ready: !sliderCaptcha && Boolean(image && image.naturalWidth > 0)
            });
        } else if (message.action === 'recognizeCaptchaPreview') {
            previewCaptchaRecognition(message.templateRerank).then(sendResponse);
        } else {
            return false;
        }
        return true;
    });
}
