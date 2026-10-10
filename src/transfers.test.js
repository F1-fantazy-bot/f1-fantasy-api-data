const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractTransfersRemaining } = require('./transfers');

test('planning allowance takes precedence over the upcoming root zero', () => {
  for (const value of [2, '2', ' 2 ']) {
    assert.equal(extractTransfersRemaining({ userTeam: [{
      team_info: { userSubsleft: value }, usersubsleft: 0,
    }] }), 2);
  }
});

test('preserves zero and negative allowances and supports the legacy root field', () => {
  for (const value of [0, '0', -2, '-2', 3, '3']) {
    assert.equal(extractTransfersRemaining({ userTeam: [{ usersubsleft: value }] }), Number(value));
    assert.equal(extractTransfersRemaining({ userTeam: [{
      team_info: { userSubsleft: value }, usersubsleft: 7,
    }] }), Number(value));
  }
});

test('missing and malformed counts remain unknown rather than becoming zero', () => {
  for (const value of [undefined, null, '', ' ', false, [], {}, 'unknown', Infinity, NaN, 1.5]) {
    assert.equal(extractTransfersRemaining({ userTeam: [{ team_info: { userSubsleft: value } }] }), null);
    assert.equal(extractTransfersRemaining({ userTeam: [{
      team_info: { userSubsleft: value }, usersubsleft: '2',
    }] }), 2);
  }
  assert.equal(extractTransfersRemaining({}), null);
});
