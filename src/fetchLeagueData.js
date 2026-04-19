/**
 * Fetches F1 Fantasy league standings for all private leagues.
 * Returns an array of `{ league, teamsData }` tuples, one per league.
 */
const f1Api = require('./f1FantasyApiService');
const { extractChipsUsed } = require('./chips');
const { extractBudget } = require('./budget');
const { getMatchdayRoster, resetCache: resetRosterCache } = require('./rosterService');

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
    let currentMatchdayId = null;
    let drivers = [];
    let constructors = [];

    try {
      const oppData = await f1Api.getOpponentGameDays(entry.user_guid, teamNo);
      const mdDetails = oppData?.mdDetails || {};

      for (const [matchdayId, details] of Object.entries(mdDetails)) {
        raceScores[`matchday_${matchdayId}`] = details.pts;
      }

      const mdIds = Object.keys(mdDetails).map(Number).filter(Number.isFinite);

      if (mdIds.length) currentMatchdayId = Math.max(...mdIds);

      try {
        chipsUsed = extractChipsUsed(oppData);
      } catch (err) {
        console.log(`   ⚠️ Could not extract chips for ${teamName}: ${err.message}`);
      }
    } catch (err) {
      console.log(`   ⚠️ Could not fetch race scores for ${teamName}: ${err.message}`);
    }

    if (currentMatchdayId) {
      if (!leagueMatchdayId) leagueMatchdayId = currentMatchdayId;

      try {
        const teamData = await f1Api.getOpponentTeam(entry.user_guid, currentMatchdayId, { teamNo });

        budget = extractBudget(teamData);

        const teamEntry = Array.isArray(teamData?.userTeam) ? teamData.userTeam[0] : null;
        const subsLeft = teamEntry?.usersubsleft ?? teamEntry?.team_info?.userSubsleft;

        if (typeof subsLeft === 'number' && Number.isFinite(subsLeft)) {
          transfersRemaining = subsLeft;
        }

        try {
          const rosterMap = await getMatchdayRoster(currentMatchdayId);
          const composition = _extractRosterItems(teamData, rosterMap);
          drivers = composition.drivers;
          constructors = composition.constructors;
        } catch (err) {
          console.log(`   ⚠️ Could not resolve roster for ${teamName}: ${err.message}`);
        }
      } catch (err) {
        console.log(`   ⚠️ Could not fetch team data for ${teamName}: ${err.message}`);
      }
    }

    teams.push({
      teamName,
      userName: entry.user_name,
      position,
      totalScore,
      raceScores,
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
      ? ` [roster: ${drivers.length}D/${constructors.length}C]`
      : '';

    console.log(
      `   ${position}. ${teamName} — ${totalScore} pts${budgetSummary}${transfersSummary}${rosterSummary}${chipSummary}`,
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
