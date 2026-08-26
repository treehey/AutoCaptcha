import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

const [manifestText, content, shield, buildScript] = await Promise.all([
  read('manifest.json'),
  read('content-grab.js'),
  read('grab-login-shield.js'),
  read('scripts/build-package.ps1')
]);
const manifest = JSON.parse(manifestText);
const courseScripts = manifest.content_scripts
  .find(entry => entry.matches?.includes('https://xk.nju.edu.cn/*') && entry.world !== 'MAIN')
  ?.js || [];

assert.ok(courseScripts.includes('grab-login-shield.js'), 'The course page must load the bounded login shield.');
assert.ok(
  courseScripts.indexOf('grab-login-shield.js') < courseScripts.indexOf('content-grab.js'),
  'The shield controller must load before the course content script.'
);
assert.match(buildScript, /'grab-login-shield\.js'/, 'Release packages must contain the shield controller.');
assert.match(shield, /\[STATUS\.PREPARING\]: 3000/, 'Preparation must have a short bounded lease.');
assert.match(shield, /\[STATUS\.SUCCESS\]: 8000/, 'Submitted login must release even when navigation stalls.');
assert.match(shield, /pointer-events:\s*none\s*!important/, 'The login panel must be blocked during automation.');
assert.match(shield, /prefers-reduced-motion:\s*reduce/, 'The shield must respect reduced-motion preferences.');

const immediateShield = content.indexOf("grabLoginShield.show(GRAB_LOGIN_SHIELD_STATUS.PREPARING");
const settingsRead = content.indexOf('async function initializeClickCaptchaSolver()');
assert.ok(immediateShield >= 0 && immediateShield < settingsRead, 'The login panel must be blocked before asynchronous settings are read.');
assert.match(
  content,
  /grabLoginShield\.resolveAutomation\(clickCaptchaSolver\.enabled && clickCaptchaSolver\.autoClick\)/,
  'Stored settings must release the preparation shield when automation is disabled.'
);
assert.match(content, /if \(!enabled\) grabLoginShield\.clear\(\)/, 'Turning off automatic clicking must release the shield.');
assert.match(content, /if \(enabled\) grabLoginShield\.clear\(\)/, 'Manual sampling must release the shield.');
assert.match(
  content,
  /grabLoginShield\.show\(GRAB_LOGIN_SHIELD_STATUS\.SUCCESS, '登录请求已提交，正在等待页面响应…'\)/,
  'A submitted request must use the bounded success state without claiming login verification.'
);

console.log('Click-captcha login shield wiring verified.');
