/**
 * Budget extraction helpers.
 *
 * The F1 Fantasy `getOpponentTeam` response returns a single number on
 * `userTeam[0].team_info.teamVal` that already equals
 * `costCapRemaining + sum(driver costs) + sum(constructor costs)` — i.e.
 * the user's definition of "budget". This module just reads it out with a
 * couple of defensive fallbacks for casing variations seen in the API.
 */

function extractBudget(opponentTeamResponse) {
  if (!opponentTeamResponse || typeof opponentTeamResponse !== 'object') return null;

  const entry = Array.isArray(opponentTeamResponse.userTeam) ? opponentTeamResponse.userTeam[0] : null;

  if (!entry) return null;

  const candidates = [
    entry.team_info?.teamVal,
    entry.team_info?.teamval,
    entry.team_info?.maxTeambal,
    entry.teamval,
    entry.teamVal,
    entry.maxteambal,
    entry.maxTeambal,
  ];

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }

  return null;
}

module.exports = { extractBudget };
