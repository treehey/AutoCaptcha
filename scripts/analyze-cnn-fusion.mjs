import { readFile } from 'node:fs/promises';

const [regressionPath, predictionsPath] = process.argv.slice(2);
if (!regressionPath || !predictionsPath) {
  throw new Error('Usage: node scripts/analyze-cnn-fusion.mjs <regression.json> <cnn-predictions.json>');
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

function normalize(value) {
  return (value || '').toLowerCase();
}

function sameCode(left, right) {
  return normalize(left) === normalize(right);
}

function mapRegression(report) {
  const output = new Map();
  for (const round of report.roundResults || []) {
    for (const sample of round.samples || []) {
      output.set(`${round.round}#${sample.id}`, { round: round.round, ...sample });
    }
  }
  return output;
}

function groupPredictions(rows) {
  const output = new Map();
  for (const row of rows || []) {
    const key = `${row.round}#${row.id}`;
    const item = output.get(key) || Array(4).fill(null);
    item[row.pos] = row;
    output.set(key, item);
  }
  return output;
}

function positionSupport(sample, position, label) {
  const target = normalize(label);
  return (sample.candidates || []).reduce((sum, candidate) => {
    const code = normalize(candidate.code);
    if (code.length !== 4 || code[position] !== target) return sum;
    return sum + (VARIANT_WEIGHT[candidate.variant] || 1) + Math.max(0, candidate.confidence || 0) / 25;
  }, 0);
}

function buildSamples(regression, predictions) {
  const samples = [];
  for (const [key, chars] of predictions) {
    const ocr = regression.get(key);
    if (!ocr || normalize(ocr.actual).length !== 4 || chars.some(item => !item)) continue;
    const positions = chars.map((cnn, position) => {
      const current = normalize(ocr.actual)[position];
      const predicted = normalize(cnn.predicted);
      const margin = cnn.top3.length > 1
        ? cnn.top3[0].probability - cnn.top3[1].probability
        : cnn.confidence;
      const currentSupport = positionSupport(ocr, position, current);
      const predictedSupport = positionSupport(ocr, position, predicted);
      return {
        position,
        current,
        predicted,
        confidence: cnn.confidence,
        margin,
        currentSupport,
        predictedSupport,
        supportDelta: predictedSupport - currentSupport,
      };
    });
    samples.push({ key, round: ocr.round, expected: ocr.expected, actual: ocr.actual, positions });
  }
  return samples;
}

function applyRule(sample, rule) {
  const replacements = sample.positions
    .filter(item => item.current !== item.predicted)
    .filter(item => item.confidence >= rule.confidence)
    .filter(item => item.margin >= rule.margin)
    .filter(item => item.currentSupport <= rule.maxCurrentSupport)
    .filter(item => item.supportDelta >= rule.minSupportDelta)
    .filter(item => !rule.candidateOnly || item.predictedSupport > 0)
    .sort((a, b) => {
      const scoreA = a.confidence + a.margin + Math.min(0.5, a.supportDelta / 20);
      const scoreB = b.confidence + b.margin + Math.min(0.5, b.supportDelta / 20);
      return scoreB - scoreA;
    })
    .slice(0, rule.maxChanges);
  const output = [...normalize(sample.actual)];
  for (const item of replacements) output[item.position] = item.predicted;
  return { code: output.join(''), replacements };
}

const regression = mapRegression(JSON.parse(await readFile(regressionPath, 'utf8')));
const predictionData = JSON.parse(await readFile(predictionsPath, 'utf8'));
const devSamples = buildSamples(regression, groupPredictions(predictionData.devPredictions));
const testSamples = buildSamples(regression, groupPredictions(predictionData.predictions));
const devRounds = [...new Set(devSamples.map(sample => sample.round))].sort();

function oracleSummary(samples, predictionRows) {
  const grouped = groupPredictions(predictionRows);
  let top1 = 0;
  let top3 = 0;
  for (const sample of samples) {
    const expected = normalize(sample.expected);
    const current = normalize(sample.actual);
    const cnn = grouped.get(sample.key);
    const top1Ok = [...expected].every((char, position) => {
      return current[position] === char || normalize(cnn[position].predicted) === char;
    });
    const top3Ok = [...expected].every((char, position) => {
      return current[position] === char
        || cnn[position].top3.some(item => normalize(item.label) === char);
    });
    top1 += Number(top1Ok);
    top3 += Number(top3Ok);
  }
  return { top1, top3 };
}

const devOracle = oracleSummary(devSamples, predictionData.devPredictions);
const testOracle = oracleSummary(testSamples, predictionData.predictions);
console.log(`Oracle dev: OCR+CNN top1=${devOracle.top1}/${devSamples.length}, top3=${devOracle.top3}/${devSamples.length}`);
console.log(`Oracle holdout: OCR+CNN top1=${testOracle.top1}/${testSamples.length}, top3=${testOracle.top3}/${testSamples.length}`);
console.log('');

const rules = [];
for (const confidence of [0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
for (const margin of [0.05, 0.1, 0.2, 0.3, 0.4])
for (const maxCurrentSupport of [2, 4, 6, 8, 12, Infinity])
for (const minSupportDelta of [-Infinity, -6, -3, 0, 3])
for (const candidateOnly of [false, true])
for (const maxChanges of [1, 2]) {
  let correct = 0;
  let baselineCorrect = 0;
  let overrides = 0;
  let fixes = 0;
  let breaks = 0;
  const roundGain = new Map();
  for (const sample of devSamples) {
    const result = applyRule(sample, {
      confidence, margin, maxCurrentSupport, minSupportDelta, candidateOnly, maxChanges,
    });
    const before = sameCode(sample.actual, sample.expected);
    const after = sameCode(result.code, sample.expected);
    baselineCorrect += Number(before);
    correct += Number(after);
    if (result.replacements.length) overrides++;
    if (!before && after) fixes++;
    if (before && !after) breaks++;
    roundGain.set(sample.round, (roundGain.get(sample.round) || 0) + Number(after) - Number(before));
  }
  const gains = devRounds.map(round => roundGain.get(round) || 0);
  rules.push({
    confidence, margin, maxCurrentSupport, minSupportDelta, candidateOnly, maxChanges,
    correct, baselineCorrect, gain: correct - baselineCorrect, overrides, fixes, breaks,
    worstRoundGain: Math.min(...gains),
  });
}

rules.sort((a, b) => {
  return b.worstRoundGain - a.worstRoundGain
    || b.gain - a.gain
    || a.breaks - b.breaks
    || a.overrides - b.overrides;
});

for (const [index, rule] of rules.slice(0, 20).entries()) {
  console.log(
    `#${index + 1} dev=${rule.correct}/${devSamples.length} gain=${rule.gain} fixes=${rule.fixes} `
    + `breaks=${rule.breaks} overrides=${rule.overrides} worstRound=${rule.worstRoundGain} `
    + `confidence>=${rule.confidence} margin>=${rule.margin} currentSupport<=${rule.maxCurrentSupport} `
    + `supportDelta>=${rule.minSupportDelta} candidateOnly=${rule.candidateOnly} maxChanges=${rule.maxChanges}`
  );
}

const frozen = rules[0];
let baselineCorrect = 0;
let selectedCorrect = 0;
let fixes = 0;
let breaks = 0;
const changes = [];
for (const sample of testSamples) {
  const result = applyRule(sample, frozen);
  const before = sameCode(sample.actual, sample.expected);
  const after = sameCode(result.code, sample.expected);
  baselineCorrect += Number(before);
  selectedCorrect += Number(after);
  if (!before && after) fixes++;
  if (before && !after) breaks++;
  if (result.replacements.length) {
    changes.push(`${sample.key}:${normalize(sample.actual)}->${result.code}(${Number(after) - Number(before)})`);
  }
}
console.log('');
console.log(
  `Frozen holdout: ${baselineCorrect}/${testSamples.length} -> ${selectedCorrect}/${testSamples.length}, `
  + `fixes=${fixes}, breaks=${breaks}`
);
console.log(changes.join(', '));
