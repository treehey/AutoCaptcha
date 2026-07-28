import assert from 'node:assert/strict';
import { webcrypto, createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

const [runtimeSource, contentSource, manifestText, buildScript] = await Promise.all([
  read('auth-slider-captcha.js'),
  read('content.js'),
  read('manifest.json'),
  read('scripts/build-package.ps1')
]);

const sandbox = {
  console,
  Uint8Array,
  Uint8ClampedArray,
  Uint32Array,
  Float32Array,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  Blob,
  Math,
  Date,
  Error,
  Number,
  String,
  Array,
  Object,
  Promise,
  crypto: webcrypto,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
  setTimeout,
  performance: { now: () => 0 },
  location: { origin: 'https://authserver.nju.edu.cn' }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(runtimeSource, sandbox, { filename: 'auth-slider-captcha.js' });
const runtime = sandbox.NjuAuthSliderCaptcha;
assert.ok(runtime, 'The auth slider runtime must expose a content-script module.');
assert.match(runtimeSource, /const MIN_VERIFY_DELAY_MS = 1700;/);
assert.match(runtimeSource, /const MAX_VERIFY_DELAY_MS = 1820;/);

function image(width, height, fill = 32) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = fill;
    data[offset + 1] = fill;
    data[offset + 2] = fill;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

function setPixel(frame, x, y, value, alpha = 255) {
  const offset = (y * frame.width + x) * 4;
  frame.data[offset] = value;
  frame.data[offset + 1] = value;
  frame.data[offset + 2] = value;
  frame.data[offset + 3] = alpha;
}

const background = image(160, 90, 34);
const piece = image(48, 90, 0);
for (let offset = 3; offset < piece.data.length; offset += 4) piece.data[offset] = 0;
const expectedLeft = 91;
const pieceLeft = 8;
const pieceTop = 23;
const pieceWidth = 28;
const pieceHeight = 27;
for (let y = 0; y < pieceHeight; y++) {
  for (let x = 0; x < pieceWidth; x++) {
    const value = (x * 37 + y * 53 + ((x + y) % 5) * 31) % 256;
    setPixel(piece, pieceLeft + x, pieceTop + y, value, 255);
    setPixel(background, expectedLeft + x, pieceTop + y, value, 255);
  }
}
const match = runtime.locateGapFromImageData(background, piece);
assert.equal(match.left, expectedLeft, 'The matcher must find the exact synthetic gap position.');
assert.ok(match.confidence > 0.7, 'The exact synthetic match must have a strong confidence score.');
assert.ok(match.margin > 0.2, 'The exact synthetic match must be clearly separated from alternatives.');

const parsed = runtime.parseChallengePayload({
  bigImage: Buffer.from([1, 2, 3]).toString('base64'),
  smallImage: Buffer.concat([Buffer.from([4, 5, 6]), Buffer.from('0123456789abcdef')]).toString('base64')
});
assert.deepEqual([...parsed.backgroundBytes], [1, 2, 3]);
assert.deepEqual([...parsed.pieceBytes], [4, 5, 6]);
assert.equal(parsed.key, '0123456789abcdef');

const payload = JSON.stringify({ canvasLength: 280, moveLength: 123, tracks: [{ a: 0, b: 0, c: 0 }] });
const key = '0123456789abcdef';
const encrypted = await runtime.encryptForPage(payload, key);
const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.alloc(16));
const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
assert.equal(decrypted.subarray(64).toString('utf8'), payload, 'The server-visible payload must match the page AES format after its random prefix.');

const tracks = runtime.__test.generateTracks(132);
assert.equal(tracks[0].a, 0);
assert.equal(tracks.at(-1).a, 132);
assert.ok(tracks.every(track => Number.isInteger(track.a) && Number.isInteger(track.b) && Number.isInteger(track.c)));

const manifest = JSON.parse(manifestText);
const authEntries = manifest.content_scripts.filter(entry => entry.matches.includes('https://authserver.nju.edu.cn/*'));
const authFastEntry = authEntries.find(entry => entry.js.includes('auth-slider-captcha.js'));
const authControllerEntry = authEntries.find(entry => entry.js.includes('content.js'));
assert.ok(authFastEntry, 'The auth slider runtime must be injected on authserver pages.');
assert.equal(authFastEntry.run_at, 'document_start', 'The slider runtime must start before the page reaches document_idle.');
assert.ok(authControllerEntry, 'The auth login controller must be injected on authserver pages.');
assert.equal(authControllerEntry.run_at, 'document_idle', 'The legacy controller must wait until the form is available.');
assert.match(buildScript, /'auth-slider-captcha\.js'/, 'The release package must include the auth slider runtime.');
assert.match(
  contentSource,
  /querySelectorAll\(['"]form#pwdFromId['"]\)/,
  'The login controller must enumerate duplicate password-form IDs used by the live authserver page.'
);
assert.match(
  contentSource,
  /getClientRects\(\)\.length/,
  'The login controller must select the form that is actually rendered, including ancestor visibility.'
);
assert.match(contentSource, /function checkAuthserverNeedsCaptcha\(username\)/);
assert.match(contentSource, /function submitPasswordLoginContext\(context\)/);
assert.match(contentSource, /HTMLFormElement\.prototype\.submit\.call\(context\.form\)/);
assert.match(contentSource, /solveSliderAuthentication\(settings, passwordLoginContext\)/);
assert.match(contentSource, /openManualSliderFallback\(context/);
assert.doesNotMatch(
  contentSource,
  /AUTH_SLIDER_SUBMIT_GUARD|hasRecentSliderSubmit|rememberSliderSubmit/,
  'A cross-navigation session lock must not prevent a fresh login attempt after returning to authserver.'
);
assert.match(
  contentSource,
  /function isAuthserverLoginPage\(\)/,
  'The auth controller must explicitly distinguish the login route from post-login authserver pages.'
);
assert.match(
  contentSource,
  /if \(isAuthserverLoginPage\(\)\) \{[\s\S]*?void solveCaptcha\(\);/,
  'Automatic login must start immediately and only on the authserver login route.'
);

console.log('Auth slider captcha runtime verified.');
