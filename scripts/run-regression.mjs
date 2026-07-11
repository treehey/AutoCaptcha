import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const verbose = process.argv.includes('--verbose') || process.env.OCR_REGRESSION_VERBOSE === '1';
const args = process.argv.slice(2).filter(arg => arg !== '--verbose');
const pluginFlow = args.includes('--plugin-flow');
const cnnOnly = args.includes('--cnn-only');
const templateRerankEnabled = args.includes('--template-rerank');
const templateTrainArg = args.find(arg => arg.startsWith('--template-train='))?.slice('--template-train='.length) || '';
const templateMode = args.find(arg => arg.startsWith('--template-mode='))?.slice('--template-mode='.length) || 'thin';
const templateK = Number(args.find(arg => arg.startsWith('--template-k='))?.slice('--template-k='.length) || 3);
const templateMargin = Number(args.find(arg => arg.startsWith('--template-margin='))?.slice('--template-margin='.length) || 10);
const templateOcrWeight = Number(args.find(arg => arg.startsWith('--template-ocr-weight='))?.slice('--template-ocr-weight='.length) || 0);
const templateSupportWeight = Number(args.find(arg => arg.startsWith('--template-support-weight='))?.slice('--template-support-weight='.length) || 0);
const templateProtectHighConfidence = args.includes('--template-protect-high-confidence');
const templateAllLabels = !args.includes('--template-candidate-labels-only');
const templateProtectWeakSingleVariant = !args.includes('--template-no-weak-single-protect');
const templateWeakSingleVariantMargin = Number(args.find(arg => arg.startsWith('--template-weak-single-margin='))?.slice('--template-weak-single-margin='.length) || 30);
const pageSegMode = args.find(arg => arg.startsWith('--psm='))?.slice('--psm='.length) || '13';

function parseRoundList(value) {
  if (!value) return [];
  return value.split(',').filter(Boolean).map(round => `round-${round.padStart(3, '0')}`);
}

// Round selection: comma-separated or 'all' (default: 'all')
const roundArg = args.find(arg => /^(all|\d{3}(,\d{3})*)$/.test(arg)) || 'all';
const rounds = roundArg === 'all'
  ? (await (async () => {
      const sampleDir = path.join(repoRoot, 'data', 'captcha-samples');
      if (!existsSync(sampleDir)) return [];
      return readdirSync(sampleDir)
        .filter(name => /^round-\d{3}$/.test(name))
        .sort();
    })())
  : roundArg.split(',').map(r => `round-${r}`);

const resultsDir = path.join(repoRoot, 'data', 'regression-results');
await mkdir(resultsDir, { recursive: true });

// ── helpers ──────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).slice(1);
  return lines
    .map(line => line.split(',').map(part => part.trim()))
    .filter(parts => parts.length >= 3 && parts[2])
    .map(([id, file, answer]) => ({ id, file, answer }));
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
      res.writeHead(404); res.end('Not found'); return;
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

function sameCaptchaAnswer(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i], b = expected[i];
    if (/[a-zA-Z]/.test(a) && /[a-zA-Z]/.test(b)) {
      if (a.toLowerCase() !== b.toLowerCase()) return false;
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

function normalizeTemplateLabel(char) {
  return /[a-zA-Z]/.test(char || '') ? char.toLowerCase() : (char || '');
}

async function buildTemplateModel(page, origin, trainRounds, mode) {
  const samples = [];

  for (const round of trainRounds) {
    const sampleDir = path.join(repoRoot, 'data', 'captcha-samples', round);
    const answersPath = path.join(sampleDir, 'answers.csv');
    if (!existsSync(answersPath)) {
      console.log(`[template] SKIP ${round} — no answers.csv found`);
      continue;
    }

    const answers = parseCsv(await readFile(answersPath, 'utf8'));
    console.log(`[template] Extracting ${answers.length} samples from ${round} (${mode})...`);

    for (const sample of answers) {
      const imageUrl = `${origin}/${path.relative(repoRoot, path.join(sampleDir, sample.file)).replaceAll(path.sep, '/')}`;
      const features = await page.evaluate(async ({ imageUrl, mode }) => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();
        const base = await window.readCaptchaBitmap(img);
        return window.extractCaptchaTemplateFeatures(base, mode);
      }, { imageUrl, mode });

      for (let pos = 0; pos < 4; pos++) {
        samples.push({
          label: normalizeTemplateLabel(sample.answer[pos]),
          mode,
          round,
          id: sample.id,
          pos,
          ...features.chars[pos],
        });
      }
    }
  }

  return {
    featureSize: { width: 24, height: 32 },
    mode,
    samples,
  };
}

