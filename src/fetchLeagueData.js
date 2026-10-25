/**
 * Fetches F1 Fantasy league standings for all private leagues.
 * Returns an array of `{ league, teamsData }` tuples, one per league.
 */
const f1Api = require('./f1FantasyApiService');
const { extractChipsUsed } = require('./chips');
const { extractBudget } = require('./budget');
const {
  getMatchdayRoster,
  getPlayersByMatchday,
  resetCache: resetRosterCache,
} = require('./rosterService');
const storage = require('./azureBlobStorageService');
const { deriveAccountId } = require('./accountId');
const { indexPriorRaceBudgets } = require('./priorRaceBudgets');
const { WeeklyDiagnostics } = require('./weeklyDiagnostics');
const { reconstructRaceStartBaseline } = require('./raceStartBaseline');
const {
  loadTransferRules,
  resolveTransferAllowance,
} = require('./transferAllowance');
const {
  resolveWeeklyMatchday,
  isOwnAccount,
  isValidTeamState,
  isValidTeamMetadata,
  fetchWeeklyTeamState,
} = require('./weeklyState');

async function fetchAllLeaguesData(diagnostics = new WeeklyDiagnostics()) {
  diagnostics.setStage('login');
  console.log('1. Logging in to F1 Fantasy...');
  const session = await f1Api.init();
  diagnostics.protect(session?.GUID, session?.SocialId, session?.UserId);
  console.log('   ✅ Logged in');

  diagnostics.setStage('fetch', { operation: 'current race resolution' });
  const matchdayId = await resolveWeeklyMatchday();
  diagnostics.currentMatchdayId = matchdayId;
  console.log(`   Current race: ${matchdayId}`);
  diagnostics.setStage('fetch', { operation: 'transfer rule resolution' });
  const transferRules = await loadTransferRules(matchdayId, diagnostics);

  resetRosterCache();

  console.log('2. Fetching user leagues...');
  diagnostics.setStage('league discovery');
  const allLeagues = await f1Api.getLeagues();
  const privateLeagues = allLeagues.filter(
    (l) => l.league_type === 'Private' && l.league_code,
  );
  console.log(
    `   Found ${allLeagues.length} total, ${privateLeagues.length} private leagues`,
  );

  const results = [];
  diagnostics.setStage('fetch');

  for (const league of privateLeagues) {
    const leagueCode = league.league_code;
    const leagueName = decodeURIComponent(league.league_name);
    console.log(`\n--- ${leagueName} (${leagueCode}) ---`);

    try {
      const data = await fetchSingleLeague(
        leagueCode,
        diagnostics,
        matchdayId,
        transferRules,
      );
      results.push(data);
    } catch (err) {
      console.log(`   ❌ Failed: ${err.message}`);
      diagnostics.record('League fetch failed', { league: leagueCode }, err);
    }
  }

  console.log(
    `\n✅ Done: ${results.length}/${privateLeagues.length} leagues fetched`,
  );

  // Prices are public and independent of whether opponent rosters are visible.
  let prices = null;
  try {
    const { drivers, constructors } = await getPlayersByMatchday(matchdayId);
    prices = {
      fetchedAt: new Date().toISOString(),
      matchdayId,
      drivers,
      constructors,
    };
    if (
      !drivers.length ||
      !constructors.length ||
      [...drivers, ...constructors].some((p) => !Number.isFinite(p.price))
    ) {
      diagnostics.record('Global price feed incomplete', {
        matchday: matchdayId,
      });
    }
  } catch (err) {
    diagnostics.record(
      'Global prices fetch failed',
      { matchday: matchdayId },
      err,
    );
  }
  if (
    !prices ||
    !prices.drivers.length ||
    !prices.constructors.length ||
    [...prices.drivers, ...prices.constructors].some(
      (p) => !Number.isFinite(p.price),
    )
  ) {
    throw new Error(
      `Current race ${matchdayId} prices unavailable or incomplete; refusing weekly uploads`,
    );
  }

  return { leagues: results, prices };
}

