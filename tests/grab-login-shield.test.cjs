const assert = require('node:assert/strict');
const test = require('node:test');

const { createLoginShield, STATUS } = require('../grab-login-shield.js');

function createClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending() {
      return [...timers.entries()].map(([id, timer]) => ({ id, delay: timer.delay }));
    },
    fire(id) {
      const timer = timers.get(id);
      assert.ok(timer, `Timer ${id} should still be pending.`);
      timers.delete(id);
      timer.callback();
    }
  };
}

function createDocument() {
  const attributes = new Map();
  const properties = new Map();
  const elements = new Map([['loginDiv', { id: 'loginDiv' }]]);
  const documentElement = {
    style: {
      setProperty(name, value) {
        properties.set(name, value);
      },
      removeProperty(name) {
        properties.delete(name);
      }
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    }
  };
  return {
    attributes,
    properties,
    documentElement,
    head: {
      appendChild(element) {
        elements.set(element.id, element);
      }
    },
    createElement() {
      return { id: '', textContent: '' };
    },
    getElementById(id) {
      return elements.get(id) || null;
    }
  };
}

function createFixture() {
  const clock = createClock();
  const documentRef = createDocument();
  const observers = [];
  let authenticatedPage = false;
  const shield = createLoginShield({
    documentRef,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    MutationObserverCtor: class FakeMutationObserver {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() { this.disconnected = true; }
      notify() {
        if (!this.disconnected) this.callback([{ type: 'childList' }]);
      }
    },
    isAuthenticatedPage: () => authenticatedPage
  });
  return {
    clock,
    documentRef,
    shield,
    reachAuthenticatedPage() {
      authenticatedPage = true;
      observers.forEach(observer => observer.notify());
    }
  };
}

test('blocks the login panel synchronously and always releases the preparation lease', () => {
  const { clock, documentRef, shield } = createFixture();

  assert.equal(shield.show(STATUS.PREPARING, '准备自动登录...'), true);
  assert.equal(documentRef.documentElement.getAttribute('data-nju-ai-status'), STATUS.PREPARING);
  assert.match(documentRef.getElementById('nju-grab-ai-overlay-style').textContent, /pointer-events:\s*none\s*!important/);
  assert.match(documentRef.getElementById('nju-grab-ai-overlay-style').textContent, /prefers-reduced-motion:\s*reduce/);

  const [lease] = clock.pending();
  assert.equal(lease.delay, 3000);
  clock.fire(lease.id);
  assert.equal(documentRef.documentElement.hasAttribute('data-nju-ai-status'), false);
});

test('releases immediately when stored settings disable automatic login', () => {
  const { clock, documentRef, shield } = createFixture();

  shield.show(STATUS.PREPARING, '准备自动登录...');
  shield.resolveAutomation(false);

  assert.equal(documentRef.documentElement.hasAttribute('data-nju-ai-status'), false);
  assert.deepEqual(clock.pending(), []);
});

test('a submitted login has a bounded lease when the page does not navigate', () => {
  const { clock, documentRef, shield } = createFixture();

  shield.show(STATUS.SUCCESS, '登录已提交，等待验证...');
  const [lease] = clock.pending();

  assert.equal(lease.delay, 8000);
  clock.fire(lease.id);
  assert.equal(documentRef.documentElement.hasAttribute('data-nju-ai-status'), false);
  assert.equal(documentRef.properties.has('--nju-ai-msg'), false);
});

test('a newer shield state cancels the older lease instead of clearing early', () => {
  const { clock, documentRef, shield } = createFixture();

  shield.show(STATUS.PREPARING, '准备自动登录...');
  const [preparationLease] = clock.pending();
  shield.show(STATUS.LOADING, '识别验证码中...');

  assert.equal(clock.pending().some(timer => timer.id === preparationLease.id), false);
  const [recognitionLease] = clock.pending();
  assert.equal(recognitionLease.delay, 12000);
  clock.fire(recognitionLease.id);
  assert.equal(documentRef.documentElement.hasAttribute('data-nju-ai-status'), false);
});

test('a same-document transition to the round selector releases a submitted-login shield immediately', () => {
  const { clock, documentRef, shield, reachAuthenticatedPage } = createFixture();

  shield.show(STATUS.SUCCESS, '登录请求已提交，正在等待页面响应…');
  assert.equal(documentRef.documentElement.getAttribute('data-nju-ai-status'), STATUS.SUCCESS);

  reachAuthenticatedPage();

  assert.equal(documentRef.documentElement.hasAttribute('data-nju-ai-status'), false);
  assert.deepEqual(clock.pending(), []);
});
