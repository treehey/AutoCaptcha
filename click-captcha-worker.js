import * as ort from './vendor/onnxruntime/ort.wasm.bundle.min.js';

const REFERENCE_WIDTH = 250;
const REFERENCE_HEIGHT = 120;
const SCENE_HEIGHT = 100;
const MODEL_SIZE = 64;
// The bottom prompt text is high contrast, but candidate glyphs may be very
// pale after background subtraction. Keep their bounding-box thresholds apart
// so a faint candidate is not expanded back to its entire slot before resize.
const TARGET_FOREGROUND_THRESHOLD = 160;
const CANDIDATE_FOREGROUND_THRESHOLD = 205;
const CANDIDATE_MIN_COMPONENT_PIXELS = 2;
const CANDIDATE_ISOLATED_NOISE_EXPANSION = 12;
const RESIDUAL_GAIN = 2;
const TARGET_SLOTS = [[120, 134], [143, 157], [166, 180], [189, 203]];
const CANDIDATE_SLOTS = [[0, 58], [58, 128], [128, 190], [190, 250]];
const TARGET_TOP = 101;
const TARGET_BOTTOM = 119;
const CANDIDATE_ROTATIONS = [-60, -40, -20, 0, 20, 40, 60];

let session = null;
let background = null;
let initializing = null;

function cubicWeight(value) {
  const distance = Math.abs(value);
  if (distance <= 1) return (1.5 * distance ** 3) - (2.5 * distance ** 2) + 1;
  if (distance < 2) return (-0.5 * distance ** 3) + (2.5 * distance ** 2) - (4 * distance) + 2;
  return 0;
}

function sampleBicubic(source, width, height, x, y, fill = 255) {
  const left = Math.floor(x);
  const top = Math.floor(y);
  let weighted = 0;
  let weightTotal = 0;
  for (let row = top - 1; row <= top + 2; row += 1) {
    const rowWeight = cubicWeight(y - row);
    if (!rowWeight) continue;
    for (let column = left - 1; column <= left + 2; column += 1) {
      const weight = rowWeight * cubicWeight(x - column);
      if (!weight) continue;
      const value = column < 0 || column >= width || row < 0 || row >= height
        ? fill
        : source[row * width + column];
      weighted += value * weight;
      weightTotal += weight;
    }
  }
  return weightTotal ? weighted / weightTotal : fill;
}

function resizeBicubic(source, sourceWidth, sourceHeight, width, height) {
  const output = new Float32Array(width * height);
  const xScale = sourceWidth / width;
  const yScale = sourceHeight / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = ((y + 0.5) * yScale) - 0.5;
    for (let x = 0; x < width; x += 1) {
      const sourceX = ((x + 0.5) * xScale) - 0.5;
      output[y * width + x] = sampleBicubic(source, sourceWidth, sourceHeight, sourceX, sourceY);
    }
  }
  return output;
}

function grayImageData(values, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < values.length; index += 1) {
    const value = Math.max(0, Math.min(255, Math.round(values[index])));
    const pixel = index * 4;
    data[pixel] = value;
    data[pixel + 1] = value;
    data[pixel + 2] = value;
    data[pixel + 3] = 255;
  }
  return new ImageData(data, width, height);
}

function canvasToGray(canvas) {
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const output = new Float32Array(canvas.width * canvas.height);
  for (let index = 0; index < output.length; index += 1) output[index] = data[index * 4];
  return output;
}

function resizeCanvas(source, sourceWidth, sourceHeight, width, height) {
  const input = new OffscreenCanvas(sourceWidth, sourceHeight);
  input.getContext('2d', { willReadFrequently: true }).putImageData(grayImageData(source, sourceWidth, sourceHeight), 0, 0);
  const output = new OffscreenCanvas(width, height);
  const context = output.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(input, 0, 0, width, height);
  return canvasToGray(output);
}

