import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

const [popupHtml, popupSource, authSource, grabSource] = await Promise.all([
  read('popup.html'),
  read('popup.js'),
  read('content.js'),
  read('content-grab.js')
]);

assert.match(
  popupHtml,
  /id="captchaTools" hidden/,
  'The low-frequency captcha test panel must be hidden until the current page opts in.'
);
assert.match(
  popupSource,
  /mode === 'legacy-ocr' \|\| mode === 'click-mark'/,
  'Only legacy OCR and manual click-marking contexts may expose the test panel.'
);
assert.match(
  popupSource,
  /sendActiveTabMessage\(\{ action: 'runClickCaptchaSolver' \}\)/,
  'Manual marking must act on the active course-selection tab.'
);
assert.match(
  popupSource,
  /识别并标点/,
  'Course-selection manual recognition must explain that it marks points.'
);
assert.match(
  authSource,
  /mode: sliderCaptcha \? 'slider' : 'legacy-ocr'/,
  'The unified-auth page must distinguish slider verification from legacy OCR.'
);
assert.match(
  grabSource,
  /const loginContext = target && findClickCaptchaLoginContext\(target\);/,
  'The course-selection manual action must require a live login form.'
);
assert.match(
  grabSource,
  /mode: ready \? 'click-mark' : 'none'/,
  'Course monitor pages must not expose manual click-captcha marking.'
);

console.log('Contextual captcha-test controls verified.');
