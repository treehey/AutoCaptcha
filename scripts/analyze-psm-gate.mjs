import { readFile } from 'node:fs/promises';

const [basePath, alternatePath, applyBasePath, applyAlternatePath] = process.argv.slice(2);
if (!basePath || !alternatePath) {
  throw new Error('Usage: node scripts/analyze-psm-gate.mjs <base-report.json> <alternate-report.json>');
}

const VARIANT_WEIGHT = {
  'strict-color': 2,
  'balanced-color': 4,
  'loose-color': 3,
  'thin-line-clean': 3,
  'aggressive-line-clean': 2,
  'simple-threshold': 2,
  'legacy-fallback': 1,
  'color-cluster': 2,
};

function normalize(code) {
  return (code || '').toLowerCase();
}

function mapSamples(report) {
  const samples = new Map();
  for (const round of report.roundResults || []) {
    for (const sample of round.samples || []) {
      samples.set(`${round.round}#${sample.id}`, { round: round.round, ...sample });
    }
  }
  return samples;
}

function candidateStats(sample) {
  const actual = normalize(sample.actual);
  const valid = (sample.candidates || []).filter(item => normalize(item.code).length === 4);
  const exact = valid.filter(item => normalize(item.code) === actual);
  const exactSupport = exact.reduce((sum, item) => {
    return sum + (VARIANT_WEIGHT[item.variant] || 1) + Math.max(0, item.confidence || 0) / 25;
  }, 0);
  const positionSupport = Array.from({ length: 4 }, (_, position) => {
    if (actual.length !== 4) return 0;
    return valid.reduce((sum, item) => {
      if (normalize(item.code)[position] !== actual[position]) return sum;
      return sum + (VARIANT_WEIGHT[item.variant] || 1) + Math.max(0, item.confidence || 0) / 25;
    }, 0);
  });
  return {
    exactCount: exact.length,
    exactMax: exact.reduce((max, item) => Math.max(max, item.confidence || 0), 0),
    exactSupport,
    minPositionSupport: Math.min(...positionSupport),
    validCount: valid.length,
  };
}

function hamming(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (left.length !== 4 || right.length !== 4) return 4;
  let count = 0;
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) count++;
  return count;
}

const base = mapSamples(JSON.parse(await readFile(basePath, 'utf8')));
const alternate = mapSamples(JSON.parse(await readFile(alternatePath, 'utf8')));
const rows = [];

for (const [key, alt] of alternate) {
  const current = base.get(key);
  if (!current || normalize(current.actual) === normalize(alt.actual)) continue;
  const a = candidateStats(current);
  const b = candidateStats(alt);
  rows.push({
    key,
    round: alt.round,
    current,
    alt,
    a,
    b,
    distance: hamming(current.actual, alt.actual),
    gain: Number(alt.ok) - Number(current.ok),
  });
}

const values = {
  baseExactMax: [0, 20, 40, 60, 80, 100],
  altExactMin: [0, 1, 2, 3],
  altMaxMin: [0, 20, 40, 60, 80],
  supportDelta: [-8, -4, 0, 4, 8, 12],
  positionDelta: [-8, -4, 0, 4, 8],
  maxDistance: [1, 2, 3, 4],
};

const rules = [];
for (const baseExactMax of values.baseExactMax)
for (const altExactMin of values.altExactMin)
for (const altMaxMin of values.altMaxMin)
for (const supportDelta of values.supportDelta)
for (const positionDelta of values.positionDelta)
for (const maxDistance of values.maxDistance) {
  const selected = rows.filter(row => {
    return row.a.exactMax <= baseExactMax
      && row.b.exactCount >= altExactMin
      && row.b.exactMax >= altMaxMin
      && row.b.exactSupport - row.a.exactSupport >= supportDelta
      && row.b.minPositionSupport - row.a.minPositionSupport >= positionDelta
      && row.distance <= maxDistance;
  });
  if (!selected.length) continue;
  const roundGains = new Map();
  for (const row of selected) {
    roundGains.set(row.round, (roundGains.get(row.round) || 0) + row.gain);
  }
  const gains = [...new Set(rows.map(row => row.round))].map(round => roundGains.get(round) || 0);
  rules.push({
    baseExactMax, altExactMin, altMaxMin, supportDelta, positionDelta, maxDistance,
    overrides: selected.length,
    gain: selected.reduce((sum, row) => sum + row.gain, 0),
    fixes: selected.filter(row => row.gain > 0).length,
    breaks: selected.filter(row => row.gain < 0).length,
    worstRoundGain: Math.min(...gains),
    selected,
  });
}

rules.sort((a, b) => {
  return b.worstRoundGain - a.worstRoundGain
    || b.gain - a.gain
    || a.breaks - b.breaks
    || a.overrides - b.overrides;
});

console.log(`Disagreements: ${rows.length}`);
console.log(`Alternate oracle fixes: ${rows.filter(row => row.gain > 0).length}`);
console.log('');
for (const [index, rule] of rules.slice(0, 20).entries()) {
  console.log(
    `#${index + 1} gain=${rule.gain} fixes=${rule.fixes} breaks=${rule.breaks} overrides=${rule.overrides} worstRound=${rule.worstRoundGain} `
    + `baseMax<=${rule.baseExactMax} altCount>=${rule.altExactMin} altMax>=${rule.altMaxMin} `
    + `supportDelta>=${rule.supportDelta} positionDelta>=${rule.positionDelta} distance<=${rule.maxDistance}`
  );
  console.log(`   ${rule.selected.map(row => `${row.key}(${row.gain > 0 ? '+' : row.gain < 0 ? '-' : '0'})`).join(', ')}`);
}

if (applyBasePath && applyAlternatePath && rules.length) {
  const applyBase = mapSamples(JSON.parse(await readFile(applyBasePath, 'utf8')));
  const applyAlternate = mapSamples(JSON.parse(await readFile(applyAlternatePath, 'utf8')));
  const rule = rules[0];
  let baselineCorrect = 0;
  let selectedCorrect = 0;
  let overrides = 0;
  const changed = [];
  for (const [key, alt] of applyAlternate) {
    const current = applyBase.get(key);
    if (!current) continue;
    baselineCorrect += Number(current.ok);
    const a = candidateStats(current);
    const b = candidateStats(alt);
    const useAlternate = normalize(current.actual) !== normalize(alt.actual)
      && a.exactMax <= rule.baseExactMax
      && b.exactCount >= rule.altExactMin
      && b.exactMax >= rule.altMaxMin
      && b.exactSupport - a.exactSupport >= rule.supportDelta
      && b.minPositionSupport - a.minPositionSupport >= rule.positionDelta
      && hamming(current.actual, alt.actual) <= rule.maxDistance;
    selectedCorrect += Number(useAlternate ? alt.ok : current.ok);
    if (useAlternate) {
      overrides++;
      changed.push(`${key}(${Number(alt.ok) - Number(current.ok)})`);
    }
  }
  console.log('');
  console.log(`Frozen rule validation: ${baselineCorrect} -> ${selectedCorrect}, overrides=${overrides}`);
  console.log(changed.join(', '));
}
