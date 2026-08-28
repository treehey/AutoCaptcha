'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { STAGE, present } = require('../grab-auth-presentation.js');

function recoveryState(stage, overrides = {}) {
  return {
    phase: 'PAUSED_AUTH',
    authRecovery: {
      pending: true,
      stage,
      ...overrides
    }
  };
}

test('returns no presentation outside an active auth recovery', () => {
  assert.equal(present(null), null);
  assert.equal(present({ phase: 'RUNNING', authRecovery: { pending: true } }), null);
  assert.equal(present({ phase: 'PAUSED_AUTH', authRecovery: { pending: false } }), null);
});

test('maps every auth recovery stage to explicit user-facing semantics', () => {
  const expectations = [
    [STAGE.WAITING_LOGIN, '等待登录', '任务已安全暂停', 'warning'],
    [STAGE.RETURNING, '自动恢复', '正在返回选课系统', 'active'],
    [STAGE.SELECTING_ROUND, '自动恢复', '正在选择原轮次', 'active'],
    [STAGE.ENTERING_COURSE, '自动恢复', '正在进入选课轮次', 'active'],
    [STAGE.VERIFYING, '恢复验证', '正在核对选课状态', 'active'],
    [STAGE.MANUAL_REQUIRED, '需要操作', '等待人工登录', 'danger']
  ];

  for (const [stage, badge, pill, tone] of expectations) {
    const view = present(recoveryState(stage), { groupCount: 3 });
    assert.equal(view.stage, stage);
    assert.equal(view.badge, badge);
    assert.equal(view.pill, pill);
    assert.equal(view.tone, tone);
    assert.equal(view.target.tone, tone);
    assert.match(view.subtitle, /3 个课程组|登录|选课|验证/);
  }
});

test('marks manual recovery as dangerous and preserves a sanitized runtime message', () => {
  const view = present(recoveryState(STAGE.MANUAL_REQUIRED, {
    lastMessage: '连续恢复次数过多，请手动登录'
  }), { groupCount: 5 });

  assert.equal(view.manualRequired, true);
  assert.equal(view.badgeTone, 'danger');
  assert.equal(view.subtitle, '连续恢复次数过多，请手动登录');
  assert.equal(view.target.label, '等待处理');
});

test('falls back unknown stages to safe waiting semantics', () => {
  const view = present(recoveryState('UNTRUSTED_STAGE'));

  assert.equal(view.stage, STAGE.WAITING_LOGIN);
  assert.equal(view.badge, '等待登录');
  assert.equal(view.manualRequired, false);
});
