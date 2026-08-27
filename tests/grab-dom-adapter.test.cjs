const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const grabTaskModel = require('../grab-task-model.js');
const grabAuthPresentation = require('../grab-auth-presentation.js');
const grabVerificationEngine = require('../grab-verification-engine.js');

const contentSource = readFileSync(resolve(__dirname, '..', 'content-grab.js'), 'utf8');
const pageUiSource = readFileSync(resolve(__dirname, '..', 'grab-page-ui.css'), 'utf8');
const adapterSource = contentSource.slice(0, contentSource.indexOf('const grabEngine ='));
const domUiSource = contentSource.slice(contentSource.indexOf('// DOM UI Interactions'));

function dataKey(attributeName) {
  return attributeName.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function matchesSimple(element, selector) {
  const value = selector.trim();
  if (!value) return false;
  if (value.startsWith('.')) return element.classes.has(value.slice(1));
  const attribute = value.match(/^\[([^=*\]]+)\]$/);
  if (attribute) return element.getAttribute(attribute[1]) !== null;
  const contains = value.match(/^\[class\*="([^"]+)"\]$/);
  if (contains) return [...element.classes].some(name => name.includes(contains[1]));
  return element.tagName.toLowerCase() === value.toLowerCase();
}

function matchesSelector(element, selector) {
  return selector.split(',').some(part => matchesSimple(element, part.trim().split(/\s+/).at(-1)));
}

class FakeElement {
  constructor(tagName, { classes = [], attributes = {}, text = '', children = [] } = {}) {
    this.tagName = tagName.toUpperCase();
    this.classes = new Set(classes);
    this.attributes = new Map(Object.entries(attributes).map(([key, value]) => [key.toLowerCase(), String(value)]));
    this.ownText = text;
    this.children = [];
    this.parentElement = null;
    this.nextElementSibling = null;
    this.listeners = new Map();
    this.style = {};
    this.disabled = false;
    this.isConnected = true;
    this.offsetParent = {};
    this.classList = {
      contains: name => this.classes.has(name),
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      toggle: (name, force) => {
        const enabled = typeof force === 'boolean' ? force : !this.classes.has(name);
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        return enabled;
      }
    };
    for (const child of children) this.append(child);
  }

  append(...children) {
    for (const child of children) {
      const previous = this.children.at(-1);
      if (previous) previous.nextElementSibling = child;
      child.parentElement = this;
      child.previousElementSibling = previous || null;
      this.children.push(child);
    }
  }

