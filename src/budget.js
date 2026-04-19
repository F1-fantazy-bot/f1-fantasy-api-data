/**
 * Budget extraction helper.
 *
 * The F1 Fantasy `getOpponentTeam` response exposes the full team value on
 * `userTeam[0].team_info.teamVal` — already equal to
 * `costCapRemaining + sum(driver costs) + sum(constructor costs)`.
 */

function extractBudget(opponentTeamResponse) {
  const entry = Array.isArray(opponentTeamResponse?.userTeam)
    ? opponentTeamResponse.userTeam[0]
    : null;
  const value = entry?.team_info?.teamVal;

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

module.exports = { extractBudget };
