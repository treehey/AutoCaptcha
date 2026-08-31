const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bridgeSource = readFileSync(resolve(__dirname, '..', 'grab-network-bridge.js'), 'utf8');

class FakeXmlHttpRequest extends EventTarget {
  static instances = [];

  constructor() {
    super();
    this.headers = [];
    FakeXmlHttpRequest.instances.push(this);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name, value) {
    this.headers.push([name, value]);
  }

  send(body) {
    this.requestBody = body;
  }

  complete({ status = 200, responseText = '', responseType = '' } = {}) {
    this.status = status;
    this.responseText = responseText;
    this.responseType = responseType;
    this.dispatchEvent(new Event('loadend'));
  }

  abort() {
    this.status = 0;
    this.dispatchEvent(new Event('loadend'));
  }
}

const fakeXhrMethods = Object.freeze({
  open: FakeXmlHttpRequest.prototype.open,
  setRequestHeader: FakeXmlHttpRequest.prototype.setRequestHeader,
  send: FakeXmlHttpRequest.prototype.send,
  abort: FakeXmlHttpRequest.prototype.abort
});

function installBridge(options = {}) {
  FakeXmlHttpRequest.instances = [];
  Object.assign(FakeXmlHttpRequest.prototype, fakeXhrMethods);
  const document = new EventTarget();
  const scheduleTimeout = options.setTimeout || ((callback) => setImmediate(callback));
  const context = vm.createContext({
    console,
    CustomEvent,
    Date: options.Date || Date,
    document,
    Event,
    FormData,
    location: { href: 'https://xk.nju.edu.cn/xsxkapp/sys/xsxkapp/grablessons.do' },
    URL,
    URLSearchParams,
    setTimeout: scheduleTimeout,
    XMLHttpRequest: FakeXmlHttpRequest,
    fetch: options.fetch
  });
  context.globalThis = context;
  context.window = context;
  vm.runInContext(bridgeSource, context, { filename: 'grab-network-bridge.js' });
  return { context, document };
}

function nextCourseDetail(document) {
  return new Promise(resolveEvent => {
    document.addEventListener('nju-autograb-course-result-v1', event => {
      resolveEvent(JSON.parse(event.detail));
    }, { once: true });
  });
}

function nextDetail(document) {
  return new Promise(resolveEvent => {
    document.addEventListener('nju-autograb-network-v1', event => {
      resolveEvent(JSON.parse(event.detail));
    }, { once: true });
  });
}

function captureQueryTemplate(context, path, teachingClassType) {
  const xhr = new context.XMLHttpRequest();
  const setting = {
    data: {
      electiveBatchCode: 'BATCH-1',
      teachingClassType,
      queryContent: ''
    },
    pageSize: '10',
    pageNumber: '0'
  };
  xhr.open('POST', `/xsxkapp/sys/xsxkapp/elective/${path}`);
  xhr.send(new URLSearchParams({ querySetting: JSON.stringify(setting) }).toString());
  xhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
  return xhr;
}

test('reports an exact teaching class result without leaking the student code', async () => {
  const { context, document } = installBridge();
  const detailPromise = nextDetail(document);
  const xhr = new context.XMLHttpRequest();

  xhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/studentstatus.do');
  xhr.send('studentCode=123456789&teachingClassId=class-2&type=1');
  xhr.complete({ responseText: JSON.stringify({ code: '1', msg: '处理成功', data: { studentCode: '123456789' } }) });

  const detail = await detailPromise;
  assert.equal(detail.path, '/elective/studentstatus.do');
  assert.equal(detail.code, '1');
  assert.equal(detail.teachingClassId, 'class-2');
  assert.equal(detail.message, '处理成功');
  assert.equal(JSON.stringify(detail).includes('123456789'), false);
});

