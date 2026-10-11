# Weekly data investigation — 11 October 2026

Branch: `bugfix/doronkilzi/weekly-data-diagnostics`. Current-race pricing, owned-team retrieval, and explicit unknown-state handling
have now been implemented following the initial investigation. Exact current
opponent transfers remain unavailable from the observed upstream API.
Investigation and local validation were completed before creating the PR.
Team display names in these notes are anonymized; raw captures stay local.

## Local reproduction and comparison

Ran the weekly `index.js` entry point with the configured F1 credentials and
Playwright login. An external local harness captured the return from
`fetchAllLeaguesData`, blocked blob uploads, and suppressed ordinary Telegram
notifications. Existing Azure league history was read for the normal budget
join. The pre-existing local upload-disable edit in `index.js` was preserved.

The baseline captured three private leagues and 33 team snapshots, all with
`matchdayId: 17`. The root prices snapshot also selected matchday 17, containing
24 drivers and 11 constructors. All 33 requests for upcoming matchday 18
returned HTTP 200 but `Meta.Success: false`, `Meta.RetVal: -1`, and
`Data.Value: null`. All 33 matchday-17 fallback requests returned usable teams.

The live F1 Fantasy home and My Team pages identify **round 18, United States**,
as current, with round 17, Singapore, as the previous race. The authenticated
game-days response independently reports `cumdid: 18` and `prvmdid: 17`.
The browser's My Team page fetches `/feeds/drivers/18_en.json` and the
authenticated current-team endpoint; both provide current data.

Comparing the generated prices with the live round-18 feed found 29 changed
prices among the 35 entries:

| Entry           | Generated round 17 | Current round 18 |
| --------------- | -----------------: | ---------------: |
| C. Leclerc      |             $23.8M |           $24.1M |
| O. Bearman      |              $5.8M |            $6.4M |
| Red Bull Racing |             $32.4M |           $32.7M |
| Racing Bulls    |             $15.9M |           $16.5M |

The logged-in team, `bot account`, shows **3 of 3** free transfers on the live
My Team screen. Its current response has `team_info.userSubsleft: 3`, but the
top-level `usersubsleft: 0`. The existing weekly code already prefers the nested
field; that precedence should be preserved. This team's historical weekly
output also happens to show 3, so this is not a demonstrated count mismatch
for this specific team. Its budget, however, is historical: generated 105.2
versus current 108.8.

Other example generated counts are `Team A: 0`, `Team B: 1`, and
`Team C: 2`. These are copied directly from round 17. The round-18 opponent
responses do not expose their live counts, so their exact current values
were **not independently verified**. Do not treat historical counts or a
computed rollover as proof of current remaining transfers.

## Why this happens

`fetchLeagueData.js` infers the preferred matchday from the largest key in an
opponent's score history, plus one. That correctly requests 18 in this run.
The upcoming opponent response fails the existing team-state validation, so
the helper falls back to 17. The fallback matchday supplies the roster,
budget, transfers, and roster price feed. The league takes the first selected
team matchday; global prices then use the first league's selected matchday.
Consequently unavailable opponent data also forces an old public price feed,
even though the new price feed exists.

HTTP success is insufficient: the upstream envelope reports a logical failure.
The rejected response previously produced no detailed diagnostic, historical
fallbacks only logged to the console, and the overall weekly run still sent a
success notification. The maximum score-history key is also not a reliable
general completion check, because matchday details can contain in-progress or
unscored entries; that did not cause the observed round-18 request failure.

## Logging added

`weeklyDiagnostics.js` groups issues per run with an ID and timestamp, current
F1 matchday, counts, and up to three examples per issue. Examples identify the
league, team, team number, and hashed account ID, with requested/selected
matchdays, API failure metadata, and observed transfers as applicable.

The weekly orchestration reports rejected upcoming responses, historical
fallbacks, stale or mixed matchdays, contradictory transfer fields, incomplete
prices/rosters, missing budgets/transfers, and swallowed partial failures.
One additional authenticated game-days read observes the current matchday for
comparison; it does not select the output race. Reports redact credentials,
private request paths, GUIDs, and URLs. Telegram diagnostics use plain text,
are split below the message-size limit, and go only to the existing bugs group.
Clean runs produce no diagnostic report. Existing success and fatal-error
notifications are retained.

A second live local run with logging produced identical output apart from
`fetchedAt`. Its actual grouped report contained 33 rejected responses,
33 historical fallbacks, 33 stale team snapshots, and one stale price-feed
selection. The labeled preview was delivered to the existing bugs channel,
message **3177**, and user verification was requested.

