const { test } = require('node:test');
const assert = require('node:assert/strict');
const f1Api = require('./f1FantasyApiService');
const rosterService = require('./rosterService');
const { deriveAccountId } = require('./accountId');

const originals = {};
for (const name of ['getLeagueInfo', 'getLeagueLeaderboard', 'getOpponentGameDays', 'getOpponentTeam']) {
  originals[name] = f1Api[name];
}
const originalRoster = rosterService.getMatchdayRoster;
rosterService.getMatchdayRoster = async () => new Map([['42', { name: 'Norris', price: 30, kind: 'driver' }]]);
const { fetchSingleLeague } = require('./fetchLeagueData');
const { _fetchLockedTeamSnapshot } = require('./fetchLockedLeagueData');

test('weekly and locked team blobs distinguish accounts and use team_no as opponent v', async () => {
  const entries = [
    { user_name: 'Tom Kregenbild', team_name: 'NoNoItsSoNotRightMikeyNO', team_no: 1, user_guid: 'f1-account/opaque-001', cur_rank: 1, cur_points: 100 },
    { user_name: 'Tom Kregenbild', team_name: 'Agentic Racing Co.', team_no: 1, user_guid: '00000000-0000-0000-0000-000000000002', cur_rank: 2, cur_points: 90 },
    { user_name: 'Someone', team_name: 'Second Squad', team_no: 2, user_guid: '00000000-0000-0000-0000-000000000003', cur_rank: 3, cur_points: 80 },
  ];
  const calls = [];
  f1Api.getLeagueInfo = async () => ({ leagueId: 10, leagueName: 'Test', memberCount: 3 });
  f1Api.getLeagueLeaderboard = async () => entries;
  f1Api.getOpponentGameDays = async (guid, teamNo, v) => {
    calls.push({ kind: 'days', guid, teamNo, v });
    return { mdDetails: { 1: { pts: 10 } } };
  };
  f1Api.getOpponentTeam = async (guid, md, options) => {
    calls.push({ kind: 'team', guid, md, ...options });
    return { userTeam: [{ playerid: [{ id: 42, playerpostion: 1, iscaptain: 1 }],
      team_info: { teamVal: 30, maxTeambal: 100 }, usersubsleft: 1 }] };
  };
  try {
    const weekly = await fetchSingleLeague('ABC');
    assert.deepEqual(weekly.league.teams.map((team) => team.accountId),
      entries.map((entry) => deriveAccountId(entry.user_guid)));
    assert.deepEqual(weekly.teamsData.teams.map((team) => team.accountId),
      entries.map((entry) => deriveAccountId(entry.user_guid)));
    assert.notEqual(weekly.league.teams[0].accountId, weekly.league.teams[1].accountId);
    assert.match(weekly.league.teams[0].accountId, /^[a-f0-9]{12}$/);
    assert.equal(JSON.stringify(weekly).includes(entries[0].user_guid), false);
    assert(calls.filter((call) => call.guid === '00000000-0000-0000-0000-000000000003').every((call) => call.v === 2));

    const locked = await _fetchLockedTeamSnapshot(entries[2], 'Second Squad');
    assert.equal(locked.accountId, deriveAccountId('00000000-0000-0000-0000-000000000003'));
    assert.equal(locked.teamNo, 2);
    assert.equal(JSON.stringify(locked).includes('00000000-0000-0000-0000-000000000003'), false);
    assert(calls.filter((call) => call.guid === '00000000-0000-0000-0000-000000000003').every((call) => call.v === 2));

    const missingGuid = { ...entries[0], user_guid: null };
    await assert.rejects(_fetchLockedTeamSnapshot(missingGuid, 'NoNoItsSoNotRightMikeyNO'),
      /Missing valid account identifier/);
    f1Api.getLeagueLeaderboard = async () => [missingGuid];
    await assert.rejects(fetchSingleLeague('ABC'), /Missing valid account identifier/);
  } finally {
    for (const [name, original] of Object.entries(originals)) f1Api[name] = original;
    rosterService.getMatchdayRoster = originalRoster;
  }
});
