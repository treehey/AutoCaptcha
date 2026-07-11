import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
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

const roundsArg = args.find(arg => arg.startsWith('--rounds='))?.slice('--rounds='.length) || '010,011,012,013,014,015';
const legacyMode = args.find(arg => arg.startsWith('--mode='))?.slice('--mode='.length);
const modesArg = args.find(arg => arg.startsWith('--modes='))?.slice('--modes='.length) || legacyMode || 'thin';
const modes = modesArg.split(',').map(item => item.trim()).filter(Boolean);
const primaryMode = modes.includes('thin') ? 'thin' : modes[0];
const outPath = path.resolve(repoRoot, args.find(arg => arg.startsWith('--out='))?.slice('--out='.length) || 'assets/captcha-template-model.json');
const appendModel = args.includes('--append');

function parseRoundList(value) {
  return value.split(',').filter(Boolean).map(round => `round-${round.padStart(3, '0')}`);
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

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  return lines.slice(1)
    .map(line => line.split(',').map(part => part.trim()))
    .filter(row => row.length >= 3 && row[2] && row[2].length === 4)
    .map(([id, file, answer]) => ({ id, file, answer }));
}

function normalizeTemplateLabel(char) {
  return /[a-zA-Z]/.test(char || '') ? char.toLowerCase() : (char || '');
}

function roundVector(values) {
  return values.map(value => Math.round(Number(value || 0) * 10000) / 10000);
}

function normalizeFeature(feature) {
  return {
    vector: feature.vector,
    col: roundVector(feature.col),
    row: roundVector(feature.row),
  };
}

const trainRounds = parseRoundList(roundsArg);
console.log(`[template-model] rounds=${trainRounds.join(', ')} modes=${modes.join(', ')}`);
console.log(`[template-model] out=${outPath}`);

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

try {
  const page = await browser.newPage();
  await page.goto(`${origin}/benchmark.html`);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: 'template-model' }),
        getURL: resource => new URL(resource, window.location.href).href,
      },
      storage: {
        local: { get: async () => ({ nju_enabled: false }) },
      },
    };
  });
  await page.addScriptTag({ url: `${origin}/tesseract.min.js` });
  await page.addScriptTag({ url: `${origin}/content.js` });
  await page.waitForFunction(() => typeof window.extractCaptchaTemplateFeatures === 'function');

  const samples = [];
  for (const round of trainRounds) {
    const sampleDir = path.join(repoRoot, 'data', 'captcha-samples', round);
    const answersPath = path.join(sampleDir, 'answers.csv');
    if (!existsSync(answersPath)) {
      console.log(`[template-model] skip ${round}: missing answers.csv`);
      continue;
    }

    const answers = parseCsv(await readFile(answersPath, 'utf8'));
    console.log(`[template-model] ${round}: ${answers.length} labeled samples`);
    for (const sample of answers) {
      const imageUrl = `${origin}/${path.relative(repoRoot, path.join(sampleDir, sample.file)).replaceAll(path.sep, '/')}`;
      const featuresByMode = await page.evaluate(async ({ imageUrl, modes }) => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();
        const base = await window.readCaptchaBitmap(img);
        const output = {};
        for (const mode of modes) {
          output[mode] = window.extractCaptchaTemplateFeatures(base, mode);
        }
        return output;
      }, { imageUrl, modes });

      for (const mode of modes) {
        const features = featuresByMode[mode];
        for (let pos = 0; pos < 4; pos++) {
          samples.push({
            label: normalizeTemplateLabel(sample.answer[pos]),
            mode,
            round,
            id: sample.id,
            pos,
            ...normalizeFeature(features.chars[pos]),
          });
        }
      }
    }
  }

  const existingModel = appendModel && existsSync(outPath)
    ? JSON.parse(await readFile(outPath, 'utf8'))
    : {};
  const retainedSamples = (existingModel.samples || []).filter(item => {
    return !(modes.includes(item.mode) && trainRounds.includes(item.round));
  });
  const combinedSamples = [...retainedSamples, ...samples];
  const model = {
    ...existingModel,
    version: modes.length > 1 || retainedSamples.length ? 2 : 1,
    generatedAt: new Date().toISOString(),
    featureSize: { width: 24, height: 32 },
    mode: primaryMode,
    recommended: {
      ...(existingModel.recommended || {}),
      enabled: true,
      mode: primaryMode,
      k: 3,
      margin: 10,
      ocrWeight: 0,
      supportWeight: 0,
      protectWeakSingleVariant: true,
      weakSingleVariantMargin: 30,
      ...(modes.includes('aggressive') ? {
        beam: {
          enabled: true,
          mode: 'aggressive',
          k: 1,
          margin: 18,
          templateCharMargin: 5,
          maxLabels: 3,
          maxChangedPositions: 1,
          maxTemplateOnlyChanges: 1,
        },
      } : {}),
    },
    trainRounds: [...new Set([...(existingModel.trainRounds || []), ...trainRounds])].sort(),
    samples: combinedSamples,
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(model), 'utf8');
  console.log(`[template-model] wrote ${combinedSamples.length} character templates (${samples.length} generated)`);
} finally {
  await browser.close();
  server.close();
}
