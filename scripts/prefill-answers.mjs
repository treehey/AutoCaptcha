import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const verbose = process.argv.includes('--verbose');

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

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0];
  const data = lines.slice(1).map(line => line.split(',').map(part => part.trim()));
  return { header, rows: data };
}

function toCsv(header, rows) {
  return [header, ...rows.map(row => row.join(','))].join('\n') + '\n';
}

// Parse round name to sort properly
function roundOrder(name) {
  const m = name.match(/^round-(\d{3})$/);
  return m ? parseInt(m[1], 10) : Infinity;
}

const sampleBase = path.join(repoRoot, 'data', 'captcha-samples');
const rounds = readdirSync(sampleBase)
  .filter(name => /^round-\d{3}$/.test(name))
  .sort((a, b) => roundOrder(a) - roundOrder(b));

if (!rounds.length) {
  console.error('No sample rounds found.');
  process.exit(1);
}

console.log(`Rounds to prefill: ${rounds.join(', ')}`);
console.log('');

// Collect work: all unlabeled images across rounds
const work = [];
for (const round of rounds) {
  const roundDir = path.join(sampleBase, round);
  const answersPath = path.join(roundDir, 'answers.csv');
  if (!existsSync(answersPath)) continue;

  const csvText = await readFile(answersPath, 'utf8');
  const { header, rows } = parseCsv(csvText);
  for (const row of rows) {
    const [id, file, answer] = row;
    if (!answer || answer.trim() === '') {
      work.push({ round, roundDir, answersPath, header, id, file, allRows: rows });
    }
  }
}

if (!work.length) {
  console.log('All answers are already filled in!');
  process.exit(0);
}

console.log(`Found ${work.length} unlabeled images across ${rounds.length} rounds.\n`);

// ── Browser + OCR ───────────────────────────────────
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

try {
  const page = await browser.newPage();
  page.on('console', msg => {
    const text = msg.text();
    if (/NJU 助手：OCR候选/.test(text)) {
      if (verbose) console.log(`  [OCR] ${text}`);
    }
  });

  await page.goto(`${origin}/benchmark.html`);
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: 'prefill' }),
        getURL: resource => new URL(resource, window.location.href).href,
      },
      storage: {
        local: { get: async () => ({ nju_enabled: false }) },
      },
    };
  });
  await page.addScriptTag({ url: `${origin}/tesseract.min.js` });
  await page.addScriptTag({ url: `${origin}/captcha-cnn.js` });
  await page.addScriptTag({ url: `${origin}/content.js` });
  await page.waitForFunction(() => typeof window.recognizeCaptchaCode === 'function');

  // Group work by round for batch CSV writing
  const byRound = new Map();
  for (const item of work) {
    if (!byRound.has(item.round)) byRound.set(item.round, []);
    byRound.get(item.round).push(item);
  }

  let done = 0;
  for (const [round, items] of byRound) {
    const roundDir = path.join(sampleBase, round);
    console.log(`[${round}] Running OCR on ${items.length} images...`);

    // Re-read CSV to get latest state
    const answersPath = path.join(roundDir, 'answers.csv');
    const csvText = await readFile(answersPath, 'utf8');
    const { header, rows } = parseCsv(csvText);

    for (const item of items) {
      const imageUrl = `${origin}/${path.relative(repoRoot, path.join(roundDir, item.file)).replaceAll(path.sep, '/')}`;

      const result = await page.evaluate(async ({ imageUrl }) => {
        const img = new Image();
        img.src = imageUrl;
        await img.decode();
        const details = await window.recognizeCaptchaCode(img, { includeDetails: true });
        return {
          code: details.code,
          confidence: details.candidates
            .filter(c => c.code === (details.selectedCode || ''))
            .reduce((max, c) => Math.max(max, c.confidence || 0), 0),
          fallback: details.candidates.some(c => ['color-cluster', 'balanced-color', 'aggressive-line-clean'].includes(c.variant)),
          candidates: details.candidates.map(c => ({
            variant: c.variant,
            code: c.code || '',
            confidence: Math.round(c.confidence || 0),
          })),
        };
      }, { imageUrl });

      // Update the row in memory
      const rowIdx = rows.findIndex(r => r[0] === item.id);
      if (rowIdx >= 0) {
        rows[rowIdx][2] = result.code || '????';
      }

      done++;
      const fb = result.fallback ? '[F]' : ' ';
      const conf = Math.round(result.confidence);
      console.log(`  ${done}/${work.length}  ${item.id}.png → ${result.code || '????'}  conf=${conf} ${fb}`);

      if (verbose && result.candidates) {
        const candStr = result.candidates.map(c => `${c.variant}=${c.code || '空'}(${c.confidence})`).join(' | ');
        console.log(`    ${candStr}`);
      }
    }

    // Write updated CSV for this round
    await writeFile(answersPath, toCsv(header, rows), 'utf8');
    console.log(`  [${round}] answers.csv saved.\n`);
  }

  console.log(`Done. Prefilled ${work.length} answers across ${byRound.size} rounds.`);
  console.log('Please review the contact sheets and correct any errors in answers.csv.');

} finally {
  await browser.close();
  server.close();
}