function rotateBicubic(source, angle) {
  if (!angle) return source.slice();
  const output = new Float32Array(MODEL_SIZE * MODEL_SIZE);
  const radians = (-angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const center = (MODEL_SIZE - 1) / 2;
  for (let y = 0; y < MODEL_SIZE; y += 1) {
    for (let x = 0; x < MODEL_SIZE; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const sourceX = (cosine * dx) - (sine * dy) + center;
      const sourceY = (sine * dx) + (cosine * dy) + center;
      output[y * MODEL_SIZE + x] = sampleBicubic(source, MODEL_SIZE, MODEL_SIZE, sourceX, sourceY);
    }
  }
  return output;
}

function rotateCanvas(source, angle) {
  if (!angle) return source.slice();
  const input = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
  input.getContext('2d', { willReadFrequently: true }).putImageData(grayImageData(source, MODEL_SIZE, MODEL_SIZE), 0, 0);
  const output = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
  const context = output.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#fff';
  context.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  context.translate(MODEL_SIZE / 2, MODEL_SIZE / 2);
  context.rotate((angle * Math.PI) / 180);
  context.drawImage(input, -MODEL_SIZE / 2, -MODEL_SIZE / 2);
  return canvasToGray(output);
}

function foregroundBox(
  gray,
  width,
  height,
  threshold,
  minimumComponentPixels = 1,
  minimumIsolatedNoiseExpansion = Infinity
) {
  if (minimumComponentPixels <= 1) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (gray[y * width + x] < threshold) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          count += 1;
        }
      }
    }
    if (count < 3) {
      return {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        foregroundPixels: count,
        sourceForegroundPixels: count,
        discardedForegroundPixels: 0,
        usedFallback: true,
        isolatedNoiseFiltered: false
      };
    }
    return {
      left: Math.max(0, minX - 2),
      top: Math.max(0, minY - 2),
      right: Math.min(width, maxX + 3),
      bottom: Math.min(height, maxY + 3),
      foregroundPixels: count,
      sourceForegroundPixels: count,
      discardedForegroundPixels: 0,
      usedFallback: false,
      isolatedNoiseFiltered: false
    };
  }

  const pixelCount = width * height;
  const foreground = new Uint8Array(pixelCount);
  const visited = new Uint8Array(pixelCount);
  const stack = new Int32Array(pixelCount);
  let sourceForegroundPixels = 0;
  let sourceMinX = width;
  let sourceMinY = height;
  let sourceMaxX = -1;
  let sourceMaxY = -1;
  for (let index = 0; index < pixelCount; index += 1) {
    if (gray[index] < threshold) {
      foreground[index] = 1;
      sourceForegroundPixels += 1;
      const x = index % width;
      const y = (index - x) / width;
      sourceMinX = Math.min(sourceMinX, x);
      sourceMinY = Math.min(sourceMinY, y);
      sourceMaxX = Math.max(sourceMaxX, x);
      sourceMaxY = Math.max(sourceMaxY, y);
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (!foreground[index] || visited[index]) continue;

    let stackLength = 0;
    let componentPixels = 0;
    let componentMinX = width;
    let componentMinY = height;
    let componentMaxX = -1;
    let componentMaxY = -1;
    stack[stackLength] = index;
    stackLength += 1;
    visited[index] = 1;

    while (stackLength) {
      stackLength -= 1;
      const current = stack[stackLength];
      const x = current % width;
      const y = (current - x) / width;
      componentPixels += 1;
      componentMinX = Math.min(componentMinX, x);
      componentMinY = Math.min(componentMinY, y);
      componentMaxX = Math.max(componentMaxX, x);
      componentMaxY = Math.max(componentMaxY, y);

      if (current >= width && foreground[current - width] && !visited[current - width]) {
        visited[current - width] = 1;
        stack[stackLength] = current - width;
        stackLength += 1;
      }
      if (current < pixelCount - width && foreground[current + width] && !visited[current + width]) {
        visited[current + width] = 1;
        stack[stackLength] = current + width;
        stackLength += 1;
      }
      if (x > 0 && foreground[current - 1] && !visited[current - 1]) {
        visited[current - 1] = 1;
        stack[stackLength] = current - 1;
        stackLength += 1;
      }
      if (x < width - 1 && foreground[current + 1] && !visited[current + 1]) {
        visited[current + 1] = 1;
        stack[stackLength] = current + 1;
        stackLength += 1;
      }
    }
    if (componentPixels < minimumComponentPixels) continue;
    minX = Math.min(minX, componentMinX);
    minY = Math.min(minY, componentMinY);
    maxX = Math.max(maxX, componentMaxX);
    maxY = Math.max(maxY, componentMaxY);
    count += componentPixels;
  }
  const isolatedNoiseExpansion = count >= 3
    ? Math.max(
      minX - sourceMinX,
      minY - sourceMinY,
      sourceMaxX - maxX,
      sourceMaxY - maxY
    )
    : 0;
  const isolatedNoiseFiltered = count >= 3
    && isolatedNoiseExpansion >= minimumIsolatedNoiseExpansion;
  if (!isolatedNoiseFiltered) {
    minX = sourceMinX;
    minY = sourceMinY;
    maxX = sourceMaxX;
    maxY = sourceMaxY;
    count = sourceForegroundPixels;
  }
  const discardedForegroundPixels = sourceForegroundPixels - count;

  if (count < 3) {
    return {
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      foregroundPixels: count,
      sourceForegroundPixels,
      discardedForegroundPixels,
      usedFallback: true,
      isolatedNoiseFiltered
    };
  }
  return {
    left: Math.max(0, minX - 2),
    top: Math.max(0, minY - 2),
    right: Math.min(width, maxX + 3),
    bottom: Math.min(height, maxY + 3),
    foregroundPixels: count,
    sourceForegroundPixels,
    discardedForegroundPixels,
    usedFallback: false,
    isolatedNoiseFiltered
  };
}

