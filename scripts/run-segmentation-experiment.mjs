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
const roundArg = args.find(arg => /^(all|\d{3}(,\d{3})*)$/.test(arg)) || '012,013,014,015';
const debug = args.includes('--debug') || args.includes('--debug-images');
const maxDebugImages = Number(args.find(arg => arg.startsWith('--max-debug='))?.split('=')[1] || 200);

const rounds = roundArg === 'all'
  ? readdirSync(path.join(repoRoot, 'data', 'captcha-samples'))
      .filter(name => /^round-\d{3}$/.test(name))
      .sort()
  : roundArg.split(',').map(round => `round-${round}`);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
const outDir = path.join(repoRoot, 'data', 'segmentation-experiments', `run-${stamp}`);
await mkdir(outDir, { recursive: true });

function parseCsv(text) {
  return text.trim().split(/\r?\n/).slice(1)
    .map(line => line.split(',').map(part => part.trim()))
    .filter(parts => parts.length >= 3 && parts[2])
    .map(([id, file, answer]) => ({ id, file, answer }));
}

function sameCaptchaAnswer(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const b = expected[i];
    if (/[a-zA-Z]/.test(a) && /[a-zA-Z]/.test(b)) {
      if (a.toLowerCase() !== b.toLowerCase()) return false;
    } else if (a !== b) {
      return false;
    }
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

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
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
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox'],
});

const allRoundResults = [];
let debugWritten = 0;

