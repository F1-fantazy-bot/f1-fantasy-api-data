# Copilot instructions for f1-fantasy-api-data

One-shot Node.js container: logs into F1 Fantasy via Playwright, fetches private-league
leaderboard data, uploads per-league JSON to Azure Blob Storage, then notifies Telegram
and exits. Deployed as an Azure Container Instance (see `infra/aci/`).

## Commands

```bash
npm install
npx playwright install chromium   # required once before first run
npm start                         # weekly scrape — runs index.js end-to-end (needs .env)
npm run scrape:locked             # locked-snapshot scrape (sets MODE=locked)
npm run lint                      # eslint .
npm run lint:fix
npm run format                    # prettier --write .
```

There is no test suite and no eslint config file checked in — `npm run lint` currently
uses ESLint defaults. Do not invent tests or a test runner unless asked.

To iterate on login/scraping with a visible browser, set `F1_HEADLESS=false` in `.env`.

## Architecture

`index.js` switches on `MODE` env var (default `weekly`):

- `MODE=weekly` → runs `fetchAllLeaguesData()` and uploads
  `league-standings.json` + `teams-data.json` per league. Used by the
  Monday Logic App scheduler. **This path is unchanged.**
- `MODE=locked` → runs `fetchAllLeaguesLocked()` and uploads only
  `leagues/{code}/locked/matchday_{N}.json`, one blob per (league,
  matchday). Used by the locked-snapshot Logic App scheduler that fires
  shortly after each session start (qualifying / race / sprint).

Why two modes: the locked snapshot must be captured between **lock**
(start of qualifying / sprint qualifying) and **race end**. Once the race
ends F1 Fantasy auto-reverts Limitless, so a post-race fetch of the same
matchday would silently overwrite the temporary mega-squad. The Monday
weekly scrape captures "next-week planning" view (upcoming md = N+1) and
must keep its current cadence.

