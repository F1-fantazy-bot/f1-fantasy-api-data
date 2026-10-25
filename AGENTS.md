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
npm test                          # node:test identity and scraper regressions
npm run lint:fix
npm run format                    # prettier --write .
```

ESLint uses `.eslintrc.json`; `npm test` covers account ID derivation,
safe historical-budget joins, the multi-team `v: teamNo` API discriminator,
current race selection, available/unknown transfer counts, current-price feeds,
chip-aware race-start transfer calculations from fresh archived API data,
and weekly diagnostics (concise reporting and preview compatibility). Mocked
execution and Telegram tests cover fatal/partial failures in both modes,
redaction, bounded stacks/examples/messages, independent channel delivery, and
cleanup ordering. Tests must never scrape, upload data, or send real messages.

To iterate on login/scraping with a visible browser, set `F1_HEADLESS=false` in `.env`.

## Architecture

`index.js` switches on `MODE` env var (default `weekly`):

- `MODE=weekly` → runs `fetchAllLeaguesData()` and uploads
  `league-standings.json` + `teams-data.json` per league, plus one
  global `prices.json` at the container root. Used by the
  Monday/Thursday Logic App scheduler. The canonical current race is selected
  once from live F1 state; historical opponent state cannot select old prices.
- `MODE=locked` → runs `fetchAllLeaguesLocked()` and uploads only
  `leagues/{code}/locked/matchday_{N}.json`, one blob per (league,
  matchday). Used by the locked-snapshot Logic App scheduler that fires
  shortly after each session start (qualifying / race / sprint).

Why two modes: the locked snapshot must be captured between **lock**
(start of qualifying / sprint qualifying) and **race end**. Once the race
ends F1 Fantasy auto-reverts Limitless, so a post-race fetch of the same
matchday would silently overwrite the temporary mega-squad. The Monday
weekly scrape captures the current planning race from live F1 state and
must keep its current cadence.

The scraper modules in `src/` are:

1. `f1FantasyApiService.js` — **the only module that talks to F1**. Holds module-level
   `browser` / `context` / `page` / `sessionData` singletons. `init()` launches Chromium,
   performs a human-like login (required to bypass Distil bot detection — do not replace
   with a plain HTTP client), then calls `/services/session/login` to obtain the GUID
   used by every subsequent request. The authenticated team path is
   `getteam/1/{teamNo}/{race}/1` (operation type precedes team number).
   `close()` must be called in a `finally` block.
2. `fetchLeagueData.js` — orchestration layer. Calls `getLeagues()`, filters to
   `league_type === 'Private'`, then for each league pulls info → leaderboard →
   per-team per-matchday scores via `getOpponentGameDays`. For each team it also
   extracts chip usage via `src/chips.js` (`extractChipsUsed`). The weekly
   helper `weeklyState.js` resolves the canonical race once from
   `getWebConfig().Data.constraints.GamedayId` (race number, NOT the config's
   sub-session `MatchdayId`), with `getUserGameDays().cumdid` as fallback.
   If neither is valid the run fails rather than guessing from score history.
   Logged-in-account entries match leaderboard `social_id` against session
   `SocialId` (falling back to the exact `-0-<SocialId>` GUID suffix when
   the field is absent) and use `getUserTeam`; other teams use
   `getOpponentTeam` with `v: teamNo`. Current and historical responses must
   match the requested race and team number and contain a seven-player roster.
   When live opponent state is unavailable, `raceStartBaseline.js` reconstructs
   the new planning window's starting roster and budget from fresh F1 archives
   and previous/new price feeds. Ordinary/Wildcard rosters carry forward;
   Final Fix restores the outgoing driver and captain; Limitless restores its
   pre-chip original roster. Temporary chip flags are cleared. The cost cap
   equals the previous regular cap plus the restored lineup's price changes.
   Validate race/team identity, swap metadata, seven unique players, five
   drivers/two constructors, prices, and nonnegative restored cash. Historical
   fallback is used only when reconstruction fails, with null current budget.
   Transfer
   metadata is validated independently of roster size (Final Fix archives
   can contain eight rows). `transferAllowance.js` prefers live counts and
   otherwise calculates a labeled race-start allowance from F1's freshly
   requested immediately previous race, never saved weekly/locked blobs.
   It loads base/carry limits from `getRaceSchedule()` and chip IDs from
   web config once per run. Limitless/Wildcard reset carry-over; other
   chips preserve normal carry-over. Only the race's active `boosterid`
   is used, never stale season-level flags. Missing rules, ambiguous chips,
   or missing/mismatched previous-race metadata leave the count unknown.
   All roster and global prices use the canonical race's memoized feed.
   Returns `{ leagues: [{ league, teamsData }, …], prices }`; unavailable or
   incomplete current prices abort the run before uploads.
   - `league`: `{ fetchedAt, leagueName, leagueCode, leagueId, memberCount,
teams }`, where each team has `{ teamName, userName, teamNo, accountId, position,
totalScore, raceScores, raceBudgets, chipsUsed: [{ name, gameDayId }] }`.
     `teamNo` mirrors the API's `team_no` field (1/2/3). `accountId` is
     a stable 12-hex-character SHA-256-derived identifier based on the
     leaderboard entry's trimmed, case-normalized opaque `user_guid`, which
     need not match UUID syntax. A missing or unusable identifier aborts that
     league's scrape instead of uploading `accountId: null`; the raw GUID is
     not persisted. Consumers
     should combine `userName + teamNo + accountId` for a readable,
     league-agnostic identity. This is required because two different F1
     accounts can share the same display `userName` and both have
     `team_no = 1`. `teamNo` defaults to `1` when the API omits it.
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
teamNo, position, budget, budgetStatus, budgetSourceMatchdayId,
transfersRemaining, transfersStatus,
transfersSourceMatchdayId, teamStateStatus,
teamStateMatchdayId, drivers: [...], constructors: [...] }` with each roster entry shaped
     `{ id, name, price, isCaptain, isMegaCaptain, isFinal }`.
     `teamNo` and `accountId` are the same identity fields described in
     the `league` shape above.
     `matchdayId` is the canonical current/planning race. It never moves
     backward merely because opponent data is unavailable. Each team includes
     `teamStateStatus` (`current`, `reconstructed-race-start`, `historical`,
     or `unavailable`) and `teamStateMatchdayId` (actual roster-source race,
     or null). Reconstructed rosters use the previous race's archive, or an
     earlier original roster for Limitless. The canonical top-level race is
     the one that baseline applies to. `budgetStatus` is `live`,
     `calculated-race-start`, or `unknown`; `budgetSourceMatchdayId` is the
     current race, immediately previous race, or null respectively. Historical
     roster prices still use the canonical race feed, but the roster, captain,
     and chip-reversion state cannot be claimed current. Current budgets
     remain null for historical/unavailable state. Transfers have their own
     `transfersStatus`: `live`, `calculated-race-start`, `unlimited`, or
     `unknown`; `transfersSourceMatchdayId` identifies the current race for
     live/unlimited counts, previous race for calculations, or null when
     unknown. Unlimited counts are null and must not be treated as unknown.
     Consumers must honor both status fields: calculations do not reflect
     private current-week changes. Complete reconstructed baselines are valid
     recommendation inputs; genuinely historical rosters cannot provide a
     current budget. First-ever team weeks are explicitly unlimited when verified;
     previous first-week counters cannot establish normal carry-over.
     Chip usage comes from top-level `is<Name>taken` / `<name>takengd` flags on
     the opponent game-days response (see `src/chips.js`). `budget` is the
     **cost cap going into the upcoming matchday** — the user's spending
     limit, sourced from `userTeam[0].team_info.maxTeambal` via
     `extractBudget` (see `src/budget.js`). For matchday 1 this is always
     `100` (season-start cap); later matchdays grow as the roster
     appreciates. Consumers compute cost-cap-remaining as
     `budget − Σ_prices`. A reconstructed starting cap uses the previous
     cap plus price changes from fresh feeds. `null` when both live extraction
     and validated reconstruction are unavailable (treat as unknown). The same value is
     also mirrored into `raceBudgets["matchday_${matchdayId}"]` on the
     matching `league-standings.json` entry, so the two blobs agree on
     the start-of-week cap. Historical note: prior to the rename `budget`
     carried `team_info.teamVal` (the team's current value — sum of
     roster prices), but no consumer derived cost-cap-remaining from it
     (the subtraction always yielded 0 because `teamVal ≈ Σ_prices`); the
     field was repurposed rather than renamed because `budget` is the
     natural name for "the user's spending limit". `transfersRemaining`
     prefers `userTeam[0].team_info.userSubsleft`, falling back to
     `userTeam[0].usersubsleft` from the same response. Negative live values
     indicate an overdrawn allowance and are clamped to zero free transfers,
     matching the F1 My Team UI. Driver/constructor
     names and prices come from `/feeds/drivers/{mdid}_en.json` (a single feed
     containing both — `PositionName` of `"DRIVER"` or `"CONSTRUCTOR"` tells
     them apart) resolved through `src/rosterService.js`, which memoizes the
     fetch per matchday. The same module also exports
     `getPlayersByMatchday(matchdayId)` which returns the full driver +
     constructor list in the public `prices.json` shape
     (`{ drivers, constructors }` where each entry is
     `{ id, name, price, code, teamId, teamName, isActive }`, sorted by
     price descending). Inactive entries are retained because saved fantasy
     teams may still own them; consumers should only offer active entries as
     new selections. `fetchLeagueData`
     calls it **once per weekly run** to produce the global prices blob.
     The feed item shape is richer than what we surface — known fields
     include (non-exhaustive): `PlayerId`, `PositionName`, `DisplayName`,
     `FUllName` (sic), `Value` (current price), `OldPlayerValue` (previous
     price → delta), `SelectedPercentage`, `CaptainSelectedPercentage`,
     `ProjectedGamedayPoints`, `OverallPpints` (sic — season total),
     `GamedayPoints`, `AdditionalStats.value_for_money`, `DriverTLA`,
     `TeamName`, `TeamId`, `IsActive`, `SessionWisePoints`.
     Identity and activity metadata is preserved so consumers can distinguish
     duplicate names/codes during driver changes without a breaking schema
     migration.
