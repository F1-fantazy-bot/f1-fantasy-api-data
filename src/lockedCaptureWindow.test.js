const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveLockedCaptureWindow: resolve,
  loadLockedCaptureWindow,
} = require('./lockedCaptureWindow');

const lock = '2026-10-24T21:00:00+00:00';
const raceStart = '2026-10-25T20:00:00+00:00';
const raceEnd = '2026-10-25T22:00:00+00:00';
function schedule() {
  // Shape/flags from F1's public /feeds/v2/schedule/raceday_en.json.
  return {
    Data: {
      fixtures: [
        {
          GamedayId: 18,
          SessionType: 'Qualifying',
          SessionStartDateISO8601: lock,
          MDIsLocked: 1,
          IsPostponed: 0,
          MatchStatus: '4',
          IsLive: 2,
          MDIsCurrent: 2,
        },
        {
          GamedayId: 18,
          SessionType: 'Race',
          SessionStartDateISO8601: raceStart,
          SessionEndDateISO8601: raceEnd,
          MatchStatus: '1',
          IsLive: 0,
          MDIsCurrent: 1,
          GDStatus: 3,
          IsPostponed: 0,
        },
      ],
    },
  };
}

test('normal weekends open at qualifying and close at scheduled race end', () => {
  for (const [time, expected] of [
    [Date.parse(lock) - 1, 'closed'],
    [Date.parse(lock), 'open'],
    [Date.parse(raceStart) + 60000, 'open'],
    [Date.parse(raceEnd) - 1, 'open'],
    [Date.parse(raceEnd), 'closed'],
    [Date.parse(raceEnd) + 86400000, 'closed'],
  ]) {
    const result = resolve(schedule(), time);
    assert.equal(result.status, expected);
    if (expected === 'open') assert.equal(result.matchdayId, 18);
  }
});

test('a sprint weekend opens at sprint qualifying and stays open after that session scores', () => {
  const data = schedule();
  data.Data.fixtures.push({
    ...data.Data.fixtures[0],
    SessionType: 'Sprint Qualifying',
    SessionStartDateISO8601: '2026-10-23T20:30:00+00:00',
  });
  assert.equal(
    resolve(data, Date.parse('2026-10-23T20:31:00Z')).status,
    'open',
  );
  assert.equal(
    resolve(data, Date.parse('2026-10-24T10:00:00Z')).status,
    'open',
  );
});

for (const flags of [
  { MatchStatus: '4' },
  { IsLive: 2 },
  { MDIsCurrent: 2 },
  { GDStatus: 4 },
]) {
  test(`early race completion blocks writes: ${JSON.stringify(flags)}`, () => {
    const data = schedule();
    Object.assign(data.Data.fixtures[1], flags);
    assert.equal(resolve(data, Date.parse(raceStart) + 60000).status, 'closed');
  });
}

test('a live race remains capturable, but clock time alone cannot establish the lock', () => {
  const data = schedule();
  Object.assign(data.Data.fixtures[1], {
    MatchStatus: '2',
    IsLive: 1,
    GDStatus: 2,
  });
  assert.equal(resolve(data, Date.parse(raceStart) + 60000).status, 'open');
  data.Data.fixtures[0].MDIsLocked = 0;
  assert.equal(resolve(data, Date.parse(raceStart) + 60000).status, 'closed');
});

test('missing, malformed, postponed and ambiguous schedule state never permits writes', () => {
  const now = Date.parse(lock) + 60000;
  for (const data of [
    null,
    {},
    { Data: { fixtures: [] } },
    { Data: { fixtures: [null] } },
  ])
    assert.equal(resolve(data, now).status, 'unknown');
  for (const mutate of [
    (f) => {
      delete f[1].SessionEndDateISO8601;
    },
    (f) => {
      f[1].SessionEndDateISO8601 = '2026-10-25T22:00:00';
    },
    (f) => {
      f[1].SessionEndDateISO8601 = 'invalid';
    },
    (f) => {
      f[1].SessionEndDateISO8601 = lock;
    },
    (f) => {
      delete f[1].IsLive;
    },
    (f) => {
      f[1].GDStatus = 99;
    },
    (f) => {
      delete f[0].MDIsLocked;
    },
    (f) => {
      f[1].MatchStatus = 'unexpected';
    },
    (f) => {
      f[1].IsPostponed = 1;
    },
    (f) => {
      f[0].IsPostponed = 1;
    },
    (f) => {
      f.push({ ...f[1] });
    },
    (f) => {
      f.push({ ...f[0], MDIsLocked: 0 });
    },
    (f) => {
      f.push(...f.map((session) => ({ ...session, GamedayId: 19 })));
    },
  ]) {
    const data = schedule();
    mutate(data.Data.fixtures);
    assert.equal(resolve(data, now).status, 'unknown');
  }
});

test('fresh schedule requests are mandatory; transport failure disables writes', async () => {
  const failure = new Error('schedule unavailable');
  const result = await loadLockedCaptureWindow({
    getRaceSchedule: async (options) => {
      assert.deepEqual(options, { fresh: true });
      throw failure;
    },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.error, failure);
});
