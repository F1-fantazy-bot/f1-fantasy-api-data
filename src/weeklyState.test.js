const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const api = require('./f1FantasyApiService');
const telegram = require('./telegramService');
const roster = require('./rosterService');
const storage = require('./azureBlobStorageService');
const { resolveWeeklyMatchday, isOwnAccount } = require('./weeklyState');
const { fetchAllLeaguesData, fetchSingleLeague } = require('./fetchLeagueData');
const { loadTransferRules } = require('./transferAllowance');

const originals = { ...api };
const originalNotify = telegram.notifyWeeklyDiagnostics;
const originalDownload = storage.downloadDataFromAzureStorage;
let calls;
let reports;
const opponent = {
  user_guid: 'opponent-private',
  team_no: 2,
  team_name: 'Opponent',
  user_name: 'other',
  cur_rank: 1,
  cur_points: 20,
};
const own = {
  ...opponent,
  user_guid: 'own-0-123',
  team_no: 1,
  team_name: 'Own',
  cur_rank: 2,
};
function state(md, teamNo, remaining = 1) {
  return {
    mdid: md,
    userTeam: [
      {
        teamno: teamNo,
        boosterid: null,
        fttourgdid: 1,
        playerid: Array.from({ length: 7 }, (_, i) => ({
          id: i + 1,
          playerpostion: i + 1,
        })),
        team_info: {
          teamVal: 100,
          maxTeambal: md === 18 ? 110 : 100,
          userSubsleft: remaining,
        },
        usersubsleft: 0,
      },
    ],
  };
}

beforeEach(() => {
  calls = [];
  reports = [];
  api.init = async () => {};
  api.getSession = () => ({ SocialId: 123 });
  api.getWebConfig = async () => ({
    Data: {
      constraints: { GamedayId: 18, MatchdayId: 41 },
      boosters: [
        [1, 'LIMITLESS'],
        [2, 'WILDCARD'],
        [3, 'FINAL FIX'],
        [4, 'AUTO PILOT'],
        [5, 'NO NEGATIVE'],
        [6, 'EXTRA DRS'],
      ].map(([BoosterId, BoosterName]) => ({ BoosterId, BoosterName })),
    },
  });
  api.getRaceSchedule = async () => ({
    Data: {
      fixtures: [
        { GamedayId: 18, SubstitutionsAllowed: 2, MaxSubstitutionsCF: 1 },
      ],
    },
  });
  storage.downloadDataFromAzureStorage = async () => null;
  api.getUserGameDays = async () => ({ cumdid: 18 });
  api.getLeagues = async () => [
    { league_type: 'Private', league_code: 'TEST', league_name: 'Test' },
  ];
  api.getLeagueInfo = async () => ({
    leagueId: 1,
    leagueName: 'Test',
    memberCount: 2,
  });
  api.getLeagueLeaderboard = async () => [opponent, own];
  api.getOpponentGameDays = async () => ({
    mdDetails: { 17: { pts: 20 }, 18: { pts: 5 }, 19: { pts: null } },
  });
  api.getOpponentTeam = async (guid, md, options) => {
    calls.push({ source: 'opponent', guid, md, ...options });
    return md === 18
      ? { Data: { Value: null }, Meta: { Success: false, RetVal: -1 } }
      : state(md, options.teamNo);
  };
  api.getUserTeam = async (teamNo, md) => {
    calls.push({ source: 'own', teamNo, md });
    return state(md, teamNo, 3);
  };
  api.getDrivers = async (md) => {
    calls.push({ source: 'prices', md });
    return Array.from({ length: 7 }, (_, i) => ({
      PlayerId: i + 1,
      DisplayName: `Player ${i + 1}`,
      Value: md === 18 ? 11 : 10,
      PositionName: i < 5 ? 'DRIVER' : 'CONSTRUCTOR',
    }));
  };
  telegram.notifyWeeklyDiagnostics = async (diagnostics) => {
    reports.push(diagnostics);
  };
  roster.resetCache();
});
afterEach(() => {
  Object.assign(api, originals);
  telegram.notifyWeeklyDiagnostics = originalNotify;
  storage.downloadDataFromAzureStorage = originalDownload;
  roster.resetCache();
});

