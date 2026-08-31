const assert = require('node:assert/strict');
const test = require('node:test');

const taskModel = require('../grab-task-model.js');
const { SCAN_MODE, createCourseProvider } = require('../grab-course-provider.js');

const CANDIDATE_STATUS = Object.freeze({
  SELECTED: 'SELECTED',
  AVAILABLE: 'AVAILABLE',
  FULL: 'FULL',
  DEFERRED: 'DEFERRED',
  UNAVAILABLE: 'UNAVAILABLE'
});

function networkEntry(overrides = {}) {
  return {
    teachingClassId: 'class-1',
    teachingClassType: 'GG',
    electiveBatchId: 'BATCH-1',
    courseNumber: 'COURSE-1',
    name: '测试课程',
    teacher: '教师甲',
    status: 'FULL',
    ...overrides
  };
}

test('uses verified network states without rendering full or selected courses into the DOM', async () => {
  const targets = taskModel.normalizeTargets([
    { name: '测试课程', teachingClassId: 'class-1', teachingClassType: 'GG', electiveBatchId: 'BATCH-1' },
    '已选测试课'
  ]);
  let domScans = 0;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    queryClient: {
      query: async searches => searches.map(search => ({
        searchId: search.searchId,
        candidates: search.searchId === targets[0].targetId
          ? [networkEntry()]
          : [networkEntry({ teachingClassId: 'selected-1', name: '已选测试课', status: 'SELECTED' })]
      }))
    },
    scanDom: async () => {
      domScans += 1;
      return new Map();
    }
  });

  const result = await provider.scan(targets, { signal: new AbortController().signal });

  assert.equal(result.get(targets[0].targetId)[0].status, 'FULL');
  assert.equal(result.get(targets[1].targetId)[0].status, 'SELECTED');
  assert.equal(domScans, 0);
  assert.deepEqual(result.diagnostics, {
    mode: SCAN_MODE.NETWORK,
    queriedTargetCount: 2,
    deferredTargetCount: 0,
    materializedQueryCount: 0,
    candidateCount: 2,
    fallbackReason: null
  });
});

test('keeps the exact available teaching class when a same-name class is full', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '昆曲艺术与民族文化',
    courseNumber: '00371880',
    electiveBatchId: '2026',
    teachingClassType: 'GG',
    teachingClassId: '2026202710037188002'
  }]);
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    queryClient: {
      query: async searches => searches.map(search => ({
        searchId: search.searchId,
        candidates: [
          networkEntry({
            teachingClassId: '2026202710037188001',
            courseNumber: '00371880',
            name: '昆曲艺术与民族文化',
            status: 'FULL'
          }),
          networkEntry({
            teachingClassId: '2026202710037188002',
            courseNumber: '00371880',
            name: '昆曲艺术与民族文化',
            status: 'AVAILABLE'
          })
        ]
      }))
    },
    scanDom: async () => new Map([[target.targetId, [{
      id: 'class:2026:GG:2026202710037188002',
      teachingClassId: '2026202710037188002',
      teachingClassType: 'GG',
      electiveBatchId: '2026',
      courseNumber: '00371880',
      name: '昆曲艺术与民族文化',
      status: 'AVAILABLE'
    }]]])
  });

  const result = await provider.scan([target], { signal: new AbortController().signal });
  const candidates = result.get(target.targetId);
  assert.deepEqual(candidates.map(candidate => [candidate.teachingClassId, candidate.status]), [
    ['2026202710037188002', 'AVAILABLE']
  ]);
});

test('applies keyword teacher, time, and campus filters to normalized network candidates', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '测试课程',
    filters: { teacher: '教师乙', time: '周二', campus: '鼓楼' }
  }]);
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    queryClient: {
      query: async () => [{
        searchId: target.targetId,
        candidates: [
          networkEntry({ teachingClassId: 'matching', teacher: '教师乙', time: '周二 3-4 节', campus: '鼓楼校区' }),
          networkEntry({ teachingClassId: 'wrong-campus', teacher: '教师乙', time: '周二 3-4 节', campus: '仙林校区' }),
          networkEntry({ teachingClassId: 'missing-time', teacher: '教师乙', time: '', campus: '鼓楼校区' })
        ]
      }]
    },
    scanDom: async () => new Map()
  });

  const result = await provider.scan([target], {});

  assert.deepEqual(result.get(target.targetId).map(candidate => candidate.teachingClassId), ['matching']);
  assert.equal(result.get(target.targetId)[0].time, '周二 3-4 节');
  assert.equal(result.get(target.targetId)[0].campus, '鼓楼校区');
});

