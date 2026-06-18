// content.js
const EXTENSION_VERSION = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest().version
    : 'dev';
console.log(`NJU 验证码识别助手 v${EXTENSION_VERSION} 已启动...`);

const IMG_SELECTOR = "#captchaImg";
const INPUT_SELECTOR = "#captcha";
const CAPTCHA_CHAR_WHITELIST = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
let captchaWorkerPromise = null;
const CAPTCHA_OCR_VARIANTS = [
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
        priority: 4
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
    if (variant.legacy) return createLegacyPreprocessedCanvas(base, variant);
    if (variant.simpleThreshold) return createThresholdPreprocessedCanvas(base, variant);
    return createColorPreprocessedCanvas(base, variant);
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
        const left = counts[i - 1] || 0;
        const center = counts[i] || 0;
        const right = counts[i + 1] || 0;
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

function correctDigitFiveFromShape(code, base, results, mask) {
    if (!/[Ss]/.test(code)) return code;

    const chars = code.split('');
    const valid = results.filter(result => result.code && result.code.length === chars.length);

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'S' && chars[i] !== 's') continue;

        const candidateVotes5 = valid
            .filter(result => result.code[i] === '5')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesS = valid
            .filter(result => result.code[i] === 'S' || result.code[i] === 's')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (candidateVotes5 > candidateVotesS) {
            chars[i] = '5';
            continue;
        }

        const shapeLooksLikeFive = isLikelyDigitFive(mask, base.width, base.height, i, chars.length);
        const hasUsefulCandidate = candidateVotes5 > 0 && candidateVotes5 + 1.5 >= candidateVotesS;
        if (shapeLooksLikeFive && (hasUsefulCandidate || i === 0)) {
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

    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'B' && chars[i] !== 'b') continue;

        const candidateVotesD = valid
            .filter(result => result.code[i] === 'D' || result.code[i] === 'd')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);
        const candidateVotesB = valid
            .filter(result => result.code[i] === 'B' || result.code[i] === 'b')
            .reduce((score, result) => score + result.priority + Math.max(0, result.confidence || 0) / 25, 0);

        if (candidateVotesD > candidateVotesB + 1 || isLikelyUppercaseD(mask, base.width, base.height, i, chars.length)) {
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
            chars[i] = 'm';
            continue;
        }

        if (isLikelyLowercaseM(mask, base.width, base.height, i, chars.length)) {
            chars[i] = 'm';
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

function correctSimpleUppercaseFromShape(code, base, mask) {
    const chars = code.split('');
    for (let i = 0; i < chars.length; i++) {
        if (chars[i] !== 'u' && chars[i] !== 'c') continue;
        if (isLikelyUppercaseSimpleShape(mask, base.width, base.height, i, chars.length)) {
            chars[i] = chars[i].toUpperCase();
        }
    }
    return chars.join('');
}

function correctVisualConfusions(code, base, results) {
    if (!code) return code;

    const mask = getCorrectionMask(base);
    let corrected = correctCaseFromCandidates(code, results);
    corrected = correctJFromShape(corrected, base, results, mask);
    corrected = correctDFromShape(corrected, base, results, mask);
    corrected = correctDigitFiveFromShape(corrected, base, results, mask);
    corrected = correctMFromShape(corrected, base, results, mask);
    corrected = correctSimpleUppercaseFromShape(corrected, base, mask);
    return corrected;
}

function selectCaptchaCode(results) {
    const valid = results.filter(result => result.code.length === 4);
    if (!valid.length) return '';
    if (valid.length === 1) {
        return (valid[0].confidence || 0) >= 45 ? valid[0].code : '';
    }

    const totals = Array.from({ length: 4 }, () => new Map());
    for (const result of valid) {
        const confidenceBonus = Math.min(3, Math.max(0, result.confidence || 0) / 25);
        const weight = result.priority + confidenceBonus;
        for (let i = 0; i < 4; i++) {
            totals[i].set(result.code[i], (totals[i].get(result.code[i]) || 0) + weight);
        }
    }

    const consensus = totals.map(positionVotes => {
        let bestChar = '';
        let bestWeight = -1;
        for (const [char, weight] of positionVotes) {
            if (weight > bestWeight) {
                bestChar = char;
                bestWeight = weight;
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
    const exactMatches = valid.filter(result => result.code === selected);
    const maxConfidence = exactMatches.reduce((max, result) => Math.max(max, result.confidence || 0), 0);
    const reliable = exactMatches.length >= 3 || (exactMatches.length >= 2 && maxConfidence >= 35);
    const trustedHighConfidence = valid
        .filter(result => ['loose-color', 'simple-threshold', 'legacy-fallback'].includes(result.variant))
        .filter(result => (result.confidence || 0) >= 75)
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];

    return reliable ? selected : (trustedHighConfidence ? trustedHighConfidence.code : '');
}

async function createCaptchaWorker() {
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
        tessedit_pageseg_mode: '7',
        user_defined_dpi: '300'
    });

    return worker;
}

function getCaptchaWorker() {
    if (!captchaWorkerPromise) {
        captchaWorkerPromise = createCaptchaWorker().catch(err => {
            captchaWorkerPromise = null;
            throw err;
        });
    }
    return captchaWorkerPromise;
}

async function resetCaptchaWorker() {
    if (!captchaWorkerPromise) return;
    try {
        const worker = await captchaWorkerPromise;
        await worker.terminate();
    } catch (err) {
        console.warn("NJU 助手：重置 OCR worker 时出现异常:", err);
    } finally {
        captchaWorkerPromise = null;
    }
}

async function recognizeCaptchaCode(imgElement) {
    const base = await readCaptchaBitmap(imgElement);
    const worker = await getCaptchaWorker();
    const results = [];

    try {
        for (const variant of CAPTCHA_OCR_VARIANTS) {
            const canvas = createPreprocessedCanvas(base, variant);
            const { data } = await worker.recognize(canvas);
            results.push({
                variant: variant.name,
                text: data.text || '',
                code: normalizeCaptchaCode(data.text),
                confidence: data.confidence || 0,
                priority: variant.priority
            });
        }
    } catch (err) {
        await resetCaptchaWorker();
        throw err;
    }

    const selectedCode = selectCaptchaCode(results);
    const code = selectedCode ? correctVisualConfusions(selectedCode, base, results) : '';
    console.log(
        "NJU 助手：OCR候选：",
        results.map(r => `${r.variant}=${r.code || '空'}(${Math.round(r.confidence)})`).join(' | '),
        "=>",
        code || '无有效结果'
    );
    return code;
}

chrome.storage.local.get(['nju_enabled']).then(settings => {
    if (settings.nju_enabled !== false) {
        getCaptchaWorker().catch(err => console.warn("NJU 助手：预热 OCR worker 失败:", err));
    }
});

window.addEventListener('beforeunload', () => {
    resetCaptchaWorker();
});

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
let autoRefreshCount = 0; // 自动刷新次数计数，防止无限循环
let isProgrammaticRefresh = false; // 标记是否为程序触发的图片刷新

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
                }, 350);
            } else {
                console.log("NJU助手：自动登录开关关闭，请手动检查后点击。");
            }
        } else {
            const MAX_AUTO_REFRESHES = 5;
            if (autoRefreshCount < MAX_AUTO_REFRESHES) {
                autoRefreshCount++;
                console.log(`NJU 助手：识别结果不完整，自动刷新重试 (${autoRefreshCount}/${MAX_AUTO_REFRESHES})...`);
                hideLoadingAnimation();
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
                hideLoadingAnimation();
                autoRefreshCount = 0;
                isProgrammaticRefresh = false; // 重置，防止状态卡住导致手动刷新不生效
            }
        }
    } catch (err) {
        console.error("识别出错:", err);
        hideLoadingAnimation();
        scheduleRetry(2000); // 出错后也保底重试
    }
}

// 稍微等待南大脚本把验证码图片刷出来；若图片未就绪，后续逻辑会继续短轮询
scheduleRetry(800);

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