test('new race prices and calculated starting transfers are independent of unavailable current opponents', async () => {
  const result = await fetchAllLeaguesData();
  assert.equal(result.prices.matchdayId, 18);
  assert(result.prices.drivers.every((p) => p.price === 11));
  const snapshot = result.leagues[0].teamsData;
  assert.equal(snapshot.matchdayId, 18);
  const other = snapshot.teams[0];
  assert.equal(other.transfersRemaining, 3);
  assert.equal(other.transfersStatus, 'calculated-race-start');
  assert.equal(other.transfersSourceMatchdayId, 17);
  assert.equal(other.budget, 107);
  assert.equal(other.budgetStatus, 'calculated-race-start');
  assert.equal(other.budgetSourceMatchdayId, 17);
  assert.equal(other.teamStateStatus, 'reconstructed-race-start');
  assert.equal(other.teamStateMatchdayId, 17);
  assert(other.drivers.every((p) => p.price === 11));
  assert.equal(result.leagues[0].league.teams[0].raceBudgets.matchday_18, 107);
  assert.equal(result.leagues[0].league.teams[0].raceBudgets.matchday_17, 100);
  assert.equal(snapshot.teams[1].transfersRemaining, 3);
  assert.equal(snapshot.teams[1].transfersStatus, 'live');
  assert.equal(snapshot.teams[1].transfersSourceMatchdayId, 18);
  assert.equal(snapshot.teams[1].budget, 110);
  assert.equal(snapshot.teams[1].budgetStatus, 'live');
  assert.equal(snapshot.teams[1].teamStateStatus, 'current');
  assert(
    calls
      .filter((c) => c.source === 'opponent' && c.guid === opponent.user_guid)
      .every((c) => c.v === 2),
  );
  assert.deepEqual(
    calls
      .filter((c) => c.source === 'prices')
      .map((c) => c.md)
      .sort(),
    [17, 18],
  );
  assert.equal(
    calls.some((c) => c.md === 19),
    false,
  );
  assert.equal(reports[0].format(), null);
  assert.equal(
    reports[0].information.get('Reconstructed race-start baselines').count,
    1,
  );
  assert.equal(reports[0].issues.has('Calculated race-start transfers'), false);
  assert.equal(reports[0].issues.has('Upcoming team response rejected'), false);
  assert.equal(
    reports[0].information.get('Live opponent response unavailable').count,
    1,
  );
  assert.equal(
    reports[0].information.get('Calculated race-start transfers').count,
    1,
  );
});

test('owned-team absence and malformed opponent responses are not classified as expected opponent unavailability', async () => {
  api.getUserTeam = async () => ({ Meta: { Success: false, RetVal: -1 } });
  api.getOpponentTeam = async (guid, md, options) =>
    state(md === 18 ? 17 : md, options.teamNo);
  await fetchAllLeaguesData();
  assert.equal(
    reports[0].issues.get('Upcoming team response rejected').count,
    2,
  );
  assert.equal(
    reports[0].information.has('Live opponent response unavailable'),
    false,
  );
  assert.match(reports[0].format(), /Unexpected current-team responses: 2/);
});

test('corrupt saved Singapore transfers and chip flags are ignored in favor of a fresh F1 archive', async () => {
  api.getLeagueLeaderboard = async () => [opponent];
  storage.downloadDataFromAzureStorage = async () => ({
    teams: [
      {
        teamName: 'Opponent',
        userName: 'other',
        teamNo: 2,
        transfersRemaining: 999,
        budget: 999,
        matchdayId: 17,
        chipsUsed: [{ name: 'Wildcard', gameDayId: 17 }],
        raceBudgets: { matchday_17: 123 },
      },
    ],
  });
  const result = await fetchSingleLeague('TEST');
  const team = result.teamsData.teams[0];
  assert.equal(team.transfersRemaining, 3);
  assert.equal(team.transfersStatus, 'calculated-race-start');
  assert.equal(team.budget, 107);
  assert.equal(
    calls.filter((c) => c.source === 'opponent' && c.md === 17).length,
    1,
  );
});

test('only the immediately previous race can supply transfer carry-over, even with a gap in score history', async () => {
  api.getLeagueLeaderboard = async () => [opponent];
  api.getOpponentGameDays = async () => ({ mdDetails: { 16: { pts: 20 } } });
  api.getOpponentTeam = async (guid, md, options) => {
    calls.push({ source: 'opponent', md });
    return md === 16 ? state(md, options.teamNo, 2) : null;
  };
  const result = await fetchSingleLeague('TEST');
  const team = result.teamsData.teams[0];
  assert.equal(team.teamStateMatchdayId, 16);
  assert.equal(team.transfersRemaining, null);
  assert.equal(team.transfersStatus, 'unknown');
  assert(calls.some((c) => c.md === 17));
});

