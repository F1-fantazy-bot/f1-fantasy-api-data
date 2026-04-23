/**
 * Fetches F1 Fantasy league standings for all private leagues.
 * Returns an array of `{ league, teamsData }` tuples, one per league.
 */
const f1Api = require('./f1FantasyApiService');
const { extractChipsUsed } = require('./chips');
const { extractBudget, extractStartBudget } = require('./budget');
const { getMatchdayRoster, resetCache: resetRosterCache } = require('./rosterService');
const { downloadDataFromAzureStorage } = require('./azureBlobStorageService');

async function fetchAllLeaguesData() {
  console.log('1. Logging in to F1 Fantasy...');
  await f1Api.init();
  console.log('   ✅ Logged in');

  resetRosterCache();

  console.log('2. Fetching user leagues...');
  const allLeagues = await f1Api.getLeagues();
  const privateLeagues = allLeagues.filter((l) => l.league_type === 'Private' && l.league_code);
  console.log(`   Found ${allLeagues.length} total, ${privateLeagues.length} private leagues`);

  const results = [];

  for (const league of privateLeagues) {
    const leagueCode = league.league_code;
    const leagueName = decodeURIComponent(league.league_name);
    console.log(`\n--- ${leagueName} (${leagueCode}) ---`);

    try {
      const data = await fetchSingleLeague(leagueCode);
      results.push(data);
    } catch (err) {
      console.log(`   ❌ Failed: ${err.message}`);
    }
  }

  console.log(`\n✅ Done: ${results.length}/${privateLeagues.length} leagues fetched`);

  return results;
}

function _teamKey(userName, teamName) {
  return `${userName || ''}::${teamName || ''}`;
}

function _isValidTeamState(teamData) {
  const entry = Array.isArray(teamData?.userTeam) ? teamData.userTeam[0] : null;

  if (!entry) return false;

  const teamVal = entry.team_info?.teamVal;
  const hasTeamVal = typeof teamVal === 'number' && Number.isFinite(teamVal);
  const hasRoster = Array.isArray(entry.playerid) && entry.playerid.length > 0;

  return hasTeamVal && hasRoster;
}

async function _fetchTeamStateWithFallback(guid, teamNo, preferredMdid, fallbackMdid, teamName) {
  try {
    const teamData = await f1Api.getOpponentTeam(guid, preferredMdid, { teamNo });

    if (_isValidTeamState(teamData)) {
      return { teamData, matchdayId: preferredMdid };
    }
  } catch (err) {
    console.log(`   ⚠️ Upcoming matchday (${preferredMdid}) fetch failed for ${teamName}: ${err.message}`);
  }

  try {
    const teamData = await f1Api.getOpponentTeam(guid, fallbackMdid, { teamNo });

    if (_isValidTeamState(teamData)) {
      console.log(`   ⚠️ Using completed matchday ${fallbackMdid} for ${teamName} (upcoming unavailable)`);

      return { teamData, matchdayId: fallbackMdid };
    }
  } catch (err) {
    console.log(`   ⚠️ Could not fetch team data for ${teamName}: ${err.message}`);
  }

  return null;
}

function _extractRosterItems(teamData, rosterMap) {
  const teamEntry = Array.isArray(teamData?.userTeam) ? teamData.userTeam[0] : null;
  const playerIds = Array.isArray(teamEntry?.playerid) ? teamEntry.playerid : [];
  const drivers = [];
  const constructors = [];

  for (const p of playerIds) {
    if (!p || p.id === undefined || p.id === null) continue;
    const id = String(p.id);
    const info = rosterMap ? rosterMap.get(id) : null;
    const position = Number(p.playerpostion);
    const kindFromFeed = info?.kind;
    const kindFromPosition = Number.isFinite(position) && position >= 6 ? 'constructor' : 'driver';
    const kind = kindFromFeed || kindFromPosition;

    const entry = {
      id,
      name: info?.name || '',
      price: info?.price ?? null,
      isCaptain: Boolean(Number(p.iscaptain)),
      isMegaCaptain: Boolean(Number(p.ismgcaptain)),
      isFinal: Boolean(Number(p.isfinal)),
    };

    if (kind === 'constructor') {
      constructors.push(entry);
    } else {
      drivers.push(entry);
    }
  }

  return { drivers, constructors };
}

