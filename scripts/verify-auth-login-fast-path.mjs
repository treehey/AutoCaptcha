import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

const [manifestText, fastSource, contentSource, buildScript] = await Promise.all([
  read('manifest.json'),
  read('auth-login-fast.js').catch(() => ''),
  read('content.js'),
  read('scripts/build-package.ps1')
]);

const manifest = JSON.parse(manifestText);
const authEntries = manifest.content_scripts.filter(entry => entry.matches.includes('https://authserver.nju.edu.cn/*'));
const fastEntry = authEntries.find(entry => entry.js.includes('auth-login-fast.js'));

assert.ok(fastEntry, 'Authserver must have a dedicated fast-login content-script entry.');
assert.equal(fastEntry.run_at, 'document_start', 'Fast login must start before document_idle.');
assert.deepEqual(
  fastEntry.js,
  ['auth-slider-captcha.js', 'auth-login-fast.js'],
  'The fast entry must only load the slider runtime and lightweight controller.'
);
assert.match(fastSource, /function checkAuthserverNeedsCaptcha\(username\)/);
assert.match(fastSource, /await sliderRuntime\.solve\(/);
assert.match(fastSource, /new (?:global\.)?MutationObserver/);
assert.match(fastSource, /function waitForSliderCaptchaPage\(\)/);
assert.match(fastSource, /const needsCaptchaPromise = checkAuthserverNeedsCaptcha\(username\)/);
assert.match(fastSource, /getResult\(\)/);
assert.match(
  contentSource,
  /consumeFastAuthLogin\(settings, passwordLoginContext\)/,
  'The document_idle controller must consume the already-started fast login result.'
);
assert.match(
  contentSource,
  /function shouldPrewarmLegacyCaptchaRuntime\(\)/,
  'The slider page must skip unused legacy OCR/CNN warmup.'
);
assert.match(buildScript, /'auth-login-fast\.js'/, 'The release package must include the fast-login controller.');

console.log('Auth fast-login startup wiring verified.');