  appendChild(child) { this.append(child); return child; }

  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value || '').split(/\s+/).filter(Boolean)); }

  addEventListener(type, listener) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  click() {
    for (const listener of this.listeners.get('click') || []) {
      listener({ target: this, preventDefault() {}, stopPropagation() {} });
    }
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.ownText = '';
    this.children = [];
    if (!String(value).includes('data-nju-grab-remove-confirm')) return;
    const leftResize = new FakeElement('div', { classes: ['nju-grab-resize-handle-l'], attributes: { 'data-resize': 'left' } });
    const head = new FakeElement('div', { classes: ['nju-grab-status-head'] });
    const toggle = new FakeElement('button', { classes: ['nju-grab-status-toggle'], attributes: { 'data-nju-grab-status-toggle': '' } });
    const control = new FakeElement('button', { attributes: { 'data-nju-grab-control': '' } });
    const mini = new FakeElement('button', { classes: ['nju-grab-minimize-btn'], attributes: { 'data-nju-grab-mini': '', 'aria-label': '收起为胶囊', 'aria-pressed': 'false' } });
    const close = new FakeElement('button', { attributes: { 'data-nju-grab-status-close': '' } });
    head.append(toggle, control, mini, close);
    const body = new FakeElement('div', { classes: ['nju-grab-status-body'], attributes: { 'data-nju-grab-status-body': '' } });
    body.append(
      new FakeElement('strong', { attributes: { 'data-nju-grab-status-title': '' } }),
      new FakeElement('span', { attributes: { 'data-nju-grab-status-subtitle': '' } })
    );
    for (const key of ['progress', 'round', 'channel']) body.append(new FakeElement('span', { attributes: { [`data-nju-grab-status-${key}`]: '' } }));
    const targets = new FakeElement('div', { classes: ['nju-grab-status-targets'], attributes: { 'data-nju-grab-status-targets': '' } });
    const confirm = new FakeElement('div', { classes: ['nju-grab-remove-confirm'], attributes: { 'data-nju-grab-remove-confirm': '' } });
    confirm.hidden = true;
    confirm.append(
      new FakeElement('span', { attributes: { 'data-nju-grab-remove-message': '' }, text: '移除目标需要先停止全部监控。' }),
      new FakeElement('button', { attributes: { 'data-nju-grab-remove-cancel': '' }, text: '取消' }),
      new FakeElement('button', { attributes: { 'data-nju-grab-remove-stop': '' }, text: '停止并移除' })
    );
    body.append(new FakeElement('div', { classes: ['nju-grab-missing-scopes'], attributes: { 'data-nju-grab-missing-scopes': '' } }));
    body.append(targets, confirm);
    this.append(leftResize, head, body);
  }

  get innerHTML() { return this._innerHTML || ''; }

  replaceChildren(...children) {
    this.children = [];
    for (const child of children) this.append(child);
  }

  remove() {
    this.isConnected = false;
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index < 0) return;
    siblings.splice(index, 1);
    const previous = siblings[index - 1] || null;
    const next = siblings[index] || null;
    if (previous) previous.nextElementSibling = next;
    if (next) next.previousElementSibling = previous;
    this.parentElement = null;
    this.previousElementSibling = null;
    this.nextElementSibling = null;
  }

  get innerText() {
    return [this.ownText, ...this.children.map(child => child.innerText)].filter(Boolean).join(' ');
  }

  set innerText(value) {
    this.ownText = value;
  }

  get textContent() {
    return this.innerText;
  }

  set textContent(value) {
    this.ownText = value;
  }

  get dataset() {
    return Object.fromEntries([...this.attributes]
      .filter(([name]) => name.startsWith('data-'))
      .map(([name, value]) => [dataKey(name), value]));
  }

  getAttribute(name) {
    return this.attributes.get(String(name).toLowerCase()) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = element => {
      for (const child of element.children) {
        if (matchesSelector(child, selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  getClientRects() {
    return [{}];
  }
}

class FakeDocument extends EventTarget {
  constructor(roots) {
    super();
    this.roots = roots;
    this.body = roots[0];
    this.defaultView = {};
  }

  createElement(tagName) { return new FakeElement(tagName); }
  getElementById(id) {
    const all = [];
    const visit = element => { all.push(element); element.children.forEach(visit); };
    this.roots.forEach(visit);
    return all.find(element => element.id === id || element.getAttribute('id') === id) || null;
  }

  querySelectorAll(selector) {
    return this.roots.flatMap(root => [
      ...(matchesSelector(root, selector) ? [root] : []),
      ...root.querySelectorAll(selector)
    ]);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function createCapturedProfessionalDom() {
  const selectedButton = new FakeElement('button', {
    classes: ['cv-btn', 'cv-delete-select'],
    attributes: { 'data-tcid': 'class-1', 'data-number': 'COURSE-1' },
    text: '退选'
  });
  const selectedDetail = new FakeElement('a', {
    classes: ['cv-jxb-detail'],
    attributes: { 'data-teachingclassid': 'class-1' },
    text: '大纲-周历'
  });
  const selectedItem = new FakeElement('div', {
    classes: ['jxb-item', 'ischoosed'],
    children: [selectedDetail, new FakeElement('div', {
      classes: ['buttons'],
      children: [selectedButton]
    })]
  });

  const availableButton = new FakeElement('button', {
    classes: ['cv-btn', 'cv-choice'],
    attributes: { 'data-tcid': 'class-2', 'data-number': 'COURSE-1', 'data-isfull': '0' },
    text: '选择'
  });
  const availableDetail = new FakeElement('a', {
    classes: ['cv-jxb-detail'],
    attributes: { 'data-teachingclassid': 'class-2' },
    text: '大纲-周历'
  });
  const availableItem = new FakeElement('div', {
    classes: ['jxb-item'],
    children: [availableDetail, new FakeElement('div', {
      classes: ['buttons'],
      children: [availableButton]
    })]
  });

  const courseRow = new FakeElement('tr', {
    classes: ['course-tr'],
    attributes: { 'data-coursenumber': 'COURSE-1' },
    children: [
      new FakeElement('td', { classes: ['kcmc'], text: '测试课程' }),
      new FakeElement('button', { classes: ['cv-zy-expand'], text: '展开' })
    ]
  });
  const classContainer = new FakeElement('tr', {
    classes: ['course-jxb-container-tr'],
    children: [new FakeElement('div', {
      classes: ['course-jxb-container'],
      attributes: { 'data-coursenumber': 'COURSE-1' },
      children: [selectedItem, availableItem]
    })]
  });
  const nextCourse = new FakeElement('tr', { classes: ['course-tr'] });
  courseRow.nextElementSibling = classContainer;
  classContainer.previousElementSibling = courseRow;
  classContainer.nextElementSibling = nextCourse;
  nextCourse.previousElementSibling = classContainer;

  return { availableButton, availableItem, classContainer, courseRow, nextCourse, selectedItem };
}

function createCapturedPublicDom() {
  const createRow = ({ classId, full }) => {
    const detail = new FakeElement('a', {
      classes: ['cv-jxb-detail'],
      attributes: { 'data-teachingclassid': classId, 'data-number': 'PUBLIC-1' },
      text: '详情'
    });
    const favorite = new FakeElement('a', {
      classes: ['cv-favorite'],
      attributes: { 'data-tcid': classId, 'data-number': 'PUBLIC-1' },
      text: '收藏'
    });
    const actionChildren = [favorite];
    let choice = null;
    if (!full) {
      choice = new FakeElement('button', {
        classes: ['cv-choice'],
        attributes: { 'data-tcid': classId, 'data-number': 'PUBLIC-1', 'data-isfull': '0' },
        text: '选择'
      });
      actionChildren.push(choice);
    }
    const row = new FakeElement('tr', {
      classes: ['course-tr'],
      attributes: { 'data-teachingclasstype': 'GG02' },
      children: [
        new FakeElement('td', { classes: ['kch', 'course-cell'], text: 'PUBLIC-1', children: [detail] }),
        new FakeElement('td', { classes: ['kcmc', 'course-cell'], text: '公共测试课程' }),
        new FakeElement('td', { classes: ['jsmc', 'course-cell'], text: '教师甲' }),
        new FakeElement('td', { classes: ['sjdd', 'course-cell'], text: '周一 1-2 节' }),
        new FakeElement('td', { classes: ['xq', 'course-cell'], text: '仙林校区' }),
        new FakeElement('td', {
          classes: ['cz', 'course-cell'],
          text: full ? '已满' : '',
          children: actionChildren
        })
      ]
    });
    return { choice, detail, favorite, row };
  };
  return {
    full: createRow({ classId: 'public-full', full: true }),
    open: createRow({ classId: 'public-open', full: false })
  };
}

function createCapturedFavoriteDom() {
  const classId = 'favorite-full';
  const detail = new FakeElement('a', {
    classes: ['cv-jxb-detail'],
    attributes: { 'data-teachingclassid': classId, 'data-number': 'FAVORITE-1' },
    text: '详情'
  });
  const removeFavorite = new FakeElement('a', {
    classes: ['cv-delete-favorite'],
    attributes: { 'data-tcid': classId },
    text: '取消收藏'
  });
  const disabledChoice = new FakeElement('a', {
    classes: ['cv-choice', 'sc-add', 'cv-disabled'],
    attributes: {
      'data-tcid': classId,
      'data-number': 'FAVORITE-1',
      'data-teachingclasstype': 'GG02'
    },
    text: '已满'
  });
  const row = new FakeElement('tr', {
    classes: ['course-tr'],
    attributes: { 'data-teachingclasstype': 'SC' },
    children: [
      new FakeElement('td', { classes: ['kch', 'course-cell'], text: 'FAVORITE-1', children: [detail] }),
      new FakeElement('td', { classes: ['kcmc', 'course-cell'], text: '收藏测试课程' }),
      new FakeElement('td', { classes: ['jsmc', 'course-cell'], text: '教师乙' }),
      new FakeElement('td', { classes: ['sjdd', 'course-cell'], text: '周二 3-4 节' }),
      new FakeElement('td', { classes: ['xq', 'course-cell'], text: '鼓楼校区' }),
      new FakeElement('td', {
        classes: ['cz', 'course-cell'],
        children: [removeFavorite, disabledChoice]
      })
    ]
  });
  return { detail, disabledChoice, removeFavorite, row };
}

function loadAdapter(document, options = {}) {
  const storageWrites = [];
  const storageState = {
    nju_grab_courses: '旧关键词',
    nju_grab_interval: '5000',
    ...(options.storageState || {})
  };
  const context = vm.createContext({
    AbortController,
    clearTimeout,
    console,
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    getStateSnapshot: () => options.grabState || {},
    MutationObserver: class {},
    NjuGrabAuthPresentation: grabAuthPresentation,
    NjuGrabTaskModel: grabTaskModel,
    NjuGrabVerificationEngine: grabVerificationEngine,
    chrome: {
      runtime: { sendMessage: async () => ({ ok: true }) },
      storage: {
        local: {
          get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
            .filter(key => Object.hasOwn(storageState, key))
            .map(key => [key, structuredClone(storageState[key])])),
          set: async value => {
            if (options.storageSetError) throw new Error(options.storageSetError);
            Object.assign(storageState, structuredClone(value));
            storageWrites.push(structuredClone(value));
          }
        }
      }
    },
    NjuGrabEngine: {
      CANDIDATE_STATUS: { SELECTED: 'SELECTED', AVAILABLE: 'AVAILABLE', FULL: 'FULL', UNAVAILABLE: 'UNAVAILABLE' },
      OUTCOME: {
        AUTH_EXPIRED: 'AUTH_EXPIRED', CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED', CONFLICT: 'CONFLICT',
        COURSE_LIMIT: 'COURSE_LIMIT', CREDIT_LIMIT: 'CREDIT_LIMIT', DUPLICATE: 'DUPLICATE',
        FULL: 'FULL', NETWORK_ERROR: 'NETWORK_ERROR', PREREQUISITE_FAILED: 'PREREQUISITE_FAILED',
        RATE_LIMITED: 'RATE_LIMITED', REJECTED: 'REJECTED', SERVER_ERROR: 'SERVER_ERROR', SUCCESS: 'SUCCESS'
      }
    },
    sessionStorage: {
      getItem(key) {
        if (key === 'teachingClassType') return 'ZY';
        if (key === 'studentInfo') return JSON.stringify({ electiveBatch: { code: 'BATCH-1' } });
        return null;
      }
    },
    clearTimeout: options.clearTimeout || clearTimeout,
    setTimeout: options.setTimeout || setTimeout
  });
  context.stopGrab = options.stopGrab || (() => ({ running: false, phase: 'STOPPED' }));
  context.globalThis = context;
  context.window = context;
  vm.runInContext(`${adapterSource}\n${domUiSource}\nglobalThis.grabNetworkMonitorForTest = grabNetworkMonitor;`, context, {
    filename: 'content-grab-adapter.js'
  });
  context.storageWritesForTest = storageWrites;
  context.storageStateForTest = storageState;
  return context;
}

test('splits every professional .jxb-item into an exact candidate', () => {
  const dom = createCapturedProfessionalDom();
  const document = new FakeDocument([dom.courseRow, dom.classContainer, dom.nextCourse]);
  const adapter = loadAdapter(document);

  const rows = adapter.getExpandedClassRows(dom.courseRow);
  assert.deepEqual(Array.from(rows), [dom.selectedItem, dom.availableItem]);

  const candidate = adapter.buildDomCandidate(dom.availableItem, '测试课程', 0);
  assert.equal(candidate.teachingClassId, 'class-2');
  assert.equal(candidate.courseNumber, 'COURSE-1');
  assert.equal(candidate.id, 'class:BATCH-1:ZY:class-2');
  assert.equal(candidate.status, 'AVAILABLE');
});

test('places monitor controls in the native course action area', () => {
  const professional = createCapturedProfessionalDom();
  const publicCourses = createCapturedPublicDom();
  const document = new FakeDocument([
    professional.courseRow,
    professional.classContainer,
    professional.nextCourse,
    publicCourses.full.row
  ]);
  const adapter = loadAdapter(document);

  const cardActions = adapter.grabTargetButtonContainer(professional.availableItem);
  assert.equal(cardActions.classList.contains('buttons'), true);
  assert.equal(cardActions.classList.contains('nju-grab-card-actions'), true);
  assert.equal(professional.availableItem.classList.contains('nju-grab-enhanced'), true);

  const rowActions = adapter.grabTargetButtonContainer(publicCourses.full.row);
  assert.equal(rowActions.classList.contains('cz'), true);
  assert.equal(publicCourses.full.row.classList.contains('nju-grab-enhanced-row'), true);
});

test('a popup keyword target marks each matching teaching class as pending', () => {
  const professional = createCapturedProfessionalDom();
  const document = new FakeDocument([
    professional.courseRow,
    professional.classContainer,
    professional.nextCourse
  ]);
  const adapter = loadAdapter(document);
  vm.runInContext(`
    configuredGrabTargets = grabTaskModel.normalizeTargets(['测试课程']);
    configuredGrabTargetIds = new Set(configuredGrabTargets.map(target => target.targetId));
    latestGrabPageState = { running: false, targetStates: {} };
  `, adapter);
  const pageTarget = adapter.targetFromCourseElement(professional.availableItem);
  const button = new FakeElement('button');
  button.ownerDocument = { createElement() {} };

  adapter.updateGrabTargetButton(button, pageTarget);

  assert.equal(button.textContent, '待启动');
  assert.equal(button.disabled, true);
  assert.equal(button.classList.contains('is-added'), true);
  assert.notEqual(button.textContent, '移除监控');
});

test('keeps runtime state visible while exposing an exact-target remove action', () => {
  const dom = createCapturedProfessionalDom();
  const adapter = loadAdapter(new FakeDocument([dom.courseRow, dom.classContainer, dom.nextCourse]));
  const target = adapter.targetFromCourseElement(dom.availableItem);
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(target)}];`, adapter);
  const button = new FakeElement('button');

  const render = phase => vm.runInContext(`latestGrabPageState = { running: true, targetStates: {
    ${JSON.stringify(target.targetId)}: { phase: '${phase}', lastOutcome: '${phase === 'WATCHING' ? 'UNKNOWN' : phase}' }
  }};`, adapter);

  render('SELECTED');
  adapter.updateGrabTargetButton(button, target);

  assert.equal(button.textContent, '已选 · 移除');
  assert.equal(button.classList.contains('is-selected'), true);
  assert.equal(button.classList.contains('is-warning'), false);
  assert.match(button.title, /已二次确认.*先停止监控后移除/);
  assert.match(button.getAttribute('aria-label'), /已选 · 移除/);

  render('WATCHING');
  adapter.updateGrabTargetButton(button, target);
  assert.equal(button.textContent, '监控中 · 移除');
  assert.equal(button.classList.contains('is-active'), true);
  assert.equal(button.classList.contains('is-warning'), false);

  render('WATCHING');
  vm.runInContext(`latestGrabPageState.targetStates[${JSON.stringify(target.targetId)}].lastOutcome = 'FULL';`, adapter);
  adapter.updateGrabTargetButton(button, target);
  assert.equal(button.textContent, '已满 · 移除');
  assert.equal(button.classList.contains('is-warning'), true);
  assert.equal(button.classList.contains('is-active'), false);
});

test('labels the running primary action as stop and keeps the header action as hide panel', () => {
  const adapter = loadAdapter(new FakeDocument([new FakeElement('div', { classes: ['result-container'] })]));
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(grabTaskModel.normalizeTarget('面板测试'))}];`, adapter);
  adapter.renderGrabPageStatus({ running: true, phase: 'RUNNING', runId: 1, configuredTargets: [], targetStates: {} });
  const panel = vm.runInContext('grabPageStatusPanel', adapter);
  const control = panel.querySelector('[data-nju-grab-control]');
  const close = panel.querySelector('[data-nju-grab-status-close]');
  assert.equal(control.textContent, '停止');
  assert.equal(close.getAttribute('aria-label'), '隐藏面板');
  assert.equal(close.getAttribute('title'), '隐藏课程监控面板');
});

test('offers an accessible mini-mode button and restores the panel from its semantic header control', () => {
  const adapter = loadAdapter(new FakeDocument([new FakeElement('div', { classes: ['result-container'] })]));
  adapter.renderGrabPageStatus({ running: true, phase: 'RUNNING', runId: 1, configuredTargets: [], targetStates: {} });
  const panel = vm.runInContext('grabPageStatusPanel', adapter);
  const mini = panel.querySelector('[data-nju-grab-mini]');
  const toggle = panel.querySelector('[data-nju-grab-status-toggle]');
  const body = panel.querySelector('[data-nju-grab-status-body]');

  assert.equal(mini.getAttribute('aria-label'), '收起为胶囊');
  mini.click();
  assert.equal(panel.classList.contains('is-mini'), true);
  assert.equal(mini.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), '展开课程监控面板');
  assert.equal(body.hidden, true);

  toggle.click();
  assert.equal(panel.classList.contains('is-mini'), false);
  assert.equal(mini.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), '折叠或展开课程监控状态');
  assert.equal(body.hidden, false);
});