test('Final Fix extra roster row does not discard valid archived transfer metadata', async () => {
  api.getLeagueLeaderboard = async () => [opponent];
  api.getOpponentTeam = async (guid, md, options) => {
    if (md === 18) return null;
    const data = state(md, options.teamNo, 1);
    data.userTeam[0].boosterid = 3;
    data.userTeam[0].finalfxoldplayerid = 1;
    data.userTeam[0].finalfxnewplayerid = 8;
    data.userTeam[0].playerid[0].isfinal = 2;
    data.userTeam[0].playerid.push({ id: 8, playerpostion: 8, isfinal: 1 });
    return data;
  };
  const result = await fetchSingleLeague('TEST');
  assert.equal(result.teamsData.teams[0].transfersRemaining, 3);
  assert.equal(
    result.teamsData.teams[0].transfersStatus,
    'calculated-race-start',
  );
  assert.equal(
    result.teamsData.teams[0].teamStateStatus,
    'reconstructed-race-start',
  );
  assert.equal(result.teamsData.teams[0].budget, 107);
  assert.equal(result.teamsData.teams[0].drivers.length, 5);
});

test('Limitless retrieves the original roster but uses the immediately previous race for budget and transfer rules', async () => {
  api.getLeagueLeaderboard = async () => [opponent];
  api.getOpponentTeam = async (guid, md, options) => {
    calls.push({ source: 'opponent', guid, md, ...options });
    if (md === 18) return { Meta: { Success: false, RetVal: -1 } };
    const data = state(md, options.teamNo);
    if (md === 17) {
      data.userTeam[0].boosterid = 1;
      data.userTeam[0].playerid = data.userTeam[0].playerid.map((p) => ({
        ...p,
        id: Number(p.id) + 100,
      }));
    }
    return data;
  };
  const result = await fetchAllLeaguesData();
  const team = result.leagues[0].teamsData.teams[0];
  assert.equal(team.teamStateStatus, 'reconstructed-race-start');
  assert.equal(team.teamStateMatchdayId, 16);
  assert.equal(team.budgetSourceMatchdayId, 17);
  assert.equal(team.transfersSourceMatchdayId, 17);
  assert.equal(team.budget, 107);
  assert.equal(team.transfersRemaining, 2);
  assert.deepEqual(
    team.drivers.map((p) => p.id),
    ['1', '2', '3', '4', '5'],
  );
  assert.equal(reports[0].format(), null);
});

test('a missing previous-price entry leaves the budget unknown instead of treating it as zero', async () => {
  api.getLeagueLeaderboard = async () => [opponent];
  storage.downloadDataFromAzureStorage = async () => ({
    teams: [
      {
        userName: 'other',
        teamNo: 2,
        teamName: 'Opponent',
        raceBudgets: { matchday_18: 999 },
      },
    ],
  });
  const getPrices = api.getDrivers;
  api.getDrivers = async (md) => {
    const rows = await getPrices(md);
    if (md === 17) rows[0].Value = null;
    return rows;
  };
  const result = await fetchAllLeaguesData();
  const team = result.leagues[0].teamsData.teams[0];
  assert.equal(team.budget, null);
  assert.equal(team.budgetStatus, 'unknown');
  assert.equal(
    result.leagues[0].league.teams[0].raceBudgets.matchday_18,
    undefined,
  );
  assert.equal(team.teamStateStatus, 'historical');
  assert.match(reports[0].format(), /Race-start reconstruction failed/);
  assert.equal(result.prices.matchdayId, 18);
});

test('null current feed prices fail before weekly uploads rather than becoming a zero price', async () => {
  const getPrices = api.getDrivers;
  api.getDrivers = async (md) => {
    const rows = await getPrices(md);
    if (md === 18) rows[0].Value = null;
    return rows;
  };
  await assert.rejects(fetchAllLeaguesData(), /refusing weekly uploads/);
});

test('missing or conflicting current schedule rules disable calculation without blocking live counts', async () => {
  api.getRaceSchedule = async () => ({
    Data: {
      fixtures: [
        { GamedayId: 18, SubstitutionsAllowed: 2, MaxSubstitutionsCF: 1 },
        { GamedayId: 18, SubstitutionsAllowed: 3, MaxSubstitutionsCF: 1 },
      ],
    },
  });
  assert.equal(await loadTransferRules(18), null);
  const result = await fetchSingleLeague('TEST');
  assert.equal(result.teamsData.teams[0].transfersStatus, 'unknown');
  assert.equal(result.teamsData.teams[1].transfersStatus, 'live');
  assert.equal(result.teamsData.teams[1].transfersRemaining, 3);
  api.getRaceSchedule = async () => ({
    Data: {
      fixtures: [
        { GamedayId: 41, SubstitutionsAllowed: 2, MaxSubstitutionsCF: 1 },
      ],
    },
  });
  assert.equal(await loadTransferRules(18), null);
});