The local evidence and harnesses are in `/tmp/f1-weekly-investigation`.
These files are not repository changes. The default Homebrew Node executable
could not start because of a missing `libsimdjson.29.dylib`; the runs and
checks used the existing fnm Node 22.14.0 executable instead.

## Original proposed fix

1. Resolve the canonical current/planning matchday once from the live game
   state and schedule. Handle in-progress weekends and season end explicitly,
   instead of treating the largest score-history key as necessarily completed.
2. Fetch the public price feed for that canonical matchday independently of
   opponent team-state availability. Validate coverage, numeric prices, and
   the matchday before publishing either global or team roster prices.
3. Verify which supported, authorized API source exposes each team's current
   roster and remaining transfers before lock. Use the authenticated
   current-team source for owned teams and preserve team-number discrimination
   and nested transfer-field precedence. If opponent state is withheld until
   lock, exact live counts require another authorized source; do not invent
   counts by adding a weekly allowance to history.
4. Make unavailable current state explicit, with unknown transfers and
   separately identified historical data where necessary. Avoid labeling
   mixed or historical team snapshots as current. Keep historical scores and
   budget joins tied to their actual matchdays, and distinguish partial
   completion from a fully current successful run.
5. Add regression coverage for HTTP-200 logical failures, available new prices
   with unavailable opponents, differing transfer fields, multiple teams,
   partial weekend scores, missing current state, and season end. Compare a
   local candidate run with the same live F1 pages before rollout.

## Implementation and follow-up validation

The implementation selects the canonical race from the app's
`constraints.GamedayId`, with account `cumdid` as fallback. The config's
`MatchdayId` is a sub-session ID (41 in this run), so it must not select the
race price feed. Unknown canonical state fails instead of guessing; season
end uses the final canonical race rather than probing one beyond it.

The live app's endpoint definitions also revealed that the authenticated team
path orders operation type before team number. `getUserTeam` now uses
`getteam/1/{teamNo}/{race}/1`, fixing selection of owned teams 2 and 3.
Owned-account identification matches leaderboard `social_id` to session
`SocialId`, with an exact GUID-suffix fallback when the field is absent. It
never matches a username or transient session GUID.

Current state must identify the requested race and team and include a complete
roster. A historical fallback provides only a clearly labeled last-known
roster, resolved against current prices. Its transfers and budget cannot be
copied into current values. New fields `teamStateStatus` and
`teamStateMatchdayId` identify current/historical/unavailable roster state.
Unavailable current transfers and budgets are null, including during API
failures. Unavailable current prices abort the weekly run before uploads.
Historical budget joins remain tied to their source races.

A third local weekly run selected race **18** for all three league snapshots
and the global feed. All **35 global prices** and all generated roster prices
matched the live round-18 feed. The owned team appears in three leagues; all
three snapshots show **3 remaining transfers** and **108.8 budget**, matching
the live authenticated My Team data. The other **30 league team snapshots**
retain explicitly historical rosters with unknown current transfers/budgets.
The existing opponent endpoint also returned no current data for the tested
zero-matchday and phase variants. This is an upstream availability limit,
not evidence for any particular calculated remaining-transfer count.

Telegram now receives a short problem/impact summary; detailed redacted
examples remain in the service logs. The new preview was **212 characters**
before the service prefix and delivered to the existing bugs group as
message **3178**. Ordinary success notifications distinguish partial results
from a fully current run. No production blobs were uploaded in validation.

Regression tests cover independent current prices, unknown historical
transfers, nested-field precedence including zero, owned and opponent team
selection, partial/unscored history, missing history, wrong race/team
responses, season end, price-feed failures, concise warnings, and partial
success reporting. Full exact current transfers for opponents still require
an upstream source that exposes that state; consumers must respect null and
historical status rather than substitute guessed defaults.

## Further endpoint investigation with only the bot account

Traced the live F1 league page, downloaded the actual frontend modules, and
inspected the app's GET endpoint definitions plus a published development
OpenAPI schema. Tested requests inside the existing authenticated browser;
no credentials, cookies, or authenticated identity were changed.

The official league view uses `opponentgamedayplayerteamget` for the last
available scored race. Its race selector is populated from scored race
fixtures; it is not another frontend source for unscored current rosters.
The race-18 opponent request also fails for the bot's OWN team even though
its authenticated race-18 team response is present. This rules out using
that archived endpoint as a live-data source solely because data exists in
the owning account.