try {
  const page = await browser.newPage();
  page.on('console', msg => {
    const text = msg.text();
    if (/SegExperiment/.test(text)) console.log(`[browser] ${text}`);
  });

  await page.goto(`${origin}/`);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: 'segmentation-experiment' }),
        getURL: resource => new URL(resource, window.location.href).href,
      },
      storage: {
        local: { get: async () => ({ nju_enabled: false }) },
      },
    };
  });
  await page.addScriptTag({ url: `${origin}/tesseract.min.js` });
  await page.addScriptTag({ url: `${origin}/content.js` });
  await page.waitForFunction(() => typeof window.readCaptchaBitmap === 'function');

  await page.evaluate(() => {
    const CHAR_WHITELIST = '23456789abcdefghijklmnpqrstuvwxyABCDEFGHIJKLMNPQRSTUVWXY';

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
      if (mode === 'color') {
        return buildColorClusterMask(base);
      }

      const variant = getVariant(mode);
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
      const bounds = getMaskBounds(mask, width, height) || {
        minX: 0,
        minY: 0,
        maxX: width - 1,
        maxY: height - 1,
      };
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
      const c1Start = xMin + minSeg;
      const c1End = Math.min(xMax - minSeg * 3, xMin + Math.floor(totalW * 0.38));
      for (let c1 = c1Start; c1 <= c1End; c1++) {
        const c2Start = Math.max(c1 + minSeg, xMin + Math.floor(totalW * 0.34));
        const c2End = Math.min(xMax - minSeg * 2, xMin + Math.floor(totalW * 0.64));
        for (let c2 = c2Start; c2 <= c2End; c2++) {
          const c3Start = Math.max(c2 + minSeg, xMin + Math.floor(totalW * 0.58));
          const c3End = Math.min(xMax - minSeg, xMin + Math.floor(totalW * 0.86));
          for (let c3 = c3Start; c3 <= c3End; c3++) {
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
          y1: Math.min(height - 1, maxY + 2),
        });
      }

      return { ...best, boxes };
    }

    function renderCharMask(mask, width, height, box) {
      const output = document.createElement('canvas');
      output.width = 56;
      output.height = 56;
      const ctx = output.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, output.width, output.height);
      ctx.fillStyle = '#000';

      const boxW = Math.max(1, box.x1 - box.x0 + 1);
      const boxH = Math.max(1, box.y1 - box.y0 + 1);
      const scale = Math.min(38 / boxW, 42 / boxH);
      const drawW = boxW * scale;
      const drawH = boxH * scale;
      const ox = Math.floor((output.width - drawW) / 2);
      const oy = Math.floor((output.height - drawH) / 2);

      for (let y = box.y0; y <= box.y1; y++) {
        for (let x = box.x0; x <= box.x1; x++) {
          if (mask[y * width + x]) {
            ctx.fillRect(ox + (x - box.x0) * scale, oy + (y - box.y0) * scale, Math.max(1, scale), Math.max(1, scale));
          }
        }
      }

      return output;
    }

    function renderDebugCanvas(base, mode, mask, segmentation, code, expected) {
      const scale = 2;
      const charSize = 56;
      const canvas = document.createElement('canvas');
      canvas.width = base.width * scale * 2 + charSize * 4 + 80;
      canvas.height = Math.max(base.height * scale, charSize) + 42;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = '14px Consolas, monospace';
      ctx.fillStyle = '#111';
      ctx.fillText(`${mode}  exp=${expected}  got=${code || '----'}`, 8, 18);

      const y = 28;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(base.canvas, 8, y, base.width * scale, base.height * scale);
      ctx.strokeStyle = '#e02020';
      ctx.lineWidth = 1;
      for (const cut of segmentation.cuts) {
        const x = 8 + cut * scale;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + base.height * scale);
        ctx.stroke();
      }
      ctx.strokeStyle = '#00a060';
      for (const box of segmentation.boxes) {
        ctx.strokeRect(8 + box.x0 * scale, y + box.y0 * scale, (box.x1 - box.x0 + 1) * scale, (box.y1 - box.y0 + 1) * scale);
      }

      const maskX = 8 + base.width * scale + 12;
      ctx.fillStyle = '#f6f6f6';
      ctx.fillRect(maskX, y, base.width * scale, base.height * scale);
      ctx.fillStyle = '#000';
      for (let yy = 0; yy < base.height; yy++) {
        for (let xx = 0; xx < base.width; xx++) {
          if (mask[yy * base.width + xx]) ctx.fillRect(maskX + xx * scale, y + yy * scale, scale, scale);
        }
      }
      ctx.strokeStyle = '#e02020';
      for (const cut of segmentation.cuts) {
        const x = maskX + cut * scale;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + base.height * scale);
        ctx.stroke();
      }

      let cx = maskX + base.width * scale + 16;
      for (const box of segmentation.boxes) {
        const charCanvas = renderCharMask(mask, base.width, base.height, box);
        ctx.drawImage(charCanvas, cx, y, charSize, charSize);
        ctx.strokeStyle = '#aaa';
        ctx.strokeRect(cx, y, charSize, charSize);
        cx += charSize + 6;
      }

      return canvas.toDataURL('image/png');
    }

    async function getSegmentationWorker() {
      if (window.__segmentationWorker) return window.__segmentationWorker;
      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: chrome.runtime.getURL('langs/worker.min.js'),
        corePath: chrome.runtime.getURL('langs/tesseract-core.wasm.js'),
        langPath: chrome.runtime.getURL('langs/'),
        gzip: false,
        logger: () => {},
      });
      await worker.setParameters({
        tessedit_char_whitelist: CHAR_WHITELIST,
        tessedit_pageseg_mode: '10',
        user_defined_dpi: '300',
      });
      window.__segmentationWorker = worker;
      return worker;
    }

    async function recognizeChar(worker, canvas) {
      const { data } = await worker.recognize(canvas);
      const code = normalizeCaptchaCode(data.text).slice(0, 1);
      return {
        char: code,
        confidence: data.confidence || 0,
        text: data.text || '',
      };
    }

    function pickModeResult(results) {
      const complete = results.filter(result => result.code.length === 4);
      if (!complete.length) {
        return results.slice().sort((a, b) => b.avgConfidence - a.avgConfidence)[0];
      }
      return complete.sort((a, b) => {
        const scoreA = a.avgConfidence + a.modeBonus - a.segmentationScore * 0.01;
        const scoreB = b.avgConfidence + b.modeBonus - b.segmentationScore * 0.01;
        return scoreB - scoreA;
      })[0];
    }

    window.runSegmentationExperiment = async ({ imageUrl, expected, debug }) => {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();
      const base = await readCaptchaBitmap(img);
      const worker = await getSegmentationWorker();
      const modes = ['thin', 'aggressive', 'color'];
      const results = [];

      for (const mode of modes) {
        const mask = buildExperimentMask(base, mode);
        const segmentation = segmentMask(mask, base.width, base.height);
        const chars = [];
        for (const box of segmentation.boxes) {
          const charCanvas = renderCharMask(mask, base.width, base.height, box);
          chars.push(await recognizeChar(worker, charCanvas));
        }
        const code = chars.map(item => item.char || '').join('');
        const avgConfidence = chars.reduce((sum, item) => sum + (item.confidence || 0), 0) / Math.max(1, chars.length);
        const modeBonus = mode === 'thin' ? 3 : mode === 'aggressive' ? 1 : 0;
        results.push({
          mode,
          code,
          avgConfidence,
          segmentationScore: segmentation.score,
          chars,
          cuts: segmentation.cuts,
          boxes: segmentation.boxes,
          debugDataUrl: debug ? renderDebugCanvas(base, mode, mask, segmentation, code, expected) : '',
        });
      }

      const selected = pickModeResult(results);
      return {
        code: selected?.code || '',
        selectedMode: selected?.mode || '',
        modes: results.map(result => ({
          mode: result.mode,
          code: result.code,
          avgConfidence: result.avgConfidence,
          segmentationScore: result.segmentationScore,
          chars: result.chars,
          cuts: result.cuts,
          boxes: result.boxes,
        })),
        debugDataUrl: selected?.debugDataUrl || '',
      };
    };
  });

  console.log(`Segmentation rounds: ${rounds.join(', ')}`);
  console.log(`Output: ${path.relative(repoRoot, outDir)}`);
  console.log('');

  for (const round of rounds) {
    const sampleDir = path.join(repoRoot, 'data', 'captcha-samples', round);
    const answersPath = path.join(sampleDir, 'answers.csv');
    if (!existsSync(answersPath)) {
      console.log(`[${round}] SKIP no answers.csv`);
      continue;
    }
    const samples = parseCsv(await readFile(answersPath, 'utf8'));
    const roundOut = path.join(outDir, round);
    await mkdir(roundOut, { recursive: true });

    console.log(`[${round}] Running ${samples.length} samples...`);
    const results = [];
    for (const sample of samples) {
      const imageUrl = `${origin}/${path.relative(repoRoot, path.join(sampleDir, sample.file)).replaceAll(path.sep, '/')}`;
      const started = performance.now?.() || Date.now();
      const result = await page.evaluate(
        payload => window.runSegmentationExperiment(payload),
        { imageUrl, expected: sample.answer, debug: debug && debugWritten < maxDebugImages }
      );
      const elapsedMs = (performance.now?.() || Date.now()) - started;
      const ok = sameCaptchaAnswer(result.code, sample.answer);
      const row = { ...sample, ...result, ok, elapsedMs };
      results.push(row);

      if (result.debugDataUrl && debugWritten < maxDebugImages) {
        const fileName = `${sample.id}-${ok ? 'ok' : 'err'}-${result.selectedMode}-${result.code || 'empty'}.png`.replace(/[^\w.-]+/g, '_');
        await writeFile(path.join(roundOut, fileName), dataUrlToBuffer(result.debugDataUrl));
        row.debugFile = path.join(round, fileName).replaceAll(path.sep, '/');
        debugWritten++;
      }

      console.log(`  ${ok ? 'OK ' : 'ERR'} ${sample.id} expected=${sample.answer} got=${result.code || '(empty)'} mode=${result.selectedMode} ${Math.round(elapsedMs)}ms`);
    }

    const correct = results.filter(item => item.ok).length;
    allRoundResults.push({ round, correct, total: results.length, accuracy: correct / results.length, results });
    console.log(`  Accuracy: ${correct}/${results.length} (${(correct / results.length * 100).toFixed(1)}%)`);
    console.log('');
  }
} finally {
  await browser.close();
  server.close();
}

