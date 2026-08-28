const test = require('node:test');
const assert = require('node:assert/strict');

const grabEngine = require('../grab-engine.js');
const { createVerificationEngine } = require('../grab-verification-engine.js');

const verifier = createVerificationEngine({ outcome: grabEngine.OUTCOME });

test('classifies user-facing selection feedback through one verification interface', () => {
  const cases = [
    ['名额已满', 'FULL'],
    ['课程时间冲突', 'CONFLICT'],
    ['学分超出上限', 'CREDIT_LIMIT'],
    ['课程门数超过上限', 'COURSE_LIMIT'],
    ['不满足先修条件', 'PREREQUISITE_FAILED'],
    ['请求频繁，请稍后再试', 'RATE_LIMITED'],
    ['该课程已经选择', 'DUPLICATE'],
    ['登录状态已过期', 'AUTH_EXPIRED'],
    ['需要验证码', 'CAPTCHA_REQUIRED']
  ];

  for (const [feedbackText, expectedOutcome] of cases) {
    assert.equal(verifier.evaluate({ feedbackText }).outcome, expectedOutcome);
  }
  assert.equal(verifier.evaluate({ feedbackText: '请稍候' }), null);
});

test('accepts final success only from the matching teaching class status event', () => {
  const candidate = { teachingClassId: 'class-2' };
  const otherClassFailure = {
    path: '/elective/studentstatus.do', status: 200, code: '-1',
    teachingClassId: 'class-1', message: '其他教学班失败'
  };
  const matchingSuccess = {
    path: '/elective/studentstatus.do', status: 200, code: '1',
    teachingClassId: 'class-2', message: '处理成功'
  };

  assert.equal(verifier.evaluate({ candidate, networkEvents: [otherClassFailure] }), null);
  assert.deepEqual(
    verifier.evaluate({ candidate, networkEvents: [otherClassFailure, matchingSuccess] }),
    { outcome: 'SUCCESS', message: '处理成功' }
  );
});

test('keeps accepted submit and processing status responses pending', () => {
  const candidate = { teachingClassId: 'class-2' };
  assert.equal(verifier.evaluate({ candidate, networkEvents: [{
    path: '/elective/volunteer.do', status: 200, code: '1', message: '已提交', teachingClassId: 'class-2'
  }] }), null);
  assert.equal(verifier.evaluate({ candidate, networkEvents: [{
    path: '/elective/studentstatus.do', status: 200, code: '0',
    teachingClassId: 'class-2', message: '处理中'
  }] }), null);
});

test('ignores another teaching class candidate-level submit outcomes', () => {
  const candidate = { teachingClassId: 'class-a' };
  for (const message of ['课程冲突', '名额已满', '添加选课失败']) {
    assert.equal(verifier.evaluate({
      candidate,
      networkEvents: [{
        path: '/elective/volunteer.do', status: 200, code: '0', message, teachingClassId: 'class-b'
      }]
    }), null, `another class must not affect candidate A: ${message}`);
  }
  assert.deepEqual(verifier.evaluate({
    candidate,
    networkEvents: [{
      path: '/elective/volunteer.do', status: 200, code: '0', message: '课程冲突', teachingClassId: 'class-a'
    }]
  }), { outcome: 'CONFLICT', message: '课程冲突', retryOtherCandidate: true });
});

test('does not let unassociated page feedback reject a candidate', () => {
  assert.equal(verifier.evaluate({
    candidate: { teachingClassId: 'class-a' }, feedbackText: '添加选课失败：课程冲突'
  }), null);
  assert.equal(verifier.evaluate({
    candidate: { teachingClassId: 'class-a' }, feedbackText: '名额已满'
  }), null);
  assert.equal(verifier.evaluate({
    candidate: { teachingClassId: 'class-a' }, feedbackText: '登录状态已过期'
  }).outcome, 'AUTH_EXPIRED');
});

test('stops candidate fan-out for a global selection-window rejection', () => {
  assert.deepEqual(verifier.evaluate({
    candidate: { teachingClassId: 'class-2' },
    networkEvents: [{
      path: '/elective/volunteer.do', status: 200, code: '0',
      message: '当前时间不在选课开放时间范围内'
    }]
  }), {
    outcome: 'REJECTED',
    message: '当前时间不在选课开放时间范围内',
    retryOtherCandidate: false
  });
});

test('maps transport failures without treating them as course-rule failures', () => {
  const candidate = { teachingClassId: 'class-2' };
  const cases = [
    [{ status: 403, code: '', message: '' }, 'AUTH_EXPIRED'],
    [{ status: 429, code: '', message: '' }, 'RATE_LIMITED'],
    [{ status: 503, code: '', message: '' }, 'SERVER_ERROR'],
    [{ status: 0, code: '', message: '' }, 'NETWORK_ERROR']
  ];
  for (const [event, expectedOutcome] of cases) {
    assert.equal(verifier.evaluate({
      candidate,
      networkEvents: [{ ...event, path: '/elective/volunteer.do', teachingClassId: 'class-2' }]
    }).outcome, expectedOutcome);
  }
});

test('accepts an exact DOM selected observation as success evidence', () => {
  assert.equal(verifier.evaluate({ domSelected: true }), null);
  assert.deepEqual(verifier.evaluate({
    candidate: { teachingClassId: 'class-2' },
    domSelected: true
  }), {
    outcome: 'SUCCESS',
    message: '页面已显示该教学班为已选'
  });
});
