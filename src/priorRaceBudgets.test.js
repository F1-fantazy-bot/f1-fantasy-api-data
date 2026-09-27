const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveAccountId } = require('./accountId');
const { indexPriorRaceBudgets } = require('./priorRaceBudgets');

test('uses account and team number across display-name changes and multiple teams', () => {
  const accountId = deriveAccountId('00000000-0000-0000-0000-000000000001');
  const entries = [1, 2].map((team_no) => ({ user_guid: '00000000-0000-0000-0000-000000000001', user_name: 'New Name', team_name: `Team ${team_no}`, team_no }));
  const lookup = indexPriorRaceBudgets([
    { accountId, teamNo: 1, userName: 'Old Name', raceBudgets: { matchday_1: 101 } },
    { accountId, teamNo: 2, userName: 'Old Name', raceBudgets: { matchday_1: 102 } },
  ], entries);
  assert.deepEqual(lookup(entries[0]), { matchday_1: 101 });
  assert.deepEqual(lookup(entries[1]), { matchday_1: 102 });
});

test('does not assign ambiguous legacy history to either account', () => {
  const entries = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'].map((user_guid) => ({ user_guid, user_name: 'Tom', team_name: 'Same', team_no: 1 }));
  const lookup = indexPriorRaceBudgets([{ userName: 'Tom', teamName: 'Same', teamNo: 1, raceBudgets: { matchday_1: 100 } }], entries);
  assert.deepEqual(lookup(entries[0]), {});
  assert.deepEqual(lookup(entries[1]), {});
});

test('never falls back from another account-aware record with the same display fields', () => {
  const entries = [{ user_guid: '00000000-0000-0000-0000-000000000002', user_name: 'Tom', team_name: 'Same', team_no: 1 }];
  const lookup = indexPriorRaceBudgets([{ accountId: deriveAccountId('00000000-0000-0000-0000-000000000001'), userName: 'Tom', teamName: 'Same', teamNo: 1, raceBudgets: { matchday_1: 100 } }], entries);
  assert.deepEqual(lookup(entries[0]), {});
});
