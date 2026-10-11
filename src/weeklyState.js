const f1Api = require('./f1FantasyApiService');

function validMatchday(value) {
  return Number.isInteger(value) && value > 0;
}

async function resolveWeeklyMatchday() {
  // F1 calls the race number GamedayId; MatchdayId is a sub-session number.
  try {
    const config = await f1Api.getWebConfig();
    const matchdayId = (config?.Data || config)?.constraints?.GamedayId;
    if (validMatchday(matchdayId)) return matchdayId;
  } catch {
    // The account's current game state is an independent fallback.
  }
  const gameDays = await f1Api.getUserGameDays();
  if (validMatchday(gameDays?.cumdid)) return gameDays.cumdid;
  throw new Error(
    'Cannot determine the current F1 race; refusing to guess from score history',
  );
}

function isOwnAccount(entry, session = f1Api.getSession()) {
  // Use the stable leaderboard SocialId, never a display name or the
  // transient login GUID. Older responses may only include it in the GUID.
  const socialId = String(session?.SocialId ?? '');
  if (!/^\d+$/.test(socialId)) return false;
  if (entry?.social_id !== undefined && entry.social_id !== null) {
    return String(entry.social_id) === socialId;
  }
  return (
    typeof entry?.user_guid === 'string' &&
    entry.user_guid.endsWith(`-0-${socialId}`)
  );
}

function isValidTeamMetadata(data, matchdayId, teamNo) {
  const team = data?.userTeam?.[0];
  return (
    validMatchday(matchdayId) &&
    data?.Meta?.Success !== false &&
    !(typeof data?.Meta?.RetVal === 'number' && data.Meta.RetVal < 0) &&
    !(typeof data?.retval === 'number' && data.retval < 0) &&
    Number(data?.mdid) === matchdayId &&
    Number(team?.teamno) === Number(teamNo)
  );
}

function isValidTeamState(data, matchdayId, teamNo) {
  const team = data?.userTeam?.[0];
  return (
    isValidTeamMetadata(data, matchdayId, teamNo) &&
    Number.isFinite(team?.team_info?.teamVal) &&
    Array.isArray(team?.playerid) &&
    team.playerid.length === 7
  );
}

async function fetchWeeklyTeamState(entry, matchdayId) {
  return isOwnAccount(entry)
    ? f1Api.getUserTeam(entry.team_no || 1, matchdayId)
    : f1Api.getOpponentTeam(entry.user_guid, matchdayId, {
        teamNo: entry.team_no || 1,
        v: entry.team_no || 1,
      });
}

module.exports = {
  resolveWeeklyMatchday,
  isOwnAccount,
  isValidTeamMetadata,
  isValidTeamState,
  fetchWeeklyTeamState,
};
