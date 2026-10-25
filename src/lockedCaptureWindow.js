const f1Api = require('./f1FantasyApiService');

function timestamp(value) {
  // Only accept timestamps with an explicit timezone, never machine-local dates.
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return NaN;
  return Date.parse(value);
}

function resolveLockedCaptureWindow(schedule, now = Date.now()) {
  const closed = {
    status: 'closed',
    reason: 'Outside the locked capture window',
  };
  const unknown = {
    status: 'unknown',
    reason: 'Cannot verify the locked capture window from the F1 schedule',
  };
  const fixtures = (schedule?.Data || schedule)?.fixtures;
  if (
    !Number.isFinite(now) ||
    !Array.isArray(fixtures) ||
    !fixtures.length ||
    fixtures.some((fixture) => !fixture || typeof fixture !== 'object')
  )
    return unknown;

  const races = fixtures.filter((fixture) => fixture.SessionType === 'Race');
  if (!races.length) return unknown;
  const candidates = [];
  let incomplete = false;
  for (const race of races) {
    const matchdayId = race.GamedayId;
    const sessions = fixtures.filter((f) => f.GamedayId === matchdayId);
    const qualifying = sessions.filter((f) =>
      ['Qualifying', 'Sprint Qualifying'].includes(f.SessionType),
    );
    const starts = qualifying.map((f) => timestamp(f.SessionStartDateISO8601));
    const raceStart = timestamp(race.SessionStartDateISO8601);
    const closesAt = timestamp(race.SessionEndDateISO8601);
    const opensAt = Math.min(...starts);
    if (
      !Number.isInteger(matchdayId) ||
      matchdayId <= 0 ||
      sessions.filter((f) => f.SessionType === 'Race').length !== 1 ||
      new Set(qualifying.map((f) => f.SessionType)).size !==
        qualifying.length ||
      !starts.length ||
      starts.some((start) => !Number.isFinite(start)) ||
      !Number.isFinite(raceStart) ||
      !Number.isFinite(closesAt) ||
      opensAt >= raceStart ||
      raceStart >= closesAt
    ) {
      incomplete = true;
      continue;
    }
    if (now >= opensAt && now < closesAt)
      candidates.push({ race, qualifying, matchdayId, opensAt, closesAt });
  }
  // Ambiguous/missing schedule data must never authorize a write.
  if (incomplete || candidates.length > 1) return unknown;
  if (!candidates.length) return closed;

  const window = candidates[0];
  const { race, qualifying } = window;
  // A race may finish before its scheduled end. Completion flags take priority
  // over timestamps; a completed sprint/qualifying does not close the weekend.
  if (
    race.MatchStatus === '4' ||
    race.IsLive === 2 ||
    race.MDIsCurrent === 2 ||
    race.GDStatus === 4
  )
    return closed;
  if (
    race.IsPostponed !== 0 ||
    ![0, 1].includes(race.IsLive) ||
    !['0', '1', '2', '3'].includes(race.MatchStatus) ||
    ![0, 1].includes(race.MDIsCurrent) ||
    ![0, 1, 2, 3].includes(race.GDStatus) ||
    qualifying.some((f) => f.IsPostponed !== 0)
  )
    return unknown;
  if (
    qualifying.some(
      (f) =>
        timestamp(f.SessionStartDateISO8601) <= now &&
        ![0, 1].includes(f.MDIsLocked),
    )
  )
    return unknown;
  const locked = qualifying.some(
    (f) => timestamp(f.SessionStartDateISO8601) <= now && f.MDIsLocked === 1,
  );
  if (!locked) return closed;
  return {
    status: 'open',
    matchdayId: window.matchdayId,
    opensAt: window.opensAt,
    closesAt: window.closesAt,
  };
}

async function loadLockedCaptureWindow(api = f1Api) {
  try {
    const schedule = await api.getRaceSchedule({ fresh: true });
    return resolveLockedCaptureWindow(schedule);
  } catch (error) {
    return {
      status: 'unknown',
      reason: 'F1 schedule request failed; locked writes disabled',
      error,
    };
  }
}

module.exports = { resolveLockedCaptureWindow, loadLockedCaptureWindow };