async function fetchSingleLeague(leagueCode) {
  console.log('   Fetching league info...');
  const leagueInfo = await f1Api.getLeagueInfo(leagueCode);
  const leagueId = leagueInfo.leagueId;
  const leagueName = decodeURIComponent(leagueInfo.leagueName);
  console.log(`   ${leagueName} (ID: ${leagueId}, ${leagueInfo.memberCount} members)`);

  console.log('   Fetching leaderboard...');
  const leaderboard = await f1Api.getLeagueLeaderboard(leagueId);
  console.log(`   ${leaderboard.length} teams`);

  let priorRaceBudgetsByTeam = new Map();

  try {
    const priorLeague = await downloadDataFromAzureStorage(leagueCode);

    if (priorLeague && Array.isArray(priorLeague.teams)) {
      for (const prior of priorLeague.teams) {
        if (prior?.raceBudgets && typeof prior.raceBudgets === 'object') {
          priorRaceBudgetsByTeam.set(_teamKey(prior.userName, prior.teamName), prior.raceBudgets);
        }
      }
      console.log(`   Loaded prior raceBudgets for ${priorRaceBudgetsByTeam.size} teams`);
    }
  } catch (err) {
    console.log(`   ⚠️ Could not load prior league-standings.json: ${err.message}`);
  }

  console.log('   Fetching per-race scores...');
  const teams = [];
  const teamsComposition = [];
  let leagueMatchdayId = null;

  for (const entry of leaderboard) {
    const teamName = decodeURIComponent(entry.team_name);
    const position = entry.cur_rank;
    const totalScore = entry.cur_points;
    const teamNo = entry.team_no || 1;
    let raceScores = {};
    let chipsUsed = [];
    let budget = null;
    let transfersRemaining = null;
    let lastCompletedMatchdayId = null;
    let teamStateMatchdayId = null;
    let drivers = [];
    let constructors = [];
    let raceBudgets = {
      ...(priorRaceBudgetsByTeam.get(_teamKey(entry.user_name, teamName)) || {}),
    };
    let completedMatchdayIds = [];

    try {
      const oppData = await f1Api.getOpponentGameDays(entry.user_guid, teamNo);
      const mdDetails = oppData?.mdDetails || {};

      for (const [matchdayId, details] of Object.entries(mdDetails)) {
        raceScores[`matchday_${matchdayId}`] = details.pts;
      }

      completedMatchdayIds = Object.keys(mdDetails).map(Number).filter(Number.isFinite);

      if (completedMatchdayIds.length) lastCompletedMatchdayId = Math.max(...completedMatchdayIds);

      try {
        chipsUsed = extractChipsUsed(oppData);
      } catch (err) {
        console.log(`   ⚠️ Could not extract chips for ${teamName}: ${err.message}`);
      }
    } catch (err) {
      console.log(`   ⚠️ Could not fetch race scores for ${teamName}: ${err.message}`);
    }

    if (lastCompletedMatchdayId) {
      // Prefer the upcoming matchday: driver/constructor prices update weekly,
      // transfer counts accrue for the next race, and if the team played
      // Limitless in the last race the roster has reverted to the real squad.
      // Fall back to the last completed matchday if the upcoming call returns
      // no data (e.g. end of season).
      const fetched = await _fetchTeamStateWithFallback(
        entry.user_guid,
        teamNo,
        lastCompletedMatchdayId + 1,
        lastCompletedMatchdayId,
        teamName,
      );

      if (fetched) {
        teamStateMatchdayId = fetched.matchdayId;

        if (!leagueMatchdayId) leagueMatchdayId = teamStateMatchdayId;

        budget = extractBudget(fetched.teamData);

        const teamEntry = Array.isArray(fetched.teamData?.userTeam) ? fetched.teamData.userTeam[0] : null;
        const subsLeft = teamEntry?.team_info?.userSubsleft ?? teamEntry?.usersubsleft;

        if (typeof subsLeft === 'number' && Number.isFinite(subsLeft)) {
          transfersRemaining = subsLeft;
        }

        try {
          const rosterMap = await getMatchdayRoster(teamStateMatchdayId);
          const composition = _extractRosterItems(fetched.teamData, rosterMap);
          drivers = composition.drivers;
          constructors = composition.constructors;
        } catch (err) {
          console.log(`   ⚠️ Could not resolve roster for ${teamName}: ${err.message}`);
        }

        // The upcoming race's start-of-week budget (maxTeambal) is already
        // finalized once the previous race ends — cost-cap carries over from
        // historical price rises and doesn't shift with in-week transfers.
        // Capture it from the response we already have so consumers can see
        // the next race's budget without waiting for the race to complete.
        const startBudget = extractStartBudget(fetched.teamData);

        if (startBudget !== null) {
          raceBudgets[`matchday_${teamStateMatchdayId}`] = startBudget;
        }
      }
    }

    // Historical per-race budgets: fetch only matchdays missing from the prior blob.
    const missingMdIds = completedMatchdayIds.filter(
      (mdid) => raceBudgets[`matchday_${mdid}`] === undefined,
    );

    for (const mdid of missingMdIds) {
      try {
        const teamData = await f1Api.getOpponentTeam(entry.user_guid, mdid, { teamNo });
        const val = extractStartBudget(teamData);

        if (val !== null) {
          raceBudgets[`matchday_${mdid}`] = val;
        }
      } catch (err) {
        console.log(
          `   ⚠️ Could not fetch budget for ${teamName} matchday ${mdid}: ${err.message}`,
        );
      }
    }

    teams.push({
      teamName,
      userName: entry.user_name,
      position,
      totalScore,
      raceScores,
      raceBudgets,
      chipsUsed,
    });

    teamsComposition.push({
      teamName,
      userName: entry.user_name,
      position,
      budget,
      transfersRemaining,
      drivers,
      constructors,
    });

    const chipSummary = chipsUsed.length ? ` [chips: ${chipsUsed.map((c) => c.name).join(', ')}]` : '';
    const budgetSummary = budget !== null ? ` [budget: ${budget}]` : '';
    const transfersSummary = transfersRemaining !== null ? ` [transfers: ${transfersRemaining}]` : '';
    const rosterSummary = drivers.length || constructors.length
      ? ` [roster@md${teamStateMatchdayId}: ${drivers.length}D/${constructors.length}C]`
      : '';
    const raceBudgetSummary = missingMdIds.length
      ? ` [+${missingMdIds.length} raceBudget${missingMdIds.length === 1 ? '' : 's'}]`
      : '';

    console.log(
      `   ${position}. ${teamName} — ${totalScore} pts${budgetSummary}${transfersSummary}${rosterSummary}${raceBudgetSummary}${chipSummary}`,
    );
  }

  const fetchedAt = new Date().toISOString();

  const league = {
    fetchedAt,
    leagueName,
    leagueCode,
    leagueId,
    memberCount: leagueInfo.memberCount,
    teams,
  };

  const teamsData = {
    fetchedAt,
    leagueName,
    leagueCode,
    leagueId,
    matchdayId: leagueMatchdayId,
    teams: teamsComposition,
  };

  return { league, teamsData };
}

module.exports = { fetchAllLeaguesData };