test('keeps a visible full favorite candidate when the current network query misses its category', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '网络新科学',
    electiveBatchId: 'BATCH-1',
    teachingClassType: 'TY',
    teachingClassId: 'favorite-class'
  }]);
  const domCandidate = {
    id: 'class:BATCH-1:TY:favorite-class',
    teachingClassId: 'favorite-class',
    teachingClassType: 'TY',
    electiveBatchId: 'BATCH-1',
    target,
    targetId: target.targetId,
    status: CANDIDATE_STATUS.FULL,
    row: {},
    choiceBtn: null
  };
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    queryClient: {
      query: async () => [{ searchId: target.targetId, candidates: [] }]
    },
    scanDom: async () => new Map([[target.targetId, [domCandidate]]])
  });

  const result = await provider.scan([target], {});

  assert.equal(result.get(target.targetId).length, 1);
  assert.equal(result.get(target.targetId)[0].status, CANDIDATE_STATUS.FULL);
});

test('defers an exact target when its catalog query template has not been captured', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '网络新科学', teachingClassId: 'favorite-class', teachingClassType: 'GG01', queryScope: 'SC'
  }]);
  let searches = null;
  let domScans = 0;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    queryClient: {
      query: async value => {
        searches = value;
        return [{
          searchId: target.targetId,
          outcome: 'OUT_OF_SCOPE',
          message: '等待打开 SC 课程分类以建立查询通道',
          candidates: []
        }];
      }
    },
    scanDom: async () => {
      domScans += 1;
      return new Map();
    }
  });

  const result = await provider.scan([target], {});

  assert.equal(searches[0].queryScope, 'SC');
  assert.equal(searches[0].teachingClassType, 'GG01');
  assert.equal(result.get(target.targetId)[0].status, CANDIDATE_STATUS.DEFERRED);
  assert.equal(result.get(target.targetId)[0].label, '等待打开 SC 课程分类以建立查询通道');
  assert.equal(result.diagnostics.deferredTargetCount, 0);
  assert.equal(result.diagnostics.scopeDeferredTargetCount, 1);
  assert.equal(domScans, 1);
});

test('does not refresh the public catalog to verify an exact favorite target whose query channel is missing', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '收藏中的公共课程',
    teachingClassId: 'favorite-public-class',
    teachingClassType: 'GG02',
    queryScope: 'SC'
  }]);
  let domScans = 0;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    getCurrentQueryScope: () => 'GG02',
    queryClient: {
      query: async () => [{
        searchId: target.targetId,
        queryScope: 'SC',
        outcome: 'OUT_OF_SCOPE',
        message: '等待打开 SC 课程分类以建立查询通道',
        candidates: []
      }]
    },
    scanDom: async () => {
      domScans += 1;
      return new Map();
    }
  });

  const result = await provider.scan([target], {});
  const [candidate] = result.get(target.targetId);

  assert.equal(domScans, 0);
  assert.equal(candidate.status, CANDIDATE_STATUS.DEFERRED);
  assert.match(candidate.label, /SC|收藏/);
  assert.equal(result.diagnostics.scopeDeferredTargetCount, 1);
});