test('reopens the ordinary collapsed radar from the header control', () => {
  const adapter = loadAdapter(new FakeDocument([new FakeElement('div', { classes: ['result-container'] })]));
  adapter.renderGrabPageStatus({ running: true, phase: 'RUNNING', runId: 1, configuredTargets: [], targetStates: {} });
  const panel = vm.runInContext('grabPageStatusPanel', adapter);
  const toggle = panel.querySelector('[data-nju-grab-status-toggle]');
  const body = panel.querySelector('[data-nju-grab-status-body]');

  toggle.click();
  assert.equal(panel.classList.contains('is-expanded'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(body.hidden, true);

  toggle.click();
  assert.equal(panel.classList.contains('is-expanded'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(body.hidden, false);
});

test('reopens collapsed and mini radar states when pointer capture retargets the click to the header', () => {
  const adapter = loadAdapter(new FakeDocument([new FakeElement('div', { classes: ['result-container'] })]));
  adapter.renderGrabPageStatus({ running: true, phase: 'RUNNING', runId: 1, configuredTargets: [], targetStates: {} });
  const panel = vm.runInContext('grabPageStatusPanel', adapter);
  const head = panel.querySelector('.nju-grab-status-head');
  const toggle = panel.querySelector('[data-nju-grab-status-toggle]');
  const mini = panel.querySelector('[data-nju-grab-mini]');
  const body = panel.querySelector('[data-nju-grab-status-body]');

  toggle.click();
  assert.equal(body.hidden, true);
  head.click();
  assert.equal(body.hidden, false);

  mini.click();
  assert.equal(panel.classList.contains('is-mini'), true);
  head.click();
  assert.equal(panel.classList.contains('is-mini'), false);
  assert.equal(body.hidden, false);
});

test('reduced-motion styling disables the redesigned panel animations', () => {
  const reducedMotion = pageUiSource.slice(pageUiSource.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reducedMotion, /\.nju-grab-status-panel,/);
  assert.match(reducedMotion, /\.nju-grab-tutorial-tooltip,/);
  assert.match(reducedMotion, /animation:\s*none\s*!important/);
  assert.match(reducedMotion, /transition:\s*none\s*!important/);
});

test('treats auth recovery as active so the primary action stops recovery instead of starting a task', () => {
  const adapter = loadAdapter(new FakeDocument([new FakeElement('div', { classes: ['result-container'] })]));
  adapter.renderGrabPageStatus({
    running: false, phase: 'PAUSED_AUTH', authRecovery: { pending: true, stage: 'WAITING_LOGIN' },
    configuredTargets: [], targetStates: {}
  });
  const panel = vm.runInContext('grabPageStatusPanel', adapter);
  const control = panel.querySelector('[data-nju-grab-control]');
  assert.equal(control.textContent, '停止恢复');
  assert.equal(control.getAttribute('aria-label'), '停止登录恢复');
  assert.equal(vm.runInContext('isGrabPanelEditableStopped({ running: false, phase: "PAUSED_AUTH", authRecovery: { pending: true } })', adapter), false);
});

test('disables the interval control while auth recovery is pending even when running is false', () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document);
  adapter.renderGrabPageStatus({ running: false, phase: 'PAUSED_AUTH', authRecovery: { pending: true }, targetStates: {} });
  const panel = vm.runInContext('grabPageStatusPanel', adapter);
  const interval = new FakeElement('select', { attributes: { 'data-nju-grab-interval': '' } });
  panel.querySelector('[data-nju-grab-status-body]').append(interval);
  adapter.renderGrabPageStatus({ running: false, phase: 'PAUSED_AUTH', authRecovery: { pending: true }, targetStates: {} });
  assert.equal(interval.disabled, true);
});

test('shows the immediate-check action only for a running task and names blocked states truthfully', () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document);
  adapter.renderGrabPageStatus({ running: false, phase: 'STOPPED', targetStates: {} });
  const panel = vm.runInContext('grabPageStatusPanel', adapter);
  const runNow = new FakeElement('button', { attributes: { 'data-nju-grab-run-now': '' } });
  panel.querySelector('[data-nju-grab-status-body]').append(runNow);
  adapter.renderGrabPageStatus({ running: false, phase: 'STOPPED', targetStates: {} });
  assert.equal(runNow.hidden, true);

  adapter.renderGrabPageStatus({ running: true, phase: 'RUNNING', inFlight: false, targetStates: {} });
  assert.equal(runNow.hidden, false);
  assert.equal(runNow.disabled, false);
  assert.equal(runNow.textContent, '立即检查');

  adapter.renderGrabPageStatus({ running: true, phase: 'RUNNING', inFlight: true, targetStates: {} });
  assert.equal(runNow.disabled, true);
  assert.equal(runNow.textContent, '正在检查');

  adapter.renderGrabPageStatus({
    running: true, phase: 'RUNNING', inFlight: false,
    globalRetryAt: Date.now() + 5000, targetStates: {}
  });
  assert.equal(runNow.disabled, true);
  assert.equal(runNow.textContent, '退避中');
});

test('shows the real non-preset interval while running instead of silently changing it to five seconds', () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document);
  adapter.renderGrabPageStatus({ running: true, phase: 'RUNNING', interval: 1000, targetStates: {} });
  const panel = vm.runInContext('grabPageStatusPanel', adapter);
  const interval = new FakeElement('select', { attributes: { 'data-nju-grab-interval': '' } });
  panel.querySelector('[data-nju-grab-status-body]').append(interval);
  adapter.renderGrabPageStatus({ running: true, phase: 'RUNNING', interval: 1000, targetStates: {} });
  assert.equal(interval.value, '1000');
  assert.equal(interval.disabled, true);
  assert.match(interval.querySelector('[data-nju-grab-current-interval]').textContent, /1 秒/);
});

test('diagnostic summary contains aggregate runtime facts but no target content', () => {
  const adapter = loadAdapter(new FakeDocument([]));
  const summary = vm.runInContext(`buildGrabDiagnosticSummary({
    phase: 'RUNNING', running: true, round: 4, initialTargetCount: 1,
    remainingTargets: [{ name: '绝密课程', targetId: 'class:secret' }],
    targetStates: { 'class:secret': { phase: 'WATCHING', lastMessage: '查询词不要泄露' } },
    lastScan: { mode: 'NETWORK', outcome: 'UNKNOWN', durationMs: 12 }, lastRoundDurationMs: 12
  })`, adapter);
  assert.match(summary, /phase=RUNNING/);
  assert.match(summary, /scanMode=NETWORK/);
  assert.equal(summary.includes('绝密课程'), false);
  assert.equal(summary.includes('secret'), false);
  assert.equal(summary.includes('查询词'), false);
});

test('persists a stopped interval in both versioned task config and legacy storage', async () => {
  const adapter = loadAdapter(new FakeDocument([]), {
    storageState: { nju_grab_interval: '5000', nju_grab_courses: '旧关键词' }
  });
  await adapter.persistGrabInterval(10000);
  const write = adapter.storageWritesForTest.at(-1);
  assert.equal(write.nju_grab_interval, 10000);
  assert.equal(write.nju_grab_task_v1.intervalMs, 10000);
  assert.deepEqual(write.nju_grab_task_v1.targets.map(target => target.name), ['旧关键词']);
});