function centerGlyph(
  gray,
  width,
  height,
  renderer,
  threshold,
  minimumComponentPixels,
  minimumIsolatedNoiseExpansion
) {
  const box = foregroundBox(
    gray,
    width,
    height,
    threshold,
    minimumComponentPixels,
    minimumIsolatedNoiseExpansion
  );
  const cropWidth = Math.max(1, box.right - box.left);
  const cropHeight = Math.max(1, box.bottom - box.top);
  const crop = new Float32Array(cropWidth * cropHeight);
  for (let y = 0; y < cropHeight; y += 1) {
    const start = (box.top + y) * width + box.left;
    crop.set(gray.subarray(start, start + cropWidth), y * cropWidth);
  }
  const scale = Math.min((MODEL_SIZE - 8) / cropWidth, (MODEL_SIZE - 8) / cropHeight);
  const resizedWidth = Math.max(1, Math.round(cropWidth * scale));
  const resizedHeight = Math.max(1, Math.round(cropHeight * scale));
  const resized = renderer === 'canvas'
    ? resizeCanvas(crop, cropWidth, cropHeight, resizedWidth, resizedHeight)
    : resizeBicubic(crop, cropWidth, cropHeight, resizedWidth, resizedHeight);
  const centered = new Float32Array(MODEL_SIZE * MODEL_SIZE).fill(255);
  const left = Math.floor((MODEL_SIZE - resizedWidth) / 2);
  const top = Math.floor((MODEL_SIZE - resizedHeight) / 2);
  for (let y = 0; y < resizedHeight; y += 1) {
    centered.set(resized.subarray(y * resizedWidth, (y + 1) * resizedWidth), (top + y) * MODEL_SIZE + left);
  }
  return { glyph: centered, box };
}

function makeGrayTargets(pixels, width, height, targetCount, renderer) {
  const targets = new Float32Array(4 * MODEL_SIZE * MODEL_SIZE).fill(1);
  for (let index = 0; index < targetCount; index += 1) {
    const [left, right] = TARGET_SLOTS[index];
    const gray = new Float32Array((right - left) * (TARGET_BOTTOM - TARGET_TOP));
    let offset = 0;
    for (let y = TARGET_TOP; y < TARGET_BOTTOM; y += 1) {
      for (let x = left; x < right; x += 1) {
        const pixel = ((y * width) + x) * 4;
        gray[offset] = 255 - ((pixels[pixel] + pixels[pixel + 1] + pixels[pixel + 2]) / 3);
        offset += 1;
      }
    }
    const { glyph } = centerGlyph(
      gray,
      right - left,
      TARGET_BOTTOM - TARGET_TOP,
      renderer,
      TARGET_FOREGROUND_THRESHOLD,
      1,
      Infinity
    );
    for (let pixel = 0; pixel < glyph.length; pixel += 1) {
      targets[(index * glyph.length) + pixel] = glyph[pixel] / 255;
    }
  }
  return targets;
}