test('reports a volunteer teaching class ID when the page sends it without exposing other parameters', async () => {
  const { context, document } = installBridge();
  const detailPromise = nextDetail(document);
  const xhr = new context.XMLHttpRequest();

  xhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/volunteer.do');
  xhr.send('addParam=encrypted-secret&studentCode=123456789&teachingClassId=class-2');
  xhr.complete({ responseText: JSON.stringify({ code: '0', msg: '当前时间不在选课开放时间范围内' }) });

  const detail = await detailPromise;
  assert.equal(detail.path, '/elective/volunteer.do');
  assert.equal(detail.code, '0');
  assert.equal(detail.teachingClassId, 'class-2');
  assert.equal(detail.message, '当前时间不在选课开放时间范围内');
  assert.equal(JSON.stringify(detail).includes('encrypted-secret'), false);
  assert.equal(JSON.stringify(detail).includes('123456789'), false);
});

test('does not guess a volunteer teaching class ID from encrypted parameters', async () => {
  const { context, document } = installBridge();
  const detailPromise = nextDetail(document);
  const xhr = new context.XMLHttpRequest();

  xhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/volunteer.do');
  xhr.send('addParam=encrypted-secret&studentCode=123456789');
  xhr.complete({ responseText: JSON.stringify({ code: '0', msg: '添加选课失败' }) });

  const detail = await detailPromise;
  assert.equal(detail.teachingClassId, '');
  assert.equal(JSON.stringify(detail).includes('encrypted-secret'), false);
});

test('consumes an armed automated class for one encrypted volunteer XHR only', async () => {
  const { context, document } = installBridge();
  document.dispatchEvent(new CustomEvent('nju-autograb-volunteer-arm-v1', {
    detail: JSON.stringify({ action: 'arm', teachingClassId: 'class-a' })
  }));
  const armedDetail = nextDetail(document);
  const automated = new context.XMLHttpRequest();
  automated.open('POST', '/xsxkapp/sys/xsxkapp/elective/volunteer.do');
  automated.send('addParam=encrypted-secret&studentCode=123456789');
  automated.complete({ responseText: JSON.stringify({ code: '0', msg: '课程冲突' }) });
  assert.equal((await armedDetail).teachingClassId, 'class-a');

  const manualDetail = nextDetail(document);
  const manual = new context.XMLHttpRequest();
  manual.open('POST', '/xsxkapp/sys/xsxkapp/elective/volunteer.do');
  manual.send('addParam=encrypted-secret&studentCode=123456789');
  manual.complete({ responseText: JSON.stringify({ code: '0', msg: '课程冲突' }) });
  assert.equal((await manualDetail).teachingClassId, '');
});

test('consumes an armed automated class for an encrypted volunteer fetch request', async () => {
  const fetch = async () => ({
    status: 200,
    url: 'https://xk.nju.edu.cn/xsxkapp/sys/xsxkapp/elective/volunteer.do',
    clone: () => ({ text: async () => JSON.stringify({ code: '0', msg: '名额已满' }) })
  });
  const { context, document } = installBridge({ fetch });
  document.dispatchEvent(new CustomEvent('nju-autograb-volunteer-arm-v1', {
    detail: JSON.stringify({ action: 'arm', teachingClassId: 'class-a' })
  }));
  const detailPromise = nextDetail(document);
  await context.fetch('/xsxkapp/sys/xsxkapp/elective/volunteer.do', {
    method: 'POST', body: 'addParam=encrypted-secret&studentCode=123456789'
  });
  assert.equal((await detailPromise).teachingClassId, 'class-a');
});

test('reports course query completion without exposing query settings', async () => {
  const { context, document } = installBridge();
  const detailPromise = nextDetail(document);
  const xhr = new context.XMLHttpRequest();

  xhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/programCourse.do');
  xhr.send('querySetting=sensitive-query-json');
  xhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [{ courseName: '测试课程' }] }) });

  const detail = await detailPromise;
  assert.equal(detail.path, '/elective/programCourse.do');
  assert.equal(detail.code, '1');
  assert.equal(detail.status, 200);
  assert.equal(JSON.stringify(detail).includes('sensitive-query-json'), false);
  assert.equal(JSON.stringify(detail).includes('测试课程'), false);
});