function _extractRosterItems(teamData, rosterMap) {
  const teamEntry = Array.isArray(teamData?.userTeam)
    ? teamData.userTeam[0]
    : null;
  const playerIds = Array.isArray(teamEntry?.playerid)
    ? teamEntry.playerid
    : [];
  const drivers = [];
  const constructors = [];

  for (const p of playerIds) {
    if (!p || p.id === undefined || p.id === null) continue;
    const id = String(p.id);
    const info = rosterMap ? rosterMap.get(id) : null;
    const position = Number(p.playerpostion);
    const kindFromFeed = info?.kind;
    const kindFromPosition =
      Number.isFinite(position) && position >= 6 ? 'constructor' : 'driver';
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

async function fetchSingleLeague(
  leagueCode,
  diagnostics = null,
  matchdayId = null,
  transferRules = undefined,
) {
  matchdayId = matchdayId ?? (await resolveWeeklyMatchday());
  if (transferRules === undefined)
    transferRules = await loadTransferRules(matchdayId, diagnostics);
  console.log('   Fetching league info...');
  const leagueInfo = await f1Api.getLeagueInfo(leagueCode);
  const leagueId = leagueInfo.leagueId;
  const leagueName = decodeURIComponent(leagueInfo.leagueName);
  console.log(
    `   ${leagueName} (ID: ${leagueId}, ${leagueInfo.memberCount} members)`,
  );

  console.log('   Fetching leaderboard...');
  const leaderboard = await f1Api.getLeagueLeaderboard(leagueId);
  for (const entry of leaderboard) {
    diagnostics?.protect(
      entry.user_guid,
      entry.social_id,
      entry.user_name,
      deriveAccountId(entry.user_guid),
    );
  }
  console.log(`   ${leaderboard.length} teams`);

  let priorTeams = [];

  try {
    const priorLeague = await storage.downloadDataFromAzureStorage(leagueCode);

    if (priorLeague && Array.isArray(priorLeague.teams)) {
      priorTeams = priorLeague.teams;
      console.log(`   Loaded prior raceBudgets for ${priorTeams.length} teams`);
    }
  } catch (err) {
    diagnostics?.record(
      'Prior standings download failed',
      { league: leagueCode },
      err,
    );
    console.log(
      `   ⚠️ Could not load prior league-standings.json: ${err.message}`,
    );
  }

  console.log('   Fetching per-race scores...');
  const teams = [];
  const teamsComposition = [];
  const findPriorRaceBudgets = indexPriorRaceBudgets(priorTeams, leaderboard);
  const leagueMatchdayId = matchdayId;

  for (const entry of leaderboard) {
    const teamName = decodeURIComponent(entry.team_name);
    const position = entry.cur_rank;
    const totalScore = entry.cur_points;
    const teamNo = entry.team_no || 1;
    const accountId = deriveAccountId(entry.user_guid);
    if (!accountId) {
      throw new Error(
        `Missing valid account identifier for ${teamName} in league ${leagueCode}; refusing to upload incomplete team identities`,
      );
    }
    let raceScores = {};
    let chipsUsed = [];
    let budget = null;
    let budgetStatus = 'unknown';
    let budgetSourceMatchdayId = null;
    let lastCompletedMatchdayId = null;
    let teamStateStatus = 'unavailable';
    let historicalTeamData = null;
    let teamStateMatchdayId = null;
    let drivers = [];
    let constructors = [];
    const priorRaceBudgets = findPriorRaceBudgets(entry);
    let raceBudgets = { ...priorRaceBudgets };
    let completedMatchdayIds = [];
    const diagnosticContext = {
      league: leagueCode,
      team: teamName,
      teamNo,
      accountId,
    };

    try {
      // v = teamNo so a user with multiple teams returns each one's
      // distinct mdDetails / chip flags.
      const oppData = await f1Api.getOpponentGameDays(
        entry.user_guid,
        teamNo,
        teamNo,
      );
      const mdDetails = oppData?.mdDetails || {};

      for (const [matchdayId, details] of Object.entries(mdDetails)) {
        if (Number.isFinite(details?.pts))
          raceScores[`matchday_${matchdayId}`] = details.pts;
      }

      completedMatchdayIds = Object.entries(mdDetails)
        .filter(
          ([md, details]) =>
            Number(md) < matchdayId && Number.isFinite(details?.pts),
        )
        .map(([md]) => Number(md))
        .filter(Number.isFinite);

      if (completedMatchdayIds.length)
        lastCompletedMatchdayId = Math.max(...completedMatchdayIds);

      try {
        chipsUsed = extractChipsUsed(oppData);
      } catch (err) {
        diagnostics?.record('Chip extraction failed', diagnosticContext, err);
        console.log(
          `   ⚠️ Could not extract chips for ${teamName}: ${err.message}`,
        );
      }
    } catch (err) {
      diagnostics?.record('Race scores fetch failed', diagnosticContext, err);
      console.log(
        `   ⚠️ Could not fetch race scores for ${teamName}: ${err.message}`,
      );
    }

    let teamData = null;
    let currentTeamData = null;
    const archivedResponses = new Map();
    const fetchArchivedTeam = async (md) => {
      if (!archivedResponses.has(md)) {
        archivedResponses.set(
          md,
          f1Api.getOpponentTeam(entry.user_guid, md, { teamNo, v: teamNo }),
        );
      }
      return archivedResponses.get(md);
    };
    try {
      const current = await fetchWeeklyTeamState(entry, matchdayId);
      currentTeamData = current;
      if (isValidTeamState(current, matchdayId, teamNo)) {
        teamData = current;
        teamStateMatchdayId = matchdayId;
        teamStateStatus = 'current';
      } else {
        const context = {
          ...diagnosticContext,
          requested: matchdayId,
          apiSuccess: current?.Meta?.Success,
          apiRetVal: current?.Meta?.RetVal ?? current?.retval,
          returned: current?.mdid,
        };
        const expectedOpponentAbsence =
          !isOwnAccount(entry) &&
          current?.Meta?.Success === false &&
          (current.Meta.RetVal ?? current.retval) === -1;
        if (expectedOpponentAbsence) {
          diagnostics?.recordInfo(
            'Live opponent response unavailable',
            context,
          );
        } else {
          diagnostics?.record('Upcoming team response rejected', context);
        }
      }
    } catch (err) {
      diagnostics?.record(
        'Upcoming team request failed',
        diagnosticContext,
        err,
      );
    }

    if (teamData) {
      budget = extractBudget(teamData);
      if (budget !== null) {
        budgetStatus = 'live';
        budgetSourceMatchdayId = matchdayId;
      } else diagnostics?.record('Team budget missing', diagnosticContext);
    } else if (matchdayId > 1) {
      try {
        const previous = await fetchArchivedTeam(matchdayId - 1);
        const baseline = await reconstructRaceStartBaseline({
          previous,
          matchdayId,
          teamNo,
          chips: transferRules?.chips,
          fetchArchivedTeam,
          getRoster: getMatchdayRoster,
        });
        teamData = baseline.teamData;
        teamStateStatus = baseline.teamStateStatus;
        teamStateMatchdayId = baseline.teamStateMatchdayId;
        budget = baseline.budget;
        budgetStatus = baseline.budgetStatus;
        budgetSourceMatchdayId = baseline.budgetSourceMatchdayId;
        diagnostics?.recordInfo(
          'Reconstructed race-start baselines',
          diagnosticContext,
        );
      } catch (err) {
        diagnostics?.record(
          'Race-start reconstruction failed',
          diagnosticContext,
          err,
        );
      }
    }
    if (!teamData) {
      diagnostics?.record('Current team state unavailable', diagnosticContext);
      // Keep a clearly labeled last-known roster, priced for the current race.
      // Its historical transfers and budget must not become current values.
      if (lastCompletedMatchdayId) {
        try {
          const historical = await fetchArchivedTeam(lastCompletedMatchdayId);
          if (isValidTeamState(historical, lastCompletedMatchdayId, teamNo)) {
            historicalTeamData = historical;
            teamData = historical;
            teamStateMatchdayId = lastCompletedMatchdayId;
            teamStateStatus = 'historical';
          }
        } catch (err) {
          diagnostics?.record(
            'Historical roster request failed',
            diagnosticContext,
            err,
          );
        }
      }
    }
    if (budget !== null) raceBudgets[`matchday_${matchdayId}`] = budget;
    else delete raceBudgets[`matchday_${matchdayId}`];

    let transferState = resolveTransferAllowance(
      currentTeamData,
      null,
      matchdayId,
      teamNo,
      transferRules,
    );
    if (
      transferState.transfersStatus === 'unknown' &&
      matchdayId > 1 &&
      transferRules
    ) {
      try {
        // Always query F1 for the immediately previous race. A saved Singapore
        // snapshot (or an older scored race) must not supply this calculation.
        const previous = await fetchArchivedTeam(matchdayId - 1);
        transferState = resolveTransferAllowance(
          currentTeamData,
          previous,
          matchdayId,
          teamNo,
          transferRules,
        );
      } catch (err) {
        diagnostics?.record(
          'Previous race transfers request failed',
          { ...diagnosticContext, requested: matchdayId - 1 },
          err,
        );
      }
    }
    if (transferState.transfersStatus === 'calculated-race-start') {
      diagnostics?.recordInfo(
        'Calculated race-start transfers',
        diagnosticContext,
      );
    } else if (transferState.transfersStatus === 'unknown') {
      diagnostics?.record('Remaining transfers unknown', diagnosticContext);
    }

    if (teamData) {
      try {
        const rosterMap = await getMatchdayRoster(matchdayId);
        const composition = _extractRosterItems(teamData, rosterMap);
        drivers = composition.drivers;
        constructors = composition.constructors;
        if (
          drivers.length !== 5 ||
          constructors.length !== 2 ||
          [...drivers, ...constructors].some((p) => !p.name || p.price === null)
        ) {
          diagnostics?.record('Incomplete roster or prices', diagnosticContext);
        }
      } catch (err) {
        diagnostics?.record('Roster resolution failed', diagnosticContext, err);
      }
    }

    // Historical per-race budgets: fetch only matchdays missing from the prior blob.
    const missingMdIds = completedMatchdayIds.filter(
      (mdid) => raceBudgets[`matchday_${mdid}`] === undefined,
    );

    for (const mdid of missingMdIds) {
      try {
        const teamData =
          mdid === teamStateMatchdayId && historicalTeamData
            ? historicalTeamData
            : await fetchArchivedTeam(mdid);
        const val = isValidTeamMetadata(teamData, mdid, teamNo)
          ? extractBudget(teamData)
          : null;

        if (val !== null) {
          raceBudgets[`matchday_${mdid}`] = val;
        }
      } catch (err) {
        diagnostics?.record(
          'Historical budget request failed',
          { ...diagnosticContext, requested: mdid },
          err,
        );
        console.log(
          `   ⚠️ Could not fetch budget for ${teamName} matchday ${mdid}: ${err.message}`,
        );
      }
    }

    teams.push({
      teamName,
      userName: entry.user_name,
      teamNo,
      accountId,
      position,
      totalScore,
      raceScores,
      raceBudgets,
      chipsUsed,
    });

    teamsComposition.push({
      teamName,
      userName: entry.user_name,
      teamNo,
      accountId,
      position,
      budget,
      budgetStatus,
      budgetSourceMatchdayId,
      ...transferState,
      teamStateStatus,
      teamStateMatchdayId,
      drivers,
      constructors,
    });

    const chipSummary = chipsUsed.length
      ? ` [chips: ${chipsUsed.map((c) => c.name).join(', ')}]`
      : '';
    const budgetSummary =
      budget !== null
        ? ` [budget: ${budget}${budgetStatus === 'calculated-race-start' ? ' (calculated race-start)' : ''}]`
        : '';
    const transfersSummary =
      transferState.transfersStatus === 'unlimited'
        ? ' [transfers: unlimited]'
        : transferState.transfersRemaining !== null
          ? ` [transfers: ${transferState.transfersRemaining}${transferState.transfersStatus === 'calculated-race-start' ? ' (calculated race-start)' : ''}]`
          : '';
    const rosterSummary =
      drivers.length || constructors.length
        ? teamStateStatus === 'reconstructed-race-start'
          ? ` [race-start roster@md${matchdayId} (source md${teamStateMatchdayId}), prices@md${matchdayId}: ${drivers.length}D/${constructors.length}C]`
          : ` [${teamStateStatus} roster@md${teamStateMatchdayId}, prices@md${matchdayId}: ${drivers.length}D/${constructors.length}C]`
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

module.exports = { fetchAllLeaguesData, fetchSingleLeague };
