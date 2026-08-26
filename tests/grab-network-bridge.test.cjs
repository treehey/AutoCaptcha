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

function installBridge() {
  FakeXmlHttpRequest.instances = [];
  Object.assign(FakeXmlHttpRequest.prototype, fakeXhrMethods);
  const document = new EventTarget();
  const context = vm.createContext({
    console,
    CustomEvent,
    Date,
    document,
    Event,
    FormData,
    location: { href: 'https://xk.nju.edu.cn/xsxkapp/sys/xsxkapp/grablessons.do' },
    URL,
    URLSearchParams,
    XMLHttpRequest: FakeXmlHttpRequest
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

test('reports an immediate volunteer rejection without exposing encrypted parameters', async () => {
  const { context, document } = installBridge();
  const detailPromise = nextDetail(document);
  const xhr = new context.XMLHttpRequest();

  xhr.open('POST', '/xsxkapp/sys/xsxkapp/elective/volunteer.do');
  xhr.send('addParam=encrypted-secret&studentCode=123456789');
  xhr.complete({ responseText: JSON.stringify({ code: '0', msg: '当前时间不在选课开放时间范围内' }) });

  const detail = await detailPromise;
  assert.equal(detail.path, '/elective/volunteer.do');
  assert.equal(detail.code, '0');
  assert.equal(detail.teachingClassId, '');
  assert.equal(detail.message, '当前时间不在选课开放时间范围内');
  assert.equal(JSON.stringify(detail).includes('encrypted-secret'), false);
  assert.equal(JSON.stringify(detail).includes('123456789'), false);
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