const totalCorrect = allRoundResults.reduce((sum, round) => sum + round.correct, 0);
const totalSamples = allRoundResults.reduce((sum, round) => sum + round.total, 0);
const report = {
  timestamp: new Date().toISOString(),
  rounds,
  totalCorrect,
  totalSamples,
  accuracy: totalSamples ? totalCorrect / totalSamples : 0,
  roundResults: allRoundResults,
};
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

const htmlRows = allRoundResults.flatMap(round => round.results.map(item => `
  <tr class="${item.ok ? 'ok' : 'err'}">
    <td>${round.round}</td>
    <td>${item.id}</td>
    <td>${item.answer}</td>
    <td>${item.code || ''}</td>
    <td>${item.selectedMode}</td>
    <td>${item.modes.map(mode => `${mode.mode}:${mode.code || '-'}(${Math.round(mode.avgConfidence)})`).join('<br>')}</td>
    <td>${item.debugFile ? `<img src="${item.debugFile}" alt="${round.round} ${item.id}">` : ''}</td>
  </tr>`)).join('\n');
await writeFile(path.join(outDir, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>Segmentation Experiment</title>
<style>
body{font-family:system-ui,sans-serif;margin:20px;background:#f7f8fb;color:#202124}
table{border-collapse:collapse;width:100%;background:white}
td,th{border:1px solid #dde2ea;padding:6px;font-size:12px;vertical-align:top}
tr.ok{background:#f1f8f3} tr.err{background:#fff4f2}
img{max-width:100%;image-rendering:pixelated}
code{font-family:Consolas,monospace}
</style>
<h1>Segmentation Experiment</h1>
<p>Accuracy: <strong>${totalCorrect}/${totalSamples} (${totalSamples ? (totalCorrect / totalSamples * 100).toFixed(1) : '0.0'}%)</strong></p>
<table>
<thead><tr><th>Round</th><th>ID</th><th>Expected</th><th>Got</th><th>Mode</th><th>Modes</th><th>Debug</th></tr></thead>
<tbody>${htmlRows}</tbody>
</table>
`, 'utf8');

console.log('═══════════════════════════════════════════');
for (const round of allRoundResults) {
  console.log(`${round.round}: ${round.correct}/${round.total} (${(round.accuracy * 100).toFixed(1)}%)`);
}
console.log(`OVERALL: ${totalCorrect}/${totalSamples} (${totalSamples ? (totalCorrect / totalSamples * 100).toFixed(1) : '0.0'}%)`);
console.log(`Report: ${path.relative(repoRoot, path.join(outDir, 'report.json'))}`);
console.log(`Index: ${path.relative(repoRoot, path.join(outDir, 'index.html'))}`);
