'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SCHEMA_VERSION,
  TARGET_KIND,
  normalizeTarget,
  normalizeTargets,
  normalizeTaskConfig,
  replaceKeywordTargets,
  addTargetToTaskConfig,
  removeTargetFromTaskConfig,
  updateCourseGroup,
  updateTargetPriority,
  updateTargetFilters,
  moveTargetToGroup,
  targetAcceptsCandidate
} = require('../grab-task-model.js');

test('migrates legacy course-name lines into deduplicated keyword targets', () => {
  const config = normalizeTaskConfig(null, {
    legacyCourseText: '羽毛球\n羽毛球\n 操作系统 ',
    intervalMs: '3000'
  });

  assert.equal(config.schemaVersion, SCHEMA_VERSION);
  assert.equal(config.intervalMs, 3000);
  assert.deepEqual(config.targets.map(target => target.kind), [TARGET_KIND.KEYWORD, TARGET_KIND.KEYWORD]);
  assert.deepEqual(config.targets.map(target => target.name), ['羽毛球', '操作系统']);
  assert.equal(config.groups.length, 2);
  assert.deepEqual(config.groups.map(group => group.requiredCount), [1, 1]);
});

test('uses the versioned source interval before the legacy options fallback', () => {
  const config = normalizeTaskConfig({
    targets: ['课程甲'],
    intervalMs: 12000
  }, { intervalMs: 2000 });

  assert.equal(config.intervalMs, 12000);
  assert.equal(normalizeTaskConfig({ targets: ['课程甲'] }, { intervalMs: 2000 }).intervalMs, 2000);
});

test('normalizes course groups, required counts and bounded target priorities', () => {
  const config = normalizeTaskConfig({
    groups: [{
      groupId: 'sport',
      label: '体育组',
      requiredCount: 9,
      targets: [
        { name: '羽毛球 A 班', priority: 100 },
        { name: '羽毛球 B 班', priority: 80 },
        { name: '网球', priority: 5000 }
      ]
    }]
  });

  assert.equal(config.schemaVersion, SCHEMA_VERSION);
  assert.equal(config.groups.length, 1);
  assert.equal(config.groups[0].groupId, 'sport');
  assert.equal(config.groups[0].requiredCount, 3);
  assert.deepEqual(config.groups[0].targets.map(target => target.priority), [100, 80, 1000]);
});

test('a target can belong to only one course group', () => {
  const config = normalizeTaskConfig({
    groups: [
      { groupId: 'preferred', targets: [{ name: '羽毛球', priority: 100 }] },
      { groupId: 'fallback', targets: [{ name: '羽毛球', priority: 20 }, '网球'] }
    ]
  });

  assert.deepEqual(config.groups.map(group => group.targets.map(target => target.name)), [
    ['羽毛球'],
    ['网球']
  ]);
});

test('task config helpers preserve exact groups while replacing keyword inputs', () => {
  let config = normalizeTaskConfig({
    groups: [{
      groupId: 'sport',
      label: '体育组',
      requiredCount: 1,
      targets: [
        { name: '羽毛球', priority: 100 },
        { name: '羽毛球 B 班', teachingClassId: 'class-b', priority: 80 }
      ]
    }]
  });

  config = replaceKeywordTargets(config, ['网球']);
  assert.deepEqual(config.targets.map(target => target.name), ['羽毛球 B 班', '网球']);
  assert.equal(config.groups.find(group => group.groupId === 'sport').requiredCount, 1);

  config = addTargetToTaskConfig(config, { name: '篮球', teachingClassId: 'class-c' });
  assert.equal(config.targets.some(target => target.teachingClassId === 'class-c'), true);
  config = removeTargetFromTaskConfig(config, 'class:-:-:class-c');
  assert.equal(config.targets.some(target => target.teachingClassId === 'class-c'), false);
});

test('edits group strategy without losing membership during keyword persistence', () => {
  let config = normalizeTaskConfig({ targets: ['羽毛球 A 班', '羽毛球 B 班', '网球'] });
  const [firstGroup, secondGroup] = config.groups;
  config = moveTargetToGroup(config, secondGroup.targets[0].targetId, firstGroup.groupId);
  config = updateCourseGroup(config, firstGroup.groupId, { label: '体育保底', requiredCount: 1 });
  config = updateTargetPriority(config, firstGroup.targets[0].targetId, 100);
  config = replaceKeywordTargets(config, ['羽毛球 A 班', '羽毛球 B 班', '网球']);

  const sport = config.groups.find(group => group.groupId === firstGroup.groupId);
  assert.equal(sport.label, '体育保底');
  assert.equal(sport.requiredCount, 1);
  assert.deepEqual(sport.targets.map(target => target.name), ['羽毛球 A 班', '羽毛球 B 班']);
  assert.equal(sport.targets[0].priority, 100);

  config = moveTargetToGroup(config, sport.targets[1].targetId, '');
  assert.equal(config.groups.length, 3);
  assert.equal(config.groups.some(group => group.targets.length === 1 && group.targets[0].name === '羽毛球 B 班'), true);
});