test('replays the native query template and exposes only normalized course candidates', async () => {
  const { context, document } = installBridge();
  const nativeXhr = new context.XMLHttpRequest();
  const nativeSetting = {
    data: {
      studentCode: '123456789',
      electiveBatchCode: 'BATCH-1',
      teachingClassType: 'ZY',
      queryContent: ''
    },
    pageSize: '10',
    pageNumber: '0',
    order: 'isChoose -'
  };
  nativeXhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/programCourse.do');
  nativeXhr.setRequestHeader('token', 'session-secret');
  nativeXhr.send(new URLSearchParams({ querySetting: JSON.stringify(nativeSetting) }).toString());
  nativeXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });

  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({
      action: 'query',
      requestId: 'request-1',
      searches: [{ searchId: 'target-1', query: 'COURSE-1' }]
    })
  }));

  const replayXhr = FakeXmlHttpRequest.instances.at(-1);
  assert.notEqual(replayXhr, nativeXhr);
  assert.deepEqual(replayXhr.headers, [['token', 'session-secret']]);
  const replaySetting = JSON.parse(new URLSearchParams(replayXhr.requestBody).get('querySetting'));
  assert.equal(replaySetting.data.queryContent, 'COURSE-1');
  assert.equal(replaySetting.data.studentCode, '123456789');
  assert.equal(replaySetting.pageSize, '100');

  replayXhr.complete({
    responseText: JSON.stringify({
      code: '1',
      dataList: [{
        courseName: '测试课程',
        courseNumber: 'COURSE-1',
        isChoose: '1',
        tcList: [
          { teachingClassID: 'class-full', teacherName: '教师甲', isChoose: '0', isFull: '1', classCapacity: '30' },
          {
            teachingClassID: 'class-open', teacherName: '教师乙', teachingTime: '周二 3-4 节',
            teachingPlace: '教学楼 101', campusName: '鼓楼校区', isChoose: '0', isFull: '0', classCapacity: '30'
          }
        ]
      }]
    })
  });

  const detail = await resultPromise;
  assert.equal(detail.ok, true);
  assert.deepEqual(detail.results[0].candidates.map(candidate => ({
    id: candidate.teachingClassId,
    status: candidate.status,
    courseNumber: candidate.courseNumber,
    type: candidate.teachingClassType,
    batch: candidate.electiveBatchId
  })), [
    { id: 'class-full', status: 'FULL', courseNumber: 'COURSE-1', type: 'ZY', batch: 'BATCH-1' },
    { id: 'class-open', status: 'AVAILABLE', courseNumber: 'COURSE-1', type: 'ZY', batch: 'BATCH-1' }
  ]);
  assert.equal(detail.results[0].candidates[1].teacher, '教师乙');
  assert.equal(detail.results[0].candidates[1].time, '周二 3-4 节 教学楼 101');
  assert.equal(detail.results[0].candidates[1].campus, '鼓楼校区');
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes('123456789'), false);
  assert.equal(serialized.includes('session-secret'), false);
  assert.equal(serialized.includes('querySetting'), false);
});

test('classifies a followed-login HTML response as auth expiry instead of empty course data', async () => {
  const { context, document } = installBridge();
  const nativeXhr = new context.XMLHttpRequest();
  const nativeSetting = { data: { electiveBatchCode: 'BATCH-1', teachingClassType: 'ZY', queryContent: '' } };
  nativeXhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/programCourse.do');
  nativeXhr.send(new URLSearchParams({ querySetting: JSON.stringify(nativeSetting) }).toString());
  nativeXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({ action: 'query', requestId: 'request-auth-html', searches: [{ searchId: 'target-1', query: 'COURSE-1' }] })
  }));
  const replayXhr = FakeXmlHttpRequest.instances.at(-1);
  replayXhr.complete({ status: 200, responseText: '<html><body><div id="loginDiv">登录</div></body></html>' });
  const detail = await resultPromise;
  assert.equal(detail.ok, true);
  assert.equal(detail.results[0].outcome, 'AUTH_EXPIRED');
});