function makeCandidates(pixels, width, height, renderer) {
  const candidates = new Float32Array(4 * CANDIDATE_ROTATIONS.length * MODEL_SIZE * MODEL_SIZE);
  const boxes = [];
  const glyphSize = MODEL_SIZE * MODEL_SIZE;
  for (let index = 0; index < CANDIDATE_SLOTS.length; index += 1) {
    const [left, right] = CANDIDATE_SLOTS[index];
    const regionWidth = right - left;
    const gray = new Float32Array(regionWidth * SCENE_HEIGHT);
    let offset = 0;
    for (let y = 0; y < SCENE_HEIGHT; y += 1) {
      for (let x = left; x < right; x += 1) {
        const imageOffset = ((y * width) + x) * 4;
        const backgroundOffset = ((y * REFERENCE_WIDTH) + x) * 4;
        const residual = Math.max(
          Math.abs(pixels[imageOffset] - background[backgroundOffset]),
          Math.abs(pixels[imageOffset + 1] - background[backgroundOffset + 1]),
          Math.abs(pixels[imageOffset + 2] - background[backgroundOffset + 2])
        );
        gray[offset] = 255 - Math.min(255, residual * RESIDUAL_GAIN);
        offset += 1;
      }
    }
    const centered = centerGlyph(
      gray,
      regionWidth,
      SCENE_HEIGHT,
      renderer,
      CANDIDATE_FOREGROUND_THRESHOLD,
      CANDIDATE_MIN_COMPONENT_PIXELS,
      CANDIDATE_ISOLATED_NOISE_EXPANSION
    );
    boxes.push({
      left: left + centered.box.left,
      top: centered.box.top,
      right: left + centered.box.right,
      bottom: centered.box.bottom,
      foregroundPixels: centered.box.foregroundPixels,
      sourceForegroundPixels: centered.box.sourceForegroundPixels,
      discardedForegroundPixels: centered.box.discardedForegroundPixels,
      usedFallback: centered.box.usedFallback,
      isolatedNoiseFiltered: centered.box.isolatedNoiseFiltered
    });
    for (let rotationIndex = 0; rotationIndex < CANDIDATE_ROTATIONS.length; rotationIndex += 1) {
      const rotated = renderer === 'canvas'
        ? rotateCanvas(centered.glyph, CANDIDATE_ROTATIONS[rotationIndex])
        : rotateBicubic(centered.glyph, CANDIDATE_ROTATIONS[rotationIndex]);
      const base = ((index * CANDIDATE_ROTATIONS.length) + rotationIndex) * glyphSize;
      for (let pixel = 0; pixel < glyphSize; pixel += 1) candidates[base + pixel] = rotated[pixel] / 255;
    }
  }
  return { candidates, boxes };
}

function calculateBackgroundResidual(pixels) {
  let total = 0;
  for (let y = 0; y < SCENE_HEIGHT; y += 1) {
    for (let x = 0; x < REFERENCE_WIDTH; x += 1) {
      const offset = ((y * REFERENCE_WIDTH) + x) * 4;
      total += Math.max(
        Math.abs(pixels[offset] - background[offset]),
        Math.abs(pixels[offset + 1] - background[offset + 1]),
        Math.abs(pixels[offset + 2] - background[offset + 2])
      );
    }
  }
  return total / (REFERENCE_WIDTH * SCENE_HEIGHT);
}

function assignmentsFor(targetCount) {
  const results = [];
  const visit = (current, used) => {
    if (current.length === targetCount) {
      results.push(current.slice());
      return;
    }
    for (let candidate = 0; candidate < 4; candidate += 1) {
      if (!used[candidate]) {
        used[candidate] = true;
        current.push(candidate);
        visit(current, used);
        current.pop();
        used[candidate] = false;
      }
    }
  };
  visit([], [false, false, false, false]);
  return results;
}

function standardized(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  const spread = Math.sqrt(variance);
  return spread < 1e-8 ? values.map(() => 0) : values.map(value => (value - mean) / spread);
}

function selectAssignment(matrices, targetCount, boxes) {
  const assignments = assignmentsFor(targetCount);
  const perHead = matrices.map(matrix => standardized(assignments.map(assignment =>
    assignment.reduce((sum, candidate, target) => sum + matrix[(target * 4) + candidate], 0)
  )));
  const scores = assignments.map((_, index) => perHead.reduce((sum, head) => sum + head[index], 0) / perHead.length);
  const ranking = scores.map((score, index) => ({ score, index })).sort((left, right) => right.score - left.score);
  const best = ranking[0];
  const next = ranking[1];
  const order = assignments[best.index];
  const agreement = perHead.filter(head => {
    const bestIndex = head.reduce((currentBest, value, index) => value > head[currentBest] ? index : currentBest, 0);
    return bestIndex === best.index;
  }).length;
  return {
    order,
    points: order.map(candidate => {
      const box = boxes[candidate];
      return {
        x: Math.round((box.left + box.right) / 2),
        y: Math.round((box.top + box.bottom) / 2),
        candidate,
        // Keep the glyph bounds so the page overlay can label beside, rather
        // than directly on top of, the character the user may need to inspect.
        box: {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom
        }
      };
    }),
    margin: best.score - next.score,
    headAgreement: agreement,
    topScore: best.score,
    secondScore: next.score
  };
}

