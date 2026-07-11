import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const roundArg = args.find(arg => /^(all|\d{3}(,\d{3})*)$/.test(arg)) || '010,011,012,013,014,015';
const rounds = roundArg === 'all'
  ? readdirSync(path.join(repoRoot, 'data', 'captcha-samples')).filter(name => /^round-\d{3}$/.test(name)).sort()
  : roundArg.split(',').map(round => `round-${round}`);
const trainArg = args.find(arg => arg.startsWith('--train='))?.slice('--train='.length);
const testArg = args.find(arg => arg.startsWith('--test='))?.slice('--test='.length);
const regressionArg = args.find(arg => arg.startsWith('--regression='))?.slice('--regression='.length);
const trainRounds = trainArg ? trainArg.split(',').map(round => `round-${round}`) : null;
const testRounds = testArg ? testArg.split(',').map(round => `round-${round}`) : null;
const useShiftDistance = args.includes('--shift');
const quickBeam = args.includes('--quick-beam');
const experimentModes = quickBeam ? ['aggressive'] : ['thin', 'aggressive', 'color'];
const experimentClassifiers = quickBeam ? ['knn1'] : ['knn1', 'knn5', 'centroid'];
const positionAware = args.includes('--position-aware');

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
const outDir = path.join(repoRoot, 'data', 'segmentation-experiments', `template-${stamp}`);
await mkdir(outDir, { recursive: true });

const FEATURE_W = 24;
const FEATURE_H = 32;

function parseCsv(text) {
  return text.trim().split(/\r?\n/).slice(1)
    .map(line => line.split(',').map(part => part.trim()))
    .filter(parts => parts.length >= 3 && parts[2] && parts[2].length === 4)
    .map(([id, file, answer]) => ({ id, file, answer }));
}

function normalizeChar(char) {
  return /[a-z]/i.test(char) ? char.toLowerCase() : char;
}

function normalizeCode(code) {
  return [...(code || '')].map(normalizeChar).join('');
}

function sameChar(actual, expected) {
  return normalizeChar(actual) === normalizeChar(expected);
}

function sameCode(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (!sameChar(actual[i], expected[i])) return false;
  }
  return true;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.wasm': 'application/wasm',
    '.traineddata': 'application/octet-stream',
  };
  return map[ext] || 'application/octet-stream';
}

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!decoded) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8">');
      return;
    }
    const filePath = path.resolve(repoRoot, decoded);
    if (!filePath.startsWith(repoRoot) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' });
    createReadStream(filePath).pipe(res);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function shiftedDistance(a, b, dx, dy) {
  let diff = 0;
  let union = 0;
  for (let y = 0; y < FEATURE_H; y++) {
    const by = y + dy;
    for (let x = 0; x < FEATURE_W; x++) {
      const bx = x + dx;
      const av = a[y * FEATURE_W + x] ? 1 : 0;
      const bv = bx >= 0 && bx < FEATURE_W && by >= 0 && by < FEATURE_H
        ? (b[by * FEATURE_W + bx] ? 1 : 0)
        : 0;
      if (av || bv) union++;
      if (av !== bv) diff++;
    }
  }
  return union ? diff / union : 1;
}

function templateDistance(a, b) {
  let best = shiftedDistance(a.vector, b.vector, 0, 0);
  if (useShiftDistance) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const distance = shiftedDistance(a.vector, b.vector, dx, dy);
        if (distance < best) best = distance;
      }
    }
  }

  let projection = 0;
  for (let i = 0; i < FEATURE_W; i++) projection += Math.abs(a.col[i] - b.col[i]);
  for (let i = 0; i < FEATURE_H; i++) projection += Math.abs(a.row[i] - b.row[i]);
  return best + projection * 0.04;
}