test('owned and opponent multi-team responses preserve team selection and zero transfers', async () => {
  api.getLeagueLeaderboard = async () => [{ ...own, team_no: 3 }, opponent];
  api.getOpponentTeam = async (guid, md, options) => {
    calls.push({ source: 'opponent', guid, md, ...options });
    return state(md, options.teamNo, 0);
  };
  const result = await fetchSingleLeague('TEST');
  assert.equal(result.teamsData.teams[0].transfersRemaining, 3);
  assert.equal(result.teamsData.teams[1].transfersRemaining, 0);
  assert(
    calls.some((c) => c.source === 'own' && c.teamNo === 3 && c.md === 18),
  );
  assert(
    calls
      .filter((c) => c.source === 'opponent' && c.guid === opponent.user_guid)
      .every((c) => c.v === 2),
  );
});

test('current roster is fetched before the first scored race and with no score history', async () => {
  api.getLeagueLeaderboard = async () => [own];
  api.getOpponentGameDays = async () => ({ mdDetails: {} });
  api.getWebConfig = async () => ({ Data: { constraints: { GamedayId: 1 } } });
  const result = await fetchSingleLeague('TEST');
  assert.equal(result.teamsData.matchdayId, 1);
  assert.equal(result.teamsData.teams[0].teamStateStatus, 'current');
  assert(calls.some((c) => c.source === 'own' && c.md === 1));
});

test('overdrawn live transfer allowance means zero free transfers rather than missing data', async () => {
  api.getLeagueLeaderboard = async () => [own];
  api.getUserTeam = async (teamNo, md) => state(md, teamNo, -1);
  const result = await fetchSingleLeague('TEST');
  assert.equal(result.teamsData.teams[0].transfersRemaining, 0);
  assert.equal(result.teamsData.teams[0].teamStateStatus, 'current');
});

test('wrong matchday or team responses never become current transfers', async () => {
  api.getLeagueLeaderboard = async () => [opponent];
  api.getOpponentTeam = async () => state(17, 1, 2);
  const result = await fetchSingleLeague('TEST');
  const team = result.teamsData.teams[0];
  assert.equal(result.teamsData.matchdayId, 18);
  assert.equal(team.transfersRemaining, null);
  assert.equal(team.teamStateStatus, 'unavailable');
  assert.deepEqual(team.drivers, []);
});

test('canonical race uses config race number, falls back to account state, and never guesses', async () => {
  assert.equal(await resolveWeeklyMatchday(), 18);
  api.getWebConfig = async () => {
    throw new Error('Unavailable');
  };
  assert.equal(await resolveWeeklyMatchday(), 18);
  api.getUserGameDays = async () => ({ mddetails: { 17: { pts: 10 } } });
  await assert.rejects(resolveWeeklyMatchday(), /refusing to guess/);
});

test('season end keeps the canonical final race instead of probing a nonexistent next race', async () => {
  api.getWebConfig = async () => ({ Data: { constraints: { GamedayId: 22 } } });
  api.getLeagueLeaderboard = async () => [own];
  api.getOpponentGameDays = async () => ({ mdDetails: { 22: { pts: 10 } } });
  const result = await fetchSingleLeague('TEST');
  assert.equal(result.teamsData.matchdayId, 22);
  assert(calls.some((c) => c.source === 'own' && c.md === 22));
  assert.equal(
    calls.some((c) => c.md === 23),
    false,
  );
});

test('missing current price feed fails the weekly run instead of leaving misleading old global prices', async () => {
  api.getDrivers = async () => {
    throw new Error('Current feed unavailable');
  };
  await assert.rejects(fetchAllLeaguesData(), /refusing weekly uploads/);
  assert.equal(reports.length, 1);
});

test('owned account matching uses stable SocialId and rejects conflicting identities', () => {
  assert(isOwnAccount({ user_guid: 'opaque-0-123' }, { SocialId: 123 }));
  assert.equal(
    isOwnAccount({ user_guid: 'opaque-0-9123' }, { SocialId: 123 }),
    false,
  );
  assert.equal(isOwnAccount({ user_guid: 'opaque-0-123' }, null), false);
  assert(
    isOwnAccount(
      { social_id: 123, user_guid: 'unstructured' },
      { SocialId: 123 },
    ),
  );
  assert.equal(
    isOwnAccount(
      { social_id: 999, user_guid: 'opaque-0-123' },
      { SocialId: 123 },
    ),
    false,
  );
});