Controlled archive comparisons confirm that substitution fields depend on
the requested race. Team B reports zero in race 16 and one in race 17;
Team A reports minus one in race 16 and zero in race 17. The negative
values represent exceeding a race's free allowance, not missing data. The
My Team frontend clamps a negative free-transfer count to zero; the weekly
extraction now does the same for valid live responses.

The authenticated `getteam`, current game-days, and homepage-statistics
endpoints return the BOT's account when given a different public GUID.
Substituting an opponent GUID therefore cannot collect that opponent's
current state. Service league rankings and league-member endpoints expose
identities, roster IDs, and ranks, but no current transfer fields. The
additional `getteaminfo` endpoint returned a logical failure. Race/phase,
operation-type, all-team, full/base-GUID, and cache-busting variants did not
produce an opponent's race-18 state. No authentication-bypass mechanisms
were used.

The supported live source verified so far is the owning account's
`getteam` response. Only the bot account is available in this task. A live
source for all other owners has not been found, so exact live counts must
not be described as solved.

For planning, F1's round-18 schedule feed separately supplies an allowance
of two transfers and a maximum carry-over of one. Applying those rules to
race-17 unused transfers yields START-OF-RACE allowances, e.g. Team A=2,
Team B=3, Team C=3. These cannot prove what remains after an owner's
subsequent changes; using calculated allowances requires keeping that
meaning explicit. A preview was computed locally and a scope question was
sent to the user before changing the output to calculated values.

## Chip-aware calculation implementation

The user requested research before implementation, then explicitly approved
adding calculated allowances. Findings and a concrete
race-18 preview are recorded in [chip-transfer-allowance-research.md](chip-transfer-allowance-research.md).
Limitless and Wildcard require no carry-over in the following ordinary race;
the other four chips follow normal unused-transfer carry-over. The initial
simple preview therefore needs a Wildcard exception for Team B, squad 3.

The calculation now queries F1's archived API for the immediately previous
race, validating returned race/team identity; it does not use the faulty
saved Singapore output or any saved transfer/chip metadata. Base and carry
limits come from the current schedule, chip IDs from current web config,
and active chips from the requested archive's `boosterid`. Transfer metadata
is validated independently of roster size to handle Final Fix archives.

The live local race-18 run completed 3/3 leagues and produced live counts
for three bot snapshots plus calculated starting allowances for all 30
opponent snapshots. Team B, squad 3 received 2 after Wildcard; Team D received 3
after Autopilot. The output exposes `transfersStatus` and
`transfersSourceMatchdayId`, and Telegram wording explicitly states that
current private usage is unknown. Current budgets and historical roster
limitations are unchanged. The validation harness suppressed all uploads
and Telegram messages. Tests include deliberately corrupted saved Singapore
data, missing previous races, invalid schedule rules, chip resets, live
priority, and Final Fix metadata.

## Follow-up: console warning classification

A user-run scrape completed successfully and uploaded race-18 data, but the
default console diagnostics repeated the same opponent-data limitation under
multiple issue headings and listed successful transfer calculations as an issue.
The follow-up logging change prints one short partial-data warning and a separate
informational calculation count. Successful calculations and expected opponent
`Meta.Success:false/RetVal:-1` responses are stored as information, with bounded
redacted response examples available through `F1_WEEKLY_DEBUG=true`.
Malformed responses, owned-team failures, request failures, and unknown transfer
counts remain visible as warnings. Informational-only calculations do not trigger
a bugs-channel warning. The underlying data retrieval and calculation behavior
is unchanged by this logging follow-up.

## Starting roster and budget baseline

The user clarified that recommendations should use the lineup, budget, and
transfer allowance at the start of the new planning window, regardless of
later private changes. After research and explicit approval, `raceStartBaseline.js`
now reconstructs the roster and cap directly from F1 archives and price feeds.
Limitless restores the pre-chip roster; Final Fix restores the outgoing driver
and its captain boost. Temporary chip flags are cleared. The previous regular
cap plus the restored lineup's price changes gives the starting cap.

The implemented helper matched 83/83 archived next-race budgets. The live local
race-18 run produced complete reconstructed baselines for all 30 opponent league
snapshots, alongside three live bot snapshots. It produced no partial-data
warning, only informational source/count summaries. See
[starting-weekend-baseline-research.md](starting-weekend-baseline-research.md)
for the evidence and output contract. Validation suppressed uploads and Telegram
sends; these local follow-up changes have not yet been committed or pushed.