function tensorSums(values, itemSize) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += itemSize) {
    let sum = 0;
    for (let index = offset; index < offset + itemSize; index += 1) sum += values[index];
    result.push(sum);
  }
  return result;
}

function resizeSourceIfNeeded(pixels, width, height) {
  if (width === REFERENCE_WIDTH && height === REFERENCE_HEIGHT) return pixels;
  const output = new Uint8ClampedArray(REFERENCE_WIDTH * REFERENCE_HEIGHT * 4);
  for (let y = 0; y < REFERENCE_HEIGHT; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y * height) / REFERENCE_HEIGHT));
    for (let x = 0; x < REFERENCE_WIDTH; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x * width) / REFERENCE_WIDTH));
      const sourceOffset = ((sourceY * width) + sourceX) * 4;
      const targetOffset = ((y * REFERENCE_WIDTH) + x) * 4;
      output[targetOffset] = pixels[sourceOffset];
      output[targetOffset + 1] = pixels[sourceOffset + 1];
      output[targetOffset + 2] = pixels[sourceOffset + 2];
      output[targetOffset + 3] = pixels[sourceOffset + 3];
    }
  }
  return output;
}

async function imageDataFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取本地模型资产：${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

async function initialize({ modelUrl, backgroundUrl, wasmBaseUrl }) {
  if (session && background) return;
  if (!initializing) {
    initializing = (async () => {
      ort.env.wasm.wasmPaths = wasmBaseUrl.endsWith('/') ? wasmBaseUrl : `${wasmBaseUrl}/`;
      ort.env.wasm.numThreads = 1;
      background = await imageDataFromUrl(backgroundUrl);
      session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
    })();
  }
  await initializing;
}

async function solve(message) {
  if (!session || !background) throw new Error('点击验证码模型尚未初始化');
  const started = performance.now();
  const sourcePixels = new Uint8ClampedArray(message.pixels);
  const pixels = resizeSourceIfNeeded(sourcePixels, message.width, message.height);
  const renderer = message.renderer === 'custom' ? 'custom' : 'canvas';
  const backgroundResidual = calculateBackgroundResidual(pixels);
  const targets = makeGrayTargets(pixels, REFERENCE_WIDTH, REFERENCE_HEIGHT, message.targetCount, renderer);
  const candidateData = makeCandidates(pixels, REFERENCE_WIDTH, REFERENCE_HEIGHT, renderer);
  const result = await session.run({
    targets: new ort.Tensor('float32', targets, [1, 4, 1, MODEL_SIZE, MODEL_SIZE]),
    candidates: new ort.Tensor('float32', candidateData.candidates, [1, 4, CANDIDATE_ROTATIONS.length, 1, MODEL_SIZE, MODEL_SIZE])
  });
  const values = result.matrices.data;
  const matrices = Array.from({ length: 5 }, (_, head) => Array.from(values.slice(head * 16, (head + 1) * 16)));
  const chosen = selectAssignment(matrices, message.targetCount, candidateData.boxes);
  return {
    ...chosen,
    backgroundResidual,
    elapsedMs: performance.now() - started,
    modelVersion: `click-ensemble5-20260723-${renderer}`,
    referenceWidth: REFERENCE_WIDTH,
    referenceHeight: REFERENCE_HEIGHT,
    debugMatrices: message.debug ? matrices : undefined,
    debugTensorSums: message.debug ? {
      targets: tensorSums(targets, MODEL_SIZE * MODEL_SIZE),
      candidates: tensorSums(candidateData.candidates, MODEL_SIZE * MODEL_SIZE),
      candidateBoxes: candidateData.boxes.map(box => ({
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        foregroundPixels: box.foregroundPixels,
        sourceForegroundPixels: box.sourceForegroundPixels,
        discardedForegroundPixels: box.discardedForegroundPixels,
        usedFallback: box.usedFallback,
        isolatedNoiseFiltered: box.isolatedNoiseFiltered
      }))
    } : undefined
  };
}

self.onmessage = async event => {
  const message = event.data || {};
  try {
    if (message.type === 'init') {
      await initialize(message);
      self.postMessage({ type: 'ready' });
      return;
    }
    if (message.type === 'solve') {
      const result = await solve(message);
      self.postMessage({ type: 'solved', requestId: message.requestId, result });
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
