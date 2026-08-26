import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

const [html, source] = await Promise.all([
  read('popup.html'),
  read('popup.js')
]);

assert.match(html, /id="featureGuideBtn"/, 'The popup must expose a global feature guide.');
assert.match(html, /data-help-target="help-auth-login"/, 'Unified-auth login needs contextual help.');
assert.match(html, /data-help-target="help-auth-prewarm"/, 'Prewarm needs contextual help.');
assert.match(html, /data-help-target="help-course-login"/, 'Course-system login needs contextual help.');
assert.match(html, /data-help-target="help-course-names"/, 'Course-name matching needs contextual help.');
assert.match(html, /data-help-target="help-grab-interval"/, 'Refresh interval needs contextual help.');
assert.match(html, /提前准备统一认证/, 'The prewarm control should use user-facing language.');
assert.match(html, /value="5000" selected/, 'Five seconds should be the visible default interval.');
assert.match(html, /id="grabSteps"/, 'Disconnected course monitoring needs a guided next step.');
assert.match(html, /tabindex="-1"/, 'Inactive tabs need a roving tabindex.');
assert.match(source, /ArrowLeft', 'ArrowRight', 'Home', 'End/, 'Tabs must support keyboard navigation.');
assert.match(source, /closeContextualHelp/, 'Only one contextual help panel should remain open.');
assert.match(source, /event\.key !== 'Escape'/, 'Help panels must close with Escape.');
assert.match(source, /nju_grab_interval \|\| '5000'/, 'Five seconds should be the stored fallback interval.');

console.log('Popup help and accessibility contract verified.');
