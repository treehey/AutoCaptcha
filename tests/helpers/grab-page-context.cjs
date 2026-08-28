const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const contentSource = readFileSync(resolve(__dirname, '..', '..', 'content-grab.js'), 'utf8');
const roundDetectorStart = contentSource.indexOf('function isGrabRoundSelectionPage()');
const roundDetectorEnd = contentSource.indexOf('function isGrabAuthenticatedPage()');
assert.notEqual(roundDetectorStart, -1, 'round selector detector must exist');
assert.notEqual(roundDetectorEnd, -1, 'authenticated page detector must follow the round selector detector');
const roundDetectorSource = `${contentSource.slice(roundDetectorStart, roundDetectorEnd)}\n`
  + 'globalThis.__detectRoundSelectionPage = isGrabRoundSelectionPage;';

function createRoundSelectionPageDetector(documentRef, pathname) {
  const context = vm.createContext({
    document: documentRef,
    isVisibleGrabElement: () => true,
    location: { pathname }
  });
  context.globalThis = context;
  vm.runInContext(roundDetectorSource, context, { filename: 'content-grab-round-detector.js' });
  return context.__detectRoundSelectionPage;
}

module.exports = { createRoundSelectionPageDetector };