test('matches an exact target across page metadata changes but not another class or missing batch', () => {
  const adapter = loadAdapter(new FakeDocument([]));
  const pageTarget = grabTaskModel.normalizeTarget({
    name: '跨页课程', electiveBatchId: 'BATCH-1', teachingClassType: 'GG02',
    teachingClassId: 'class-002', queryScope: 'GG02'
  });
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(grabTaskModel.normalizeTarget({
    name: '跨页课程', electiveBatchId: 'BATCH-1', teachingClassType: 'GG01',
    teachingClassId: 'class-002', queryScope: 'SC'
  }))}];`, adapter);
  const button = new FakeElement('button');

  adapter.updateGrabTargetButton(button, pageTarget);
  assert.equal(button.classList.contains('is-added'), true);

  const otherClass = { ...pageTarget, teachingClassId: 'class-001' };
  adapter.updateGrabTargetButton(button, otherClass);
  assert.equal(button.classList.contains('is-added'), false);

  const missingBatch = { ...pageTarget, electiveBatchId: '' };
  adapter.updateGrabTargetButton(button, missingBatch);
  assert.equal(button.classList.contains('is-added'), false);
});

test('removes the original configured target after a cross-page metadata match', async () => {
  const adapter = loadAdapter(new FakeDocument([]));
  const configured = grabTaskModel.normalizeTarget({
    name: '跨页移除', electiveBatchId: 'BATCH-1', teachingClassType: 'GG01',
    teachingClassId: 'class-002', queryScope: 'SC'
  });
  const pageTarget = grabTaskModel.normalizeTarget({
    name: '跨页移除', electiveBatchId: 'BATCH-1', teachingClassType: 'GG02',
    teachingClassId: 'class-002', queryScope: 'GG02'
  });
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(configured)}];`, adapter);
  const button = new FakeElement('button');

  const result = await adapter.removeConfiguredGrabTarget(pageTarget, button);
  assert.equal(result.removed, true);
  assert.equal(adapter.storageStateForTest[grabTaskModel.STORAGE_KEY].targets.some(item => item.targetId === configured.targetId), false);
  assert.equal(button.textContent, '加入监控');
  assert.equal(button.classList.contains('is-added'), false);
});

test('renders separate state and remove labels with an accessible action contract', () => {
  const adapter = loadAdapter(new FakeDocument([]));
  const target = grabTaskModel.normalizeTarget({
    name: '结构课程', electiveBatchId: 'BATCH-1', teachingClassId: 'class-002', teachingClassType: 'GG'
  });
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(target)}]; latestGrabPageState = {
    running: true, targetStates: { ${JSON.stringify(target.targetId)}: { phase: 'SELECTED' } }
  };`, adapter);
  const button = new FakeElement('button');
  button.ownerDocument = { createElement() {} };
  adapter.updateGrabTargetButton(button, target);

  assert.match(String(button.innerHTML || ''), /data-nju-grab-state-label/);
  assert.match(String(button.innerHTML || ''), /data-nju-grab-remove-label/);
  assert.match(button.getAttribute('aria-label'), /已选/);
  assert.match(button.getAttribute('aria-label'), /移除/);
  assert.match(button.title, /先停止监控后移除/);
});

test('running page removal opens a labeled panel confirmation and cancel is a true no-op', () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, { grabState: { running: true, authRecovery: null } });
  const target = grabTaskModel.normalizeTarget({
    name: '运行态确认课程', electiveBatchId: 'BATCH-1', teachingClassId: 'class-running', teachingClassType: 'GG'
  });
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(target)}]; latestGrabPageState = { running: true, authRecovery: null };`, adapter);

  adapter.requestGrabTargetRemoval(target);
  const panel = document.querySelector('.nju-grab-status-panel');
  assert.ok(panel, 'request creates the stable status panel');
  const confirm = panel.querySelector('[data-nju-grab-remove-confirm]');
  assert.equal(confirm.hidden, false);
  assert.match(confirm.querySelector('[data-nju-grab-remove-message]').textContent, /运行态确认课程/);
  assert.equal(adapter.storageWritesForTest.length, 0);

  confirm.querySelector('[data-nju-grab-remove-cancel]').click();
  assert.equal(confirm.hidden, true);
  assert.equal(adapter.storageWritesForTest.length, 0);
  assert.equal(vm.runInContext('pendingGrabRemoval', adapter), null);
});

test('a real page button click routes exact removal through the same panel confirmation', () => {
  const captured = createCapturedPublicDom();
  const root = new FakeElement('main', { classes: ['result-container'], children: [captured.open.row] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, { grabState: { running: true } });
  const pageTarget = adapter.targetFromCourseElement(captured.open.row);
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(pageTarget)}]; latestGrabPageState = { running: true };`, adapter);
  adapter.decorateCourseTargets();
  const pageButton = captured.open.row.querySelector('.nju-grab-add-target');
  assert.ok(pageButton);
  pageButton.click();
  const confirm = document.querySelector('[data-nju-grab-remove-confirm]');
  assert.equal(confirm.hidden, false);
  assert.match(confirm.querySelector('[data-nju-grab-remove-message]').textContent, /公共测试课程/);
});

test('page removal reopens a hidden collapsed panel and clears its restore entry', () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, { grabState: { running: true } });
  const target = grabTaskModel.normalizeTarget({ name: '隐藏面板课程', electiveBatchId: 'BATCH-1', teachingClassId: 'hidden-1', teachingClassType: 'GG' });
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(target)}]; latestGrabPageState = { running: true };`, adapter);
  adapter.requestGrabTargetRemoval(target);
  const panel = document.querySelector('.nju-grab-status-panel');
  panel.style.display = 'none';
  const restore = new FakeElement('button');
  restore.id = 'nju-grab-restore-btn';
  document.body.appendChild(restore);
  vm.runInContext('setGrabPageStatusExpanded(false);', adapter);
  adapter.requestGrabTargetRemoval(target);
  const confirm = panel.querySelector('[data-nju-grab-remove-confirm]');
  assert.equal(panel.style.display, '');
  assert.equal(panel.querySelector('[data-nju-grab-status-body]').hidden, false);
  assert.equal(confirm.hidden, false);
  assert.equal(document.getElementById('nju-grab-restore-btn'), null);
});

test('a stale row parse still uses the button configured target identity on click', () => {
  const captured = createCapturedPublicDom();
  const root = new FakeElement('main', { classes: ['result-container'], children: [captured.open.row] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, { grabState: { running: true } });
  const target = adapter.targetFromCourseElement(captured.open.row);
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(target)}]; latestGrabPageState = { running: true };`, adapter);
  adapter.decorateCourseTargets();
  const pageButton = captured.open.row.querySelector('.nju-grab-add-target');
  pageButton.setAttribute('data-configured-target-id', target.targetId);
  captured.open.row.children = [];
  pageButton.click();
  const confirm = document.querySelector('[data-nju-grab-remove-confirm]');
  assert.equal(confirm.hidden, false);
  assert.match(confirm.querySelector('[data-nju-grab-remove-message]').textContent, /公共测试课程/);
});

test('stopped panel target remove uses a real click and removes the configured keyword target', async () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const keyword = grabTaskModel.normalizeTarget('面板关键词课程');
  const adapter = loadAdapter(document, { grabState: { running: false } });
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(keyword)}]; configuredGrabGroups = []; latestGrabPageState = { running: false, targetStates: {} };`, adapter);
  adapter.renderGrabPageStatus({ running: false, targetStates: {} });
  const remove = document.querySelector('.nju-grab-target-remove');
  assert.ok(remove, 'panel renders a keyboard/clickable remove control');
  remove.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const saved = grabTaskModel.normalizeTaskConfig(adapter.storageStateForTest[grabTaskModel.STORAGE_KEY]);
  assert.equal(saved.targets.some(item => item.targetId === keyword.targetId), false);
  assert.equal(adapter.storageWritesForTest.length > 0, true);
});

test('stopped panel prefers the current configured targets after a removal, not a stale runtime snapshot', () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, { grabState: { running: false } });
  const stale = grabTaskModel.normalizeTarget('已移除的旧课程');
  vm.runInContext('configuredGrabTargets = []; configuredGrabGroups = []; latestGrabPageState = { running: false, phase: "STOPPED", targetStates: {} };', adapter);
  adapter.renderGrabPageStatus({ running: false, phase: 'STOPPED', configuredTargets: [stale], targetStates: {} });
  const targetContainer = document.querySelector('[data-nju-grab-status-targets]');
  assert.equal(targetContainer.textContent.includes('已移除的旧课程'), false);
});

test('terminal snapshot status does not claim completion after the configured targets changed', () => {
  const adapter = loadAdapter(new FakeDocument([]));
  const current = grabTaskModel.normalizeTarget('当前课程');
  const stale = grabTaskModel.normalizeTarget('已完成但已移除');
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(current)}]; configuredGrabGroups = [];`, adapter);
  const presentation = adapter.grabPageSummaryPresentation({
    running: false, phase: 'COMPLETED', completedGroups: 1, totalGroups: 1,
    configuredTargets: [stale], targetStates: {}
  });
  assert.notEqual(presentation.title, '课程组已完成');
  assert.equal(presentation.title, '已配置 1 门课程');
});

test('target action portal survives outside-pointer dismissal and its remove item uses the normal confirmation path', async () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, { grabState: { running: false } });
  const target = grabTaskModel.normalizeTarget({ name: 'portal目标课程', electiveBatchId: 'BATCH-1', teachingClassId: 'portal-1', teachingClassType: 'GG' });
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(target)}]; latestGrabPageState = { running: false, phase: 'STOPPED', targetStates: {} };`, adapter);
  adapter.renderGrabPageStatus({ running: false, phase: 'STOPPED', targetStates: {} });
  const trigger = new FakeElement('button');
  adapter.openGrabTargetMenuPortal(target, trigger);
  const portal = document.querySelector('.nju-grab-target-menu');
  const remove = portal?.querySelector('.nju-grab-target-remove');
  assert.ok(portal && remove);
  vm.runInContext('grabPanelDismissHandlers.pointerdown', adapter)({ target: remove });
  assert.equal(portal.isConnected, true, 'pointerdown inside the portal must not dismiss it');
  remove.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const saved = grabTaskModel.normalizeTaskConfig(adapter.storageStateForTest[grabTaskModel.STORAGE_KEY]);
  assert.equal(saved.targets.some(item => item.targetId === target.targetId), false);
});