test('classifies a server-error HTML response as server error, not auth expiry', async () => {
  const { context, document } = installBridge();
  const nativeXhr = new context.XMLHttpRequest();
  const nativeSetting = { data: { electiveBatchCode: 'BATCH-1', teachingClassType: 'ZY', queryContent: '' } };
  nativeXhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/programCourse.do');
  nativeXhr.send(new URLSearchParams({ querySetting: JSON.stringify(nativeSetting) }).toString());
  nativeXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });

  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({ action: 'query', requestId: 'request-server-html', searches: [{ searchId: 'target-1', query: 'COURSE-1' }] })
  }));
  const replayXhr = FakeXmlHttpRequest.instances.at(-1);
  replayXhr.complete({ status: 500, responseText: '<html><body>服务器暂时不可用</body></html>' });
  const detail = await resultPromise;
  assert.equal(detail.results[0].outcome, 'SERVER_ERROR');
});

test('classifies a redirected HTML login page by explicit login evidence', async () => {
  const { context, document } = installBridge();
  const nativeXhr = new context.XMLHttpRequest();
  const nativeSetting = { data: { electiveBatchCode: 'BATCH-1', teachingClassType: 'ZY', queryContent: '' } };
  nativeXhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/programCourse.do');
  nativeXhr.send(new URLSearchParams({ querySetting: JSON.stringify(nativeSetting) }).toString());
  nativeXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });

  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({ action: 'query', requestId: 'request-redirect-login', searches: [{ searchId: 'target-1', query: 'COURSE-1' }] })
  }));
  const replayXhr = FakeXmlHttpRequest.instances.at(-1);
  replayXhr.complete({ status: 200, responseText: '<html><body><form action="/authserver/login"><input name="username"></form></body></html>' });
  const detail = await resultPromise;
  assert.equal(detail.results[0].outcome, 'AUTH_EXPIRED');
});

test('replays all targets from a normal five-course monitoring round', async () => {
  const { context, document } = installBridge({
    setTimeout(callback) {
      callback();
      return 1;
    }
  });
  const nativeXhr = new context.XMLHttpRequest();
  const nativeSetting = {
    data: {
      studentCode: '123456789',
      electiveBatchCode: 'BATCH-1',
      teachingClassType: 'ZY',
      queryContent: ''
    },
    pageSize: '10',
    pageNumber: '0'
  };
  nativeXhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/programCourse.do');
  nativeXhr.send(new URLSearchParams({ querySetting: JSON.stringify(nativeSetting) }).toString());
  nativeXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });

  const searches = Array.from({ length: 5 }, (_, index) => ({
    searchId: `target-${index + 1}`,
    query: `COURSE-${index + 1}`
  }));
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({ action: 'query', requestId: 'request-five', searches })
  }));

  const replayedQueries = [];
  for (let index = 0; index < searches.length; index += 1) {
    await new Promise(resolveEvent => setImmediate(resolveEvent));
    const replayXhr = FakeXmlHttpRequest.instances[index + 1];
    assert.ok(replayXhr, `missing replay request ${index + 1}`);
    const replaySetting = JSON.parse(new URLSearchParams(replayXhr.requestBody).get('querySetting'));
    replayedQueries.push(replaySetting.data.queryContent);
    replayXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
  }

  const detail = await resultPromise;
  assert.equal(detail.ok, true);
  assert.deepEqual(replayedQueries, searches.map(search => search.query));
  assert.deepEqual(detail.results.map(result => result.searchId), searches.map(search => search.searchId));
});

