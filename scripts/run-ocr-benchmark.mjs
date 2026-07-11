import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const verbose = process.argv.includes('--verbose') || process.env.OCR_BENCHMARK_VERBOSE === '1';
const sampleArg = process.argv.slice(2).find(arg => arg !== '--verbose');
const sampleDir = path.resolve(sampleArg || path.join(repoRoot, 'data/captcha-samples/round-001'));
const answersPath = path.join(sampleDir, 'answers.csv');

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).slice(1);
  return lines
    .map(line => line.split(',').map(part => part.trim()))
    .filter(parts => parts.length >= 3 && parts[2])
    .map(([id, file, answer]) => ({ id, file, answer }));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.traineddata') return 'application/octet-stream';
  return 'application/octet-stream';
}

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!decoded || decoded === 'benchmark.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>OCR Benchmark</title></head><body></body></html>');
      return;
    }
    const filePath = path.resolve(repoRoot, decoded || 'benchmark.html');
    if (!filePath.startsWith(repoRoot) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-store'
    });
    createReadStream(filePath).pipe(res);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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

const answers = parseCsv(await readFile(answersPath, 'utf8'));
if (!answers.length) {
  throw new Error(`No labeled samples found in ${answersPath}`);
}

const { server, origin } = await startServer();
const browserCandidates = [
  process.env.BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox']
});

try {
  const page = await browser.newPage();
  page.on('console', msg => {
    const text = msg.text();
    if (/NJU 助手：OCR候选/.test(text)) console.log(`[browser] ${text}`);
  });

  await page.goto(`${origin}/benchmark.html`);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: 'benchmark' }),
        getURL: resource => new URL(resource, window.location.href).href
      },
      storage: {
        local: {
          get: async () => ({ nju_enabled: false })
        }
      }
    };
  });
  await page.addScriptTag({ url: `${origin}/tesseract.min.js` });
  await page.addScriptTag({ url: `${origin}/captcha-cnn.js` });
  await page.addScriptTag({ url: `${origin}/content.js` });
  await page.waitForFunction(() => typeof window.recognizeCaptchaCode === 'function');

  const results = [];
  for (const sample of answers) {
    const imageUrl = `${origin}/${path.relative(repoRoot, path.join(sampleDir, sample.file)).replaceAll(path.sep, '/')}`;
    const result = await page.evaluate(async ({ imageUrl }) => {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();

      const started = performance.now();
      const base = await window.readCaptchaBitmap(img);
      const engine = await window.getCaptchaWorker();
      let candidates = await window.recognizeCaptchaVariants(engine, base, window.getFastCaptchaVariants());
      let selected = window.selectCaptchaCode(candidates);
      let usedFallback = false;

      if (window.shouldRunFallbackVariants(candidates, selected)) {
        const fallback = await window.recognizeCaptchaVariants(engine, base, window.getFallbackCaptchaVariants());
        candidates = candidates.concat(fallback);
        selected = window.selectCaptchaCode(candidates);
        usedFallback = true;
      }

      const code = selected ? window.correctVisualConfusions(selected, base, candidates) : '';
      return {
        code,
        selected,
        elapsedMs: performance.now() - started,
        usedFallback,
        candidates: candidates.map(item => ({
          variant: item.variant,
          code: item.code || '',
          confidence: Math.round(item.confidence || 0)
        }))
      };
    }, { imageUrl });

    const ok = sameCaptchaAnswer(result.code, sample.answer);
    results.push({ ...sample, ...result, ok });
    console.log(`${sample.id} ${ok ? 'OK ' : 'ERR'} expected=${sample.answer} selected=${result.selected || '(empty)'} actual=${result.code || '(empty)'} time=${Math.round(result.elapsedMs)}ms fallback=${result.usedFallback}`);
    if (verbose) {
      const candidates = result.candidates.map(item => `${item.variant}=${item.code || '空'}(${item.confidence})`).join(' | ');
      console.log(`   candidates: ${candidates}`);
    }
  }

  const correct = results.filter(item => item.ok).length;
  const times = results.map(item => item.elapsedMs);
  const warmTimes = times.slice(1);
  console.log('');
  console.log(`Accuracy: ${correct}/${results.length} (${(correct / results.length * 100).toFixed(1)}%)`);
  console.log(`Avg OCR: ${average(times).toFixed(0)}ms`);
  console.log(`Warm avg OCR: ${average(warmTimes).toFixed(0)}ms`);
  console.log(`P50/P95 OCR: ${percentile(times, 50).toFixed(0)}ms / ${percentile(times, 95).toFixed(0)}ms`);
  console.log(`Fallback used: ${results.filter(item => item.usedFallback).length}/${results.length}`);

  const errors = results.filter(item => !item.ok);
  if (errors.length) {
    console.log('');
    console.log('Errors:');
    for (const err of errors) {
      const candidates = err.candidates.map(item => `${item.variant}=${item.code || '空'}(${item.confidence})`).join(' | ');
      console.log(`${err.id}: expected=${err.answer} selected=${err.selected || '(empty)'} actual=${err.code || '(empty)'} candidates: ${candidates}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}
