/**
 * Locked-snapshot scrape: for each private league, capture the **just-locked**
 * matchday's roster, captain, budget, transfers and chips for every team.
 *
 * The "just-locked" matchday is `lastCompletedMatchdayId + 1` — i.e. the
 * race the user has just been locked into by qualifying (or sprint
 * qualifying on sprint weekends). This mode is intended to fire shortly
 * after each session start (qualifying / race / sprint) when the F1
 * Fantasy lock has just kicked in but the race has not yet ended.
 *
 * Why this is a separate path from the weekly scrape:
 *   - We must capture between lock and race-end. Once the race ends F1
 *     Fantasy auto-reverts Limitless, and a post-race fetch of the same
 *     matchday would silently overwrite the temporary mega-squad with the
 *     reverted real squad.
 *   - The output blob path is also different — `leagues/{code}/locked/
 *     matchday_{N}.json` — so consumers (the bot's `/league_changes` and
 *     `/live_score` features) can reason about lock state explicitly
 *     without ever clobbering the weekly `teams-data.json` blob.
 *
 * Returns an array of `{ league, blobName, payload }` tuples ready for
 * upload, where `blobName` is the per-matchday filename
 * (`locked/matchday_{N}.json`) and `payload` matches the shape consumers
 * already understand from `teams-data.json` plus a top-level `mode`
 * discriminator and per-team `chipsUsed`.
 */
const f1Api = require('./f1FantasyApiService');
const { extractChipsUsed } = require('./chips');
const { extractBudget } = require('./budget');
const {
  getMatchdayRoster,
  resetCache: resetRosterCache,
} = require('./rosterService');