test('queries 12 public courses serially and pauses before searches 4, 7, and 10', async () => {
  const waits = [];
  let currentTime = 0;
  const { context, document } = installBridge({
    Date: { now: () => currentTime },
    setTimeout(callback, delay) {
      waits.push({ callback, delay });
      return waits.length;
    }
  });
  const nativeXhr = new context.XMLHttpRequest();
  const nativeSetting = {
    data: {
      studentCode: '123456789',
      electiveBatchCode: 'BATCH-1',
      teachingClassType: 'GG02',
      queryContent: ''
    },
    pageSize: '10',
    pageNumber: '0'
  };
  nativeXhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/programCourse.do');
  nativeXhr.send(new URLSearchParams({ querySetting: JSON.stringify(nativeSetting) }).toString());
  nativeXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });

  const searches = Array.from({ length: 12 }, (_, index) => ({
    searchId: `target-${index + 1}`,
    query: `COURSE-${index + 1}`,
    queryScope: 'GG02'
  }));
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({ action: 'query', requestId: 'request-many-batched', searches })
  }));

  for (let index = 0; index < searches.length; index += 1) {
    await new Promise(resolveEvent => setImmediate(resolveEvent));
    assert.equal(FakeXmlHttpRequest.instances.length, index + 2, 'public queries remain serial');
    currentTime += 250;
    FakeXmlHttpRequest.instances[index + 1].complete({
      responseText: JSON.stringify({ code: '1', dataList: [] })
    });

    const completedCount = index + 1;
    if (completedCount % 3 === 0 && completedCount < searches.length) {
      await new Promise(resolveEvent => setImmediate(resolveEvent));
      assert.equal(FakeXmlHttpRequest.instances.length, index + 2,
        'the next query waits at each three-query public-course boundary');
      assert.equal(waits.length, 1);
      assert.equal(waits[0].delay, 1000,
        'the full one-second cooldown starts after the third response completes');
      currentTime += waits[0].delay;
      waits.shift().callback();
    }
  }

  const detail = await resultPromise;
  assert.equal(waits.length, 0);
  assert.deepEqual(detail.results.map(result => result.searchId), searches.map(search => search.searchId));
});

test('starts an exact 1000ms cooldown after the third public response completes', async () => {
  const waits = [];
  let currentTime = 0;
  const { context, document } = installBridge({
    Date: { now: () => currentTime },
    setTimeout(callback, delay) {
      waits.push({ callback, delay });
      return waits.length;
    }
  });
  captureQueryTemplate(context, 'programCourse.do', 'GG02');
  const searches = Array.from({ length: 4 }, (_, index) => ({
    searchId: `fast-${index + 1}`,
    query: `FAST-${index + 1}`,
    queryScope: 'GG02'
  }));
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({ action: 'query', requestId: 'request-exact-cooldown', searches })
  }));

  for (let index = 0; index < 3; index += 1) {
    await new Promise(resolveEvent => setImmediate(resolveEvent));
    assert.equal(FakeXmlHttpRequest.instances.length, index + 2);
    FakeXmlHttpRequest.instances[index + 1].complete({
      responseText: JSON.stringify({ code: '1', dataList: [] })
    });
  }
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(FakeXmlHttpRequest.instances.length, 4);
  assert.deepEqual(waits.map(wait => wait.delay), [1000]);
  currentTime += 1000;
  waits.shift().callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  FakeXmlHttpRequest.instances[4].complete({
    responseText: JSON.stringify({ code: '1', dataList: [] })
  });
  const detail = await resultPromise;
  assert.deepEqual(detail.results.map(result => result.searchId), searches.map(search => search.searchId));
});

test('a non-public response consumes elapsed public cooldown time', async () => {
  const waits = [];
  let currentTime = 0;
  const { context, document } = installBridge({
    Date: { now: () => currentTime },
    setTimeout(callback, delay) {
      waits.push({ callback, delay });
      return waits.length;
    }
  });
  captureQueryTemplate(context, 'programCourse.do', 'GG02');
  captureQueryTemplate(context, 'queryfavorite.do', 'SC');
  const searches = [
    { searchId: 'public-1', query: 'PUBLIC-1', queryScope: 'GG02' },
    { searchId: 'public-2', query: 'PUBLIC-2', queryScope: 'GG02' },
    { searchId: 'public-3', query: 'PUBLIC-3', queryScope: 'GG02' },
    { searchId: 'favorite', query: 'FAVORITE', queryScope: 'SC' },
    { searchId: 'public-4', query: 'PUBLIC-4', queryScope: 'GG02' }
  ];
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({ action: 'query', requestId: 'request-interleaved-cooldown', searches })
  }));

  for (let index = 0; index < 3; index += 1) {
    await new Promise(resolveEvent => setImmediate(resolveEvent));
    FakeXmlHttpRequest.instances[index + 2].complete({
      responseText: JSON.stringify({ code: '1', dataList: [] })
    });
  }
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.match(FakeXmlHttpRequest.instances[5].url, /queryfavorite\.do$/);
  currentTime = 400;
  FakeXmlHttpRequest.instances[5].complete({
    responseText: JSON.stringify({ code: '1', dataList: [] })
  });
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(FakeXmlHttpRequest.instances.length, 6);
  assert.deepEqual(waits.map(wait => wait.delay), [600]);
  currentTime = 1000;
  waits.shift().callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  FakeXmlHttpRequest.instances[6].complete({
    responseText: JSON.stringify({ code: '1', dataList: [] })
  });
  const detail = await resultPromise;
  assert.deepEqual(detail.results.map(result => result.searchId), searches.map(search => search.searchId));
});