test('uses batch, teaching-class type and teaching-class ID as exact identity', () => {
  const first = normalizeTarget({
    name: '测试课程', electiveBatchId: 'BATCH-1', teachingClassType: 'ZY', teachingClassId: 'class-1'
  });
  const duplicateWithDifferentMetadata = normalizeTarget({
    name: '测试课程（新名称）', teacher: '教师甲', electiveBatchId: 'BATCH-1',
    teachingClassType: 'ZY', teachingClassId: 'class-1'
  });
  const anotherClass = normalizeTarget({
    name: '测试课程', electiveBatchId: 'BATCH-1', teachingClassType: 'ZY', teachingClassId: 'class-2'
  });

  assert.equal(first.targetId, 'class:BATCH-1:ZY:class-1');
  assert.equal(normalizeTargets([first, duplicateWithDifferentMetadata, anotherClass]).length, 2);
});

test('an exact target rejects a same-name candidate from another teaching class', () => {
  const target = normalizeTarget({
    name: '测试课程', electiveBatchId: 'BATCH-1', teachingClassType: 'ZY', teachingClassId: 'class-2'
  });

  assert.equal(targetAcceptsCandidate(target, {
    teachingClassId: 'class-1', electiveBatchId: 'BATCH-1', teachingClassType: 'ZY'
  }), false);
  assert.equal(targetAcceptsCandidate(target, {
    teachingClassId: 'class-2', electiveBatchId: 'BATCH-1', teachingClassType: 'ZY'
  }), true);
});

test('an exact teaching class ID remains authoritative when page metadata changes', () => {
  const target = normalizeTarget({
    name: '昆曲艺术与民族文化', electiveBatchId: '2026', teachingClassType: 'GG01',
    teachingClassId: '2026202710037188002'
  });
  assert.equal(targetAcceptsCandidate(target, {
    teachingClassId: '2026202710037188002', electiveBatchId: '2026', teachingClassType: 'GG02'
  }), true);
});

test('keyword filters are normalized, identity-bearing, and require every requested candidate field', () => {
  const unfiltered = normalizeTarget('机器学习');
  const target = normalizeTarget({
    name: '机器学习',
    filters: { teacher: ' 教师甲 ', time: '周一', campus: '仙林' }
  });

  assert.notEqual(target.targetId, unfiltered.targetId);
  assert.deepEqual({ ...target.filters }, {
    teacher: '教师甲',
    time: '周一',
    campus: '仙林'
  });
  assert.equal(targetAcceptsCandidate(target, {
    teacher: '教师甲、教师乙',
    time: '周一 3-4 节 逸夫馆',
    campus: '仙林校区'
  }), true);
  assert.equal(targetAcceptsCandidate(target, {
    teacher: '教师甲',
    time: '周二 3-4 节',
    campus: '仙林校区'
  }), false);
  assert.equal(targetAcceptsCandidate(target, {
    teacher: '教师甲',
    time: '周一 3-4 节'
  }), false);
});

test('editing keyword filters preserves its course group and survives keyword text persistence', () => {
  let config = normalizeTaskConfig({
    groups: [{
      groupId: 'ml-options',
      label: '机器学习候选',
      requiredCount: 1,
      targets: ['机器学习', '深度学习']
    }]
  });
  const originalId = config.targets[0].targetId;

  config = updateTargetFilters(config, originalId, {
    teacher: '教师甲',
    time: '周一',
    campus: '仙林'
  });
  const filtered = config.targets.find(target => target.name === '机器学习');
  assert.notEqual(filtered.targetId, originalId);
  assert.equal(config.groups[0].groupId, 'ml-options');
  assert.equal(config.groups[0].targets.some(target => target.targetId === filtered.targetId), true);

  config = replaceKeywordTargets(config, ['机器学习', '深度学习']);
  assert.deepEqual({ ...config.targets.find(target => target.name === '机器学习').filters }, {
    teacher: '教师甲',
    time: '周一',
    campus: '仙林'
  });
});

test('drops unknown fields from persisted exact targets', () => {
  const config = normalizeTaskConfig({
    schemaVersion: 999,
    targets: [{
      name: '测试课程', teachingClassId: 'class-2', token: 'secret', row: { innerHTML: 'private' }
    }]
  });
  const serialized = JSON.stringify(config);

  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('private'), false);
});

test('persists an exact target query scope without changing teaching-class identity', () => {
  const target = normalizeTarget({
    name: '网络新科学',
    electiveBatchId: 'BATCH-1',
    teachingClassType: 'GG01',
    teachingClassId: 'class-2',
    queryScope: 'SC'
  });

  assert.equal(target.queryScope, 'SC');
  assert.equal(target.targetId, 'class:BATCH-1:GG01:class-2');
});
