import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');

const [html, source, authPresentationSource] = await Promise.all([
  read('popup.html'),
  read('popup.js'),
  read('grab-auth-presentation.js')
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
assert.match(html, /id="exactTargets"/, 'The popup must list exact teaching-class targets.');
assert.match(html, /id="courseGroups"/, 'The popup must expose course-group and priority controls.');
assert.match(html, /id="grabPageEnhancementsEnabled"/, 'All course-page enhancements must be optional and reversible from the popup.');
assert.match(html, /id="importFavoriteCoursesBtn"/, 'The popup must expose favorite-course import without requiring page enhancements.');
assert.match(html, /只导入当前已加载的教学班/, 'Favorite import must explain its visible-page scope.');
assert.match(html, /教师、时间和校区均为包含匹配/, 'Keyword filters must explain their AND and missing-metadata behavior.');
assert.match(html, /安全恢复：/, 'The popup must explain safe auth recovery before it is needed.');
assert.match(html, /连续失效或入口不可用则转人工/, 'The popup must explain when auth recovery hands over to the user.');
assert.doesNotMatch(html, /断网或掉线会自动恢复任务，无需人工干预/, 'The popup must not promise recovery without manual handoff conditions.');
assert.match(html, /浏览器重启后不会自行恢复真实提交/, 'The popup must make the high-risk restart behavior explicit.');
assert.match(html, /不会自动退掉保底课程/, 'Course-group help must explain the no-auto-withdraw safety rule.');
const featureGuideStart = html.indexOf('<section class="feature-guide"');
const featureGuideEnd = html.indexOf('</section>', featureGuideStart);
const featureGuideMarkup = html.slice(featureGuideStart, featureGuideEnd);
assert.match(featureGuideMarkup, /它能帮你做什么？/, 'The feature overview should start from the user\'s question.');
assert.match(featureGuideMarkup, /自动登录、识别验证码/, 'The feature overview should explain the main benefit in plain language.');
assert.match(featureGuideMarkup, /确认真的选上后才提示成功/, 'The feature overview must explain verified success without implementation jargon.');
assert.match(featureGuideMarkup, /只保存在你的浏览器中/, 'The feature overview should explain local storage in plain language.');
assert.doesNotMatch(featureGuideMarkup, /明确边界|原生流程|二次验证|检查点/, 'The feature overview should avoid internal implementation language.');
assert.doesNotMatch(html, /无感秒登|任何校内系统|毫秒内自动捡漏/, 'The feature overview must not overpromise unsupported sites or selection speed.');
assert.match(html, /<script src="grab-task-model\.js"><\/script>\s*<script src="grab-auth-presentation\.js"><\/script>\s*<script src="popup\.js"><\/script>/, 'Shared grab presentation modules must load before the popup controller.');
assert.match(html, /tabindex="-1"/, 'Inactive tabs need a roving tabindex.');
assert.match(source, /ArrowLeft', 'ArrowRight', 'Home', 'End/, 'Tabs must support keyboard navigation.');
assert.match(source, /closeContextualHelp/, 'Only one contextual help panel should remain open.');
assert.match(source, /event\.key !== 'Escape'/, 'Help panels must close with Escape.');
assert.match(source, /nju_grab_interval \|\| '5000'/, 'Five seconds should be the stored fallback interval.');
assert.match(source, /initialTargetCount/, 'Grab progress must use the immutable initial target count.');
assert.match(source, /globalRetryAt/, 'Global course-grab backoff must be visible in the popup.');
assert.match(source, /retryingTargetCount/, 'Per-target course-grab backoff must be visible in the popup.');
assert.match(source, /GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY/, 'The course-page enhancement preference must persist across reloads.');
assert.match(source, /data\[GRAB_PAGE_ENHANCEMENTS_ENABLED_KEY\] !== false/, 'Course-page enhancements should default on but respect an explicit opt-out.');
assert.match(source, /退避中/, 'The popup must explain a protected retry delay to the user.');
assert.match(source, /grabAuthPresentation\.present/, 'The popup must use the shared auth-recovery presentation model.');
assert.match(authPresentationSource, /PAUSED_AUTH/, 'The shared presentation model must recognize a paused auth-recovery task.');
assert.match(authPresentationSource, /MANUAL_REQUIRED/, 'The shared presentation model must expose manual takeover explicitly.');
assert.match(source, /authRecovery\?\.pending/, 'A task waiting for login must remain stoppable from the popup.');
assert.match(
  source,
  /const GRAB_ENTRY_URL = 'https:\/\/xk\.nju\.edu\.cn\/'/,
  'The popup must open the course-system entry so the site can initialize the current round.'
);
assert.doesNotMatch(
  source,
  /const GRAB_(?:ENTRY_)?URL = .*grablessons\.do/,
  'The popup must not bypass the course-round landing page with a hard-coded course URL.'
);
assert.match(
  source,
  /response\.state\.running \|\| response\.state\.authRecovery\?\.pending/,
  'The popup must prefer the tab that owns an active or login-recovering task.'
);
assert.match(source, /getConfiguredTargets/, 'The popup must start tasks from structured targets.');
assert.match(source, /taskConfig,/, 'The popup must send the canonical grouped task configuration to the page.');
assert.match(source, /updateCourseGroup/, 'The popup must persist course-group requirements.');
assert.match(source, /updateTargetPriority/, 'The popup must persist target priorities.');
assert.match(source, /updateTargetFilters/, 'The popup must persist keyword teacher, time, and campus filters.');
assert.match(source, /moveTargetToGroup/, 'The popup must support grouping fallback targets.');
assert.match(source, /TARGET_KIND\.TEACHING_CLASS/, 'The popup must distinguish exact teaching-class targets.');
assert.match(source, /action: 'importFavoriteCourses'/, 'Favorite import must go through the existing content-script seam.');
const applySnapshotSource = source.slice(
  source.indexOf('function applyGrabSnapshot'),
  source.indexOf('async function syncGrabStatus')
);
assert.doesNotMatch(
  applySnapshotSource,
  /courseNames\.value\s*=/,
  'Runtime snapshots must not rewrite the persisted target inputs.'
);
assert.match(
  source,
  /updateCourseCount\(\{ persist: false \}\)/,
  'Runtime snapshots must not overwrite the persisted course configuration.'
);
assert.match(
  source,
  /setIntervalValue\(state\.interval, \{ persist: false \}\)/,
  'Runtime snapshots must not rewrite the persisted polling interval.'
);

console.log('Popup help and accessibility contract verified.');