3. `azureBlobStorageService.js` — uploads to
   `leagues/<leagueCode>/<blobName>` in the configured container when
   `leagueCode` is provided, or **directly to `<blobName>` at the
   container root** when `leagueCode` is null/empty. `blobName`
   defaults to `league-standings.json`; the weekly path also uploads
   `teams-data.json` per league plus a single global
   `prices.json` at the container root, and the locked path uploads
   `locked/matchday_{N}.json` per league per locked matchday. Skipped
   entirely when `AZURE_STORAGE_CONNECTION_STRING` is unset (useful for
   local dry runs).

   `prices.json` shape:

   ```jsonc
   {
     "fetchedAt": "<ISO>",
     "matchdayId": 5,
     "drivers":      [{ "id": "1",  "name": "M. Verstappen", "price": 30.4 }, …],
     "constructors": [{ "id": "28", "name": "Mercedes",       "price": 30.5 }, …]
   }
   ```

   Driver/constructor prices are league-agnostic, so the blob lives at
   the container root rather than under `leagues/<code>/`. Written only
   by the weekly path; the locked path does not re-emit `prices.json`
   because prices don't change between lock and race end.

4. `telegramService.js` — singleton instance (`module.exports = new TelegramService()`).
   Sends success to `LOG_CHANNEL_ID` (with separate `notifySuccess` /
   `notifySuccessLocked` messages so the channel makes the mode obvious),
   errors to **both** log and errors channels. Messages to those channels
   are auto-prefixed with `F1_FANTASY_API: `. No-ops with a warning if
   `TELEGRAM_BOT_TOKEN` is missing.
   `weeklyDiagnostics.js` exports a shared `ExecutionDiagnostics` collector and
   preserves `WeeklyDiagnostics` for existing weekly consumers. `index.js`
   creates one collector per execution and delivers one consolidated failure
   report after browser cleanup, covering fatal login, discovery, fetch,
   upload, and cleanup errors plus partial team/league failures. Every failed
   execution is reported; repeated categories within a run are grouped into
   counts with at most three examples, stage/context, and sanitized stacks
   (bounded to 8,000 characters per example). Missing data has a reason and no
   invented stack. Reports go independently to **both** existing log
   (`-1002298860617`) and errors (`-5167373779`) channels in plain text with
   the `F1_FANTASY_API:` prefix. Multipart messages split on lines, including
   oversized individual lines, and stay below 4,096 characters with headings
   and prefixes included. Shared `reportSanitizer.js` redacts credentials,
   tokens, connection strings, private user paths, account identifiers, and
   URLs while retaining readable stack frames. Delivery errors are sanitized
   locally and never trigger recursive reports or replace scrape failures.
   Existing concise weekly formatting and `formatDetails()` debug output
   remain available (`F1_WEEKLY_DEBUG=true`).
   `logToConsole()` prints one concise warning plus informational transfer
   calculation counts by default. `recordInfo()` stores successful calculations
   and the expected opponent `Meta.Success:false/RetVal:-1` response separately
   from warnings. Reconstructed starting rosters/budgets are also information.
   Successful baselines do not produce an incomplete-data warning. Missing
   live state is a warning only when no valid baseline can be reconstructed;
   unexpected responses (including owned-team failures) and request failures
   remain visible. Informational-only runs do not send bugs-channel warnings.
   `notifySuccess` also receives the team snapshots and reports partial data
   when current state, transfers, budgets, or roster prices are incomplete.
   Fetchers collect diagnostics without sending notifications. Healthy and
   informational-only runs send no failure report. Previews still use
   `notifyWeeklyDiagnostics(report, { preview: true })` for a concise message
   to the errors channel; disable uploads and ordinary notifications in a
   local harness for preview runs. Missing tokens explicitly warn/skip locally.

