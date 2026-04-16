/**
 * Fetches F1 Fantasy league data using the API service.
 * Orchestrates: login → fetch leagues → fetch leaderboard → return structured data.
 */
const f1Api = require('./f1FantasyApiService');

async function fetchLeagueData() {
  const leagueCode = process.env.F1_LEAGUE_CODE || 'C7UYMMWIO07';

  console.log('1. Logging in to F1 Fantasy...');
  const session = await f1Api.init();
  console.log(`   ✅ Logged in as: ${session.FirstName} ${session.LastName} (GUID: ${session.GUID})`);

  console.log('2. Fetching leagues...');
  const leagues = await f1Api.getLeagues();
  console.log(`   Found ${leagues.length} league(s)`);

  console.log(`3. Fetching league info for ${leagueCode}...`);
  const leagueInfo = await f1Api.getLeagueInfo(leagueCode);
  console.log(`   League: ${decodeURIComponent(leagueInfo.leagueName)} (${leagueInfo.memberCount} members)`);

  console.log('4. Fetching user game days...');
  const gameDays = await f1Api.getUserGameDays(1);
  const currentMatchday = gameDays.cumdid;
  console.log(`   Team: ${decodeURIComponent(gameDays.teamname || 'unknown')}, Matchday: ${currentMatchday}`);

  console.log('5. Fetching user team...');
  const userTeam = currentMatchday ? await f1Api.getUserTeam(1, currentMatchday) : null;

  if (userTeam) {
    const team = userTeam?.userTeam?.[0];
    console.log(`   Value: ${team?.teamval}, Balance: ${team?.teambal}, Players: ${team?.playerid?.length}`);
  }

  console.log('6. Fetching user rank...');
  const targetLeague = leagues.find((l) => l.league_code === leagueCode);
  let userRank = null;

  if (targetLeague) {
    const leagueType = targetLeague.league_type.toLowerCase();

    try {
      userRank = await f1Api.getUserRank(1, leagueType, targetLeague.league_id);
    } catch (err) {
      console.log(`   ⚠️ Could not fetch rank: ${err.message}`);
    }
  }

  console.log('7. Fetching drivers feed...');
  let drivers = [];

  if (currentMatchday) {
    try {
      drivers = await f1Api.getDrivers(currentMatchday);
    } catch (err) {
      console.log(`   ⚠️ Could not fetch drivers: ${err.message}`);
    }
  }

  // Build output
  const result = {
    fetchedAt: new Date().toISOString(),
    user: {
      firstName: session.FirstName,
      lastName: session.LastName,
      guid: session.GUID,
      socialId: session.SocialId,
      teamCount: session.TeamCount,
    },
    currentMatchday,
    league: {
      leagueCode: leagueInfo.leagueCode,
      leagueName: decodeURIComponent(leagueInfo.leagueName),
      leagueType: leagueInfo.leaugeType,
      memberCount: leagueInfo.memberCount,
      admin: {
        userName: leagueInfo.userName,
        teamName: leagueInfo.teamName,
      },
      dateCreated: leagueInfo.dateCreated,
      userList: leagueInfo.user_list || [],
    },
    userRank: Array.isArray(userRank) && userRank.length > 0
      ? {
        rank: userRank[0].cur_rank,
        points: userRank[0].cur_points,
        trend: userRank[0].trend,
        teamName: decodeURIComponent(userRank[0].team_name || ''),
      }
      : null,
    userTeam: userTeam?.userTeam?.[0]
      ? {
        teamName: decodeURIComponent(userTeam.userTeam[0].teamname || ''),
        teamValue: userTeam.userTeam[0].teamval,
        balance: userTeam.userTeam[0].teambal,
        players: userTeam.userTeam[0].playerid?.map((p) => ({
          id: p.id,
          isCaptain: p.iscaptain === 1,
          position: p.playerpostion,
        })) || [],
        chips: {
          wildcard: gameDays.iswildcardtaken === 1,
          limitless: gameDays.islimitlesstaken === 1,
          finalFix: gameDays.isfinalfixtaken === 0,
          extraDrs: gameDays.isextradrstaken === 1,
          noNegative: gameDays.isnonigativetaken === 1,
          autopilot: gameDays.isautopilottaken === 1,
        },
      }
      : null,
    allLeagues: leagues.map((l) => ({
      leagueId: l.league_id,
      leagueCode: l.league_code,
      leagueName: decodeURIComponent(l.league_name),
      leagueType: l.league_type,
      memberCount: l.member_count,
      formattedMemberCount: l.formatted_member_count,
      rank: l.teams?.[0]?.cur_rank ?? null,
    })),
    drivers: Array.isArray(drivers)
      ? drivers.map((d) => ({
        playerId: d.PlayerId,
        displayName: d.DisplayName,
        fullName: d.FUllName,
        teamName: d.TeamName,
        driverTLA: d.DriverTLA,
        value: d.Value,
        overallPoints: d.OverallPpints,
        gamedayPoints: d.GamedayPoints,
        selectedPercentage: d.SelectedPercentage,
        positionName: d.PositionName,
      }))
      : [],
  };

  console.log(`\n✅ Data assembled: ${result.allLeagues.length} leagues, ${result.drivers.length} drivers`);

  return result;
}

module.exports = { fetchLeagueData };