function predictKnn(sample, training, k = 5) {
  const neighbors = training
    .map(item => ({ label: item.label, distance: templateDistance(sample, item) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);

  const votes = new Map();
  for (const item of neighbors) {
    votes.set(item.label, (votes.get(item.label) || 0) + 1 / Math.max(0.02, item.distance));
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function scoreLabelsKnn(sample, training, k = 5) {
  const neighbors = training
    .map(item => ({ label: item.label, distance: templateDistance(sample, item) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);

  const scores = new Map();
  for (const item of neighbors) {
    scores.set(item.label, (scores.get(item.label) || 0) + 1 / Math.max(0.02, item.distance));
  }
  return scores;
}

function buildCentroids(training) {
  const groups = new Map();
  for (const item of training) {
    const group = groups.get(item.label) || [];
    group.push(item);
    groups.set(item.label, group);
  }

  return [...groups.entries()].map(([label, items]) => {
    const vector = new Array(FEATURE_W * FEATURE_H).fill(0);
    const col = new Array(FEATURE_W).fill(0);
    const row = new Array(FEATURE_H).fill(0);
    for (const item of items) {
      for (let i = 0; i < vector.length; i++) vector[i] += item.vector[i];
      for (let i = 0; i < col.length; i++) col[i] += item.col[i];
      for (let i = 0; i < row.length; i++) row[i] += item.row[i];
    }
    for (let i = 0; i < vector.length; i++) vector[i] = vector[i] / items.length >= 0.45 ? 1 : 0;
    for (let i = 0; i < col.length; i++) col[i] /= items.length;
    for (let i = 0; i < row.length; i++) row[i] /= items.length;
    return { label, vector, col, row };
  });
}

function predictCentroid(sample, centroids) {
  return centroids
    .map(item => ({ label: item.label, distance: templateDistance(sample, item) }))
    .sort((a, b) => a.distance - b.distance)[0]?.label || '';
}

function scoreLabelsCentroid(sample, centroids) {
  const scores = new Map();
  for (const item of centroids) {
    scores.set(item.label, -templateDistance(sample, item));
  }
  return scores;
}

function codeScoreFromLabelScores(code, labelScores) {
  if (!code || code.length !== 4) return -Infinity;
  let score = 0;
  for (let i = 0; i < 4; i++) {
    const label = normalizeChar(code[i]);
    score += labelScores[i].get(label) ?? -8;
  }
  return score;
}

const OCR_VARIANT_PRIORITIES = {
  'strict-color': 2,
  'balanced-color': 4,
  'loose-color': 3,
  'thin-line-clean': 3,
  'aggressive-line-clean': 2,
  'simple-threshold': 2,
  'legacy-fallback': 1,
  'color-cluster': 2,
};

const TEMPLATE_CONFUSION_GROUPS = [
  ['3', '5', '8', 's'],
  ['i', 'j', 'l', '4', 'w'],
  ['a', 'b', 'd', '4'],
  ['q', 'g'],
  ['u', 'v', 'y'],
  ['n', 'm', 'w'],
  ['c', 'e', 'f', 'l', 't'],
  ['g', 'p', 'r'],
];

function getOcrPositionLabels(reg, maxLabels = 3) {
  const positions = Array.from({ length: 4 }, () => new Map());
  const add = (position, char, score, source) => {
    const label = normalizeChar(char || '');
    if (!label) return;
    const current = positions[position].get(label) || { label, score: 0, sources: new Set() };
    current.score += score;
    current.sources.add(source);
    positions[position].set(label, current);
  };

  for (const candidate of reg.candidates || []) {
    if (!candidate.code || candidate.code.length !== 4) continue;
    const priority = OCR_VARIANT_PRIORITIES[candidate.variant] || 1;
    const weight = priority + Math.min(3, Math.max(0, candidate.confidence || 0) / 25);
    for (let i = 0; i < 4; i++) add(i, candidate.code[i], weight, candidate.variant);
  }

  if (reg.current && reg.current.length === 4) {
    for (let i = 0; i < 4; i++) add(i, reg.current[i], 0.01, 'current');
  }

  return positions.map((position, index) => {
    const ranked = [...position.values()]
      .sort((a, b) => b.score - a.score || b.sources.size - a.sources.size);
    const selected = ranked.slice(0, maxLabels);
    const currentLabel = normalizeChar(reg.current?.[index] || '');
    const currentItem = position.get(currentLabel);
    if (currentItem && !selected.some(item => item.label === currentLabel)) {
      selected[selected.length - 1] = currentItem;
    }
    return selected;
  });
}

function getConfusionAlternatives(char) {
  const label = normalizeChar(char || '');
  const alternatives = new Set();
  for (const group of TEMPLATE_CONFUSION_GROUPS) {
    if (!group.includes(label)) continue;
    for (const item of group) {
      if (item !== label) alternatives.add(item);
    }
  }
  return [...alternatives];
}

function buildBeamCodes(reg, labelScores, options = {}) {
  const maxLabels = options.maxLabels || 3;
  const positions = getOcrPositionLabels(reg, maxLabels);
  const templateCharMargin = Number(options.templateCharMargin ?? Infinity);

  if (Number.isFinite(templateCharMargin) && reg.current?.length === 4) {
    for (let i = 0; i < 4; i++) {
      const current = normalizeChar(reg.current[i]);
      const currentScore = labelScores[i].get(current) ?? -8;
      const existing = new Set(positions[i].map(item => item.label));
      const alternatives = getConfusionAlternatives(current)
        .filter(label => !existing.has(label))
        .map(label => ({ label, templateScore: labelScores[i].get(label) ?? -8 }))
        .filter(item => item.templateScore > -8)
        .filter(item => item.templateScore >= currentScore + templateCharMargin)
        .sort((a, b) => b.templateScore - a.templateScore)
        .slice(0, 1);

      for (const item of alternatives) {
        positions[i].push({
          label: item.label,
          score: 0,
          sources: new Set(['template-confusion']),
        });
      }
    }
  }

  if (positions.some(position => position.length === 0)) return [];

  let beam = [{ code: '', ocrScore: 0, changedPositions: 0, templateOnlyChanges: 0, maxEvidenceDeficit: 0 }];
  for (let i = 0; i < 4; i++) {
    const next = [];
    const currentLabel = normalizeChar(reg.current?.[i] || '');
    const currentEvidence = positions[i].find(item => item.label === currentLabel)?.score || 0;
    for (const prefix of beam) {
      for (const item of positions[i]) {
        next.push({
          code: prefix.code + item.label,
          ocrScore: prefix.ocrScore + item.score,
          changedPositions: prefix.changedPositions + (item.label === currentLabel ? 0 : 1),
          templateOnlyChanges: prefix.templateOnlyChanges + (item.sources.has('template-confusion') ? 1 : 0),
          maxEvidenceDeficit: Math.max(
            prefix.maxEvidenceDeficit,
            item.label === currentLabel ? 0 : Math.max(0, currentEvidence - item.score)
          ),
        });
      }
    }
    beam = next
      .sort((a, b) => b.ocrScore - a.ocrScore)
      .slice(0, options.beamWidth || 81);
  }

  return beam
    .filter(item => item.changedPositions <= (options.maxChangedPositions ?? 4))
    .filter(item => item.templateOnlyChanges <= (options.maxTemplateOnlyChanges ?? 1))
    .filter(item => item.maxEvidenceDeficit <= (options.maxEvidenceDeficit ?? Infinity));
}

function findLatestRegressionReport() {
  const dir = path.join(repoRoot, 'data', 'regression-results');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter(name => /^regression-.*\.json$/.test(name))
    .map(name => path.join(dir, name))
    .sort((a, b) => {
      const aTime = existsSync(a) ? require('node:fs').statSync(a).mtimeMs : 0;
      const bTime = existsSync(b) ? require('node:fs').statSync(b).mtimeMs : 0;
      return bTime - aTime;
    })[0] || '';
}

const { server, origin } = await startServer();
const browserCandidates = [
  process.env.BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => existsSync(candidate));
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });

const charSamples = [];
const imageSamples = [];

try {
  const page = await browser.newPage();
  await page.goto(`${origin}/`);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: 'template-experiment' }),
        getURL: resource => new URL(resource, window.location.href).href,
      },
      storage: { local: { get: async () => ({ nju_enabled: false }) } },
    };
  });
  await page.addScriptTag({ url: `${origin}/content.js` });
  await page.waitForFunction(() => typeof window.readCaptchaBitmap === 'function');

  await page.evaluate(({ featureW, featureH, modes }) => {
    function getVariant(mode) {
      if (mode === 'aggressive') {
        return {
          minSaturation: 0.09,
          minChroma: 10,
          maxLuminance: 210,
          darkLuminance: 100,
          darkMinSaturation: 0.02,
          lineMaxSaturation: 0.36,
          lineMinLuminance: 88,
        };
      }
      return {
        minSaturation: 0.10,
        minChroma: 12,
        maxLuminance: 205,
        darkLuminance: 95,
        darkMinSaturation: 0.02,
        lineMaxSaturation: 0.22,
        lineMinLuminance: 120,
      };
    }

    function buildExperimentMask(base, mode) {
      if (mode === 'color') return buildColorClusterMask(base);
      const variant = getVariant(mode);
      const mask = buildTextMask(base, variant);
      suppressInterferenceLines(mask, base, variant);
      if (mode === 'aggressive') removeDirectionalInterference(mask, base);
      removeOnePixelInterference(mask, base);
      removeDenseHorizontalRows(mask, base.width, base.height);
      filterSmallComponents(mask, base.width, base.height);
      bridgeOnePixelGaps(mask, base.width, base.height);
      if (mode === 'aggressive') bridgeOnePixelGaps(mask, base.width, base.height);
      return mask;
    }

    function columnCounts(mask, width, height, y0, y1) {
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

    function smoothColumn(counts, x) {
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

    function segmentMask(mask, width, height) {
      const bounds = getMaskBounds(mask, width, height) || { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };
      const xMin = Math.max(0, bounds.minX - 2);
      const xMax = Math.min(width - 1, bounds.maxX + 2);
      const yMin = Math.max(0, bounds.minY - 2);
      const yMax = Math.min(height - 1, bounds.maxY + 2);
      const totalW = xMax - xMin + 1;
      const minSeg = Math.max(10, Math.floor(totalW * 0.14));
      const maxSeg = Math.max(minSeg + 4, Math.floor(totalW * 0.36));
      const counts = columnCounts(mask, width, height, yMin, yMax);
      const expected = [0.25, 0.50, 0.75].map(ratio => xMin + totalW * ratio);
      let best = null;

      for (let c1 = xMin + minSeg; c1 <= Math.min(xMax - minSeg * 3, xMin + Math.floor(totalW * 0.38)); c1++) {
        for (let c2 = Math.max(c1 + minSeg, xMin + Math.floor(totalW * 0.34)); c2 <= Math.min(xMax - minSeg * 2, xMin + Math.floor(totalW * 0.64)); c2++) {
          for (let c3 = Math.max(c2 + minSeg, xMin + Math.floor(totalW * 0.58)); c3 <= Math.min(xMax - minSeg, xMin + Math.floor(totalW * 0.86)); c3++) {
            const cuts = [c1, c2, c3];
            const edges = [xMin, c1, c2, c3, xMax + 1];
            const widths = [edges[1] - edges[0], edges[2] - edges[1], edges[3] - edges[2], edges[4] - edges[3]];
            if (widths.some(w => w < minSeg || w > maxSeg)) continue;
            let score = 0;
            for (let i = 0; i < 3; i++) {
              score += smoothColumn(counts, cuts[i]) * 6;
              score += Math.abs(cuts[i] - expected[i]) * 0.10;
            }
            const idealW = totalW / 4;
            for (const w of widths) score += Math.abs(w - idealW) * 0.12;
            for (let i = 0; i < 4; i++) {
              let ink = 0;
              for (let x = edges[i]; x < edges[i + 1]; x++) ink += counts[x] || 0;
              if (ink < 6) score += 200;
            }
            if (!best || score < best.score) best = { score, cuts, edges, bounds: { xMin, xMax, yMin, yMax } };
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
          y1: Math.min(height - 1, maxY + 2),
        });
      }
      return { ...best, boxes };
    }

    function featureFromBox(mask, width, height, box) {
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

    window.extractTemplateFeatures = async ({ imageUrl }) => {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();
      const base = await readCaptchaBitmap(img);
      const output = {};

      for (const mode of modes) {
        const mask = buildExperimentMask(base, mode);
        const segmentation = segmentMask(mask, base.width, base.height);
        output[mode] = {
          score: segmentation.score,
          cuts: segmentation.cuts,
          boxes: segmentation.boxes,
          chars: segmentation.boxes.map(box => featureFromBox(mask, base.width, base.height, box)),
        };
      }

      return output;
    };
  }, { featureW: FEATURE_W, featureH: FEATURE_H, modes: experimentModes });

  console.log(`Extracting template features: ${rounds.join(', ')}`);
  for (const round of rounds) {
    const sampleDir = path.join(repoRoot, 'data', 'captcha-samples', round);
    const answersPath = path.join(sampleDir, 'answers.csv');
    if (!existsSync(answersPath)) continue;
    const samples = parseCsv(await readFile(answersPath, 'utf8'));
    console.log(`[${round}] ${samples.length} samples`);

    for (const sample of samples) {
      const imageUrl = `${origin}/${path.relative(repoRoot, path.join(sampleDir, sample.file)).replaceAll(path.sep, '/')}`;
      const features = await page.evaluate(payload => window.extractTemplateFeatures(payload), { imageUrl });
      imageSamples.push({ round, id: sample.id, answer: sample.answer, features });
      for (const mode of Object.keys(features)) {
        for (let i = 0; i < 4; i++) {
          charSamples.push({
            round,
            imageId: sample.id,
            pos: i,
            mode,
            label: normalizeChar(sample.answer[i]),
            ...features[mode].chars[i],
          });
        }
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

function evaluateSplit(name, trainRoundNames, testRoundNames, mode, classifier) {
  const training = charSamples.filter(item => item.mode === mode && trainRoundNames.includes(item.round));
  const testingImages = imageSamples.filter(item => testRoundNames.includes(item.round));
  const centroids = classifier === 'centroid' ? buildCentroids(training) : null;
  const predictions = [];
  let correct = 0;
  let total = 0;
  let charCorrect = 0;
  let charTotal = 0;

  for (const image of testingImages) {
    const modeFeatures = image.features[mode];
    let code = '';
    for (let i = 0; i < 4; i++) {
      const feature = modeFeatures.chars[i];
      const label = classifier === 'centroid'
        ? predictCentroid(feature, centroids)
        : predictKnn(feature, training, classifier === 'knn1' ? 1 : 5);
      code += label;
      if (sameChar(label, image.answer[i])) charCorrect++;
      charTotal++;
    }
    const ok = sameCode(code, image.answer);
    if (ok) correct++;
    total++;
    predictions.push({ round: image.round, id: image.id, expected: image.answer, actual: code, ok });
  }

  return {
    name,
    mode,
    classifier,
    trainRounds: trainRoundNames,
    testRounds: testRoundNames,
    correct,
    total,
    accuracy: total ? correct / total : 0,
    charCorrect,
    charTotal,
    charAccuracy: charTotal ? charCorrect / charTotal : 0,
    predictions,
  };
}

const splits = [];
const availableRounds = [...new Set(imageSamples.map(item => item.round))].sort();
if (trainRounds && testRounds) {
  splits.push({ name: 'explicit', train: trainRounds, test: testRounds });
} else {
  for (const round of availableRounds) {
    splits.push({ name: `leave-${round}-out`, train: availableRounds.filter(item => item !== round), test: [round] });
  }
  if (availableRounds.includes('round-010') && availableRounds.includes('round-011')) {
    splits.push({
      name: 'train-010-011-test-012-015',
      train: ['round-010', 'round-011'],
      test: availableRounds.filter(round => !['round-010', 'round-011'].includes(round)),
    });
  }
}

const evaluations = [];
for (const split of splits) {
  for (const mode of experimentModes) {
    for (const classifier of experimentClassifiers) {
      evaluations.push(evaluateSplit(split.name, split.train, split.test, mode, classifier));
    }
  }
}

evaluations.sort((a, b) => b.accuracy - a.accuracy || b.charAccuracy - a.charAccuracy);

const rerankEvaluations = [];
const regressionPaths = regressionArg
  ? regressionArg.split(';').filter(Boolean).map(item => path.resolve(repoRoot, item))
  : [findLatestRegressionReport()].filter(Boolean);
const existingRegressionPaths = regressionPaths.filter(item => existsSync(item));
const regressionLabel = existingRegressionPaths
  .map(item => path.relative(repoRoot, item))
  .join(', ');

if (existingRegressionPaths.length) {
  const regressionSamples = new Map();
  for (const regressionPath of existingRegressionPaths) {
    const regression = JSON.parse(await readFile(regressionPath, 'utf8'));
    for (const roundResult of regression.roundResults || []) {
      for (const sample of roundResult.samples || []) {
        regressionSamples.set(`${roundResult.round}#${sample.id}`, {
          round: roundResult.round,
          id: sample.id,
          expected: sample.expected,
          current: sample.actual || '',
          candidates: sample.candidates || [],
        });
      }
    }
  }

  for (const split of splits) {
    for (const mode of experimentModes.filter(item => item !== 'color')) {
      for (const classifier of experimentClassifiers) {
        const training = charSamples.filter(item => item.mode === mode && split.train.includes(item.round));
        const centroids = classifier === 'centroid' ? buildCentroids(training) : null;
        const testingImages = imageSamples.filter(item => split.test.includes(item.round));

        for (const candidateMode of ['whole', 'ocr-beam', 'confusion-beam']) {
          const templateCharMargins = candidateMode === 'confusion-beam'
            ? (quickBeam ? [0, 5] : [0, 2, 5])
            : [Infinity];
          for (const templateCharMargin of templateCharMargins) {
          const beamOcrWeights = candidateMode === 'whole' ? [0] : (quickBeam ? [0] : [0, 1]);
          for (const beamOcrWeight of beamOcrWeights) {
          const maxEvidenceDeficits = candidateMode === 'ocr-beam' && quickBeam
            ? [2, 4, 6, 8, Infinity]
            : [Infinity];
          for (const maxEvidenceDeficit of maxEvidenceDeficits) {
          const margins = quickBeam
            ? (candidateMode === 'whole' ? [10] : candidateMode === 'ocr-beam' ? [10, 18] : [18])
            : [0, 2, 5, 10, 18];
          for (const margin of margins) {
          let correct = 0;
          let total = 0;
          let overrides = 0;
          const predictions = [];

          for (const image of testingImages) {
            const reg = regressionSamples.get(`${image.round}#${image.id}`);
            if (!reg) continue;

            const labelScores = image.features[mode].chars.map((feature, position) => {
              const scopedTraining = positionAware
                ? training.filter(item => item.pos === position)
                : training;
              return classifier === 'centroid'
                ? scoreLabelsCentroid(feature, centroids)
                : scoreLabelsKnn(feature, scopedTraining, classifier === 'knn1' ? 1 : 5);
            });

            const codes = new Map();
            if (reg.current) codes.set(normalizeCode(reg.current), { code: reg.current, source: 'current' });
            if (candidateMode === 'whole') {
              for (const candidate of reg.candidates) {
                if (!candidate.code || candidate.code.length !== 4) continue;
                const key = normalizeCode(candidate.code);
                const existing = codes.get(key) || { code: key, source: candidate.variant };
                existing.confidence = Math.max(existing.confidence || 0, candidate.confidence || 0);
                codes.set(key, existing);
              }
            }

            if (candidateMode !== 'whole') {
              const beamCodes = buildBeamCodes(reg, labelScores, {
                maxLabels: 3,
                beamWidth: 81,
                templateCharMargin,
                maxChangedPositions: candidateMode === 'confusion-beam' ? 1 : 4,
                maxTemplateOnlyChanges: 1,
                maxEvidenceDeficit,
              });
              for (const item of beamCodes) {
                const key = normalizeCode(item.code);
                if (codes.has(key)) {
                  const existing = codes.get(key);
                  existing.beamOcrScore = Math.max(existing.beamOcrScore || 0, item.ocrScore);
                } else {
                  codes.set(key, {
                    code: item.code,
                    source: item.templateOnlyChanges ? 'confusion-beam' : 'ocr-beam',
                    beamOcrScore: item.ocrScore,
                    templateOnlyChanges: item.templateOnlyChanges,
                  });
                }
              }
            }

            const currentItem = codes.get(normalizeCode(reg.current));
            const currentTemplateScore = codeScoreFromLabelScores(reg.current, labelScores);
            const currentScore = currentTemplateScore + (currentItem?.beamOcrScore || 0) * beamOcrWeight;
            let best = { code: reg.current, score: currentScore, source: 'current' };
            for (const item of codes.values()) {
              const score = codeScoreFromLabelScores(item.code, labelScores)
                + (item.beamOcrScore || 0) * beamOcrWeight;
              if (score > best.score) best = { ...item, score };
            }

            const useBest = !reg.current || reg.current.length !== 4 || best.score >= currentScore + margin;
            const actual = useBest ? best.code : reg.current;
            if (actual !== reg.current) overrides++;
            if (sameCode(actual, reg.expected)) correct++;
            total++;
            predictions.push({
              round: image.round,
              id: image.id,
              expected: reg.expected,
              current: reg.current,
              actual,
              overridden: actual !== reg.current,
              source: best.source,
              score: best.score,
              currentScore,
            });
          }

          rerankEvaluations.push({
            name: split.name,
            mode,
            classifier,
            candidateMode,
            positionAware,
            templateCharMargin,
            beamOcrWeight,
            maxEvidenceDeficit,
            margin,
            trainRounds: split.train,
            testRounds: split.test,
            correct,
            total,
            accuracy: total ? correct / total : 0,
            overrides,
            predictions,
          });
          }
          }
          }
          }
        }
      }
    }
  }

  rerankEvaluations.sort((a, b) => b.accuracy - a.accuracy || a.overrides - b.overrides);
}

const report = {
  timestamp: new Date().toISOString(),
  rounds: availableRounds,
  featureSize: { width: FEATURE_W, height: FEATURE_H },
  samples: imageSamples.length,
  charSamples: charSamples.length,
  regressionPaths: existingRegressionPaths,
  evaluations,
  rerankEvaluations,
};
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

const lines = [];
lines.push(`Template experiment output: ${path.relative(repoRoot, outDir)}`);
lines.push('');
lines.push('Classifier results:');
for (const item of evaluations.slice(0, 20)) {
  lines.push(`${item.name} ${item.mode}/${item.classifier}: ${item.correct}/${item.total} (${(item.accuracy * 100).toFixed(1)}%), chars ${item.charCorrect}/${item.charTotal} (${(item.charAccuracy * 100).toFixed(1)}%)`);
}
if (rerankEvaluations.length) {
  lines.push('');
  lines.push(`Candidate rerank results from ${regressionLabel}:`);
  for (const item of rerankEvaluations.slice(0, 20)) {
    lines.push(`${item.name} ${item.mode}/${item.classifier} ${item.candidateMode} positionAware=${item.positionAware} charMargin=${Number.isFinite(item.templateCharMargin) ? item.templateCharMargin : '-'} ocrWeight=${item.beamOcrWeight} evidenceDeficit=${Number.isFinite(item.maxEvidenceDeficit) ? item.maxEvidenceDeficit : '-'} margin=${item.margin}: ${item.correct}/${item.total} (${(item.accuracy * 100).toFixed(1)}%), overrides=${item.overrides}`);
  }
}
await writeFile(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n', 'utf8');

console.log(lines.join('\n'));
console.log(`Report: ${path.relative(repoRoot, path.join(outDir, 'report.json'))}`);
