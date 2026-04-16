/**
 * F1 Fantasy API Service
 *
 * Provides authenticated access to the F1 Fantasy API.
 * Uses Playwright to drive a real Chromium browser for login (required by Distil bot detection),
 * then uses page.evaluate(fetch(...)) for all subsequent API calls.
 */
const { chromium } = require('playwright');

const BASE_URL = 'https://fantasy.formula1.com';
const LOGIN_URL =
  'https://account.formula1.com/#/en/login' +
  '?redirect=https%3A%2F%2Ffantasy.formula1.com%2Fen%2F' +
  '&lead_source=web_fantasy';

let browser = null;
let context = null;
let page = null;
let sessionData = null;

// ---------------------------------------------------------------------------
// Browser & Login
// ---------------------------------------------------------------------------

async function init() {
  if (page) {
    return sessionData;
  }

  const email = process.env.F1_FANTASY_EMAIL;
  const password = process.env.F1_FANTASY_PASSWORD;

  if (!email || !password) {
    throw new Error('Set F1_FANTASY_EMAIL and F1_FANTASY_PASSWORD in .env');
  }

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

  await _login(email, password);
  sessionData = await _sessionLogin();

  return sessionData;
}

async function _login(email, password) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[name="Login"]', { visible: true, timeout: 20000 });

  // Dismiss cookie consent overlay
  try {
    const consentFrame = page.frameLocator('iframe[title*="Consent"]');
    await consentFrame
      .locator('button[title="Accept All"], button:has-text("Accept All"), button:has-text("ACCEPT ALL")')
      .click({ timeout: 5000 });
    await page.waitForTimeout(1000);
  } catch {
    // No banner — fine
  }

  await page.waitForTimeout(2000);

  // Human-like credential entry
  const emailInput = page.locator('input[name="Login"]');

  await emailInput.hover();
  await page.waitForTimeout(500);
  await emailInput.click();
  await page.waitForTimeout(300);

  for (const char of email) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 50 });
  }

  await page.waitForTimeout(800);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(500);

  for (const char of password) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 50 });
  }

  await page.waitForTimeout(1000);

  const signInBtn = page.locator('button:has-text("Sign In"):visible');

  await signInBtn.hover();
  await page.waitForTimeout(300);
  await signInBtn.click();

  try {
    await page.waitForURL(/^https:\/\/fantasy\.formula1\.com/, { timeout: 30000 });
  } catch {
    const errorMsg = await page
      .locator('.loginError, [class*="error"]:visible')
      .first()
      .textContent()
      .catch(() => null);

    throw new Error(errorMsg ? `Login failed: ${errorMsg.trim()}` : `Login failed — stuck at ${page.url()}`);
  }

  // Let the Fantasy app fully load
  try {
    await page.goto(`${BASE_URL}/en/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    // ERR_ABORTED on redirect is fine
  }

  await page.waitForTimeout(5000);
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
  if (browser) {
    await browser.close();
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
  if (json?.Data?.Value !== undefined && json?.Data?.Value !== null) {
    return json.Data.Value;
  }

  if (json?.Meta?.Success === false) {
    throw new Error(`API error: ${json.Meta.Message || `RetVal ${json.Meta.RetVal}`}`);
  }

  return json?.Data?.Value ?? json;
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
  return _apiGet(`/services/user/gameplay/${_guid()}/getteam/${teamNo}/1/${matchdayId}/1`);
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

/** Get opponent's game days */
async function getOpponentGameDays(opponentGuid, teamNo = 1, v = 1) {
  return _apiGet(`/services/user/opponentteam/opponentgamedayget/${teamNo}/${opponentGuid}/${v}`);
}

/** Get opponent's team for a specific matchday */
async function getOpponentTeam(opponentGuid, matchdayId, { teamNo = 1, v = 1, v2 = 1 } = {}) {
  return _apiGet(
    `/services/user/opponentteam/opponentgamedayplayerteamget/${teamNo}/${opponentGuid}/${v}/${matchdayId}/${v2}`,
  );
}

/** Get all drivers for a matchday */
async function getDrivers(matchdayId) {
  return _apiGet(`/feeds/drivers/${matchdayId}_en.json`);
}

/** Get web config (tourId, current matchday, etc.) */
async function getWebConfig() {
  return _apiGet('/feeds/v2/apps/web_config.json');
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
  getUserGameDays,
  getUserTeam,
  getUserRank,
  getFeaturedLeagues,
  getOpponentGameDays,
  getOpponentTeam,
  getDrivers,
  getWebConfig,
};
