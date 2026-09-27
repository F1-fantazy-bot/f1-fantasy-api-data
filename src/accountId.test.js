const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNT_ID_LENGTH, deriveAccountId } = require('./accountId');

test('deriveAccountId is stable, case-insensitive, and account-specific', () => {
  const first = deriveAccountId('ABCDEF00-1111-2222-3333-444444444444');
  const same = deriveAccountId('abcdef00-1111-2222-3333-444444444444');
  const other = deriveAccountId('abcdef00-1111-2222-3333-555555555555');

  assert.equal(first, same);
  assert.equal(first.length, ACCOUNT_ID_LENGTH);
  assert.match(first, /^[0-9a-f]+$/);
  assert.notEqual(first, other);
});

test('deriveAccountId rejects missing GUIDs', () => {
  assert.equal(deriveAccountId(null), null);
  assert.equal(deriveAccountId(''), null);
  assert.equal(deriveAccountId('   '), null);
});
