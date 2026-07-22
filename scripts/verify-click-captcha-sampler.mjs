import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourcePath = path.resolve(__dirname, '..', 'content-grab.js');
const source = await readFile(sourcePath, 'utf8');
const start = source.indexOf('async function saveClickCaptchaSample()');
const end = source.indexOf('async function setClickCaptchaCaptureEnabled(', start);

if (start < 0 || end < 0) {
  throw new Error('Could not locate click-captcha sample completion flow.');
}

const completionFlow = source.slice(start, end);
if (!/await storageSet\(\{[\s\S]*?CLICK_CAPTCHA_SAMPLE_COUNT_KEY[\s\S]*?\}\);[\s\S]*?clickCaptchaCapture\.enabled = false;[\s\S]*?refreshClickCaptchaAndResume\(id\)/.test(completionFlow)) {
  throw new Error('Saved samples must pause capture before refreshing and rearm only through the refresh flow.');
}

if (!/document\.querySelector\('\.verify-refresh'\)/.test(source) || !/CVVerifyCode briefly clears and redraws the same canvas/.test(source)) {
  throw new Error('Click-captcha refresh must prioritize the verified page refresh control and wait for canvas redraw stability.');
}

if (!/CLICK_CAPTCHA_REQUIRED_TARGET_COUNT = 4/.test(source)
  || !/async function ensureFourTargetClickCaptcha\(target\)/.test(source)
  || !/CLICK_CAPTCHA_MAX_TARGET_REFRESH_ATTEMPTS/.test(source)) {
  throw new Error('Click-captcha capture must refresh three-target challenges before rearming.');
}

if (!/refreshClickCaptchaAndResume[\s\S]*?ensureFourTargetClickCaptcha\(refreshedTarget\)/.test(source)
  || !/setClickCaptchaCaptureEnabled[\s\S]*?ensureFourTargetClickCaptcha\(target\)/.test(source)) {
  throw new Error('Both initial capture and post-save refresh must enforce four-target challenges.');
}

if (!/recordSkippedThreeTargetCaptcha\(\)/.test(source)
  || !/skippedThreeTargetCount/.test(source)) {
  throw new Error('Skipped three-target challenges must be counted for evaluation.');
}

if (!/if \(source\.targetCount !== CLICK_CAPTCHA_REQUIRED_TARGET_COUNT\)/.test(source)
  || !/expectedClicks: CLICK_CAPTCHA_REQUIRED_TARGET_COUNT/.test(source)) {
  throw new Error('A canvas changed after capture starts must not produce a three-target sample.');
}

console.log('Click-captcha sampler completion guard verified.');
