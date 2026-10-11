const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTransferAllowance } = require('./transferAllowance');

const rules = {
  matchdayId: 18,
  base: 2,
  maxCarry: 1,
  chips: new Map([
    [1, 'LIMITLESS'],
    [2, 'WILDCARD'],
    [3, 'FINAL FIX'],
    [4, 'AUTO PILOT'],
    [5, 'NO NEGATIVE'],
    [6, 'EXTRA DRS'],
  ]),
  resetChips: new Set([1, 2]),
};
function archive(chip, left = 2, mdid = 17) {
  return {
    mdid,
    retval: 1,
    userTeam: [
      {
        teamno: 3,
        boosterid: chip,
        fttourgdid: 1,
        team_info: { userSubsleft: left },
        usersubsleft: 99,
      },
    ],
  };
}
const resolve = (previous, current = null, policy = rules) =>
  resolveTransferAllowance(current, previous, 18, 3, policy);

test('only Limitless and Wildcard reset next-race carry-over; season flags cannot reset it', () => {
  for (const chip of [1, 2])
    assert.equal(resolve(archive(chip)).transfersRemaining, 2);
  for (const chip of [null, 0, 3, 4, 5, 6]) {
    const data = archive(chip);
    Object.assign(data.userTeam[0], {
      iswildcard: 1,
      iswildcardtaken: 1,
      wildcardtakengd: 5,
    });
    assert.deepEqual(resolve(data), {
      transfersRemaining: 3,
      transfersStatus: 'calculated-race-start',
      transfersSourceMatchdayId: 17,
    });
  }
});

test('unused transfers carry at most the current schedule limit, never negative', () => {
  for (const [left, expected] of [
    [-2, 2],
    [0, 2],
    [1, 3],
    [3, 3],
  ]) {
    assert.equal(resolve(archive(null, left)).transfersRemaining, expected);
  }
  assert.equal(
    resolve(archive(null, 3), null, { ...rules, base: 4, maxCarry: 2 })
      .transfersRemaining,
    6,
  );
});

test('valid live values take priority, including zero and negative free-transfer counts', () => {
  for (const left of [0, -1, 1]) {
    assert.deepEqual(resolve(archive(2), archive(null, left, 18)), {
      transfersRemaining: Math.max(0, left),
      transfersStatus: 'live',
      transfersSourceMatchdayId: 18,
    });
  }
});

test('known current unlimited chips and first team weeks never expose nominal bookkeeping counters', () => {
  for (const chip of [1, 2])
    assert.equal(
      resolve(archive(null), archive(chip, 2, 18)).transfersStatus,
      'unlimited',
    );
  const first = archive(null, 2, 18);
  first.userTeam[0].fttourgdid = 18;
  assert.deepEqual(resolve(null, first), {
    transfersRemaining: null,
    transfersStatus: 'unlimited',
    transfersSourceMatchdayId: 18,
  });
  const priorFirst = archive(null);
  priorFirst.userTeam[0].fttourgdid = 17;
  assert.equal(resolve(priorFirst).transfersStatus, 'unknown');
});

test('missing, rejected, mismatched, or ambiguous previous metadata stays unknown', () => {
  const invalid = [
    null,
    archive(null, 1, 16),
    archive(undefined),
    archive(999),
    archive(null, null),
  ];
  // Remove the fallback count as well for a genuinely missing allowance.
  invalid[4].userTeam[0].usersubsleft = null;
  const otherTeam = archive(null);
  otherTeam.userTeam[0].teamno = 1;
  invalid.push(otherTeam);
  const rejected = archive(null);
  rejected.Meta = { Success: false };
  invalid.push(rejected);
  const rejectedRetVal = archive(null);
  rejectedRetVal.retval = -1;
  invalid.push(rejectedRetVal);
  for (const data of invalid)
    assert.equal(resolve(data).transfersStatus, 'unknown');
  assert.equal(resolve(archive(null), null, null).transfersStatus, 'unknown');
  assert.equal(
    resolve(archive(null), null, { ...rules, matchdayId: 41 }).transfersStatus,
    'unknown',
  );
  assert.equal(
    resolve(archive(null), archive(999, 2, 18)).transfersStatus,
    'unknown',
  );
});
