/**
 * Chip extraction helpers.
 *
 * The F1 Fantasy `getOpponentGameDays` response exposes chip usage as top-level
 * flag pairs on the opponent's team summary. For most chips there is:
 *   - `is<Name>taken` — 1 if the chip has been used, 0 otherwise
 *   - `<name>takengd` — the game-day id (gdid) when it was used, 0 if unused
 *
 * Note: the "gd" value is a **gameDayId**, not a matchdayId. A matchday may
 * contain multiple game days (FP / Qualifying / Race / Sprint).
 *
 * Two quirks worth remembering:
 *   1. The Autopilot chip's "taken game-day" field is `isAutopilottakengd`
 *      (still prefixed with `is`), unlike the others.
 *   2. The Extra DRS chip stores the **gameDayId** in its `isExtradrstaken`
 *      flag instead of a 0/1 boolean (so the flag can be e.g. `6`). We treat
 *      any non-zero numeric value as "taken" so this case is covered.
 */

const CHIPS = [
  { name: 'Wildcard', takenFlag: 'isWildcardtaken', takenGd: 'wildCardtakengd' },
  { name: 'Limitless', takenFlag: 'isLimitlesstaken', takenGd: 'limitLesstakengd' },
  { name: 'Final Fix', takenFlag: 'isFinalfixtaken', takenGd: 'finalFixtakengd' },
  { name: 'Extra DRS Boost', takenFlag: 'isExtradrstaken', takenGd: 'extraDrstakengd' },
  { name: 'No Negative', takenFlag: 'isNonigativetaken', takenGd: 'noNigativetakengd' },
  { name: 'Autopilot', takenFlag: 'isAutopilottaken', takenGd: 'isAutopilottakengd' },
];

function _isTaken(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined || value === '') return false;

  const n = Number(value);

  return Number.isFinite(n) && n > 0;
}

function _toGameDayId(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) return null;

  return n;
}

/**
 * Extract the list of chips a team has used from the `getOpponentGameDays` response.
 *
 * Returns an array of `{ name, gameDayId }`, one per chip the team has used.
 * `gameDayId` is the F1 Fantasy game-day id (gdid) when the chip was activated,
 * or `null` if the API reports the chip as taken but gives no game-day.
 */
function extractChipsUsed(oppData) {
  if (!oppData || typeof oppData !== 'object') return [];

  const chipsUsed = [];

  for (const chip of CHIPS) {
    if (!_isTaken(oppData[chip.takenFlag])) continue;

    chipsUsed.push({
      name: chip.name,
      gameDayId: _toGameDayId(oppData[chip.takenGd]),
    });
  }

  return chipsUsed;
}

module.exports = {
  extractChipsUsed,
  CHIPS,
};