function charDiff(actual, expected) {
  if (!actual || !expected) return [];
  const diffs = [];
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    const a = actual[i] || '', e = expected[i] || '';
    if (!sameCaptchaAnswer(a, e)) diffs.push({ pos: i, expected: e, actual: a });
  }
  return diffs;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function average(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

// Confusion pairs that are worth highlighting
const CONFUSION_PAIRS = new Set([
  'jJ', 'pP', 'iI', 'l1', '5S', '5s', '5Z', '5z',
  'bB', 'dD', '8B', '8b', 'B8', 'b8',
  'Ut', 'uT', 'uU', 'tT',
  'qQ', 'gG', 'yY',
  'cC', 'eE',
  'vV', '2V', '2v',
  'nN', 'mM', 'wW',
  'rR', 'tT',
  'fF', 'pP',
  'EF', 'eF', 'Pp',
]);

function isConfusionPair(a, b) {
  if (!a || !b) return false;
  const pair = `${a}${b}`;
  return CONFUSION_PAIRS.has(pair) || CONFUSION_PAIRS.has(`${b}${a}`);
}

// ── main ─────────────────────────────────────────────────
if (!rounds.length) {
  console.error('No regression rounds found. Run collect-captcha-samples.ps1 first.');
  process.exit(1);
}

console.log(`Regression rounds: ${rounds.join(', ')}`);
console.log('');

const { server, origin } = await startServer();

const browserCandidates = [
  process.env.BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = browserCandidates.find(c => existsSync(c));
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox'],
});

const allRoundResults = [];

