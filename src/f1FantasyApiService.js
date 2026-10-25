/**
 * F1 Fantasy API Service
 *
 * Provides authenticated access to the F1 Fantasy API.
 * Uses Playwright to drive a real Chromium browser for login (required by Distil bot detection),
 * then uses page.evaluate(fetch(...)) for all subsequent API calls.
 */
const { chromium } = require('playwright');
const { safeText } = require('./reportSanitizer');

const BASE_URL = 'https://fantasy.formula1.com';
const LOGIN_URL =
  'https://account.formula1.com/#/en/login' +
  '?redirect=https%3A%2F%2Ffantasy.formula1.com%2Fen%2F' +
  '&lead_source=web_fantasy';

let browser = null;
let context = null;
let page = null;
let sessionData = null;
let initialization = null;

// ---------------------------------------------------------------------------
// Browser & Login
// ---------------------------------------------------------------------------

async function init() {
  if (sessionData) return sessionData;
  if (initialization) return initialization;

  initialization = _initialize();
  try {
    return await initialization;
  } finally {
    initialization = null;
  }
}

async function _initialize() {
  const email = process.env.F1_FANTASY_EMAIL;
  const password = process.env.F1_FANTASY_PASSWORD;

  if (!email || !password) {
    throw new Error('Set F1_FANTASY_EMAIL and F1_FANTASY_PASSWORD in .env');
  }

  let stage = 'browser startup';
  try {
    // A failed initialization is never considered a reusable authenticated page.
    if (browser) await close();
    browser = await chromium.launch({
      headless: process.env.F1_HEADLESS !== 'false',
      args: ['--disable-blink-features=AutomationControlled'],
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    stage = 'login';
    await _login(email, password);
    stage = 'Fantasy session';
    const session = await _sessionLogin();
    // F1 GUIDs are opaque identifiers, not necessarily UUIDs. They must be
    // usable as a single URL path segment by all authenticated API methods.
    if (
      typeof session?.GUID !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(session.GUID) ||
      session.GUID.length > 512 ||
      /^(?:null|undefined)$/i.test(session.GUID)
    ) {
      throw new Error('No usable session GUID returned');
    }
    sessionData = session;
    return sessionData;
  } catch (error) {
    // Playwright call logs can contain credentials, authorization URLs/state,
    // and server error text. Do not retain the raw error as a cause or stack.
    throw new Error(
      `F1 authentication failed (${stage}): ${safeText(error.message || error, [email, password])}`,
    );
  }
}

async function _dismissConsent() {
  const buttons = [
    page.frameLocator('iframe[title*="consent" i]').getByRole('button', {
      name: /^accept all$/i,
    }),
    page.locator('#onetrust-accept-btn-handler'),
    page.getByRole('button', { name: /^accept all$/i }),
  ];
  for (const button of buttons) {
    // Optional banners may appear after the form, disappear during redirects,
    // or not exist at all. Never spend the credential timeout waiting for one.
    try {
      if (await button.first().isVisible())
        await button.first().click({ timeout: 500 });
    } catch {
      // The next pass can handle a banner that is still loading.
    }
  }
}

async function _login(email, password) {
  // Keep the account entry URL: its redirects create fresh authorization state.
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await _dismissConsent();
  let watchingConsent = true;
  const consentWatcher = (async () => {
    while (watchingConsent) {
      try {
        await _dismissConsent();
        await page.waitForTimeout(200);
      } catch {
        // Page closure is reported by the foreground login operation.
        break;
      }
    }
  })();

  try {
    await page
      .locator('#loginForm:visible, form:has(input[name="Login"]):visible')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 });
    const modernForm = page.locator('#loginForm');
    const modern = await modernForm.isVisible();
    const form = modern
      ? modernForm
      : page.locator('form:has(input[name="Login"])').first();
    const emailInput = modern
      ? form.getByRole('textbox', { name: /email/i })
      : form.locator('input[name="Login"]');
    const passwordInput = modern
      ? form.getByLabel(/^password/i)
      : form.locator('input[type="password"]');

    await page.waitForTimeout(2000);
    await _typeCredential(emailInput, email);
    await page.waitForTimeout(800);
    // Click the actual password field; intervening controls can change Tab order.
    await _typeCredential(passwordInput, password);
    await page.waitForTimeout(1000);

    const signIn = form.getByRole('button', { name: /^sign in$/i });
    await signIn.hover();
    await page.waitForTimeout(300);
    await signIn.click({ timeout: 10000 });

    try {
      await page.waitForURL((url) => url.origin === BASE_URL, {
        timeout: 30000,
      });
    } catch {
      const errorMsg = await form
        .locator(
          '.loginError:visible, [role="alert"]:visible, [class*="error"]:visible',
        )
        .first()
        .textContent({ timeout: 1000 })
        .catch(() => null);
      throw new Error(
        errorMsg
          ? `Login rejected: ${errorMsg.trim()}`
          : 'Login did not return to Fantasy',
      );
    }

    // Let Fantasy finish its own redirects before obtaining its API session.
    // A failed navigation must not be mistaken for a successful return.
    await page.goto(`${BASE_URL}/en/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(5000);
    if (new URL(page.url()).origin !== BASE_URL) {
      throw new Error('Login did not remain on the Fantasy origin');
    }
  } finally {
    watchingConsent = false;
    await consentWatcher;
  }
}

async function _typeCredential(input, value) {
  await input.hover();
  await page.waitForTimeout(500);
  await input.click({ timeout: 10000 });
  await page.waitForTimeout(300);
  for (const char of value) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 50 });
  }
}

async function _sessionLogin() {
  return _apiPost('/services/session/login', {
    optType: 1,
    platformId: 1,
    platformVersion: '1',
    platformCategory: 'web',
    clientId: 1,
  });
}

async function close() {
  try {
    if (browser) await browser.close();
  } finally {
    browser = null;
    context = null;
    page = null;
    sessionData = null;
  }
}

// ---------------------------------------------------------------------------
// Low-level API helpers
// ---------------------------------------------------------------------------

async function _apiGet(path) {
  _ensureReady();
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

  const result = await page.evaluate(async (fetchUrl) => {
    const res = await fetch(fetchUrl, { credentials: 'include' });
    const text = await res.text();

    return { status: res.status, ok: res.ok, body: text };
  }, url);

  if (!result.ok) {
    throw new Error(`GET ${path} → HTTP ${result.status}: ${result.body.substring(0, 200)}`);
  }

  const json = JSON.parse(result.body);

  return _unwrap(json);
}

async function _apiPost(path, body) {
  _ensureReady();
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

  const result = await page.evaluate(
    async ({ fetchUrl, fetchBody }) => {
      const res = await fetch(fetchUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fetchBody),
      });
      const text = await res.text();

      return { status: res.status, ok: res.ok, body: text };
    },
    { fetchUrl: url, fetchBody: body },
  );

  if (!result.ok) {
    throw new Error(`POST ${path} → HTTP ${result.status}: ${result.body.substring(0, 200)}`);
  }

  const json = JSON.parse(result.body);

  return _unwrap(json);
}

/** Unwrap the standard F1 API response envelope { Data: { Value: ... } } */
function _unwrap(json) {

  return json?.Data?.Value ?? json;
}

/** GET that returns raw JSON without unwrapping (for /feeds/ endpoints that don't use Data.Value) */
async function _apiGetRaw(path, { fresh = false } = {}) {
  _ensureReady();
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

  const result = await page.evaluate(
    async ({ fetchUrl, fresh }) => {
      const res = await fetch(fetchUrl, {
        credentials: 'include',
        cache: fresh ? 'no-store' : 'default',
      });
      const text = await res.text();

      return { status: res.status, ok: res.ok, body: text };
    },
    { fetchUrl: url, fresh },
  );

  if (!result.ok) {
    throw new Error(
      `GET ${path} → HTTP ${result.status}: ${result.body.substring(0, 200)}`,
    );
  }

  return JSON.parse(result.body);
}

function _ensureReady() {
  if (!page) {
    throw new Error('Call init() before making API calls');
  }
}

function _guid() {
  if (!sessionData?.GUID) {
    throw new Error('No session — call init() first');
  }

  return sessionData.GUID;
}

// ---------------------------------------------------------------------------
// High-level API methods
// ---------------------------------------------------------------------------

/** Get all leagues the user belongs to */
async function getLeagues() {
  const data = await _apiGet(`/services/user/league/${_guid()}/leaguelandingv1`);

  return data?.user_leagues || data;
}

/** Get league details by league code */
async function getLeagueInfo(leagueCode) {
  return _apiGet(`/services/user/league/getleagueinfo/${leagueCode}`);
}

/** Get the user's game days for a team */
async function getUserGameDays(teamNo = 1) {
  const data = await _apiGet(`/services/user/gameplay/${_guid()}/getusergamedaysv1/${teamNo}`);

  // Response is { "0": { ... } } — extract the first team
  return data?.['0'] || data;
}

/** Get the user's team composition for a specific matchday */
async function getUserTeam(teamNo = 1, matchdayId) {
  // Path order is optType / teamNo / race / phase, as used by the F1 app.
  return _apiGet(`/services/user/gameplay/${_guid()}/getteam/1/${teamNo}/${matchdayId}/1`);
}

/** Get the user's rank in a specific league (leagueType: global|private|team|driver|country) */
async function getUserRank(teamNo = 1, leagueType = 'private', leagueId) {
  return _apiGet(
    `/services/user/leaderboard/${_guid()}/userrankgetv1/0/${teamNo}/${leagueType}/${leagueId}`,
  );
}

/** Get featured leagues */
async function getFeaturedLeagues() {
  return _apiGet(`/services/user/league/${_guid()}/featuredleaguev1`);
}

/**
 * Get opponent's game days (per-matchday scores + chip flags).
 *
 * `v` is the **team_no disambiguator** for opponents who have
 * multiple F1 Fantasy teams in the league (the path-level `teamNo`
 * is empirically ignored when fetching opponent data — it represents
 * the caller's perspective). Pass the opponent's `team_no` as `v`
 * to fetch THAT specific team's data. Default `v=1` returns the
 * opponent's first team and is correct for users with only one team.
 */
async function getOpponentGameDays(opponentGuid, teamNo = 1, v = 1) {
  return _apiGet(`/services/user/opponentteam/opponentgamedayget/${teamNo}/${opponentGuid}/${v}`);
}

/**
 * Get opponent's team for a specific matchday.
 *
 * `v` is the **team_no disambiguator** for opponents who have
 * multiple F1 Fantasy teams in the league. The path-level `teamNo`
 * is empirically ignored for opponent fetches; only `v` selects
 * which of the opponent's teams to return. Pass the opponent's
 * `team_no` as `v`. Default `v=1` returns the opponent's first
 * team. `v2` has no observable effect.
 */
async function getOpponentTeam(opponentGuid, matchdayId, { teamNo = 1, v = 1, v2 = 1 } = {}) {
  return _apiGet(
    `/services/user/opponentteam/opponentgamedayplayerteamget/${teamNo}/${opponentGuid}/${v}/${matchdayId}/${v2}`,
  );
}

/** Get all drivers for a matchday */
async function getDrivers(matchdayId) {
  return _apiGet(`/feeds/drivers/${matchdayId}_en.json`);
}

/** Get private league leaderboard (all members with rank + points) */
async function getLeagueLeaderboard(leagueId, teamNo = 1) {
  const json = await _apiGetRaw(`/feeds/leaderboard/privateleague/list_${teamNo}_${leagueId}_0_1.json`);

  return json?.Value?.leaderboard || [];
}

/** Get web config (tourId, current matchday, etc.) */
async function getWebConfig() {
  return _apiGet('/feeds/v2/apps/web_config.json');
}

/** Session fixtures include the race's base and carried-transfer allowances. */
async function getRaceSchedule(options) {
  return _apiGetRaw('/feeds/v2/schedule/raceday_en.json', options);
}

/** Get the session data returned by /services/session/login */
function getSession() {
  return sessionData;
}

module.exports = {
  init,
  close,
  getSession,
  getLeagues,
  getLeagueInfo,
  getLeagueLeaderboard,
  getUserGameDays,
  getUserTeam,
  getUserRank,
  getFeaturedLeagues,
  getOpponentGameDays,
  getOpponentTeam,
  getDrivers,
  getWebConfig,
  getRaceSchedule,
};
