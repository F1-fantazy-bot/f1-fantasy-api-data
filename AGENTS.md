# Copilot instructions for f1-fantasy-api-data

One-shot Node.js container: logs into F1 Fantasy via Playwright, fetches private-league
leaderboard data, uploads per-league JSON to Azure Blob Storage, then notifies Telegram
and exits. Deployed as an Azure Container Instance (see `infra/aci/`).

## Commands

```bash
npm install
npx playwright install chromium   # required once before first run
npm start                         # runs index.js end-to-end (needs .env)
npm run lint                      # eslint .
npm run lint:fix
npm run format                    # prettier --write .
```

There is no test suite and no eslint config file checked in — `npm run lint` currently
uses ESLint defaults. Do not invent tests or a test runner unless asked.

To iterate on login/scraping with a visible browser, set `F1_HEADLESS=false` in `.env`.

## Architecture

Entry point `index.js` wires four single-responsibility modules in `src/`:

1. `f1FantasyApiService.js` — **the only module that talks to F1**. Holds module-level
   `browser` / `context` / `page` / `sessionData` singletons. `init()` launches Chromium,
   performs a human-like login (required to bypass Distil bot detection — do not replace
   with a plain HTTP client), then calls `/services/session/login` to obtain the GUID
   used by every subsequent request. `close()` must be called in a `finally` block.
2. `fetchLeagueData.js` — orchestration layer. Calls `getLeagues()`, filters to
   `league_type === 'Private'`, then for each league pulls info → leaderboard →
   per-team per-matchday scores via `getOpponentGameDays`. For each team it also
   extracts chip usage via `src/chips.js` (`extractChipsUsed`), budget and
   transfers via `getOpponentTeam`, and resolves the team's drivers and
   constructors via `src/rosterService.js`. Returns an array of
   `{ league, teamsData }` tuples per league.
   - `league`: `{ fetchedAt, leagueName, leagueCode, leagueId, memberCount,
teams }`, where each team has `{ teamName, userName, position,
totalScore, raceScores, chipsUsed: [{ name, gameDayId }] }`.
     Budget and transfers live only in the `teamsData` blob.
   - `teamsData`: `{ fetchedAt, leagueName, leagueCode, leagueId,
  matchdayId, teams }` where each team has `{ teamName, userName,
  position, budget, transfersRemaining, drivers: [...],
  constructors: [...] }` with each roster entry shaped
     `{ id, name, price, isCaptain, isMegaCaptain, isFinal }`.
     `matchdayId` is the **upcoming** matchday (= last-completed + 1,
     with graceful fallback to the last-completed matchday when no
     upcoming data is returned, e.g. at end of season). Reading the
     upcoming matchday rather than the last completed one matters
     because driver/constructor prices change every week, transfers
     accrue for the next race, and teams that played the Limitless
     chip automatically revert to their pre-chip squad after the race.
     Chip usage comes from top-level `is<Name>taken` / `<name>takengd` flags on
     the opponent game-days response (see `src/chips.js`). Budget is the single
     number `userTeam[0].team_info.teamVal` from `getOpponentTeam`
     (see `src/budget.js`) — already equal to cost-cap-remaining plus
     sum of driver and constructor costs. `transfersRemaining`
     is `userTeam[0].usersubsleft` from the same response. Driver/constructor
     names and prices come from `/feeds/drivers/{mdid}_en.json` (a single feed
     containing both — `PositionName` of `"DRIVER"` or `"CONSTRUCTOR"` tells
     them apart) resolved through `src/rosterService.js`, which memoizes the
     fetch per matchday.
3. `azureBlobStorageService.js` — uploads to
   `leagues/<leagueCode>/<blobName>` in the configured container. `blobName`
   defaults to `league-standings.json`; `index.js` also uploads
   `teams-data.json` per league. Skipped entirely when
   `AZURE_STORAGE_CONNECTION_STRING` is unset (useful for local dry runs).
4. `telegramService.js` — singleton instance (`module.exports = new TelegramService()`).
   Sends success to `LOG_CHANNEL_ID`, errors to **both** log and errors channels.
   Messages to those channels are auto-prefixed with `F1_FANTASY_API: `. No-ops with a
   warning if `TELEGRAM_BOT_TOKEN` is missing.

### How API calls actually work

All HTTP happens **inside the browser page** via `page.evaluate(async () => fetch(...))`
with `credentials: 'include'`, so the F1 session cookies are attached automatically.
Do not try to extract cookies and use `node-fetch`/`axios` — Distil will block it.

Two helpers wrap this:

- `_apiGet` / `_apiPost` — for `/services/*` endpoints; unwraps the standard
  `{ Data: { Value: ... } }` envelope via `_unwrap`.
- `_apiGetRaw` — for `/feeds/*` endpoints which have a different shape (e.g.
  `getLeagueLeaderboard` reads `json.Value.leaderboard`). Don't run these through
  `_unwrap`.

When adding a new endpoint, pick the right helper based on whether the response uses
the `Data.Value` envelope.

## Conventions

- CommonJS only (`require` / `module.exports`). Node runtime, no TypeScript, no bundler.
- Prettier: 2-space indent, single quotes, semicolons (`.prettierrc`). Run `npm run format`
  before committing non-trivial changes.
- Private helpers in a module are prefixed with `_` (e.g. `_login`, `_apiGet`, `_guid`)
  and are not exported.
- `decodeURIComponent` every `league_name` / `team_name` read from the API — they come
  URL-encoded.
- Console output uses emoji status prefixes (`✅`, `❌`, `⚠️`) and numbered/indented
  progress lines; match that style when adding logs.
- Per-team failures inside `fetchSingleLeague` are logged and swallowed so one bad team
  doesn't abort a whole league; keep that resilience when editing the loop.
- Fatal errors in `index.js` must still go through `telegramService.notifyError` and end
  with `process.exit(1)` after `f1Api.close()`.

## Deployment

Docker image is built from `mcr.microsoft.com/playwright:v1.52.0-noble` and runs as the
built-in `pwuser`. If you bump `playwright` in `package.json`, bump the base image tag
in `Dockerfile` to match — version skew between the Playwright client and the bundled
browsers will break login.

ACI deployment uses `infra/aci/azuredeploy.json` + `azuredeploy.parameters.json`; GitHub
Actions workflows in `.github/workflows/` build/push the image and send Telegram
notifications on commits and PRs.

## update your instructions

After every change, make sure to update the instructions above to reflect the current state of the code if necessary.
