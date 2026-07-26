import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

const [manifestText, content, worker, fixture] = await Promise.all([
  read('manifest.json'),
  read('content-grab.js'),
  read('click-captcha-worker.js'),
  read('tests/click-captcha-worker.html')
]);
const manifest = JSON.parse(manifestText);
const workerResources = manifest.web_accessible_resources
  .flatMap(entry => entry.resources || []);

for (const resource of [
  'click-captcha-worker.js',
  'assets/click-captcha-model.onnx',
  'assets/click-captcha-background.png',
  'vendor/onnxruntime/ort.wasm.bundle.min.js',
  'vendor/onnxruntime/ort-wasm-simd-threaded.mjs',
  'vendor/onnxruntime/ort-wasm-simd-threaded.wasm'
]) {
  if (!workerResources.includes(resource)) {
    throw new Error(`Click-captcha runtime resource is not web accessible: ${resource}`);
  }
  await access(path.join(root, resource));
}

if (!/const CLICK_CAPTCHA_AUTO_MARGIN = 0\.4/.test(content)
  || !/const CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL = 12/.test(content)
  || !/result\.margin >= CLICK_CAPTCHA_AUTO_MARGIN/.test(content)
  || !/result\.backgroundResidual <= CLICK_CAPTCHA_MAX_BACKGROUND_RESIDUAL/.test(content)) {
  throw new Error('The calibrated confidence gate is missing from automatic click handling.');
}

if (!/if \(clickCaptchaCapture\.enabled\)/.test(content)
  || !/采样进行中，识别已暂停/.test(content)) {
  throw new Error('Click-captcha recognition must yield to the sampler.');
}

if (!/prepareFourTargetClickCaptchaForSolver/.test(content)
  || !/requestFreshClickCaptcha\(current\)/.test(content)) {
  throw new Error('The solver must refresh three-target challenges before inference.');
}

if (!/frame\.width !== CLICK_CAPTCHA_REFERENCE_WIDTH/.test(content)
  || !/frame\.height !== CLICK_CAPTCHA_REFERENCE_HEIGHT/.test(content)) {
  throw new Error('Automatic clicks must reject an unknown captcha frame size.');
}

if (!/function createClickCaptchaWorker\(\)/.test(content)
  || !/import \$\{JSON\.stringify\(workerModuleUrl\)\};/.test(content)
  || !/new Worker\(bootstrapUrl, \{ type: 'module' \}\)/.test(content)
  || !/executionProviders: \['wasm'\]/.test(worker)
  || !/message\.renderer === 'custom' \? 'custom' : 'canvas'/.test(worker)) {
  throw new Error('The local Canvas + WASM click-captcha Worker bootstrap is incomplete.');
}

if (!/new Blob\(\[/.test(fixture)
  || !/new Worker\(workerBootstrapUrl, \{ type: 'module' \}\)/.test(fixture)) {
  throw new Error('The browser fixture must exercise the content-script Worker bootstrap.');
}

if (!/message\.type === 'error' && !message\.requestId/.test(content)
  || !/点击验证码模型初始化失败/.test(content)) {
  throw new Error('Worker initialization failures must not leave the UI waiting indefinitely.');
}

if (!/autoClickToken/.test(content)
  || !/自动点击已取消/.test(content)
  || !/attemptedFingerprint/.test(content)) {
  throw new Error('Automatic clicks must be cancellable and failed frames must not restart continuously.');
}

if (!/calculateBackgroundResidual/.test(worker)
  || !/backgroundResidual/.test(worker)) {
  throw new Error('The solver must expose its fixed-background compatibility metric.');
}

if (/\bhttps?:\/\//.test(worker)) {
  throw new Error('The click-captcha Worker must not fetch remote runtime code or data.');
}

console.log('Click-captcha solver wiring verified.');