test('normalizes aliases and lowercase scopes for template lookup and shared public pacing', async () => {
  const waits = [];
  let currentTime = 0;
  const { context, document } = installBridge({
    Date: { now: () => currentTime },
    setTimeout(callback, delay) {
      waits.push({ callback, delay });
      return waits.length;
    }
  });
  captureQueryTemplate(context, 'programCourse.do', 'GG02');
  captureQueryTemplate(context, 'publicCourse.do', 'GG01');
  const searches = [
    { searchId: 'gg02-lower', query: 'LOWER', queryScope: 'gg02' },
    { searchId: 'tct3-alias', query: 'ALIAS', queryScope: 'TCT3' },
    { searchId: 'gg01', query: 'CANONICAL', queryScope: 'GG01' },
    { searchId: 'tct4-alias', query: 'SECOND-ALIAS', queryScope: 'TCT4' }
  ];
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({ action: 'query', requestId: 'request-scope-aliases', searches })
  }));

  const replayedPaths = [];
  for (let index = 0; index < 3; index += 1) {
    await new Promise(resolveEvent => setImmediate(resolveEvent));
    replayedPaths.push(FakeXmlHttpRequest.instances[index + 2].url);
    FakeXmlHttpRequest.instances[index + 2].complete({
      responseText: JSON.stringify({ code: '1', dataList: [] })
    });
  }
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  assert.equal(FakeXmlHttpRequest.instances.length, 5);
  assert.deepEqual(waits.map(wait => wait.delay), [1000]);
  currentTime = 1000;
  waits.shift().callback();
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  replayedPaths.push(FakeXmlHttpRequest.instances[5].url);
  FakeXmlHttpRequest.instances[5].complete({
    responseText: JSON.stringify({ code: '1', dataList: [] })
  });
  const detail = await resultPromise;
  assert.deepEqual(replayedPaths.map(path => path.match(/[^/]+\.do$/)[0]), [
    'programCourse.do', 'publicCourse.do', 'publicCourse.do', 'programCourse.do'
  ]);
  assert.deepEqual(detail.results.map(result => result.queryScope), ['GG02', 'GG01', 'GG01', 'GG02']);
});

test('stops before a third search when the second public response expires auth', async () => {
  const { context, document } = installBridge();
  captureQueryTemplate(context, 'programCourse.do', 'GG02');
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({
      action: 'query',
      requestId: 'request-auth-second',
      searches: [1, 2, 3].map(index => ({ searchId: `auth-${index}`, query: `AUTH-${index}`, queryScope: 'GG02' }))
    })
  }));
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  FakeXmlHttpRequest.instances[1].complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  FakeXmlHttpRequest.instances[2].complete({ status: 401, responseText: '' });
  const detail = await resultPromise;
  assert.equal(FakeXmlHttpRequest.instances.length, 3);
  assert.deepEqual(detail.results.map(result => result.outcome), ['', 'AUTH_EXPIRED']);
});

test('promotes a public-course request-too-fast response to auth recovery and stops', async () => {
  const { context, document } = installBridge();
  captureQueryTemplate(context, 'programCourse.do', 'GG02');
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({
      action: 'query',
      requestId: 'request-message-rate-limit',
      searches: [1, 2, 3].map(index => ({ searchId: `limit-${index}`, query: `LIMIT-${index}`, queryScope: 'GG02' }))
    })
  }));
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  FakeXmlHttpRequest.instances[1].complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
  await new Promise(resolveEvent => setImmediate(resolveEvent));
  FakeXmlHttpRequest.instances[2].complete({
    status: 500,
    responseText: JSON.stringify({ code: '0', msg: '请求过快，请登录后再试' })
  });
  const detail = await resultPromise;
  assert.equal(FakeXmlHttpRequest.instances.length, 3);
  assert.equal(detail.results.length, 2);
  assert.equal(detail.results[1].outcome, 'AUTH_EXPIRED');
  assert.match(detail.results[1].message, /重新登录/);
});