Both modes share four single-responsibility modules in `src/`:

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
totalScore, raceScores, raceBudgets, chipsUsed: [{ name, gameDayId }] }`.
     `raceBudgets` mirrors `raceScores` (keyed `matchday_<id>`) and stores the
     team's budget cap at the **start** of that race
     (`team_info.maxTeambal` — cost-cap-remaining + roster cost at lock
     prices). For matchday 1 this is always `100` (season-start cap).
     It is populated **incrementally**: `fetchSingleLeague` downloads the
     prior `league-standings.json` from blob storage and only calls
     `getOpponentTeam` for matchdays missing from the existing
     `raceBudgets`, so steady-state runs add ~0 extra API calls per team.
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
   defaults to `league-standings.json`; the weekly path also uploads
   `teams-data.json` per league, and the locked path uploads
   `locked/matchday_{N}.json` per league per locked matchday. Skipped
   entirely when `AZURE_STORAGE_CONNECTION_STRING` is unset (useful for
   local dry runs).
4. `telegramService.js` — singleton instance (`module.exports = new TelegramService()`).
   Sends success to `LOG_CHANNEL_ID` (with separate `notifySuccess` /
   `notifySuccessLocked` messages so the channel makes the mode obvious),
   errors to **both** log and errors channels. Messages to those channels
   are auto-prefixed with `F1_FANTASY_API: `. No-ops with a warning if
   `TELEGRAM_BOT_TOKEN` is missing.

5. `fetchLockedLeagueData.js` — locked-snapshot orchestration. Mirrors a
   minimal subset of `fetchLeagueData.js`: for each private league it
   calls `getLeagueLeaderboard`, then for each team uses
   `getOpponentGameDays` to compute the **just-locked** matchday
   (`max(completedMatchdayIds) + 1`), fetches `getOpponentTeam` for that
   matchday, resolves the roster via `rosterService`, extracts chips via
   `chips.js`, and returns one snapshot per team. Snapshots are grouped
   by `matchdayId` so each league produces one blob per locked matchday.
   Per-team failures are logged and skipped — they don't abort the
   league. Output blob shape:
   ```jsonc
   {
     "fetchedAt":   "<ISO>",
     "mode":        "locked",
     "leagueName":  "...", "leagueCode": "...", "leagueId": 1,
     "matchdayId":  6,
     "teams": [
       { "teamName":"...", "userName":"...", "position":1,
         "matchdayId":6, "budget":101.3, "transfersRemaining":0,
         "drivers":[{id,name,price,isCaptain,isMegaCaptain,isFinal}],
         "constructors":[…],
         "chipsUsed":[{name,gameDayId}] }
     ]
   }
   ```

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

The pipeline ships **two parallel deployment stacks** that share one Docker image
but have completely independent Azure resources so neither can disrupt the other.

### Weekly stack (default — drives `league-standings.json` + `teams-data.json`)

ACI deployment uses `infra/aci/azuredeploy.json` + `azuredeploy.parameters.json`. Logic
Apps (runner + scheduler) live under `infra/runner/` and `infra/scheduler/`. The runner
Logic App uses a system-assigned identity to call the ACI `/start` endpoint, so it needs
Contributor on the ACI — `scripts/grant-runner-msi.sh` handles that idempotently and is
wired into `npm run deploy:logicapps` between `deploy:runner` and `deploy:scheduler`.
The scheduler fires every Monday 03:00 UTC.

### Locked-snapshot stack (drives `leagues/{code}/locked/matchday_{N}.json`)

Mirror of the weekly stack with `-locked` suffixes. Mode is selected via the `MODE`
env var baked into the ACI deployment (`scrapeMode: "locked"`), so the same image
runs the locked path without command overrides.

- `infra/aci-locked/` — second ACI container group (`f1-fantasy-api-data-aci-locked`),
  same Key Vault references as weekly, plus `MODE=locked` in `environmentVariables`.
- `infra/runner-locked/` — runner Logic App (`f1-fantasy-api-data-runner-locked`)
  pointing at the locked ACI. The MSI grant is reused via
  `LOGIC_APP_NAME=… ACI_NAME=… bash scripts/grant-runner-msi.sh` (see
  `deploy:grant-runner-msi-locked`).
- `infra/scheduler-locked/` — calendar-aware scheduler Logic App
  (`f1-fantasy-api-data-scheduler-locked`). Recurrence trigger fires every hour at
  `:01` UTC. On each pulse it:
    1. HTTP GETs `https://api.jolpi.ca/ergast/f1/current/next.json` (Jolpica/Ergast
       proxy of the next race in the current season).
    2. Computes the current top-of-hour as `concat(formatDateTime(startOfHour(utcNow()), 'yyyy-MM-ddTHH:mm:ss'), 'Z')`.
    3. Builds candidate session-start strings as `date + 'T' + time` for
       `Qualifying`, `Sprint` (sprint weekends only), and the race itself.
    4. If top-of-hour equals any candidate → POSTs the runner-locked manual trigger
       and notifies the log channel; otherwise no-op.

  Why hourly @ X:01: F1 sessions always start on the hour (HH:00:00Z in the Jolpica
  schema), so equality on top-of-hour is sufficient. Firing at X:01 means the runner
  fires ~1 minute after the session starts. Idempotency: the locked scrape writes
  `matchday_N.json` deterministically, so a duplicate fire is safe.

  Why match `Sprint` (the sprint race) and not `SprintQualifying`: by the time the
  sprint race starts on Saturday the F1 Fantasy sprint lock has been in effect since
  the start of sprint qualifying on Friday, so the locked roster is already
  capturable. SprintQualifying also doesn't always start on the hour
  (e.g. `20:30:00Z`), which our top-of-hour matcher would miss.

Deploy commands:
- `npm run deploy:locked` — full locked stack (ACI + runner + grant + scheduler).
- Individual: `deploy:aci-locked`, `deploy:runner-locked`,
  `deploy:grant-runner-msi-locked`, `deploy:scheduler-locked`.
- `deploy:logicapps-locked` — runner + grant + scheduler only (skips ACI).

GitHub Actions workflows in `.github/workflows/` build/push the image
(`docker-build-push.yml`); deploy the weekly stack on changes to
`infra/aci/**`, `infra/runner/**`, `infra/scheduler/**`, or the grant script
(`deploy-aci.yml` + `deploy-logicapps.yml`); and deploy the locked stack on
changes to `infra/aci-locked/**`, `infra/runner-locked/**`,
`infra/scheduler-locked/**`, or the grant script (`deploy-aci-locked.yml`
+ `deploy-logicapps-locked.yml`). All four deploy workflows also support
`workflow_dispatch` for manual triggering. Telegram notifications fire on
commits and PRs.

## update your instructions

After every change, make sure to update the instructions above to reflect the current state of the code if necessary.
