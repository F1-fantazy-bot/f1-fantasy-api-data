/**
 * Budget extraction helper.
 *
 * `extractBudget` returns `team_info.maxTeambal` — the user's cost cap
 * going into the given matchday (a.k.a. "max team balance"). For
 * matchday 1 this is always 100 (the season-start cap); later matchdays
 * grow as drivers on the roster appreciate. Consumers compute
 * cost-cap-remaining as `budget − sum_of_prices`.
 *
 * The previously-exposed `team_info.teamVal` value (the team's current
 * total value, equal to the sum of driver + constructor prices in
 * practice) was never used semantically by any downstream consumer
 * (only a `console.log` line in this scraper and a fallback path in the
 * f1-fantazy-bot mapper). It was misleadingly written as `budget` on
 * the per-team blob entries but yielded `costCapRemaining = budget −
 * Σprices = 0` for every league team. The rename to `maxTeambal` makes
 * `budget` carry the actual cost cap — the value consumers want.
 */

function extractBudget(opponentTeamResponse) {
  const entry = Array.isArray(opponentTeamResponse?.userTeam)
    ? opponentTeamResponse.userTeam[0]
    : null;
  const value = entry?.team_info?.maxTeambal;

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

module.exports = { extractBudget };