test('uses an exact course row visible in favorites even when the target came from GG02', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '混合来源通识课',
    electiveBatchId: 'BATCH-1',
    teachingClassId: 'class-9',
    teachingClassType: 'GG02',
    queryScope: 'GG02'
  }]);
  let domScans = 0;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    getCurrentQueryScope: () => 'SC',
    queryClient: {
      query: async () => [{
        searchId: target.targetId,
        outcome: 'OUT_OF_SCOPE',
        message: '等待打开 GG02 课程分类以建立查询通道',
        candidates: []
      }]
    },
    scanDom: async () => {
      domScans += 1;
      return new Map([[target.targetId, [{
        id: 'class-9',
        teachingClassId: 'class-9',
        status: CANDIDATE_STATUS.FULL
      }]]]);
    }
  });

  const result = await provider.scan([target], {});
  const [candidate] = result.get(target.targetId);

  assert.equal(domScans, 1);
  assert.equal(candidate.status, CANDIDATE_STATUS.FULL);
  assert.equal(result.diagnostics.scopeDeferredTargetCount || 0, 0);
});

test('normalizes a raw TCT4 target and accepts a canonical GG02 network result', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '原始分类通识课',
    electiveBatchId: 'BATCH-1',
    teachingClassId: 'class-raw-scope',
    teachingClassType: ' TCT4 ',
    queryScope: 'tct4'
  }]);
  let searches = null;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    getCurrentQueryScope: () => ' tct4 ',
    queryClient: {
      query: async value => {
        searches = value;
        return [{
          searchId: target.targetId,
          queryScope: 'GG02',
          candidates: [networkEntry({
            teachingClassId: 'class-raw-scope',
            teachingClassType: ' GG02 ',
            status: CANDIDATE_STATUS.FULL
          })]
        }];
      }
    },
    scanDom: async () => new Map()
  });

  const result = await provider.scan([target], {});
  const [candidate] = result.get(target.targetId);

  assert.equal(searches[0].queryScope, 'GG02');
  assert.equal(searches[0].teachingClassType, 'GG02');
  assert.equal(candidate.teachingClassType, 'GG02');
  assert.equal(candidate.status, CANDIDATE_STATUS.FULL);
});

test('does not report a target from another page as missing during DOM fallback', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '网络新科学',
    teachingClassId: 'favorite-class',
    teachingClassType: 'GG01',
    queryScope: 'SC'
  }]);
  let domScans = 0;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    getCurrentQueryScope: () => 'ZY',
    queryClient: {
      query: async () => {
        const error = new Error('尚未捕获原生查询模板');
        error.outcome = 'UNSUPPORTED';
        throw error;
      }
    },
    scanDom: async () => {
      domScans += 1;
      return new Map([[target.targetId, []]]);
    }
  });

  const result = await provider.scan([target], {});
  const [candidate] = result.get(target.targetId);

  assert.equal(candidate.status, CANDIDATE_STATUS.DEFERRED);
  assert.match(candidate.label, /收藏|对应分类/);
  assert.equal(result.diagnostics.scopeDeferredTargetCount, 1);
  assert.equal(domScans, 0);
});

test('keeps an unscoped keyword target pending when only the current page was searched', async () => {
  const [target] = taskModel.normalizeTargets(['跨页关键词课程']);
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    getCurrentQueryScope: () => 'ZY',
    queryClient: {
      query: async () => [{ searchId: target.targetId, candidates: [] }]
    },
    scanDom: async () => new Map([[target.targetId, []]])
  });

  const result = await provider.scan([target], {});
  const [candidate] = result.get(target.targetId);

  assert.equal(candidate.status, CANDIDATE_STATUS.DEFERRED);
  assert.match(candidate.label, /本轮.*专业.*分类|其他课程分类/);
  assert.equal(result.diagnostics.scopeDeferredTargetCount, 1);
});

test('reports a remotely observed slot without pretending the current page can submit it', async () => {
  const [target] = taskModel.normalizeTargets(['跨页有余量课程']);
  let domScans = 0;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    getCurrentQueryScope: () => 'ZY',
    queryClient: {
      query: async () => [{
        searchId: target.targetId,
        queryScope: 'SC',
        candidates: [networkEntry({ status: 'AVAILABLE', teachingClassType: 'GG01' })]
      }]
    },
    scanDom: async () => {
      domScans += 1;
      return new Map();
    }
  });

  const result = await provider.scan([target], {});
  const [candidate] = result.get(target.targetId);

  assert.equal(candidate.status, CANDIDATE_STATUS.DEFERRED);
  assert.match(candidate.label, /收藏课程分类发现余量.*进入.*提交/);
  assert.equal(result.diagnostics.scopeDeferredTargetCount, 1);
  assert.equal(domScans, 0);
});