test('hiding the panel closes both floating menus and resets their expanded state', () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, { grabState: { running: false } });
  adapter.renderGrabPageStatus({ running: false, phase: 'STOPPED', targetStates: {} });
  const panel = vm.runInContext('grabPageStatusPanel', adapter);
  const moreButton = new FakeElement('button');
  moreButton.setAttribute('aria-expanded', 'true');
  const moreMenu = new FakeElement('div');
  moreMenu.hidden = false;
  document.body.append(moreMenu);
  adapter.moreButtonFixture = moreButton;
  adapter.moreMenuFixture = moreMenu;
  vm.runInContext('grabMoreButton = moreButtonFixture; grabMoreMenu = moreMenuFixture;', adapter);
  adapter.openGrabTargetMenuPortal(grabTaskModel.normalizeTarget('隐藏时关闭菜单'), new FakeElement('button'));
  const portal = document.querySelector('.nju-grab-target-menu');
  assert.ok(portal);
  vm.runInContext('hideGrabPageStatusPanel();', adapter);
  assert.equal(portal.isConnected, false);
  assert.equal(vm.runInContext('openGrabTargetMenu', adapter), null);
  assert.equal(moreMenu.hidden, true);
  assert.equal(moreButton.getAttribute('aria-expanded'), 'false');
});