try {
  const page = await browser.newPage();
  page.on('console', msg => {
    const text = msg.text();
    if (/NJU 助手：OCR候选/.test(text) && verbose) console.log(`  [browser] ${text}`);
  });

  await page.goto(`${origin}/benchmark.html`);
  await page.evaluate(({ pluginFlow, pageSegMode }) => {
    window.NJU_OCR_PSM = pageSegMode;
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: 'regression' }),
        getURL: resource => new URL(resource, window.location.href).href,
      },
      storage: {
        local: {
          get: async () => ({
            nju_enabled: false,
            nju_template_rerank: pluginFlow,
            nju_template_debug: false,
          }),
        },
      },
    };
  }, { pluginFlow, pageSegMode });
  await page.addScriptTag({ url: `${origin}/tesseract.min.js` });
  await page.addScriptTag({ url: `${origin}/captcha-cnn.js` });
  await page.addScriptTag({ url: `${origin}/content.js` });
  await page.waitForFunction(() => typeof window.recognizeCaptchaCode === 'function');
  await page.waitForFunction(() => typeof window.extractCaptchaTemplateFeatures === 'function');

  if (pluginFlow) {
    console.log('[template] Plugin flow enabled: using packaged model via recognizeCaptchaCode()');
    console.log('');
  } else if (templateRerankEnabled) {
    const trainRounds = parseRoundList(templateTrainArg);
    if (!trainRounds.length) {
      throw new Error('Template rerank requires --template-train=010,011,...');
    }
    const model = await buildTemplateModel(page, origin, trainRounds, templateMode);
    await page.evaluate(config => {
      window.NJU_TEMPLATE_RERANK_CONFIG = config;
    }, {
      enabled: true,
      mode: templateMode,
      k: templateK,
      margin: templateMargin,
      ocrWeight: templateOcrWeight,
      supportWeight: templateSupportWeight,
      allTemplateLabels: templateAllLabels,
      protectWeakSingleVariant: templateProtectWeakSingleVariant,
      weakSingleVariantMargin: templateWeakSingleVariantMargin,
      protectHighConfidence: templateProtectHighConfidence,
      model,
      debug: verbose,
    });
    console.log(`[template] Rerank enabled: train=${trainRounds.join(', ')} mode=${templateMode} k=${templateK} margin=${templateMargin} ocrWeight=${templateOcrWeight} supportWeight=${templateSupportWeight} allLabels=${templateAllLabels} protectWeakSingleVariant=${templateProtectWeakSingleVariant} weakSingleMargin=${templateWeakSingleVariantMargin} protectHighConfidence=${templateProtectHighConfidence}`);
    console.log('');
  } else {
    await page.evaluate(() => {
      window.NJU_TEMPLATE_RERANK_CONFIG = { enabled: false };
    });
  }

  for (const round of rounds) {
    const sampleDir = path.join(repoRoot, 'data', 'captcha-samples', round);
    const answersPath = path.join(sampleDir, 'answers.csv');
    if (!existsSync(answersPath)) {
      console.log(`[${round}] SKIP — no answers.csv found (not yet labeled)`);
      continue;
    }

    const csvText = await readFile(answersPath, 'utf8');
    const answers = parseCsv(csvText);
    if (!answers.length) {
      console.log(`[${round}] SKIP — answers.csv is empty (not yet labeled)`);
      continue;
    }

    console.log(`[${round}] Running ${answers.length} samples...`);
    const results = [];

    for (const sample of answers) {
      const imageUrl = `${origin}/${path.relative(repoRoot, path.join(sampleDir, sample.file)).replaceAll(path.sep, '/')}`;
      const result = await page.evaluate(async ({ imageUrl, pluginFlow, cnnOnly }) => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();

        const started = performance.now();
        if (cnnOnly) {
          const details = await window.NjuCaptchaCnn.recognize(img);
          return {
            code: details.code,
            selected: details.code,
            elapsedMs: performance.now() - started,
            usedFallback: false,
            templateRerank: null,
            templateBeam: null,
            candidates: [{
              variant: 'raw-cnn',
              code: details.code,
              confidence: Math.min(...details.chars.map(item => item.confidence)) * 100,
            }],
          };
        }
        if (pluginFlow) {
          const details = await window.recognizeCaptchaCode(img, { includeDetails: true });
          return {
            code: details.code,
            selected: details.selectedCode || '',
            elapsedMs: performance.now() - started,
            usedFallback: details.candidates.some(candidate => {
              return ['color-cluster', 'balanced-color', 'aggressive-line-clean'].includes(candidate.variant);
            }),
            templateRerank: details.templateRerank || null,
            templateBeam: details.templateBeam || null,
            candidates: details.candidates,
          };
        }

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

        let code = selected ? window.correctVisualConfusions(selected, base, candidates) : '';
        const templateRerank = window.rerankCaptchaCodeWithTemplate(base, candidates, code);
        if (templateRerank.overridden) {
          code = templateRerank.selectedAfter;
        }
        return {
          code,
          selected,
          elapsedMs: performance.now() - started,
          usedFallback,
          templateRerank,
          templateBeam: null,
          candidates: candidates.map(c => ({
            variant: c.variant,
            code: c.code || '',
            confidence: Math.round(c.confidence || 0),
          })),
        };
      }, { imageUrl, pluginFlow, cnnOnly });

      const ok = sameCaptchaAnswer(result.code, sample.answer);
      const diffs = ok ? [] : charDiff(result.code, sample.answer);
      const confusions = diffs.filter(d => isConfusionPair(d.expected, d.actual));

      results.push({ ...sample, ...result, ok, diffs, confusions });

      const icon = ok ? '✓' : '✗';
      const diffStr = ok ? '' : `  expected=${sample.answer} got=${result.code || '(empty)'}  diffs=[${diffs.map(d => `${d.expected}→${d.actual}`).join(', ')}]`;
      console.log(`  ${icon} ${sample.id}  ${Math.round(result.elapsedMs)}ms  fallback=${result.usedFallback}${diffStr}`);

      if (!ok && verbose) {
        const candStr = result.candidates.map(c => `${c.variant}=${c.code || '空'}(${c.confidence})`).join(' | ');
        console.log(`    candidates: ${candStr}`);
        if (result.templateRerank?.enabled) {
          const rerankStr = result.templateRerank.candidates
            .slice(0, 8)
            .map(c => `${c.code || '空'}:${Number(c.combinedScore || 0).toFixed(1)}[t=${Number(c.templateScore || 0).toFixed(1)},o=${Number(c.ocrScore || 0).toFixed(1)}]`)
            .join(' | ');
          console.log(`    template: ${result.templateRerank.selectedBefore || '空'} -> ${result.templateRerank.selectedAfter || '空'} ${result.templateRerank.reason}; ${rerankStr}`);
        }
      }
    }

    const correct = results.filter(r => r.ok).length;
    const times = results.map(r => r.elapsedMs);
    const errors = results.filter(r => !r.ok);
    const confusionErrors = errors.filter(r => r.confusions.length > 0);

    const roundSummary = {
      round,
      correct,
      total: results.length,
      accuracy: correct / results.length,
      avgMs: average(times),
      p50Ms: percentile(times, 50),
      p95Ms: percentile(times, 95),
      fallbackCount: results.filter(r => r.usedFallback).length,
      samples: results.map(r => ({
        id: r.id,
        expected: r.answer,
        actual: r.code || '',
        selected: r.selected || '',
        ok: r.ok,
        elapsedMs: r.elapsedMs,
        usedFallback: r.usedFallback,
        templateRerank: r.templateRerank || null,
        templateBeam: r.templateBeam || null,
        candidates: r.candidates,
      })),
      errors: errors.map(e => ({
        id: e.id,
        expected: e.answer,
        actual: e.code || '',
        selected: e.selected || '',
        templateRerank: e.templateRerank || null,
        templateBeam: e.templateBeam || null,
        diffs: e.diffs,
        confusions: e.confusions,
        candidates: e.candidates,
      })),
    };

    allRoundResults.push(roundSummary);

    console.log(`  ── Accuracy: ${correct}/${results.length} (${(correct / results.length * 100).toFixed(1)}%)  avg=${average(times).toFixed(0)}ms  p50=${percentile(times, 50).toFixed(0)}ms  p95=${percentile(times, 95).toFixed(0)}ms`);
    if (errors.length) {
      console.log(`  Errors (${errors.length}):`);
      for (const e of errors) {
        const confusionTags = e.confusions.length ? ` [CONFUSION: ${e.confusions.map(c => `${c.expected}↔${c.actual}`).join(', ')}]` : '';
        console.log(`    ${e.id}: expected=${e.answer}  actual=${e.code || '(empty)'}  diffs=[${e.diffs.map(d => `${d.expected}→${d.actual}`).join(', ')}]${confusionTags}`);
      }
    }
    console.log('');
  }

  // ── aggregate ──────────────────────────────────────
  const totalCorrect = allRoundResults.reduce((s, r) => s + r.correct, 0);
  const totalSamples = allRoundResults.reduce((s, r) => s + r.total, 0);
  const allErrors = allRoundResults.flatMap(r => r.errors.map(e => ({ round: r.round, ...e })));
  const allTimes = allRoundResults.flatMap(r => {
    // We don't store per-sample times per round in aggregate easily, skip detailed timing aggregate
    return [];
  });

  console.log('═══════════════════════════════════════════');
  console.log('  REGRESSION SUMMARY');
  console.log('═══════════════════════════════════════════');
  for (const r of allRoundResults) {
    const pct = (r.accuracy * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(r.accuracy * 20)) + '░'.repeat(20 - Math.round(r.accuracy * 20));
    console.log(`  ${r.round}  ${bar}  ${r.correct}/${r.total} (${pct}%)  ${r.avgMs.toFixed(0)}ms avg`);
  }
  console.log('───────────────────────────────────────────');
  const overallPct = (totalCorrect / totalSamples * 100).toFixed(1);
  const overallBar = '█'.repeat(Math.round(totalCorrect / totalSamples * 20)) + '░'.repeat(20 - Math.round(totalCorrect / totalSamples * 20));
  console.log(`  OVERALL   ${overallBar}  ${totalCorrect}/${totalSamples} (${overallPct}%)`);
  console.log('═══════════════════════════════════════════');

  if (allErrors.length) {
    console.log('');
    console.log(`  All errors (${allErrors.length}):`);
    for (const e of allErrors) {
      const confusionTags = e.confusions.length ? ` [CONFUSION: ${e.confusions.map(c => `${c.expected}↔${c.actual}`).join(', ')}]` : '';
      console.log(`    [${e.round}] ${e.id}: expected=${e.expected}  actual=${e.actual}  diffs=[${e.diffs.map(d => `${d.expected}→${d.actual}`).join(', ')}]${confusionTags}`);
    }
  }

  // ── persist results ──────────────────────────────
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const resultsFile = path.join(resultsDir, `regression-${stamp}.json`);
  const report = {
    timestamp: now.toISOString(),
    rounds: allRoundResults.map(r => r.round),
    templateRerank: pluginFlow ? {
      enabled: true,
      pluginFlow: true,
      packagedModel: 'assets/captcha-template-model.json',
    } : templateRerankEnabled ? {
      enabled: true,
      trainRounds: parseRoundList(templateTrainArg),
      mode: templateMode,
      k: templateK,
      margin: templateMargin,
      ocrWeight: templateOcrWeight,
      supportWeight: templateSupportWeight,
      allTemplateLabels: templateAllLabels,
      protectWeakSingleVariant: templateProtectWeakSingleVariant,
      weakSingleVariantMargin: templateWeakSingleVariantMargin,
      protectHighConfidence: templateProtectHighConfidence,
    } : { enabled: false },
    totalCorrect,
    totalSamples,
    accuracy: totalCorrect / totalSamples,
    roundResults: allRoundResults,
  };
  await writeFile(resultsFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nResults saved to: ${path.relative(repoRoot, resultsFile)}`);

} finally {
  await browser.close();
  server.close();
}
