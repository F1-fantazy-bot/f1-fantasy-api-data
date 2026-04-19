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
    if (!item || item.PlayerId === undefined || item.PlayerId === null) continue;
    const id = String(item.PlayerId);
    const position = typeof item.PositionName === 'string' ? item.PositionName.toUpperCase() : '';
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

function resetCache() {
  cache.clear();
}

module.exports = { getMatchdayRoster, resetCache };