test('materializes an available network candidate through an exact DOM query before submission', async () => {
  const [target] = taskModel.normalizeTargets(['测试课程']);
  const domCandidate = {
    id: 'class:BATCH-1:GG:class-open',
    teachingClassId: 'class-open',
    targetId: target.targetId,
    status: 'AVAILABLE',
    row: {},
    choiceBtn: {}
  };
  const materializedQueries = [];
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    queryClient: {
      query: async () => [{
        searchId: target.targetId,
        candidates: [networkEntry({ teachingClassId: 'class-open', status: 'AVAILABLE' })]
      }]
    },
    scanDom: async (targets, context, options) => {
      materializedQueries.push({
        query: options.query,
        expectedTeachingClassIds: options.expectedTeachingClassIds
      });
      return new Map([[targets[0].targetId, [domCandidate]]]);
    }
  });

  const result = await provider.scan([target], { signal: new AbortController().signal });

  assert.deepEqual(materializedQueries, [{
    query: 'COURSE-1',
    expectedTeachingClassIds: ['class-open']
  }]);
  assert.equal(result.get(target.targetId).find(candidate => candidate.id === domCandidate.id), domCandidate);
  assert.equal(result.get(target.targetId).some(candidate => candidate.status === 'AVAILABLE' && !candidate.choiceBtn), false);
  assert.equal(result.diagnostics.mode, SCAN_MODE.NETWORK_WITH_DOM);
  assert.equal(result.diagnostics.materializedQueryCount, 1);
  assert.equal(result.diagnostics.candidateCount, 1);
  assert.deepEqual(result.diagnostics.shadowComparison, {
    comparisonCount: 1,
    mismatchedComparisonCount: 0,
    networkOnlyCandidateCount: 0,
    domOnlyCandidateCount: 0,
    statusMismatchCount: 0,
    unidentifiableCandidateCount: 0
  });
});

test('records only aggregate network and DOM candidate differences during required materialization', async () => {
  const [target] = taskModel.normalizeTargets(['测试课程']);
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    queryClient: {
      query: async () => [{
        searchId: target.targetId,
        candidates: [
          networkEntry({ teachingClassId: 'class-open', status: 'AVAILABLE' }),
          networkEntry({ teachingClassId: 'network-only', status: 'FULL' }),
          networkEntry({ teachingClassId: '', status: 'FULL' })
        ]
      }]
    },
    scanDom: async () => new Map([[target.targetId, [
      {
        id: 'class:BATCH-1:GG:class-open',
        teachingClassId: 'class-open',
        targetId: target.targetId,
        status: 'FULL'
      },
      {
        id: 'class:BATCH-1:GG:dom-only',
        teachingClassId: 'dom-only',
        targetId: target.targetId,
        status: 'FULL'
      },
      {
        id: 'dom:anonymous',
        teachingClassId: null,
        targetId: target.targetId,
        status: 'FULL'
      }
    ]]])
  });

  const result = await provider.scan([target], {});

  assert.deepEqual(result.diagnostics.shadowComparison, {
    comparisonCount: 1,
    mismatchedComparisonCount: 1,
    networkOnlyCandidateCount: 1,
    domOnlyCandidateCount: 1,
    statusMismatchCount: 1,
    unidentifiableCandidateCount: 2
  });
  assert.equal(JSON.stringify(result.diagnostics).includes('class-open'), false);
  assert.equal(JSON.stringify(result.diagnostics).includes('COURSE-1'), false);
});