test('does not pace favorite-course queries that do not exhibit the public-course burst limit', async () => {
  const waits = [];
  const { context, document } = installBridge({
    setTimeout(callback, delay) {
      waits.push({ callback, delay });
      return waits.length;
    }
  });
  const nativeXhr = new context.XMLHttpRequest();
  const nativeSetting = {
    data: {
      studentCode: '123456789',
      electiveBatchCode: 'BATCH-1',
      teachingClassType: 'SC',
      queryContent: ''
    },
    pageSize: '10',
    pageNumber: '0'
  };
  nativeXhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/queryfavorite.do');
  nativeXhr.send(new URLSearchParams({ querySetting: JSON.stringify(nativeSetting) }).toString());
  nativeXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });

  const searches = Array.from({ length: 3 }, (_, index) => ({
    searchId: `favorite-${index + 1}`,
    query: `FAVORITE-${index + 1}`,
    queryScope: 'SC'
  }));
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({ action: 'query', requestId: 'request-favorites-unpaced', searches })
  }));

  for (let index = 0; index < searches.length; index += 1) {
    await new Promise(resolveEvent => setImmediate(resolveEvent));
    const replayXhr = FakeXmlHttpRequest.instances[index + 1];
    assert.ok(replayXhr, `favorite replay ${index + 1} should not wait for a pacing timer`);
    replayXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
  }

  const detail = await resultPromise;
  assert.equal(waits.length, 0);
  assert.deepEqual(detail.results.map(result => result.searchId), searches.map(search => search.searchId));
});

test('stops the remaining public-course batch and requests auth recovery after rate limiting', async () => {
  const { context, document } = installBridge();
  const nativeXhr = new context.XMLHttpRequest();
  const nativeSetting = {
    data: {
      studentCode: '123456789',
      electiveBatchCode: 'BATCH-1',
      teachingClassType: 'GG02',
      queryContent: ''
    },
    pageSize: '10',
    pageNumber: '0'
  };
  nativeXhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/programCourse.do');
  nativeXhr.send(new URLSearchParams({ querySetting: JSON.stringify(nativeSetting) }).toString());
  nativeXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });

  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({
      action: 'query',
      requestId: 'request-stop-after-limit',
      searches: Array.from({ length: 6 }, (_, index) => ({
        searchId: `target-${index + 1}`,
        query: `COURSE-${index + 1}`,
        queryScope: 'GG02'
      }))
    })
  }));

  await new Promise(resolveEvent => setImmediate(resolveEvent));
  FakeXmlHttpRequest.instances.at(-1).complete({ status: 429, responseText: '' });
  const detail = await resultPromise;

  assert.equal(FakeXmlHttpRequest.instances.length, 2, 'no later target should be queried after rate limiting');
  assert.equal(detail.results.length, 1);
  assert.equal(detail.results[0].outcome, 'AUTH_EXPIRED');
});

test('keeps a favorite-course rate limit as a normal retryable backoff', async () => {
  const { context, document } = installBridge();
  captureQueryTemplate(context, 'queryfavorite.do', 'SC');
  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({
      action: 'query',
      requestId: 'request-favorite-rate-limit',
      searches: [{ searchId: 'favorite-limit', query: 'FAVORITE-LIMIT', queryScope: 'SC' }]
    })
  }));

  await new Promise(resolveEvent => setImmediate(resolveEvent));
  FakeXmlHttpRequest.instances.at(-1).complete({ status: 429, responseText: '' });
  const detail = await resultPromise;

  assert.equal(detail.results[0].outcome, 'RATE_LIMITED');
});

