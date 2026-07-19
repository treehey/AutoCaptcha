import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const outputBase = path.join(repoRoot, 'data', 'click-captcha-samples');

function usage() {
  console.error('Usage: node scripts/import-click-captcha-samples.mjs <export.json> --round <number>');
}

function parseArguments(argv) {
  const input = argv.find(value => !value.startsWith('--'));
  const roundIndex = argv.indexOf('--round');
  const roundValue = roundIndex >= 0 ? argv[roundIndex + 1] : '';
  if (!input || !roundValue || !/^\d{1,3}$/.test(roundValue)) {
    usage();
    process.exit(1);
  }
  return {
    inputPath: path.resolve(process.cwd(), input),
    round: String(Number(roundValue)).padStart(3, '0')
  };
}

function assertSample(sample, index, expectedClicks) {
  if (!sample || typeof sample !== 'object') {
    throw new Error(`Sample ${index + 1} is not an object.`);
  }
  if (typeof sample.imageDataUrl !== 'string' || !sample.imageDataUrl.startsWith('data:image/png;base64,')) {
    throw new Error(`Sample ${index + 1} does not contain a PNG data URL.`);
  }
  if (!Array.isArray(sample.clicks) || sample.clicks.length !== expectedClicks) {
    throw new Error(`Sample ${index + 1} must contain exactly ${expectedClicks} clicks.`);
  }
  sample.clicks.forEach((click, clickIndex) => {
    if (!Number.isFinite(click?.x) || !Number.isFinite(click?.y) || !Number.isFinite(click?.relativeX) || !Number.isFinite(click?.relativeY)) {
      throw new Error(`Sample ${index + 1}, click ${clickIndex + 1} has invalid coordinates.`);
    }
  });
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const { inputPath, round } = parseArguments(process.argv.slice(2));
const rawExport = await readFile(inputPath, 'utf8');
const exported = JSON.parse(rawExport);
const expectedClicks = Number(exported.expectedClicks || 4);

if (exported.format !== 'nju-click-captcha-samples/v1') {
  throw new Error('Unsupported export format. Expected nju-click-captcha-samples/v1.');
}
if (!Array.isArray(exported.samples) || exported.samples.length === 0) {
  throw new Error('The export does not contain any samples.');
}
if (!Number.isInteger(expectedClicks) || expectedClicks <= 0 || expectedClicks > 10) {
  throw new Error('Invalid expected click count in export.');
}

exported.samples.forEach((sample, index) => assertSample(sample, index, expectedClicks));

const roundDir = path.join(outputBase, `round-${round}`);
if (await pathExists(roundDir)) {
  throw new Error(`Refusing to overwrite existing sample round: ${roundDir}`);
}

const imagesDir = path.join(roundDir, 'images');
await mkdir(imagesDir, { recursive: true });
await writeFile(path.join(roundDir, 'source-export.json'), rawExport, 'utf8');

const samples = [];
for (let index = 0; index < exported.samples.length; index += 1) {
  const sample = exported.samples[index];
  const id = String(index + 1).padStart(4, '0');
  const imageFile = `${id}.png`;
  const base64 = sample.imageDataUrl.slice('data:image/png;base64,'.length);
  await writeFile(path.join(imagesDir, imageFile), Buffer.from(base64, 'base64'));

  samples.push({
    id,
    image: `images/${imageFile}`,
    createdAt: sample.createdAt || null,
    source: sample.image || null,
    clicks: sample.clicks.map(click => ({
      order: click.order,
      x: click.x,
      y: click.y,
      relativeX: click.relativeX,
      relativeY: click.relativeY
    }))
  });
}

const metadata = {
  format: 'nju-click-captcha-round/v1',
  importedAt: new Date().toISOString(),
  sourceExportedAt: exported.exportedAt || null,
  expectedClicks,
  sampleCount: samples.length,
  samples
};
await writeFile(path.join(roundDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

console.log(`Imported ${samples.length} samples into ${path.relative(repoRoot, roundDir)}`);
