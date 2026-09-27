const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNT_ID_LENGTH, deriveAccountId } = require('./accountId');

test('deriveAccountId is stable, opaque, and account-specific', () => {
  const first = deriveAccountId('11111111-1111-1111-1111-111111111111');
  const again = deriveAccountId('11111111-1111-1111-1111-111111111111');
  const second = deriveAccountId('22222222-2222-2222-2222-222222222222');

  assert.equal(first, again);
  assert.notEqual(first, second);
  assert.equal(first.length, ACCOUNT_ID_LENGTH);
  assert.match(first, /^[a-f0-9]+$/);
  assert.equal(first.includes('11111111'), false);
});

test('deriveAccountId returns null for a missing GUID', () => {
  assert.equal(deriveAccountId(null), null);
  assert.equal(deriveAccountId('   '), null);
});