test('routes a favorite target through its captured catalog after switching to the professional page', async () => {
  const { context, document } = installBridge();
  const captureTemplate = (path, teachingClassType) => {
    const xhr = new context.XMLHttpRequest();
    const setting = {
      data: {
        studentCode: '123456789',
        electiveBatchCode: 'BATCH-1',
        teachingClassType,
        queryContent: ''
      },
      pageSize: '10',
      pageNumber: '0'
    };
    xhr.open('POST', `/xsxkapp/sys/xsxkapp/elective/${path}`);
    xhr.send(new URLSearchParams({ querySetting: JSON.stringify(setting) }).toString());
    xhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
    return xhr;
  };
  captureTemplate('queryfavorite.do', 'SC');
  captureTemplate('programCourse.do', 'ZY');

  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({
      action: 'query',
      requestId: 'favorite-after-professional',
      searches: [{
        searchId: 'favorite-target',
        query: '网络新科学',
        queryScope: 'SC',
        teachingClassType: 'GG01'
      }]
    })
  }));

  await new Promise(resolveEvent => setImmediate(resolveEvent));
  const replayXhr = FakeXmlHttpRequest.instances.at(-1);
  assert.match(replayXhr.url, /queryfavorite\.do$/);
  replayXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
  const detail = await resultPromise;
  assert.equal(detail.results[0].outcome, '');
});

test('rotates an unscoped keyword across captured catalogs one request per round', async () => {
  const { context, document } = installBridge();
  const captureTemplate = (path, teachingClassType) => {
    const xhr = new context.XMLHttpRequest();
    const setting = {
      data: {
        studentCode: '123456789',
        electiveBatchCode: 'BATCH-1',
        teachingClassType,
        queryContent: ''
      },
      pageSize: '10',
      pageNumber: '0'
    };
    xhr.open('POST', `/xsxkapp/sys/xsxkapp/elective/${path}`);
    xhr.send(new URLSearchParams({ querySetting: JSON.stringify(setting) }).toString());
    xhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
  };
  captureTemplate('queryfavorite.do', 'SC');
  captureTemplate('programCourse.do', 'ZY');

  const replayedPaths = [];
  const observedScopes = [];
  for (let round = 0; round < 2; round += 1) {
    const resultPromise = nextCourseDetail(document);
    document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
      detail: JSON.stringify({
        action: 'query',
        requestId: `unscoped-round-${round}`,
        searches: [{ searchId: 'keyword-target', query: '跨页关键词课程' }]
      })
    }));

    await new Promise(resolveEvent => setImmediate(resolveEvent));
    const replayXhr = FakeXmlHttpRequest.instances.at(-1);
    replayedPaths.push(replayXhr.url);
    replayXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });
    const detail = await resultPromise;
    observedScopes.push(detail.results[0].queryScope);
  }

  assert.match(replayedPaths[0], /queryfavorite\.do$/);
  assert.match(replayedPaths[1], /programCourse\.do$/);
  assert.deepEqual(observedScopes, ['SC', 'ZY']);
  assert.equal(FakeXmlHttpRequest.instances.length, 4);
});

test('defers a scoped search instead of replaying an unrelated catalog template', async () => {
  const { context, document } = installBridge();
  const nativeXhr = new context.XMLHttpRequest();
  const nativeSetting = {
    data: {
      studentCode: '123456789',
      electiveBatchCode: 'BATCH-1',
      teachingClassType: 'ZY',
      queryContent: ''
    },
    pageSize: '10',
    pageNumber: '0'
  };
  nativeXhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/programCourse.do');
  nativeXhr.send(new URLSearchParams({ querySetting: JSON.stringify(nativeSetting) }).toString());
  nativeXhr.complete({ responseText: JSON.stringify({ code: '1', dataList: [] }) });

  const resultPromise = nextCourseDetail(document);
  document.dispatchEvent(new CustomEvent('nju-autograb-course-query-v1', {
    detail: JSON.stringify({
      action: 'query',
      requestId: 'missing-favorite-template',
      searches: [{ searchId: 'favorite-target', query: '网络新科学', queryScope: 'SC' }]
    })
  }));

  const detail = await resultPromise;
  assert.equal(FakeXmlHttpRequest.instances.length, 1);
  assert.equal(detail.ok, true);
  assert.equal(detail.results[0].outcome, 'OUT_OF_SCOPE');
  assert.match(detail.results[0].message, /收藏/);
});