test('queries every normal-sized target in the first round by default', async () => {
  const targets = taskModel.normalizeTargets(['课程一', '课程二', '课程三', '课程四', '课程五']);
  const rounds = [];
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    queryClient: {
      query: async searches => {
        rounds.push(searches.map(search => search.searchId));
        return searches.map((search, index) => ({
          searchId: search.searchId,
          candidates: [networkEntry({ teachingClassId: `full-${index}` })]
        }));
      }
    },
    scanDom: async () => new Map()
  });

  const result = await provider.scan(targets, {});

  assert.deepEqual(rounds, [targets.map(target => target.targetId)]);
  assert.equal(result.diagnostics.queriedTargetCount, 5);
  assert.equal(result.diagnostics.deferredTargetCount, 0);
  assert.equal(targets.every(target => result.get(target.targetId)[0].status === 'FULL'), true);
});

test('keeps favorite queries on the user cadence while pacing public targets independently', async () => {
  const targets = taskModel.normalizeTargets([
    { name: '收藏目标', electiveBatchId: 'BATCH-1', teachingClassType: 'GG02', teachingClassId: 'favorite-1', courseNumber: 'FAVORITE-1', queryScope: 'SC' },
    { name: '公共目标一', electiveBatchId: 'BATCH-1', teachingClassType: 'GG02', teachingClassId: 'public-1', courseNumber: 'PUBLIC-1', queryScope: 'GG02' },
    { name: '公共目标二', electiveBatchId: 'BATCH-1', teachingClassType: 'GG02', teachingClassId: 'public-2', courseNumber: 'PUBLIC-2', queryScope: 'GG02' },
    { name: '公共目标三', electiveBatchId: 'BATCH-1', teachingClassType: 'GG02', teachingClassId: 'public-3', courseNumber: 'PUBLIC-3', queryScope: 'GG02' },
    { name: '公共目标四', electiveBatchId: 'BATCH-1', teachingClassType: 'GG02', teachingClassId: 'public-4', courseNumber: 'PUBLIC-4', queryScope: 'GG02' }
  ]);
  const targetById = new Map(targets.map(target => [target.targetId, target]));
  const rounds = [];
  let currentTime = 0;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    now: () => currentTime,
    queryClient: {
      query: async searches => {
        rounds.push(searches.map(search => search.searchId));
        return searches.map(search => {
          const target = targetById.get(search.searchId);
          return {
            searchId: search.searchId,
            queryScope: search.queryScope,
            candidates: [networkEntry({
              teachingClassId: target.teachingClassId,
              teachingClassType: target.teachingClassType,
              electiveBatchId: target.electiveBatchId,
              name: target.name,
              courseNumber: target.courseNumber,
              status: 'FULL'
            })]
          };
        });
      }
    },
    scanDom: async () => new Map()
  });

  const first = await provider.scan(targets, { runId: 'mixed-run', intervalMs: 100 });
  currentTime = 100;
  const second = await provider.scan(targets, { runId: 'mixed-run', intervalMs: 100 });
  currentTime = 1000;
  const third = await provider.scan(targets, { runId: 'mixed-run', intervalMs: 100 });

  assert.deepEqual(rounds[0], targets.slice(0, 4).map(target => target.targetId));
  assert.deepEqual(rounds[1], [targets[0].targetId]);
  assert.deepEqual(rounds[2], [
    targets[0].targetId,
    targets[1].targetId,
    targets[4].targetId,
    targets[2].targetId
  ]);
  assert.equal(first.get(targets[4].targetId)[0].status, 'DEFERRED');
  assert.equal(second.get(targets[1].targetId)[0].status, 'DEFERRED');
  assert.equal(third.get(targets[3].targetId)[0].status, 'DEFERRED');
  assert.equal(first.diagnostics.publicDeferredTargetCount, 1);
  assert.equal(second.diagnostics.publicDeferredTargetCount, 4);
  assert.equal(third.diagnostics.publicDeferredTargetCount, 1);
});

