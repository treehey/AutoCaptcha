import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(relativePath) {
  const content = await readFile(path.join(repoRoot, relativePath), 'utf8');
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

async function collectMarkdown(directory, options = {}) {
  const results = [];
  if (!(await exists(directory))) return results;

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectMarkdown(fullPath, options));
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      if (!options.readmeOnly || entry.name.toLowerCase() === 'readme.md') results.push(fullPath);
    }
  }
  return results;
}

function contentOutsideCodeFences(content) {
  let fenced = false;
  return content.split(/\r?\n/).map(line => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  }).join('\n');
}

function normalizeLinkTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  if (/\s+["']/.test(target)) target = target.split(/\s+["']/, 1)[0];
  return target;
}

function isExternalOrAnchor(target) {
  return !target
    || target.startsWith('#')
    || /^[a-z][a-z0-9+.-]*:/i.test(target)
    || target.startsWith('//');
}

async function verifyMarkdownLinks(markdownFiles) {
  const failures = [];
  const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  const htmlLinkPattern = /\b(?:href|src)=["']([^"']+)["']/gi;

  for (const file of markdownFiles) {
    const content = contentOutsideCodeFences(await readFile(file, 'utf8'));
    const targets = [
      ...Array.from(content.matchAll(markdownLinkPattern), match => match[1]),
      ...Array.from(content.matchAll(htmlLinkPattern), match => match[1])
    ];

    for (const rawTarget of targets) {
      const target = normalizeLinkTarget(rawTarget);
      if (isExternalOrAnchor(target)) continue;
      const pathPart = target.split('#', 1)[0];
      let decoded;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        failures.push(`${path.relative(repoRoot, file)} -> invalid URL encoding: ${target}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), decoded);
      if (!(await exists(resolved))) {
        failures.push(`${path.relative(repoRoot, file)} -> ${target}`);
      }
    }
  }

  assert.equal(failures.length, 0, `Broken local Markdown links:\n${failures.join('\n')}`);
}

const requiredFiles = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'PRIVACY.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/README.md',
  'docs/user-guide.md',
  'docs/troubleshooting.md',
  'docs/architecture.md',
  'docs/development.md',
  'docs/testing.md',
  'docs/releasing.md',
  'docs/benchmarks.md',
  'data/README.md'
];

for (const relativePath of requiredFiles) {
  assert.equal(await exists(path.join(repoRoot, relativePath)), true, `Missing required file: ${relativePath}`);
}

const rootEntries = await readdir(repoRoot);
assert(rootEntries.includes('README.md'), 'The canonical README.md filename is required');
assert(!rootEntries.includes('readme.md'), 'Use README.md, not readme.md');

const manifest = await readJson('manifest.json');
const packageJson = await readJson('package.json');
await readJson('_locales/zh_CN/messages.json');
await readJson('_locales/en/messages.json');

assert.equal(manifest.manifest_version, 3, 'Only Manifest V3 is supported');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'Manifest version must use x.y.z');
assert.equal(packageJson.version, manifest.version, 'package.json and manifest.json versions must match');
assert.equal(packageJson.private, true, 'package.json must remain private');

const escapedVersion = manifest.version.replaceAll('.', '\\.');
const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
assert.match(
  changelog,
  new RegExp(`^## v${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
  `CHANGELOG.md must contain a dated v${manifest.version} heading`
);
const releaseNotesRelativePath = `docs/RELEASE_NOTES_v${manifest.version}.md`;
const releaseNotesPath = path.join(repoRoot, releaseNotesRelativePath);
assert.equal(await exists(releaseNotesPath), true, `Missing current release notes: ${releaseNotesRelativePath}`);
const releaseNotes = await readFile(releaseNotesPath, 'utf8');
assert.match(
  releaseNotes,
  new RegExp(`^# NJU Login Pro v${escapedVersion}$`, 'm'),
  `Current release notes must be titled NJU Login Pro v${manifest.version}`
);
assert.match(
  releaseNotes,
  new RegExp(`NJU-Login-Pro-v${escapedVersion}\\.zip`),
  `Current release notes must name NJU-Login-Pro-v${manifest.version}.zip`
);
const docsIndex = await readFile(path.join(repoRoot, 'docs', 'README.md'), 'utf8');
assert.match(
  docsIndex,
  new RegExp(`\\[v${escapedVersion}\\]\\(RELEASE_NOTES_v${escapedVersion}\\.md\\)`),
  `docs/README.md must link the v${manifest.version} release notes`
);

const declaredPermissions = new Set(manifest.permissions || []);
for (const permission of ['cookies', 'history', 'offscreen', 'tabs', 'unlimitedStorage']) {
  assert(!declaredPermissions.has(permission), `Unexpected sensitive permission: ${permission}`);
}
assert(!new Set(manifest.host_permissions || []).has('<all_urls>'), 'Host permissions must not include <all_urls>');

const referencedRuntimeFiles = new Set([
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...manifest.content_scripts.flatMap(entry => entry.js || []),
  ...manifest.content_scripts.flatMap(entry => entry.css || []),
  ...manifest.web_accessible_resources.flatMap(entry => entry.resources || [])
].filter(Boolean));

for (const relativePath of referencedRuntimeFiles) {
  assert.equal(
    await exists(path.join(repoRoot, relativePath)),
    true,
    `Manifest references a missing runtime file: ${relativePath}`
  );
}

const packageScript = await readFile(path.join(repoRoot, 'scripts', 'build-package.ps1'), 'utf8');
const packageEntries = new Set(Array.from(
  packageScript.matchAll(/^\s*'([^']+)'\s*,?\s*$/gm),
  match => match[1].replaceAll('\\', '/')
));
for (const relativePath of referencedRuntimeFiles) {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  const packaged = packageEntries.has(normalizedPath)
    || [...packageEntries].some(entry => normalizedPath.startsWith(`${entry}/`));
  assert.equal(packaged, true, `Manifest runtime file is missing from the package whitelist: ${relativePath}`);
}

const rootMarkdown = rootEntries
  .filter(name => name.toLowerCase().endsWith('.md'))
  .map(name => path.join(repoRoot, name));
const markdownFiles = [
  ...rootMarkdown,
  ...await collectMarkdown(path.join(repoRoot, 'docs')),
  ...await collectMarkdown(path.join(repoRoot, '.github')),
  path.join(repoRoot, 'data', 'README.md'),
  path.join(repoRoot, 'data', 'captcha-samples', 'README.md'),
  ...await collectMarkdown(path.join(repoRoot, 'vendor'))
];

await verifyMarkdownLinks([...new Set(markdownFiles)]);

console.log(`Repository verification passed (${new Set(markdownFiles).size} Markdown files, ${referencedRuntimeFiles.size} manifest resources).`);
