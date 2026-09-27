const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveAccountId } = require('./accountId');

test('account ID is deterministic, case normalized, opaque and safe', () => {
  const id = deriveAccountId('  AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA  ');
  assert.equal(id, deriveAccountId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
  assert.notEqual(id, deriveAccountId('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
  assert.match(id, /^[a-f0-9]{12}$/);
  assert.equal(deriveAccountId(null), null);
  assert.equal(deriveAccountId('   '), null);
  assert.equal(deriveAccountId('not-a-guid'), null);
});