test('does not page-verify an empty favorite result while the public catalog is visible', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '收藏中的公共课程',
    teachingClassId: 'favorite-public-class',
    teachingClassType: 'GG02',
    electiveBatchId: 'BATCH-1',
    queryScope: 'SC'
  }]);
  let domScans = 0;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    getCurrentQueryScope: () => 'GG02',
    queryClient: {
      query: async searches => searches.map(search => ({
        searchId: search.searchId,
        queryScope: 'SC',
        candidates: []
      }))
    },
    scanDom: async () => {
      domScans += 1;
      return new Map();
    }
  });

  const result = await provider.scan([target], { runId: 'cross-scope', intervalMs: 100 });

  assert.equal(domScans, 0);
  assert.equal(result.diagnostics.mode, SCAN_MODE.NETWORK);
  assert.equal(result.diagnostics.materializedQueryCount, 0);
});

test('does not page-verify an available favorite result on the public catalog when the bridge omits its echoed scope', async () => {
  const [target] = taskModel.normalizeTargets([{
    name: '收藏中的有余量公共课程',
    teachingClassId: 'favorite-public-open',
    teachingClassType: 'GG02',
    electiveBatchId: 'BATCH-1',
    queryScope: 'SC'
  }]);
  let domScans = 0;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    getCurrentQueryScope: () => 'GG02',
    queryClient: {
      query: async searches => searches.map(search => ({
        searchId: search.searchId,
        candidates: [networkEntry({
          teachingClassId: 'favorite-public-open',
          teachingClassType: 'GG02',
          status: CANDIDATE_STATUS.AVAILABLE
        })]
      }))
    },
    scanDom: async () => {
      domScans += 1;
      return new Map();
    }
  });

  const result = await provider.scan([target], { runId: 'cross-scope-open', intervalMs: 100 });
  const [candidate] = result.get(target.targetId);

  assert.equal(domScans, 0);
  assert.equal(candidate.status, CANDIDATE_STATUS.DEFERRED);
  assert.match(candidate.label, /收藏课程分类发现余量.*进入.*提交/);
  assert.equal(result.diagnostics.materializedQueryCount, 0);
});

test('bounds network searches while checking the highest priority target every round', async () => {
  const targets = taskModel.normalizeTargets(['课程一', '课程二', '课程三', '课程四', '课程五']);
  const rounds = [];
  const results = [];
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    maxSearches: 3,
    queryClient: {
      query: async searches => {
        rounds.push(searches.map(search => search.searchId));
        return searches.map((search, index) => ({
          searchId: search.searchId,
          candidates: [networkEntry({ teachingClassId: `full-${index}` })]
        }));
      }
    },
    scanDom: async () => new Map()
  });

  results.push(await provider.scan(targets, {}));
  results.push(await provider.scan(targets, {}));

  assert.deepEqual(rounds, [
    [targets[0].targetId, targets[1].targetId, targets[2].targetId],
    [targets[0].targetId, targets[3].targetId, targets[4].targetId]
  ]);
  assert.equal(results[0].get(targets[3].targetId)[0].status, 'DEFERRED');
  assert.equal(results[1].get(targets[1].targetId)[0].status, 'DEFERRED');
  assert.equal(results[0].diagnostics.queriedTargetCount, 3);
  assert.equal(results[0].diagnostics.deferredTargetCount, 2);
});

test('falls back to the existing DOM scan when no native query template is available', async () => {
  const targets = taskModel.normalizeTargets(['测试课程']);
  const fallback = new Map([[targets[0].targetId, []]]);
  let receivedTargets = null;
  const provider = createCourseProvider({
    taskModel,
    candidateStatus: CANDIDATE_STATUS,
    queryClient: {
      query: async () => {
        const error = new Error('尚未捕获原生查询');
        error.outcome = 'UNSUPPORTED';
        throw error;
      }
    },
    scanDom: async values => {
      receivedTargets = values;
      return fallback;
    }
  });

  const result = await provider.scan(targets, {});

  assert.equal(result, fallback);
  assert.deepEqual(receivedTargets, targets);
  assert.deepEqual(result.diagnostics, {
    mode: SCAN_MODE.DOM_FALLBACK,
    queriedTargetCount: 1,
    deferredTargetCount: 0,
    materializedQueryCount: 0,
    candidateCount: 0,
    fallbackReason: 'NATIVE_QUERY_UNAVAILABLE'
  });
});
