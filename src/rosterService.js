/**
 * Roster service: resolves F1 Fantasy player ids (drivers + constructors)
 * to `{ name, price, kind }` using the `/feeds/drivers/{mdid}_en.json` feed.
 *
 * The drivers feed is a single source of truth for both drivers and
 * constructors — each item carries a `PositionName` of `"DRIVER"` or
 * `"CONSTRUCTOR"`. We memoize one fetch per matchday id.
 */
const f1Api = require('./f1FantasyApiService');

const cache = new Map();

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
    });
  }

  cache.set(matchdayId, roster);
  return roster;
}

/**
 * Returns the full driver + constructor list for `matchdayId` in the
 * public `prices.json` blob shape: `{ drivers, constructors }` where
 * each entry is `{ id, name, price }`, sorted by price descending.
 *
 * Reuses the memoized `getMatchdayRoster` fetch — zero extra HTTP cost
 * when called after `fetchSingleLeague` has already resolved this
 * matchday's roster.
 *
 * The upstream feed (`/feeds/drivers/{mdid}_en.json`) carries many more
 * fields per player than we expose here — `OldPlayerValue` (last week's
 * price → delta), `SelectedPercentage`, `CaptainSelectedPercentage`,
 * `ProjectedGamedayPoints`, `OverallPpints` (season total),
 * `AdditionalStats.value_for_money`, `DriverTLA`, `TeamName`, `IsActive`,
 * etc. We ship the minimal `{ id, name, price }` shape and can extend
 * additively when a consumer surfaces a concrete need.
 */
async function getPlayersByMatchday(matchdayId) {
  const roster = await getMatchdayRoster(matchdayId);
  const drivers = [];
  const constructors = [];

  for (const [id, info] of roster.entries()) {
    const entry = { id, name: info.name, price: info.price };

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
