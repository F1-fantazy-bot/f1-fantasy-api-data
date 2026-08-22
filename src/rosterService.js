/**
 * Roster service: resolves F1 Fantasy player ids (drivers + constructors)
 * to player metadata using the `/feeds/drivers/{mdid}_en.json` feed.
 *
 * The drivers feed is a single source of truth for both drivers and
 * constructors — each item carries a `PositionName` of `"DRIVER"` or
 * `"CONSTRUCTOR"`. We memoize one fetch per matchday id.
 */
const f1Api = require('./f1FantasyApiService');

const cache = new Map();

function _normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  }

  return null;
}

function _normalizeFeed(raw) {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw)) return raw;
  const body = raw.Data || raw;

  if (Array.isArray(body)) return body;

  return Object.values(body);
}

async function getMatchdayRoster(matchdayId) {
  if (matchdayId === null || matchdayId === undefined) {
    throw new Error('matchdayId is required');
  }
  if (cache.has(matchdayId)) return cache.get(matchdayId);

  const raw = await f1Api.getDrivers(matchdayId);
  const items = _normalizeFeed(raw);
  const roster = new Map();

  for (const item of items) {
    if (!item || item.PlayerId === undefined || item.PlayerId === null)
      continue;
    const id = String(item.PlayerId);
    const position =
      typeof item.PositionName === 'string'
        ? item.PositionName.toUpperCase()
        : '';
    const kind = position === 'CONSTRUCTOR' ? 'constructor' : 'driver';
    const name = item.DisplayName || item.FUllName || item.FullName || '';
    const priceRaw = item.Value;
    const price = typeof priceRaw === 'number' ? priceRaw : Number(priceRaw);

    roster.set(id, {
      name,
      price: Number.isFinite(price) ? price : null,
      kind,
      code:
        typeof item.DriverTLA === 'string' ? item.DriverTLA.trim() : '',
      teamId:
        item.TeamId === undefined || item.TeamId === null
          ? null
          : String(item.TeamId),
      teamName:
        typeof item.TeamName === 'string' ? item.TeamName.trim() : '',
      isActive: _normalizeBoolean(item.IsActive),
    });
  }

  cache.set(matchdayId, roster);
  return roster;
}

/**
 * Returns the full driver + constructor list for `matchdayId` in the
 * public `prices.json` blob shape: `{ drivers, constructors }` where
 * each entry includes stable identity and activity metadata and is sorted by
 * price descending.
 *
 * Reuses the memoized `getMatchdayRoster` fetch — zero extra HTTP cost
 * when called after `fetchSingleLeague` has already resolved this
 * matchday's roster.
 *
 * The upstream feed (`/feeds/drivers/{mdid}_en.json`) carries many more
 * fields per player — `OldPlayerValue` (last week's
 * price → delta), `SelectedPercentage`, `CaptainSelectedPercentage`,
 * `ProjectedGamedayPoints`, `OverallPpints` (season total),
 * `AdditionalStats.value_for_money`, `DriverTLA`, `TeamName`, `IsActive`,
 * etc. Activity metadata is intentionally preserved so consumers can keep an
 * owned inactive player without offering that player as a new purchase.
 */
async function getPlayersByMatchday(matchdayId) {
  const roster = await getMatchdayRoster(matchdayId);
  const drivers = [];
  const constructors = [];

  for (const [id, info] of roster.entries()) {
    const entry = {
      id,
      name: info.name,
      price: info.price,
      code: info.code,
      teamId: info.teamId,
      teamName: info.teamName,
      isActive: info.isActive,
    };

    if (info.kind === 'constructor') {
      constructors.push(entry);
    } else {
      drivers.push(entry);
    }
  }

  const byPriceDesc = (a, b) => {
    const aPrice = typeof a.price === 'number' ? a.price : -Infinity;
    const bPrice = typeof b.price === 'number' ? b.price : -Infinity;
    return bPrice - aPrice;
  };

  drivers.sort(byPriceDesc);
  constructors.sort(byPriceDesc);

  return { drivers, constructors };
}

function resetCache() {
  cache.clear();
}

module.exports = { getMatchdayRoster, getPlayersByMatchday, resetCache };
