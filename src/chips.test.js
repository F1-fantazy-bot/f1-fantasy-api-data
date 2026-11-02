const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CHIPS, extractChipsUsed, extractChipUsage } = require('./chips');
const flags = (value = 0) => Object.fromEntries(CHIPS.map((chip) => [chip.takenFlag, value]));
test('complete zero flags prove no chips used', () => {
  for (const value of [0, false, '0']) assert.deepEqual(extractChipUsage(flags(value)), { chipsUsed: [], chipUsageStatus: 'known' });
});
test('all six flags accept boolean and numeric/string values; Extra DRS uses a positive game-day flag', () => {
  for (const value of [true, 1, '1', 6, '6']) {
    const result = extractChipUsage(flags(value));
    assert.equal(result.chipUsageStatus, 'known');
    assert.equal(result.chipsUsed.length, 6);
    assert.ok(result.chipsUsed.every((chip) => chip.gameDayId === null));
  }
});
test('used flags without activation dates remain used, and partial usage preserves date metadata', () => {
  const input = { ...flags(), isWildcardtaken: '1', wildCardtakengd: 9, isExtradrstaken: 6, extraDrstakengd: null };
  assert.deepEqual(extractChipUsage(input), { chipUsageStatus: 'known', chipsUsed: [{ name: 'Wildcard', gameDayId: 9 }, { name: 'Extra DRS Boost', gameDayId: null }] });
  assert.deepEqual(extractChipsUsed(input), extractChipUsage(input).chipsUsed);
});
test('missing/malformed flags cannot prove zero usage', () => {
  for (const value of [undefined, null, '', ' ', 'bad', -1, NaN, Infinity, {}, [], 'true', 0.5]) {
    const input = { ...flags(), isWildcardtaken: value, isAutopilottaken: true };
    const result = extractChipUsage(input);
    assert.equal(result.chipUsageStatus, 'unknown');
    assert.ok(result.chipsUsed.some((chip) => chip.name === 'Autopilot'));
  }
  for (const input of [null, undefined, {}, [], { Meta: { Success: false } }]) assert.equal(extractChipUsage(input).chipUsageStatus, 'unknown');
});
test('extraction exceptions propagate to the caller diagnostics boundary', () => {
  const input = flags();
  Object.defineProperty(input, 'isWildcardtaken', { get() { throw new Error('extraction failed'); } });
  assert.throws(() => extractChipUsage(input), /extraction failed/);
});