5. `fetchLockedLeagueData.js` — locked-snapshot orchestration. Mirrors a
   minimal subset of `fetchLeagueData.js`: for each private league it
   calls `getLeagueLeaderboard`, derives the same opaque `accountId` from
   each entry's `user_guid`, then for each team uses
   `getOpponentGameDays(guid, teamNo, /* v */ teamNo)` to find the
   latest matchday in `mdDetails` and probes
   `getOpponentTeam(guid, md, { teamNo, v: teamNo })` first for
   `lastInDetails + 1` (between weekends) and falls back to
   `lastInDetails` (during a weekend after the first sub-event scored
   — typically a sprint that already completed). The first matchday
   with a valid `team_info.teamVal` plus non-empty `playerid` array is
   taken as the locked one. **The `v` parameter is the team_no
   disambiguator** — it's the only parameter that selects WHICH of an
   opponent's multiple F1 Fantasy teams is returned. The path-level
   `{teamNo}` is empirically ignored when querying opponents (it
   represents the caller's perspective). For users with only one team
   the difference is invisible (default `v=1` works); for users with
   multiple teams (e.g. `dorsegal1/2/3` with `team_no` 1/2/3 in the
   same league) we MUST pass `v: entry.team_no` or all three teams
   collapse onto whichever roster `v=1` yields. Resolves the roster
   via `rosterService`, extracts chips via `chips.js`, and returns
   one snapshot per team. Snapshots are grouped by `matchdayId` so
   each league produces one blob per locked matchday. Per-team
   failures are logged and skipped. Diagnostics cover skipped teams, failed
   leagues, unavailable locked state, failed chips/rosters, incomplete roster
   metadata, missing budgets/transfers, and runs producing no snapshots.
   Recovered candidate probes are informational. Partial results keep the
   existing upload/exit behavior, with a degraded notification heading rather
   than a fully successful one. Output blob shape:
   ```jsonc
   {
     "fetchedAt":   "<ISO>",
     "mode":        "locked",
     "leagueName":  "...", "leagueCode": "...", "leagueId": 1,
     "matchdayId":  4,
     "teams": [
       { "teamName":"...", "userName":"...", "teamNo":1, "accountId":"...", "position":1,
         "matchdayId":4, "budget":107.8, "transfersRemaining":0,
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
- Fatal errors in `index.js` set `process.exitCode = 1`; never exit before the
  awaited `f1Api.close()` in `finally`. Cleanup errors join the consolidated
  `telegramService.notifyFailureReport` report without hiding the original
  scrape failure. Production failure delivery belongs only at this boundary.

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
The scheduler fires every Monday and Thursday at 03:00 UTC.

### Locked-snapshot stack (drives `leagues/{code}/locked/matchday_{N}.json`)

Mirror of the weekly stack with `-locked` suffixes. Mode is selected via the `MODE`
env var baked into the ACI deployment (`scrapeMode: "locked"`), so the same image
runs the locked path without command overrides.

The ACI and runner Logic App **share** the weekly templates; only the parameters
files differ:

- ACI: `infra/aci/azuredeploy.json` + `infra/aci/azuredeploy.locked.parameters.json`
  → second container group (`f1-fantasy-api-data-aci-locked`), same Key Vault
  references as weekly, plus `scrapeMode: "locked"` which surfaces as `MODE=locked`
  in `environmentVariables`.
- Runner: `infra/runner/azuredeploy.json` + `infra/runner/azuredeploy.locked.parameters.json`
  → second runner Logic App (`f1-fantasy-api-data-runner-locked`) pointing at the
  locked ACI. The MSI grant is reused via
  `LOGIC_APP_NAME=… ACI_NAME=… bash scripts/grant-runner-msi.sh` (see
  `deploy:grant-runner-msi-locked`).
- Scheduler: `infra/scheduler-locked/` is its **own template** — calendar-aware
  scheduler Logic App (`f1-fantasy-api-data-scheduler-locked`) with logic that
  has no overlap with the weekly Monday cron, so it stays separate. Recurrence
  trigger fires every hour at `:01` UTC, **Friday through Sunday only** —
  F1 race weekends are always Fri–Sun, so it's wasteful to poll Mon–Thu.
  On each pulse it:

  1. HTTP GETs `https://api.jolpi.ca/ergast/f1/current/next.json` (Jolpica/Ergast
     proxy of the next race in the current season).
  2. Computes the current top-of-hour as `concat(formatDateTime(startOfHour(utcNow()), 'yyyy-MM-ddTHH:mm:ss'), 'Z')`.
  3. Builds candidate session-start strings as `date + 'T' + time` for
     `Qualifying`, `Sprint` (sprint weekends only), and the race itself.
  4. If top-of-hour equals any candidate → POSTs the runner-locked manual trigger
     and notifies the log channel; otherwise no-op.

  Why hourly @ X:01 on weekends: F1 sessions always start on the hour
  (HH:00:00Z in the Jolpica schema), so equality on top-of-hour is sufficient.
  Firing at X:01 means the runner fires ~1 minute after the session starts.
  Friday–Sunday window covers qualifying (typically Fri–Sat), sprint
  qualifying / sprint race (Fri–Sat on sprint weekends) and the race
  itself (Sun, occasionally Sat). Idempotency: the locked scrape writes
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

