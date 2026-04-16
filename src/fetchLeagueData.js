/**
 * Fetches F1 Fantasy league standings for all private leagues.
 * Returns an array of league data objects, one per league.
 */
const f1Api = require('./f1FantasyApiService');

async function fetchAllLeaguesData() {
  console.log('1. Logging in to F1 Fantasy...');
  await f1Api.init();
  console.log('   ✅ Logged in');

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

  for (const entry of leaderboard) {
    const teamName = decodeURIComponent(entry.team_name);
    const position = entry.cur_rank;
    const totalScore = entry.cur_points;
    let raceScores = {};

    try {
      const oppData = await f1Api.getOpponentGameDays(entry.user_guid, entry.team_no || 1);
      const mdDetails = oppData?.mdDetails || {};

      for (const [matchdayId, details] of Object.entries(mdDetails)) {
        raceScores[`matchday_${matchdayId}`] = details.pts;
      }
    } catch (err) {
      console.log(`   ⚠️ Could not fetch race scores for ${teamName}: ${err.message}`);
    }

    teams.push({
      teamName,
      userName: entry.user_name,
      position,
      totalScore,
      raceScores,
    });

    console.log(`   ${position}. ${teamName} — ${totalScore} pts`);
  }

  return {
    fetchedAt: new Date().toISOString(),
    leagueName,
    leagueCode,
    leagueId,
    memberCount: leagueInfo.memberCount,
    teams,
  };
}

module.exports = { fetchAllLeaguesData };