function _isValidTeamState(teamData) {
  const entry = Array.isArray(teamData?.userTeam) ? teamData.userTeam[0] : null;
  if (!entry) return false;

  const teamVal = entry.team_info?.teamVal;
  const hasTeamVal = typeof teamVal === 'number' && Number.isFinite(teamVal);
  const hasRoster = Array.isArray(entry.playerid) && entry.playerid.length > 0;

  return hasTeamVal && hasRoster;
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

function _resolveTransfersRemaining(teamData) {
  const teamEntry = Array.isArray(teamData?.userTeam) ? teamData.userTeam[0] : null;
  const subsLeft = teamEntry?.team_info?.userSubsleft ?? teamEntry?.usersubsleft;

  return typeof subsLeft === 'number' && Number.isFinite(subsLeft) ? subsLeft : null;
}

async function _fetchLockedTeamSnapshot(entry, teamName) {
  const teamNo = entry.team_no || 1;

  let oppData;
  try {
    oppData = await f1Api.getOpponentGameDays(entry.user_guid, teamNo);
  } catch (err) {
    console.log(`   ⚠️ Could not fetch game days for ${teamName}: ${err.message}`);

    return null;
  }

  const mdDetails = oppData?.mdDetails || {};
  const completedMatchdayIds = Object.keys(mdDetails)
    .map(Number)
    .filter(Number.isFinite);

  if (completedMatchdayIds.length === 0) {
    console.log(`   ⚠️ No matchdays in mdDetails for ${teamName} — skipping`);

    return null;
  }

  const lastInDetails = Math.max(...completedMatchdayIds);

  // The "imminent race weekend" can be either lastInDetails+1 (between
  // weekends, after the previous race fully scored) or lastInDetails itself
  // (during a weekend after the first sub-event already scored — typically a
  // sprint that happened earlier in the same weekend).
  // Try +1 first; if the API returns an empty/null state for that matchday
  // (no playerid, no teamVal) it means that matchday hasn't been locked yet,
  // and the currently-in-progress weekend is lastInDetails.
  const candidateMatchdays = [lastInDetails + 1, lastInDetails];
  let teamData = null;
  let lockedMatchdayId = null;

  for (const md of candidateMatchdays) {
    let resp;
    try {
      resp = await f1Api.getOpponentTeam(entry.user_guid, md, { teamNo });
    } catch (err) {
      console.log(
        `   ⚠️ getOpponentTeam(${md}) failed for ${teamName}: ${err.message}`,
      );
      continue;
    }
    if (_isValidTeamState(resp)) {
      teamData = resp;
      lockedMatchdayId = md;
      break;
    }
  }

  if (!teamData) {
    console.log(
      `   ⚠️ Locked team state invalid for ${teamName} (tried md ${candidateMatchdays.join(', ')}) — skipping`,
    );

    return null;
  }

  let chipsUsed = [];
  try {
    chipsUsed = extractChipsUsed(oppData);
  } catch (err) {
    console.log(`   ⚠️ Could not extract chips for ${teamName}: ${err.message}`);
  }

  let drivers = [];
  let constructors = [];
  try {
    const rosterMap = await getMatchdayRoster(lockedMatchdayId);
    const composition = _extractRosterItems(teamData, rosterMap);
    drivers = composition.drivers;
    constructors = composition.constructors;
  } catch (err) {
    console.log(`   ⚠️ Could not resolve roster for ${teamName}: ${err.message}`);
  }

  return {
    teamName,
    userName: entry.user_name,
    position: entry.cur_rank,
    matchdayId: lockedMatchdayId,
    budget: extractBudget(teamData),
    transfersRemaining: _resolveTransfersRemaining(teamData),
    drivers,
    constructors,
    chipsUsed,
  };
}

function _groupByMatchday(snapshots) {
  const byMd = new Map();
  for (const snap of snapshots) {
    if (!snap) continue;
    const list = byMd.get(snap.matchdayId) || [];
    list.push(snap);
    byMd.set(snap.matchdayId, list);
  }

  return byMd;
}

async function fetchSingleLeagueLocked(leagueCode) {
  console.log('   Fetching league info...');
  const leagueInfo = await f1Api.getLeagueInfo(leagueCode);
  const leagueId = leagueInfo.leagueId;
  const leagueName = decodeURIComponent(leagueInfo.leagueName);
  console.log(`   ${leagueName} (ID: ${leagueId}, ${leagueInfo.memberCount} members)`);

  console.log('   Fetching leaderboard...');
  const leaderboard = await f1Api.getLeagueLeaderboard(leagueId);
  console.log(`   ${leaderboard.length} teams`);

  console.log('   Fetching locked snapshots...');
  const snapshots = [];
  for (const entry of leaderboard) {
    const teamName = decodeURIComponent(entry.team_name);
    const snap = await _fetchLockedTeamSnapshot(entry, teamName);
    if (snap) {
      snapshots.push(snap);
      const chipSummary = snap.chipsUsed.length
        ? ` [chips: ${snap.chipsUsed.map((c) => c.name).join(', ')}]`
        : '';
      console.log(
        `   ${snap.position}. ${snap.teamName} — md${snap.matchdayId} [${snap.drivers.length}D/${snap.constructors.length}C]${chipSummary}`,
      );
    }
  }

  // In steady state every team in a league shares the same locked matchday,
  // but group robustly in case of scrape-time straddles.
  const grouped = _groupByMatchday(snapshots);
  const fetchedAt = new Date().toISOString();
  const blobs = [];

  for (const [matchdayId, teams] of grouped.entries()) {
    blobs.push({
      blobName: `locked/matchday_${matchdayId}.json`,
      payload: {
        fetchedAt,
        mode: 'locked',
        leagueName,
        leagueCode,
        leagueId,
        matchdayId,
        teams,
      },
    });
  }

  return {
    league: { leagueCode, leagueName, leagueId, memberCount: leagueInfo.memberCount },
    blobs,
  };
}

async function fetchAllLeaguesLocked() {
  console.log('1. Logging in to F1 Fantasy...');
  await f1Api.init();
  console.log('   ✅ Logged in');

  resetRosterCache();

  console.log('2. Fetching user leagues...');
  const allLeagues = await f1Api.getLeagues();
  const privateLeagues = allLeagues.filter(
    (l) => l.league_type === 'Private' && l.league_code,
  );
  console.log(
    `   Found ${allLeagues.length} total, ${privateLeagues.length} private leagues`,
  );

  const results = [];

  for (const league of privateLeagues) {
    const leagueCode = league.league_code;
    const leagueName = decodeURIComponent(league.league_name);
    console.log(`\n--- ${leagueName} (${leagueCode}) ---`);

    try {
      const data = await fetchSingleLeagueLocked(leagueCode);
      results.push(data);
    } catch (err) {
      console.log(`   ❌ Failed: ${err.message}`);
    }
  }

  const totalBlobs = results.reduce((acc, r) => acc + r.blobs.length, 0);
  console.log(
    `\n✅ Done: ${results.length}/${privateLeagues.length} leagues, ${totalBlobs} locked-matchday blob(s) ready`,
  );

  return results;
}

module.exports = {
  fetchAllLeaguesLocked,
  fetchSingleLeagueLocked,
  // exported for tests
  _fetchLockedTeamSnapshot,
};