test('confirm stops before saving, and save failure keeps a stable retry confirmation', async () => {
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const events = [];
  const target = grabTaskModel.normalizeTarget({
    name: '失败重试课程', electiveBatchId: 'BATCH-1', teachingClassId: 'class-retry', teachingClassType: 'GG'
  });
  const adapter = loadAdapter(document, {
    grabState: { running: true }, storageSetError: 'quota',
    stopGrab: () => { events.push('stop'); return { running: false, phase: 'STOPPED' }; }
  });
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(target)}]; latestGrabPageState = { running: true };`, adapter);
  adapter.requestGrabTargetRemoval(target);
  const panel = document.querySelector('.nju-grab-status-panel');
  const confirm = panel.querySelector('[data-nju-grab-remove-confirm]');
  confirm.querySelector('[data-nju-grab-remove-stop]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events, ['stop']);
  assert.equal(confirm.hidden, false);
  assert.match(confirm.querySelector('[data-nju-grab-remove-message]').textContent, /停止成功，但移除.*保存失败/);
  assert.equal(confirm.querySelector('[data-nju-grab-remove-stop]').textContent, '重试移除');

  confirm.querySelector('[data-nju-grab-remove-stop]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events, ['stop'], 'retry does not stop a second time');
  assert.equal(confirm.hidden, false);
});

test('maps runtime phases to truthful page button and radar states', () => {
  const document = new FakeDocument([]);
  const adapter = loadAdapter(document);

  assert.deepEqual(
    { ...adapter.grabPageTargetPresentation(null, false) },
    { label: '待启动', detail: '', tone: 'idle' }
  );
  assert.deepEqual(
    { ...adapter.grabPageTargetPresentation({ phase: 'WATCHING', lastOutcome: 'FULL' }, true) },
    { label: '已满监控', detail: '当前无余量，继续监控', tone: 'warning' }
  );
  assert.deepEqual(
    { ...adapter.grabPageTargetPresentation({
      phase: 'WATCHING',
      lastOutcome: null,
      lastMessage: '等待打开 SC 课程分类以建立查询通道'
    }, true) },
    { label: '等待分类', detail: '等待打开 SC 课程分类以建立查询通道', tone: 'muted' }
  );
  assert.deepEqual(
    { ...adapter.grabPageTargetPresentation({
      phase: 'WATCHING',
      lastOutcome: null,
      lastMessage: '本轮在专业课程分类未找到，继续轮查其他课程分类'
    }, true) },
    { label: '跨页待查', detail: '本轮在专业课程分类未找到，继续轮查其他课程分类', tone: 'muted' }
  );
  assert.deepEqual(
    { ...adapter.grabPageTargetPresentation({
      phase: 'WATCHING',
      lastOutcome: null,
      lastMessage: '在收藏课程分类发现余量，等待进入该分类完成提交'
    }, true) },
    { label: '切页提交', detail: '在收藏课程分类发现余量，等待进入该分类完成提交', tone: 'warning' }
  );
  assert.deepEqual(
    { ...adapter.grabPageTargetPresentation({ phase: 'VERIFYING' }, true) },
    { label: '验证中', detail: '正在二次确认选课结果', tone: 'active' }
  );
  assert.deepEqual(
    { ...adapter.grabPageTargetPresentation({ phase: 'RETRY', retryAt: 7000 }, true, { currentTime: 3000 }) },
    { label: '等待重试', detail: '4s 后自动重试', tone: 'warning' }
  );
  assert.deepEqual(
    { ...adapter.grabPageTargetPresentation({ phase: 'SELECTED' }, false) },
    { label: '已选', detail: '已二次确认选课结果', tone: 'success' }
  );

  assert.deepEqual(
    { ...adapter.grabPageSummaryPresentation({
      running: true,
      inFlight: false,
      round: 4,
      nextRunAt: 5000
    }, 2000) },
    { title: '课程监控运行中', subtitle: '第 4 轮 · 3s 后检查', tone: 'active' }
  );
  assert.deepEqual(
    { ...adapter.grabPageSummaryPresentation({
      running: true,
      inFlight: false,
      nextRetryAt: 9000,
      retryingTargetCount: 1
    }, 3000) },
    { title: '课程监控运行中 · 部分退避', subtitle: '1 个目标等待重试，其余目标继续检查', tone: 'warning' }
  );
  assert.deepEqual(
    { ...adapter.grabPageSummaryPresentation({
      phase: 'PAUSED_AUTH',
      totalGroups: 1,
      configuredTargets: [{ targetId: 'one' }, { targetId: 'two' }],
      authRecovery: { pending: true, stage: 'ENTERING_COURSE' }
    }, 3000) },
    {
      title: '正在进入当前选课轮次',
      subtitle: '已保留 1 个课程组。扩展只调用学校页面已有的进入按钮，进入后先执行恢复验证。',
      tone: 'active'
    }
  );
  assert.equal(
    adapter.grabPageScanLabel({ mode: 'NETWORK', deferredTargetCount: 2 }),
    '接口查询 · 2 个下轮分批'
  );
});

test('maps real NJU course scopes and builds a two-level automatic navigation path', () => {
  const professional = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'ZY' },
    text: '专业'
  });
  const publicRoot = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'GG' },
    text: '公共'
  });
  const publicElective = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'GG01' },
    text: '公选课'
  });
  const generalEducation = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'GG02' },
    text: '导学/研讨/通识'
  });
  const adapter = loadAdapter(new FakeDocument([
    professional,
    publicRoot,
    publicElective,
    generalEducation
  ]));

  assert.equal(adapter.courseScopeLabel('GG01'), '公选课');
  assert.equal(adapter.courseScopeLabel('GG02'), '导学/研讨/通识');
  assert.deepEqual(Array.from(adapter.courseScopeNavigationPath('GG02')), ['GG', 'GG02']);
  assert.equal(adapter.findCourseTabElement('GG01'), publicElective);
  assert.equal(adapter.findCourseTabElement('GG02'), generalEducation);
});

test('automatically navigates to a missing course scope while monitoring', async () => {
  const timers = [];
  let clicked = 0;
  const publicRoot = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'GG' },
    text: '公共'
  });
  const generalEducation = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'GG02' },
    text: '导学/研讨/通识'
  });
  generalEducation.addEventListener('click', () => { clicked += 1; });
  const root = new FakeElement('main', {
    classes: ['result-container'],
    children: [publicRoot, generalEducation]
  });
  const adapter = loadAdapter(new FakeDocument([root]), {
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });
  const target = grabTaskModel.normalizeTarget({
    name: '自动跳转通识课',
    electiveBatchId: 'BATCH-1',
    teachingClassId: 'class-auto-scope',
    teachingClassType: 'GG02',
    queryScope: 'GG02'
  });
  vm.runInContext(`configuredGrabTargets = [${JSON.stringify(target)}];`, adapter);

  adapter.renderGrabPageStatus({
    running: true,
    phase: 'RUNNING',
    configuredTargets: [target],
    targetStates: {
      [target.targetId]: {
        phase: 'WATCHING',
        lastMessage: '等待打开 GG02 课程分类以建立查询通道'
      }
    }
  });

  const navigationTimer = timers.find(timer => timer.delay === 200);
  assert.ok(navigationTimer, 'missing scope should schedule automatic navigation');
  navigationTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(clicked, 1);
});

test('continues automatic navigation when page enhancements are disabled', async () => {
  const timers = [];
  let clicked = 0;
  const tab = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'GG02' },
    text: '导学/研讨/通识'
  });
  tab.addEventListener('click', () => { clicked += 1; });
  const root = new FakeElement('main', { classes: ['result-container'], children: [tab] });
  const adapter = loadAdapter(new FakeDocument([root]), {
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });
  const target = grabTaskModel.normalizeTarget({
    name: '禁用雷达仍需导航',
    electiveBatchId: 'BATCH-1',
    teachingClassId: 'class-disabled-radar',
    teachingClassType: 'GG02',
    queryScope: 'GG02'
  });
  vm.runInContext('grabPageEnhancementsEnabled = false;', adapter);

  adapter.renderGrabPageStatus({
    running: true,
    runId: 1,
    phase: 'RUNNING',
    configuredTargets: [target],
    targetStates: {
      [target.targetId]: {
        phase: 'WATCHING',
        lastMessage: '等待打开 GG02 课程分类以建立查询通道'
      }
    }
  });

  const navigationTimer = timers.find(timer => timer.delay === 200);
  assert.ok(navigationTimer, 'automatic navigation should not depend on the radar panel');
  navigationTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(clicked, 1);
});

test('invalidates a waiting automatic navigation after stop and restart', async () => {
  const timers = [];
  let clicked = 0;
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, {
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });
  const target = grabTaskModel.normalizeTarget({
    name: '取消旧导航',
    electiveBatchId: 'BATCH-1',
    teachingClassId: 'class-cancel-old-navigation',
    teachingClassType: 'GG02',
    queryScope: 'GG02'
  });
  const running = runId => ({
    running: true,
    runId,
    phase: 'RUNNING',
    configuredTargets: [target],
    targetStates: {
      [target.targetId]: {
        phase: 'WATCHING',
        lastMessage: '等待打开 GG02 课程分类以建立查询通道'
      }
    }
  });

  adapter.renderGrabPageStatus(running(1));
  const firstTimer = timers.find(timer => timer.delay === 200);
  assert.ok(firstTimer);
  firstTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  const waitingTimer = timers.find(timer => timer.delay === 250);
  assert.ok(waitingTimer, 'navigation should be waiting for the tab');

  adapter.renderGrabPageStatus({ running: false, runId: 1, phase: 'STOPPED', configuredTargets: [target] });
  const tab = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'GG02' },
    text: '导学/研讨/通识'
  });
  tab.addEventListener('click', () => { clicked += 1; });
  root.append(tab);
  waitingTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(clicked, 0, 'a stopped navigation must not click a tab that appears later');

  adapter.renderGrabPageStatus(running(2));
  const secondTimer = timers.filter(timer => timer.delay === 200).at(-1);
  assert.ok(secondTimer);
  secondTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(clicked, 1, 'the restarted run may navigate once');
});

test('invalidates an in-flight automatic navigation when a new run starts', async () => {
  const timers = [];
  let clicked = 0;
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, {
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });
  const target = grabTaskModel.normalizeTarget({
    name: '重启旧导航', electiveBatchId: 'BATCH-1', teachingClassId: 'class-restart-navigation',
    teachingClassType: 'GG02', queryScope: 'GG02'
  });
  const state = runId => ({
    running: true, runId, phase: 'RUNNING', configuredTargets: [target],
    targetStates: {
      [target.targetId]: { phase: 'WATCHING', lastMessage: '等待打开 GG02 课程分类以建立查询通道' }
    }
  });

  adapter.renderGrabPageStatus(state(1));
  const firstTimer = timers.find(timer => timer.delay === 200);
  firstTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  const oldWaitingTimer = timers.find(timer => timer.delay === 250);
  assert.ok(oldWaitingTimer);

  adapter.renderGrabPageStatus(state(2));
  const replacementTimer = timers.filter(timer => timer.delay === 200).at(-1);
  assert.ok(replacementTimer, 'a restarted run should schedule its own navigation');
  oldWaitingTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(clicked, 0, 'the prior run must not click after restart');

  const tab = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'GG02' }, text: '导学/研讨/通识'
  });
  tab.addEventListener('click', () => { clicked += 1; });
  root.append(tab);
  replacementTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(clicked, 1);
});

test('releases an obsolete navigation timer when the run changes before it fires', async () => {
  const timers = [];
  let clicked = 0;
  const root = new FakeElement('main', { classes: ['result-container'] });
  const document = new FakeDocument([root]);
  const adapter = loadAdapter(document, {
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });
  const target = grabTaskModel.normalizeTarget({
    name: '释放过期定时器', electiveBatchId: 'BATCH-1', teachingClassId: 'class-stale-timer',
    teachingClassType: 'GG02', queryScope: 'GG02'
  });
  const state = runId => ({
    running: true, runId, phase: 'RUNNING', configuredTargets: [target],
    targetStates: {
      [target.targetId]: { phase: 'WATCHING', lastMessage: '等待打开 GG02 课程分类以建立查询通道' }
    }
  });

  adapter.renderGrabPageStatus(state(1));
  const obsoleteTimer = timers.find(timer => timer.delay === 200);
  assert.ok(obsoleteTimer);
  adapter.renderGrabPageStatus(state(2));
  obsoleteTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));

  const tab = new FakeElement('a', {
    attributes: { 'data-teachingclasstype': 'GG02' }, text: '导学/研讨/通识'
  });
  tab.addEventListener('click', () => { clicked += 1; });
  root.append(tab);
  adapter.renderGrabPageStatus(state(2));
  const replacementTimer = timers.filter(timer => timer.delay === 200).at(-1);
  assert.ok(replacementTimer, 'the new run should be able to reschedule after the stale callback');
  obsoleteTimer.callback();
  replacementTimer.callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(clicked, 1);
});

test('course radar styles are scoped, responsive and motion-safe', () => {
  assert.match(pageUiSource, /\.nju-grab-status-panel\s*\{/);
  assert.match(pageUiSource, /\.nju-grab-status-close\s*\{/);
  assert.match(pageUiSource, /\.nju-grab-status-target\[data-tone="warning"\]/);
  assert.match(pageUiSource, /\.nju-grab-status-target\s*\{[\s\S]*grid-template-columns:\s*10px\s+minmax\(0,\s*1fr\)\s+auto/);
  assert.match(pageUiSource, /@media \(hover: none\)[\s\S]*\.nju-grab-status-target \.nju-grab-target-remove\s*\{[\s\S]*opacity:\s*1/);
  assert.match(pageUiSource, /@media \(max-width: 720px\)/);
  assert.match(pageUiSource, /\.nju-grab-remove-confirm[\s\S]*grid-template-columns:\s*1fr auto/);
  assert.match(pageUiSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(pageUiSource, /\.nju-grab-more-menu\s*\{[\s\S]*z-index:\s*2147483647/);
  assert.match(pageUiSource, /\.nju-grab-more-menu\[hidden\][\s\S]*display:\s*none\s*!important/);
  assert.match(pageUiSource, /\.nju-grab-target-menu \.nju-grab-target-remove[\s\S]*var\(--nju-panel-red,\s*#ff3b30\)/);
  assert.match(pageUiSource, /\.nju-grab-target-menu\s*\{[\s\S]*font-family:/);
  assert.match(pageUiSource, /\.nju-grab-now-btn[\s\S]*font-family:\s*inherit[\s\S]*font-size:\s*11px[\s\S]*font-weight:\s*600/);
  assert.match(pageUiSource, /\.nju-grab-add-target\.is-exact-removable/);
  assert.match(pageUiSource, /grid-column: 2/);
  assert.match(pageUiSource, /grid-row: 1/);
  assert.match(pageUiSource, /opacity: 0/);
  assert.doesNotMatch(pageUiSource, /\.nju-grab-add-target \.nju-grab-remove-label\s*\{\s*display:\s*none/);
  assert.match(pageUiSource, /\.is-exact-removable:focus-visible \.nju-grab-remove-label/);
  assert.match(pageUiSource, /\.is-exact-removable:hover:not\(:disabled\)::before/);
  assert.match(pageUiSource, /content: "−"/);
  assert.match(pageUiSource, /#b42318/);
  assert.match(pageUiSource, /\.nju-grab-add-target\.is-added\s*\{[\s\S]*background: rgba\(226, 232, 240, 0\.96\)/);
  assert.match(pageUiSource, /\.nju-grab-add-target\.is-exact-removable\s*\{[\s\S]*color: #b42318[\s\S]*background: rgba\(255, 241, 240, 0\.98\)/);
  assert.match(pageUiSource, /\.nju-grab-add-target\.is-exact-removable:hover:not\(:disabled\)::before\s*,[\s\S]*content: "−"/);
  assert.match(pageUiSource, /\.nju-grab-add-target\.is-selected/);
  assert.match(pageUiSource, /\.nju-grab-add-target\.is-warning/);
  const cardBase = pageUiSource.indexOf('.course-jxb-container .jxb-item .buttons.nju-grab-card-actions > .nju-grab-add-target {');
  const cardExact = pageUiSource.indexOf('.course-jxb-container .jxb-item .buttons.nju-grab-card-actions > .nju-grab-add-target.is-exact-removable');
  assert.ok(cardBase >= 0 && cardExact > cardBase, 'card exact override must follow broad card rule');
  assert.match(pageUiSource, /\.buttons\.nju-grab-card-actions > \.nju-grab-add-target\.is-exact-removable,\s*\.course-jxb-container[\s\S]*background: rgba\(255, 241, 240, 0\.98\)/);
  assert.match(pageUiSource, /\.buttons\.nju-grab-card-actions > \.nju-grab-add-target\.is-exact-removable:hover:not\(:disabled\)/);
  assert.match(pageUiSource, /\.buttons\.nju-grab-card-actions > \.nju-grab-add-target\.is-exact-removable:focus-visible/);
});

test('course page enhancements can be hidden persistently without changing the grab task', async () => {
  const monitorButton = new FakeElement('button', { classes: ['nju-grab-add-target'] });
  const actions = new FakeElement('div', {
    classes: ['buttons', 'nju-grab-card-actions'],
    children: [monitorButton]
  });
  const row = new FakeElement('div', {
    classes: ['jxb-item', 'nju-grab-enhanced'],
    children: [actions]
  });
  const adapter = loadAdapter(new FakeDocument([row]));

  await adapter.setGrabPageEnhancementsEnabled(false);

  assert.equal(vm.runInContext('grabPageEnhancementsEnabled', adapter), false);
  assert.deepEqual(adapter.storageWritesForTest, [{ nju_grab_page_enhancements_enabled: false }]);
  assert.equal(monitorButton.isConnected, false, 'the row-level control must be removed too');
  assert.equal(row.classList.contains('nju-grab-enhanced'), false);
  assert.equal(actions.classList.contains('nju-grab-card-actions'), false);
  assert.match(contentSource, /data-nju-grab-status-close/);
});

test('dismisses the result dialog after a verified selection so later attempts are not blocked', async () => {
  const dom = createCapturedProfessionalDom();
  const confirmButton = new FakeElement('div', {
    classes: ['cv-sure', 'cvBtnFlag'],
    text: '确认'
  });
  const confirmDialog = new FakeElement('div', {
    classes: ['cv-dialog'],
    text: '是否确认选择该课程',
    children: [confirmButton]
  });
  const successButton = new FakeElement('div', {
    classes: ['cv-sure', 'cvBtnFlag'],
    text: '确认'
  });
  const successDialog = new FakeElement('div', {
    classes: ['cv-dialog', 'cv-success'],
    text: '成功 添加选课成功',
    children: [successButton]
  });
  confirmDialog.isConnected = false;
  confirmButton.isConnected = false;
  successDialog.isConnected = false;
  successButton.isConnected = false;
  const document = new FakeDocument([
    dom.courseRow,
    dom.classContainer,
    dom.nextCourse,
    confirmDialog,
    successDialog
  ]);
  const adapter = loadAdapter(document);
  const candidate = adapter.buildDomCandidate(dom.availableItem, '测试课程', 0);
  let dismissClicks = 0;

  dom.availableButton.click = () => {
    confirmDialog.isConnected = true;
    confirmButton.isConnected = true;
  };
  confirmButton.click = () => {
    confirmDialog.isConnected = false;
    confirmButton.isConnected = false;
    successDialog.isConnected = true;
    successButton.isConnected = true;
    document.dispatchEvent(new CustomEvent('nju-autograb-network-v1', {
      detail: JSON.stringify({
        path: '/elective/studentstatus.do',
        status: 200,
        code: '1',
        message: '处理成功',
        teachingClassId: 'class-2'
      })
    }));
  };
  successButton.click = () => {
    dismissClicks += 1;
    successDialog.isConnected = false;
    successButton.isConnected = false;
  };

  const result = await adapter.attemptDomCandidate(candidate, {
    signal: new AbortController().signal
  });

  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(dismissClicks, 1);
  assert.equal(successDialog.isConnected, false);
});

test('waits for a delayed conflict dialog and dismisses it before trying later courses', async () => {
  const dom = createCapturedProfessionalDom();
  const confirmButton = new FakeElement('div', {
    classes: ['cv-sure', 'cvBtnFlag'],
    text: '确认'
  });
  const confirmDialog = new FakeElement('div', {
    classes: ['cv-dialog'],
    text: '是否确认选择该课程',
    children: [confirmButton]
  });
  const failureButton = new FakeElement('div', {
    classes: ['cv-sure', 'cvBtnFlag'],
    text: '确认'
  });
  const failureDialog = new FakeElement('div', {
    classes: ['cv-dialog', 'cv-error'],
    text: '失败 添加选课失败：课程冲突',
    children: [failureButton]
  });
  confirmDialog.isConnected = false;
  confirmButton.isConnected = false;
  failureDialog.isConnected = false;
  failureButton.isConnected = false;
  const document = new FakeDocument([
    dom.courseRow,
    dom.classContainer,
    dom.nextCourse,
    confirmDialog,
    failureDialog
  ]);
  const adapter = loadAdapter(document);
  const candidate = adapter.buildDomCandidate(dom.availableItem, '测试课程', 0);
  let dismissClicks = 0;

  dom.availableButton.click = () => {
    confirmDialog.isConnected = true;
    confirmButton.isConnected = true;
  };
  confirmButton.click = () => {
    confirmDialog.isConnected = false;
    confirmButton.isConnected = false;
    document.dispatchEvent(new CustomEvent('nju-autograb-network-v1', {
      detail: JSON.stringify({
        path: '/elective/volunteer.do',
        status: 200,
        code: '0',
        message: '添加选课失败：课程冲突',
        teachingClassId: ''
      })
    }));
    setTimeout(() => {
      failureDialog.isConnected = true;
      failureButton.isConnected = true;
    }, 250);
  };
  failureButton.click = () => {
    dismissClicks += 1;
    failureDialog.isConnected = false;
    failureButton.isConnected = false;
  };

  const result = await adapter.attemptDomCandidate(candidate, {
    signal: new AbortController().signal
  });
  await new Promise(resolveEvent => setTimeout(resolveEvent, 300));

  assert.equal(result.outcome, 'CONFLICT');
  assert.equal(dismissClicks, 1);
  assert.equal(failureDialog.isConnected, false);
});

test('does not treat another selected class in the same professional container as success', () => {
  const dom = createCapturedProfessionalDom();
  const document = new FakeDocument([dom.courseRow, dom.classContainer, dom.nextCourse]);
  const adapter = loadAdapter(document);
  const candidate = adapter.buildDomCandidate(dom.availableItem, '测试课程', 0);

  assert.equal(adapter.candidateIsSelected(candidate), false);
  dom.availableButton.classList.remove('cv-choice');
  dom.availableButton.classList.add('cv-delete-select');
  dom.availableButton.innerText = '退选';
  assert.equal(adapter.candidateIsSelected(candidate), true);
});

test('accepts only the matching teaching class studentstatus result as success', () => {
  const dom = createCapturedProfessionalDom();
  const document = new FakeDocument([dom.courseRow, dom.classContainer, dom.nextCourse]);
  const adapter = loadAdapter(document);
  const candidate = adapter.buildDomCandidate(dom.availableItem, '测试课程', 0);
  const checkpoint = adapter.grabNetworkMonitorForTest.checkpoint();

  document.dispatchEvent(new CustomEvent('nju-autograb-network-v1', {
    detail: JSON.stringify({
      path: '/elective/studentstatus.do',
      status: 500,
      code: '-1',
      message: '其他教学班失败',
      teachingClassId: 'class-1'
    })
  }));
  assert.equal(adapter.selectionObservationAfter(candidate, checkpoint), null);

  document.dispatchEvent(new CustomEvent('nju-autograb-network-v1', {
    detail: JSON.stringify({
      path: '/elective/studentstatus.do',
      status: 200,
      code: '1',
      message: '处理成功',
      teachingClassId: 'class-2'
    })
  }));
  assert.deepEqual(
    { ...adapter.selectionObservationAfter(candidate, checkpoint) },
    { outcome: 'SUCCESS', message: '处理成功' }
  );
});

test('does not fan out a global selection-window rejection to other candidates', () => {
  const dom = createCapturedProfessionalDom();
  const document = new FakeDocument([dom.courseRow, dom.classContainer, dom.nextCourse]);
  const adapter = loadAdapter(document);
  const candidate = adapter.buildDomCandidate(dom.availableItem, '测试课程', 0);
  const checkpoint = adapter.grabNetworkMonitorForTest.checkpoint();

  document.dispatchEvent(new CustomEvent('nju-autograb-network-v1', {
    detail: JSON.stringify({
      path: '/elective/volunteer.do',
      status: 200,
      code: '0',
      message: '当前时间不在选课开放时间范围内',
      teachingClassId: ''
    })
  }));

  assert.deepEqual(
    { ...adapter.selectionObservationAfter(candidate, checkpoint) },
    {
      outcome: 'REJECTED',
      message: '当前时间不在选课开放时间范围内',
      retryOtherCandidate: false
    }
  );
});

test('scans a structured target down to the exact professional teaching class', async () => {
  const dom = createCapturedProfessionalDom();
  const document = new FakeDocument([dom.courseRow, dom.classContainer, dom.nextCourse]);
  const adapter = loadAdapter(document);
  const target = grabTaskModel.normalizeTarget({
    name: '测试课程', courseNumber: 'COURSE-1', electiveBatchId: 'BATCH-1',
    teachingClassType: 'ZY', teachingClassId: 'class-2'
  });

  const result = await adapter.scanDomCandidates([target], { signal: new AbortController().signal });
  const candidates = result.get(target.targetId);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].teachingClassId, 'class-2');
});

test('builds a persistent exact target from a captured professional class item', () => {
  const dom = createCapturedProfessionalDom();
  const document = new FakeDocument([dom.courseRow, dom.classContainer, dom.nextCourse]);
  const adapter = loadAdapter(document);

  const target = adapter.targetFromCourseElement(dom.availableItem);

  assert.equal(target.kind, 'TEACHING_CLASS');
  assert.equal(target.name, '测试课程');
  assert.equal(target.courseNumber, 'COURSE-1');
  assert.equal(target.electiveBatchId, 'BATCH-1');
  assert.equal(target.teachingClassType, 'ZY');
  assert.equal(target.teachingClassId, 'class-2');
  assert.equal(target.targetId, 'class:BATCH-1:ZY:class-2');
});

test('persists a page-added teaching class without losing legacy keyword targets', async () => {
  const dom = createCapturedProfessionalDom();
  const document = new FakeDocument([dom.courseRow, dom.classContainer, dom.nextCourse]);
  const adapter = loadAdapter(document);
  const target = adapter.targetFromCourseElement(dom.availableItem);
  const button = {
    disabled: false,
    textContent: '加入监控',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    removeAttribute() {}
  };

  await adapter.addConfiguredGrabTarget(target, button);

  const saved = adapter.storageWritesForTest.at(-1)[grabTaskModel.STORAGE_KEY];
  assert.deepEqual(Array.from(saved.targets, item => item.name), ['旧关键词', '测试课程']);
  assert.equal(saved.targets[1].teachingClassId, 'class-2');
  assert.equal(button.textContent, '移除监控');
  assert.equal(button.disabled, false);
});

test('reads available and full public-course rows as separate exact candidates', async () => {
  const dom = createCapturedPublicDom();
  const document = new FakeDocument([dom.full.row, dom.open.row]);
  const adapter = loadAdapter(document);

  const result = await adapter.scanDomCandidates(['公共测试课程'], {
    signal: new AbortController().signal
  });
  const candidates = result.get(grabTaskModel.normalizeTarget('公共测试课程').targetId);

  assert.deepEqual(Array.from(candidates, candidate => ({
    id: candidate.teachingClassId,
    courseNumber: candidate.courseNumber,
    status: candidate.status
  })), [
    { id: 'public-full', courseNumber: 'PUBLIC-1', status: 'FULL' },
    { id: 'public-open', courseNumber: 'PUBLIC-1', status: 'AVAILABLE' }
  ]);
});

test('keeps the exact available class when a same-name class is full', async () => {
  const dom = createCapturedPublicDom();
  const document = new FakeDocument([dom.full.row, dom.open.row]);
  const adapter = loadAdapter(document);
  const target = adapter.targetFromCourseElement(dom.open.row);

  const result = await adapter.scanDomCandidates([target], {
    signal: new AbortController().signal
  });

  assert.equal(JSON.stringify(Array.from(result.get(target.targetId), candidate => [
    candidate.teachingClassId,
    candidate.status
  ])), JSON.stringify([['public-open', 'AVAILABLE']]));
});

test('builds a persistent exact target with public-course metadata', () => {
  const dom = createCapturedPublicDom();
  const document = new FakeDocument([dom.open.row]);
  const adapter = loadAdapter(document);

  const target = adapter.targetFromCourseElement(dom.open.row);

  assert.equal(target.name, '公共测试课程');
  assert.equal(target.courseNumber, 'PUBLIC-1');
  assert.equal(target.teachingClassId, 'public-open');
  assert.equal(target.teacher, '教师甲');
  assert.equal(target.time, '周一 1-2 节');
  assert.equal(target.campus, '仙林校区');
});

test('applies keyword teacher, time, and campus filters to DOM candidates', async () => {
  const dom = createCapturedPublicDom();
  const document = new FakeDocument([dom.full.row, dom.open.row]);
  const adapter = loadAdapter(document);
  const matchingTarget = grabTaskModel.normalizeTarget({
    name: '公共测试课程',
    filters: { teacher: '教师甲', time: '周一', campus: '仙林' }
  });
  const rejectedTarget = grabTaskModel.normalizeTarget({
    name: '公共测试课程',
    filters: { teacher: '教师甲', time: '周一', campus: '鼓楼' }
  });

  const result = await adapter.scanDomCandidates([matchingTarget, rejectedTarget], {
    signal: new AbortController().signal
  });

  assert.equal(result.get(matchingTarget.targetId).length, 2);
  assert.equal(result.get(rejectedTarget.targetId).length, 0);
  assert.equal(result.get(matchingTarget.targetId)[0].teacher, '教师甲');
  assert.equal(result.get(matchingTarget.targetId)[0].time, '周一 1-2 节');
  assert.equal(result.get(matchingTarget.targetId)[0].campus, '仙林校区');
});

test('treats a captured favorite-course disabled link as full and never clickable', async () => {
  const dom = createCapturedFavoriteDom();
  const document = new FakeDocument([dom.row]);
  const adapter = loadAdapter(document);

  assert.equal(adapter.findChoiceButton(dom.row), null);
  const result = await adapter.scanDomCandidates(['收藏测试课程'], {
    signal: new AbortController().signal
  });
  const [candidate] = result.get(grabTaskModel.normalizeTarget('收藏测试课程').targetId);

  assert.equal(candidate.teachingClassId, 'favorite-full');
  assert.equal(candidate.courseNumber, 'FAVORITE-1');
  assert.equal(candidate.status, 'FULL');
  assert.equal(candidate.choiceBtn, null);
});

test('prioritizes selected state over a full marker in a favorite row', () => {
  const selectedButton = new FakeElement('button', {
    classes: ['cv-btn'],
    attributes: { 'data-tcid': 'favorite-selected', 'data-isfull': '1' },
    text: '已满'
  });
  const row = new FakeElement('tr', {
    classes: ['course-tr', 'ischoosed'],
    children: [selectedButton]
  });
  const adapter = loadAdapter(new FakeDocument([row]));

  assert.equal(adapter.buildDomCandidate(row, '收藏测试课程', 0).status, 'SELECTED');
});

test('scans an available favorite row whose action is not cv-choice', async () => {
  const choice = new FakeElement('button', {
    classes: ['cv-btn', 'choose-course'],
    attributes: { 'data-tcid': 'favorite-open', 'data-coursenumber': 'FAVORITE-1' },
    text: '选择'
  });
  const row = new FakeElement('tr', {
    classes: ['course-tr'],
    attributes: { 'data-coursenumber': 'FAVORITE-1' },
    children: [
      new FakeElement('td', { classes: ['kcmc'], text: '收藏测试课程' }),
      choice
    ]
  });
  const adapter = loadAdapter(new FakeDocument([row]));
  const result = await adapter.scanDomCandidates(['收藏测试课程'], {
    signal: new AbortController().signal
  });

  assert.equal(result.get(grabTaskModel.normalizeTarget('收藏测试课程').targetId)[0].status, 'AVAILABLE');
});

test('toggles a page-added target back out of persistent monitoring', async () => {
  const dom = createCapturedProfessionalDom();
  const adapter = loadAdapter(new FakeDocument([dom.courseRow, dom.classContainer, dom.nextCourse]));
  const target = adapter.targetFromCourseElement(dom.availableItem);
  const button = new FakeElement('button', { text: '加入监控' });

  await adapter.addConfiguredGrabTarget(target, button);
  await adapter.removeConfiguredGrabTarget(target, button);

  assert.equal(adapter.storageStateForTest[grabTaskModel.STORAGE_KEY].targets.some(item => item.targetId === target.targetId), false);
  assert.equal(button.textContent, '加入监控');
  assert.equal(button.disabled, false);
});

test('builds a persistent exact target from a captured favorite-course row', () => {
  const dom = createCapturedFavoriteDom();
  const document = new FakeDocument([dom.row]);
  const adapter = loadAdapter(document);

  const target = adapter.targetFromCourseElement(dom.row);

  assert.equal(target.name, '收藏测试课程');
  assert.equal(target.courseNumber, 'FAVORITE-1');
  assert.equal(target.teachingClassId, 'favorite-full');
  assert.equal(target.teachingClassType, 'GG02');
  assert.equal(target.queryScope, 'SC');
  assert.equal(target.teacher, '教师乙');
  assert.equal(target.time, '周二 3-4 节');
  assert.equal(target.campus, '鼓楼校区');
});

test('imports only visible favorite rows as deduplicated exact targets', async () => {
  const favorite = createCapturedFavoriteDom();
  const publicCourses = createCapturedPublicDom();
  const courseList = new FakeElement('div', {
    classes: ['course-list'],
    children: [favorite.row, publicCourses.open.row]
  });
  const adapter = loadAdapter(new FakeDocument([courseList]), {
    storageState: { nju_grab_courses: '' }
  });

  const collected = adapter.collectFavoriteCourseTargets();
  assert.equal(collected.length, 1);
  assert.equal(collected[0].teachingClassId, 'favorite-full');
  assert.equal(collected[0].teacher, '教师乙');

  const first = await adapter.importFavoriteCourseTargets();
  assert.deepEqual({ ...first }, {
    ok: true,
    discoveredCount: 1,
    addedCount: 1,
    enrichedCount: 0,
    existingCount: 0,
    capacitySkippedCount: 0,
    totalTargetCount: 1
  });
  const saved = adapter.storageStateForTest[grabTaskModel.STORAGE_KEY];
  assert.equal(saved.targets.length, 1);
  assert.equal(saved.targets[0].targetId, 'class:BATCH-1:GG02:favorite-full');
  assert.equal(saved.targets[0].queryScope, 'SC');
  assert.equal(saved.targets[0].priority, 0);
  assert.equal(saved.groups.length, 1);
  assert.equal(saved.groups[0].groupId, 'group:class%3ABATCH-1%3AGG02%3Afavorite-full');
  assert.equal(saved.groups[0].requiredCount, 1);

  const second = await adapter.importFavoriteCourseTargets();
  assert.equal(second.addedCount, 0);
  assert.equal(second.existingCount, 1);
  assert.equal(adapter.storageWritesForTest.length, 1);
});

test('favorite import enriches a legacy exact target with its catalog query scope', async () => {
  const favorite = createCapturedFavoriteDom();
  const legacyTarget = grabTaskModel.normalizeTarget({
    name: '收藏测试课程',
    electiveBatchId: 'BATCH-1',
    teachingClassType: 'ZY',
    teachingClassId: 'favorite-full',
    priority: 9
  });
  const legacyConfig = grabTaskModel.normalizeTaskConfig({
    schemaVersion: 3,
    groups: [{ groupId: 'legacy-favorite', label: '收藏保留组', targets: [legacyTarget], requiredCount: 1 }]
  });
  const courseList = new FakeElement('div', {
    classes: ['course-list'],
    children: [favorite.row]
  });
  const adapter = loadAdapter(new FakeDocument([courseList]), {
    storageState: { [grabTaskModel.STORAGE_KEY]: legacyConfig }
  });

  const result = await adapter.importFavoriteCourseTargets();

  assert.equal(result.addedCount, 0);
  assert.equal(result.enrichedCount, 1);
  assert.equal(adapter.storageWritesForTest.length, 1);
  const saved = adapter.storageStateForTest[grabTaskModel.STORAGE_KEY];
  assert.equal(saved.targets.length, 1);
  assert.equal(saved.targets[0].targetId, 'class:BATCH-1:GG02:favorite-full');
  assert.equal(saved.targets[0].queryScope, 'SC');
  assert.equal(saved.targets[0].priority, 9);
  assert.equal(saved.groups.length, 1);
  assert.equal(saved.groups[0].groupId, 'legacy-favorite');
  assert.equal(saved.groups[0].label, '收藏保留组');
  assert.equal(saved.groups[0].requiredCount, 1);
});

test('favorite import refuses to treat ordinary course rows as favorites', async () => {
  const publicCourses = createCapturedPublicDom();
  const courseList = new FakeElement('div', {
    classes: ['course-list'],
    children: [publicCourses.open.row]
  });
  const adapter = loadAdapter(new FakeDocument([courseList]));

  const result = await adapter.importFavoriteCourseTargets();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_FAVORITES_VISIBLE');
  assert.equal(adapter.storageWritesForTest.length, 0);
});

test('favorite import cannot rewrite target configuration while monitoring is active', async () => {
  const favorite = createCapturedFavoriteDom();
  const courseList = new FakeElement('div', {
    classes: ['course-list'],
    children: [favorite.row]
  });
  const adapter = loadAdapter(new FakeDocument([courseList]), {
    grabState: { running: true }
  });

  const result = await adapter.importFavoriteCourseTargets();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TASK_RUNNING');
  assert.equal(adapter.storageWritesForTest.length, 0);
});