Every push/merge to `main` runs `docker-build-push.yml`: build and publish the
image with both `latest` and the commit SHA tags, then call `deploy-aci.yml`
and `deploy-aci-locked.yml` in parallel after the build succeeds. Both reusable
workflows receive the same immutable image digest, override `containerImage`
from their parameter files, and verify the configured ACI image after deployment.
An ACR push alone does not update a running/crash-looping ACI. Redeployment
updates and restarts the one-shot workload; it can immediately execute a scrape.
Release runs are serialized without cancelling an in-progress deployment;
GitHub retains only the newest pending release when several merges queue up.
Each ACI also has a deployment lock shared with manual runs. Deployment names
include run ID and attempt so failed deployments can be rerun safely.

The ACI workflows have no independent push triggers, avoiding a race between
image publishing and deployment. Both still support `workflow_dispatch` with
an image tag/digest input (default `latest`) for manual deployments. The two
Logic App workflows retain their targeted infrastructure path filters and
manual triggers. Telegram notifications fire on commits and PRs.

## update your instructions

The agreed reliability backlog and task order are in
[`docs/reliability-priorities.md`](docs/reliability-priorities.md). Task 5
requires discussion with Doron before deciding whether to proceed.

After every change, make sure to update the instructions above to reflect the current state of the code if necessary.
