/**
 * Fetches F1 Fantasy league standings.
 * Output: for each team → name, position, total score, and per-race scores.
 */
const f1Api = require('./f1FantasyApiService');

async function fetchLeagueData() {
  const leagueCode = process.env.F1_LEAGUE_CODE || 'C7UYMMWIO07';

  console.log('1. Logging in to F1 Fantasy...');
  await f1Api.init();
  console.log('   ✅ Logged in');

  console.log('2. Fetching league info...');
  const leagueInfo = await f1Api.getLeagueInfo(leagueCode);
  const leagueId = leagueInfo.leagueId;
  const leagueName = decodeURIComponent(leagueInfo.leagueName);
  console.log(`   League: ${leagueName} (ID: ${leagueId}, ${leagueInfo.memberCount} members)`);

  console.log('3. Fetching leaderboard...');
  const leaderboard = await f1Api.getLeagueLeaderboard(leagueId);
  console.log(`   Found ${leaderboard.length} teams`);

  console.log('4. Fetching per-race scores for each team...');
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

  const result = {
    fetchedAt: new Date().toISOString(),
    leagueName,
    leagueCode,
    leagueId,
    memberCount: leagueInfo.memberCount,
    teams,
  };

  console.log(`\n✅ Done: ${teams.length} teams fetched`);

  return result;
}

module.exports = { fetchLeagueData };
