# f1-fantasy-api-data

One-shot container that logs into [F1 Fantasy](https://fantasy.formula1.com/) via Playwright,
fetches league leaderboard data through the API, and uploads it to Azure Blob Storage.

## How It Works

The container has two modes, switched via the `MODE` env var:

- **`MODE=weekly`** (default — `npm start`) — Logs in, fetches every private
  league's leaderboard + each team's per-matchday scores, current roster,
  budget, transfers, and chips used. Writes two blobs per league:
  `leagues/{code}/league-standings.json` (history + chips) and
  `leagues/{code}/teams-data.json` (current roster snapshot for the
  current planning race). Scheduled for **Monday and Thursday at 03:00 UTC** (Logic App scheduler).

- **`MODE=locked`** (`npm run scrape:locked`) — Captures the **just-locked**
  matchday's roster, captain, budget, transfers and chips for every team.
  Writes only `leagues/{code}/locked/matchday_{N}.json`, one blob per
  league per locked matchday. Designed to run shortly after each
  qualifying / sprint / race start (the F1 Fantasy lock fires at session
  start). Must complete before the race ends — once the race ends F1
  Fantasy auto-reverts Limitless and the locked mega-squad would be lost.

Both modes share login, F1 API access, roster resolution, and Telegram
notifications.

Locked runs verify the capture window against a fresh F1 race schedule before
fetching leagues and again before every upload. Writes require a verified lock,
an unfinished race, and a matching race/team response and snapshot path. The
window starts at qualifying (sprint qualifying on sprint weekends) and closes
at race completion or the scheduled race end, whichever comes first. Outside
that window, or when its state cannot be verified, writes are skipped and the
container exits successfully after cleanup. The log channel receives a skip
message; unverifiable state also receives a failure report. Repeated captures
inside a valid window remain allowed.

## Setup

```bash
cp .env.example .env
# Fill in credentials
npm install
npx playwright install chromium
npm start                    # weekly mode
npm run scrape:locked        # locked-snapshot mode
```

## Environment Variables

| Variable                          | Description                                 |
| --------------------------------- | ------------------------------------------- |
| `F1_FANTASY_EMAIL`                | F1 Fantasy account email                    |
| `F1_FANTASY_PASSWORD`             | F1 Fantasy account password                 |
| `F1_LEAGUE_CODE`                  | Target league code (default: `C7UYMMWIO07`) |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Blob Storage connection string        |
| `AZURE_STORAGE_CONTAINER_NAME`    | Blob container name                         |
| `TELEGRAM_BOT_TOKEN`              | Telegram bot token for notifications        |

## League JSON shapes

Two blobs are uploaded per league under `leagues/<leagueCode>/`:

### `league-standings.json` — leaderboard + per-race scores

Each team also carries `teamNo` and `accountId`. `accountId` is a stable
12-hex-character SHA-256-derived identifier based on F1 Fantasy's
trimmed, case-normalized `user_guid`. The upstream value is opaque and need
not be UUID-shaped. The helper returns `null` for missing or invalid values;
the scraper refuses to upload a league if a leaderboard entry lacks a usable
identifier. The raw GUID is never persisted. Consumers should use
`userName + teamNo + accountId` for human-readable canonical identity.
This keeps two distinct accounts with the same display name and `team_no`
separate while remaining stable across leagues.
The stable logical key is `accountId + teamNo`; a username may change.
`teamName` is for display and can only help match unambiguous older snapshots.
Historical race budgets with an ambiguous legacy display identity are not reused.
The same `accountId` is included in current `teams-data.json` and newly
captured `locked/matchday_N.json` entries.

`raceBudgets` mirrors `raceScores` and records each team's budget cap at the
**start** of each race (`team_info.maxTeambal` — cost-cap-remaining + roster
cost at lock prices). For matchday 1 this is always `100` (season-start cap).
It is populated **incrementally**: on each run the existing blob is
downloaded and only matchdays missing from the prior `raceBudgets` trigger
an extra `getOpponentTeam` call, so steady-state runs add essentially no
extra API traffic.

```json
{
  "fetchedAt": "2025-04-19T09:00:00.000Z",
  "leagueName": "My League",
  "leagueCode": "ABC123",
  "leagueId": 123,
  "memberCount": 10,
  "teams": [
    {
      "teamName": "Team A",
      "userName": "user_a",
      "teamNo": 1,
      "accountId": "a84f1234abcd",
      "position": 1,
      "totalScore": 500,
      "raceScores": { "matchday_1": 50, "matchday_2": 60 },
      "raceBudgets": { "matchday_1": 100.0, "matchday_2": 100.8 },
      "chipsUsed": [{ "name": "Limitless", "gameDayId": 3 }]
    }
  ]
}
```

### `teams-data.json` — per-team composition

Focused view for rendering team rosters without pulling the full league blob.
`matchdayId` is the **current planning race**, resolved from live F1 game
state rather than inferred from score history. Global and team roster prices
always use that race's feed.

Owned teams use the authenticated current-team API. Each team includes
`teamStateStatus` (`current`, `reconstructed-race-start`, `historical`, or
`unavailable`) and `teamStateMatchdayId` (the archived roster-source race, or
current race for live state). When F1 withholds current opponent state, the
service reconstructs the lineup and budget at the start of the new planning
window, before this week's changes. These form the baseline for recommendations.

`raceStartBaseline.js` carries ordinary/Wildcard rosters forward, restores
Final Fix's outgoing driver and captain, clears temporary chip flags, and
restores the original pre-Limitless roster from an earlier F1 archive.
The starting cost cap is the previous race's regular cap plus the carried
lineup's price changes. Previous/new price feeds and all archive inputs are
queried directly; saved weekly/locked snapshots do not supply the calculation.
Prices, five-driver/two-constructor composition, chip metadata, and nonnegative
restored cash are validated before publishing a baseline.

Reconstructed rosters use `teamStateStatus: "reconstructed-race-start"`.
`teamStateMatchdayId` remains their archive source race (usually current - 1;
an original pre-Limitless lineup can be older). The top-level `matchdayId`
identifies the race the baseline applies to. Budgets carry `budgetStatus`
(`live`, `calculated-race-start`, or `unknown`) and
`budgetSourceMatchdayId` (current race, previous race, or `null` respectively).
Validated starting budgets also populate `raceBudgets` for the new race.

If reconstruction fails, a clearly historical roster can be retained, with
unknown budget (`null`). Missing inputs remain warnings. A complete reconstructed
baseline is successful recommendation data and is reported as information,
without an incomplete-data warning. It does not assert a privately edited
live opponent lineup.

Current transfers prefer `team_info.userSubsleft` over top-level
`usersubsleft`; these can disagree. Unknown current race or unavailable
current price feed fails the weekly run before uploads. Partial team data is
reported as partial, with one concise warning in the console and Telegram
bugs channel. Successful transfer calculations are informational, and expected
opponent API unavailability is not listed as an unexpected response error.
Set `F1_WEEKLY_DEBUG=true` to include detailed, redacted API responses and up
to three examples per diagnostic type in console output. Real request failures
and malformed responses remain visible in the default warning.

When live transfers are unavailable, the weekly service queries F1's archived
API for the **immediately previous race** and validates its race/team identity.
It never calculates from saved weekly or locked snapshots, including the
faulty Singapore output. The current schedule supplies the base allowance and
carry limit. Limitless/Wildcard in that previous race reset carry-over; other
chips allow at most one unused transfer to carry (currently 2 + up to 1).
Final Fix's extra archived roster row does not invalidate transfer metadata.

`transfersRemaining` must be interpreted with these fields:

| `transfersStatus`       | Meaning                                                                           | `transfersSourceMatchdayId` |
| ----------------------- | --------------------------------------------------------------------------------- | --------------------------- |
| `live`                  | Current API count, with negative free transfers clamped to zero                   | Current race                |
| `calculated-race-start` | Calculated starting allowance; private changes this week are unknown              | Previous race               |
| `unlimited`             | A verified current Limitless/Wildcard or first team week; numeric count is `null` | Current race                |
| `unknown`               | Missing/ambiguous data or rules; numeric count is `null`                          | `null`                      |

Only the archived race's active `boosterid` determines a chip reset, never
season-level flags. Missing previous-race data cannot be replaced by an older
race or a guessed default. A previous first-team-week counter is not treated
as ordinary unused free transfers. Calculated values can coexist with a
historical/unavailable roster and must not be presented as live remaining
transfers. Telegram summaries explicitly identify these estimates.

```json
{
  "fetchedAt": "2025-04-19T09:00:00.000Z",
  "leagueName": "My League",
  "leagueCode": "ABC123",
  "leagueId": 123,
  "matchdayId": 3,
  "teams": [
    {
      "teamName": "Team A",
      "userName": "user_a",
      "teamNo": 1,
      "accountId": "a84f1234abcd",
      "position": 1,
      "budget": 105.8,
      "budgetStatus": "live",
      "budgetSourceMatchdayId": 3,
      "transfersRemaining": 3,
      "transfersStatus": "live",
      "transfersSourceMatchdayId": 3,
      "teamStateStatus": "current",
      "teamStateMatchdayId": 3,
      "drivers": [
        {
          "id": "124",
          "name": "G. Russell",
          "price": 28,
          "isCaptain": true,
          "isMegaCaptain": false,
          "isFinal": false
        }
      ],
      "constructors": [
        {
          "id": "25",
          "name": "Ferrari",
          "price": 23.9,
          "isCaptain": false,
          "isMegaCaptain": false,
          "isFinal": false
        }
      ]
    }
  ]
}
```

The root `prices.json` driver entries retain the F1 Fantasy player identity
and activity metadata needed to distinguish duplicate names or codes during
driver changes:

```json
{
  "id": "116",
  "name": "L. Lawson",
  "code": "LAW",
  "teamId": "9",
  "teamName": "Red Bull Racing",
  "price": 14.5,
  "isActive": true
}
```

Inactive entries remain in the file because an existing fantasy team may
still own them, but consumers should only offer active entries as new picks.

## Deployment

Every merge/push to `main` builds and publishes the image with both `latest`
and commit SHA tags. **Image published does not mean new version executed.**
Only after publishing succeeds, the release inspects the weekly and locked
ACI groups independently. It never deploys, starts, or restarts either group.

| Observed current state | Release action |
| --- | --- |
| Single container `Waiting` with `CrashLoopBackOff`, group `Running`, provisioning `Succeeded` | Re-read immediately; stop the group only if the crash loop is still confirmed. |
| Healthy/running scrape, including a recovered retry | Leave it running until it finishes. |
| Stopped or terminated container/group, or succeeded/failed group | Leave it alone. |
| Missing, ambiguous, updating, or other waiting/error state | Leave it alone; never infer a crash loop from restart counts or previous exit codes. |

Both groups must stay configured with
`f1fantasyacr.azurecr.io/f1-fantasy-api-data:latest`. Their next existing
scheduled/manual start pulls the published image. A healthy in-flight scrape
can finish using its already-pulled image. A stopped crash loop waits for the
next scheduled/manual start. Workflow summaries record publication separately
from container inspection and do not claim the new version has executed.
Establish actual execution separately from the next start's image-pull/runtime
evidence and final scrape result; the configured `:latest` tag alone is not proof.

Releases are serialized without cancelling an active release. If several merges
queue up, GitHub keeps the newest pending release. Per-group locks serialize
inspection/stop against the separate manual ACI deployment workflows. Failure
to inspect one group does not cancel inspection of the other.

### Verify configuration and migrate a pinned image

Read-only Azure checks on **2026-10-25** confirmed that both existing groups
use `:latest`; neither needs migration from a digest. These checks did not
start, stop, or redeploy a container.

If a later inspection finds a digest/SHA pin, another image, or missing image
configuration, the release reports the required migration and fails that
inspection job. It does **not** rewrite the image. A confirmed crash loop can
still be stopped safely. To migrate, plan a separate manual ACI deployment
using the checked-in `:latest` parameters during an appropriate maintenance/
capture window. **ACI deployment restarts the one-shot workload and may run a
scrape immediately**, including for a previously stopped group; merely stopping
a group before deployment does not make deployment execution-free. The release
workflow never performs this migration.

ACI infrastructure deployment is available separately through the manual
`Deploy ACI` / `Deploy ACI (locked)` workflows, both fixed to `:latest`, or the
commands below. Existing Logic App deployment filters/manual triggers,
scheduler schedules, runner `/start` behavior, and role grants are unchanged.
Locked execution retains its capture-window guard, including per-upload
refreshes and skipped writes outside a verified window.

### Deploy the ACI workload

Deploy the one-shot container group:

```bash
npm run deploy:aci
```

### Deploy the runner Logic App

Deploy the HTTP-triggered Logic App that starts the ACI:

```bash
npm run deploy:runner
```

After deployment, assign the runner Logic App managed identity `Contributor` on the ACI scope:

```bash
az role assignment create \
  --assignee <logicAppPrincipalId> \
  --role Contributor \
  --scope /subscriptions/<subscriptionId>/resourceGroups/<resourceGroup>/providers/Microsoft.ContainerInstance/containerGroups/<containerGroupName>
```

The `logicAppPrincipalId` value is emitted by the runner ARM deployment outputs.

### Deploy the weekly scheduler Logic App

Deploy the Monday/Thursday scheduler after the runner exists:

```bash
npm run deploy:scheduler
```

Or deploy both Logic Apps in order:

```bash
npm run deploy:logicapps
```

The scheduler runs every Monday and Thursday at `03:00 UTC` and invokes the runner Logic App callback URL.

### Manually trigger the runner

The runner ARM deployment outputs `runnerTriggerCallbackUrl`. You can invoke it directly:

```bash
curl -X POST "<runnerTriggerCallbackUrl>"
```

This always submits a `start` request to the configured ACI container group.

## API Documentation

See the [F1 Fantasy API Reference](../f1-fantazy-bot/docs/f1-fantasy-api.md) and
[Response Examples](../f1-fantazy-bot/docs/f1-fantasy-api-examples.md) in the bot repo.
