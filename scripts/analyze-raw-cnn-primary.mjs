import { readFile } from 'node:fs/promises';

const [regressionPath, predictionsPath] = process.argv.slice(2);
if (!regressionPath || !predictionsPath) {
  throw new Error('Usage: node scripts/analyze-raw-cnn-primary.mjs <regression.json> <predictions.json>');
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

const normalize = value => (value || '').toLowerCase();

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

function support(sample, position, label) {
  const target = normalize(label);
  return (sample.candidates || []).reduce((sum, candidate) => {
    const code = normalize(candidate.code);
    if (code.length !== 4 || code[position] !== target) return sum;
    return sum + (VARIANT_WEIGHT[candidate.variant] || 1)
      + Math.max(0, candidate.confidence || 0) / 25;
  }, 0);
}

function buildSamples(regression, predictionRows) {
  const predictions = groupPredictions(predictionRows);
  const output = [];
  for (const [key, chars] of predictions) {
    const ocr = regression.get(key);
    if (!ocr || normalize(ocr.actual).length !== 4 || chars.some(item => !item)) continue;
    output.push({ key, ocr, chars });
  }
  return output;
}

function applyRule(sample, rule) {
  const ocrCode = normalize(sample.ocr.actual);
  const output = sample.chars.map(item => normalize(item.predicted));
  const fallbacks = [];
  const candidates = sample.chars.map((item, position) => {
    const cnn = normalize(item.predicted);
    const ocr = ocrCode[position];
    const ceProtected = rule.protectFirstCE
      && position === 0
      && new Set([cnn, ocr]).size === 2
      && [cnn, ocr].every(char => char === 'c' || char === 'e');
    return {
      position,
      cnn,
      ocr,
      confidence: item.confidence,
      support: support(sample.ocr, position, ocr),
      shouldFallback: cnn !== ocr
        && (ceProtected || item.confidence < rule.confidence)
        && support(sample.ocr, position, ocr) >= rule.minOcrSupport,
      ceProtected,
    };
  }).filter(item => item.shouldFallback)
    .sort((a, b) => {
      if (a.ceProtected !== b.ceProtected) return Number(b.ceProtected) - Number(a.ceProtected);
      return a.confidence - b.confidence;
    })
    .slice(0, rule.maxFallbacks);
  for (const item of candidates) {
    output[item.position] = item.ocr;
    fallbacks.push(item);
  }
  return { code: output.join(''), fallbacks };
}

function evaluate(samples, rule) {
  let correct = 0;
  let directCorrect = 0;
  let changes = 0;
  const roundGain = new Map();
  const details = [];
  for (const sample of samples) {
    const expected = normalize(sample.ocr.expected);
    const direct = sample.chars.map(item => normalize(item.predicted)).join('');
    const result = applyRule(sample, rule);
    const before = direct === expected;
    const after = result.code === expected;
    directCorrect += Number(before);
    correct += Number(after);
    if (result.fallbacks.length) changes++;
    roundGain.set(sample.ocr.round, (roundGain.get(sample.ocr.round) || 0) + Number(after) - Number(before));
    if (result.fallbacks.length) {
      details.push(`${sample.key}:${direct}->${result.code}(${Number(after) - Number(before)})`);
    }
  }
  return {
    correct,
    directCorrect,
    gain: correct - directCorrect,
    changes,
    worstRound: Math.min(...roundGain.values()),
    details,
  };
}

const regression = mapRegression(JSON.parse(await readFile(regressionPath, 'utf8')));
const predictionData = JSON.parse(await readFile(predictionsPath, 'utf8'));
const dev = buildSamples(regression, predictionData.devPredictions);
const holdout = buildSamples(regression, predictionData.predictions);
const rules = [];
for (const protectFirstCE of [true, false])
for (const confidence of [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99])
for (const minOcrSupport of [0, 2, 4, 6, 8])
for (const maxFallbacks of [1, 2, 4]) {
  const rule = { protectFirstCE, confidence, minOcrSupport, maxFallbacks };
  rules.push({ ...rule, ...evaluate(dev, rule) });
}
rules.sort((a, b) => {
  return b.worstRound - a.worstRound
    || b.correct - a.correct
    || a.changes - b.changes
    || b.confidence - a.confidence;
});
for (const [index, rule] of rules.slice(0, 15).entries()) {
  console.log(
    `#${index + 1} dev=${rule.correct}/${dev.length} direct=${rule.directCorrect} gain=${rule.gain} `
    + `worstRound=${rule.worstRound} changes=${rule.changes} protectCE=${rule.protectFirstCE} `
    + `confidence<${rule.confidence} ocrSupport>=${rule.minOcrSupport} maxFallbacks=${rule.maxFallbacks}`
  );
}
const frozen = rules[0];
const result = evaluate(holdout, frozen);
console.log('');
console.log(
  `Frozen holdout=${result.correct}/${holdout.length} direct=${result.directCorrect} gain=${result.gain}`
);
console.log(result.details.join(', '));
