/**
 * Budget extraction helpers.
 *
 * `extractBudget` returns the total team value (`team_info.teamVal`) — already
 * equal to cost-cap-remaining + sum of roster costs at the time the response
 * was generated. That is the figure most UIs show for "current budget".
 *
 * `extractStartBudget` returns `team_info.maxTeambal` — the budget cap that
 * was in force at the start of the given matchday (cost-cap-remaining +
 * roster cost at lock prices). For matchday 1 this is always 100 (the
 * season-start cap), and for later matchdays it grows as drivers on the
 * roster rise in price. Use this when you want the budget *going into*
 * a specific race rather than the live/post-race team value.
 */

function extractBudget(opponentTeamResponse) {
  const entry = Array.isArray(opponentTeamResponse?.userTeam)
    ? opponentTeamResponse.userTeam[0]
    : null;
  const value = entry?.team_info?.teamVal;

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractStartBudget(opponentTeamResponse) {
  const entry = Array.isArray(opponentTeamResponse?.userTeam)
    ? opponentTeamResponse.userTeam[0]
    : null;
  const value = entry?.team_info?.maxTeambal;

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

module.exports = { extractBudget, extractStartBudget };
