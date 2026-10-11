# Chip-aware transfer allowance research

Research date: 11 October 2026. The user approved implementation after reviewing
these findings. The chip-aware calculation is now implemented locally, with
explicit source/status fields and no reliance on saved Singapore output.
Team display names below are anonymized; raw captures stay local.

## Findings

For a normal race-start allowance, two new free transfers are granted and
at most one unused transfer carries over. Limitless and Wildcard cancel
carry-over for the following race. Autopilot, Extra DRS Boost, No Negative,
and Final Fix do not impose that reset; normal carry-over still applies.

The [official F1 Fantasy FAQ](https://fantasy.formula1.com/en/faqs) explicitly
states that no unused free transfers carry forward after Limitless. Its
Wildcard paragraph explains unlimited changes but does not explicitly state
the carry-over reset. The [2026 Wildcard guide by Adam Medeiros/FanAmp](https://www.fanamp.com/articles/wildcard-chip-explained)
explicitly describes the following week's allowance dropping to two. These
rules were checked against this league's archived 2026 API responses, rather
than relying on older seasons or other fantasy games.

The [Final Fix guide](https://www.fanamp.com/articles/final-fix-chip-explained)
explains that the Final Fix substitution is separate from the regular free
transfer limit. The historical API examples below also show normal carry-over
after Final Fix.

## Historical evidence

Collected 116 distinct archived team responses across 22 distinct teams,
covering 62 chip-to-next-race transitions. Each reported chip activation was
confirmed against the historical response's actual `boosterid`; the six
booster IDs were resolved through the live F1 configuration.

Four transitions were excluded from rule verification because the FOLLOWING
race also used Limitless or Wildcard, making its free-transfer allowance
unlimited rather than an ordinary two/three-transfer week. All 58 remaining
chip transitions matched the proposed rule:

| Previous chip   | Ordinary follow-up transitions | Result                                       |
| --------------- | -----------------------------: | -------------------------------------------- |
| Limitless       |                             10 | All following allowances were 2              |
| Wildcard        |                              5 | All following allowances were 2              |
| Extra DRS Boost |                             14 | 2 or 3 according to unused regular transfers |
| No Negative     |                             15 | 2 or 3 according to unused regular transfers |
| Autopilot       |                             10 | 2 or 3 according to unused regular transfers |
| Final Fix       |                              4 | 2 or 3 according to unused regular transfers |

Also downloaded 42 existing Azure locked snapshots (read-only), covering
races 4–17 across the three private leagues. There were 135 comparable stored
team entries against the captured archived API responses, and all 135
`transfersRemaining` values matched `team_info.userSubsleft`. Eight joins used
stable account IDs; 127 older entries lacked those IDs and were compared only
where team name + username + team number identified a single candidate.
These counts include repeat team appearances across leagues, not 135
independent owners. This confirms that the legacy values are consistent with
the archived race data, rather than current-week counts.

Across the cached responses, 65 adjacent-race pairs with a normal follow-up
allowance, including non-chip weeks, also matched with no mismatches. Season
race 1 was excluded from this comparison because first-team-week transfers
are unlimited and need their own treatment.

Concrete examples:

| Team       | Previous race | Chip            | API unused in chip week | Following API starting allowance |
| ---------- | ------------: | --------------- | ----------------------: | -------------------------------: |
| Team B, T1 |             3 | Limitless       |                       3 |                      2 at race 4 |
| Team A, T1 |             5 | Wildcard        |                       2 |                      2 at race 6 |
| Team F, T1 |            12 | Wildcard        |                       2 |                     2 at race 13 |
| Team D, T1 |            14 | Extra DRS Boost |                       2 |                     3 at race 15 |
| Team G, T1 |            14 | No Negative     |                       1 |                     3 at race 15 |
| Team H, T1 |             7 | Autopilot       |                       1 |                      3 at race 8 |
| Team I, T1 |             6 | Final Fix       |                       1 |                      3 at race 7 |

One important apparent exception is Team E: Wildcard at
race 5 is followed by Limitless at race 6, whose nominal numeric fields show 3. That following week had unlimited transfers, so this does not establish
a three-free-transfer allowance for an ordinary post-Wildcard week. It was
excluded rather than silently counted as confirmation or a contradiction.

## Implemented calculation

1. Prefer a valid live current-team API count when available. A known active
   Limitless/Wildcard week has unlimited transfers, so its numeric bookkeeping
   fields must not be presented as an ordinary two/three-transfer limit.
2. Otherwise calculate the race-start allowance from the immediately previous
   completed race, separately for each account and team number.
3. If that race used Limitless or Wildcard, use the current race's base
   allowance (2 in the current F1 schedule) without carry-over.
4. Otherwise use the base allowance plus at most one nonnegative unused
   transfer: `base + min(max(previousUnused, 0), maxCarry)`.
5. Read `base` and `maxCarry` from the current race's schedule rather than
   assuming they will remain constant in future seasons.
6. Mark the value as a calculated race-start allowance. It cannot account for
   private team changes made after the current race opened. Missing previous
   data or ambiguous chip activation must remain unknown rather than default
   to 2/3. First-ever race weeks are unlimited and require an explicit status.

Only a chip active in the immediately preceding race resets the next
allowance. Season-level `is...taken` flags mean the chip has EVER been used;
applying them would incorrectly keep resetting teams throughout the season.
Even `iswildcard` is stale in at least one archived non-Wildcard race. Prefer
that requested race's `boosterid` or a verified activation-race match.

Archived Final Fix responses contain 8 roster rows (outgoing and incoming
drivers). Transfer/chip metadata is now validated independently of the
seven-row roster check, so Final Fix does not discard valid carry-over data.

## Current race-18 preview

The live local weekly run reproduced these values using fresh archived F1
responses, rather than saved weekly/locked snapshots:

| Team            | Race-17 chip | Race-17 unused | Calculated race-18 starting allowance |
| --------------- | ------------ | -------------: | ------------------------------------: |
| Team A          | None         |              0 |                                     2 |
| Team B          | None         |              1 |                                     3 |
| Team C          | None         |              2 |                                     3 |
| Team B, squad 3 | Wildcard     |              2 |                                     2 |
| Team D          | Autopilot    |              3 |                                     3 |

The chip-aware exception materially changes Team B, squad 3's proposed result:
blind carry-over would produce 3, whereas post-Wildcard reset produces 2.

## Local implementation verification

The race-18 weekly run completed across all three leagues: 33 entries
representing 22 distinct teams. Three bot snapshots retained live transfer
counts; 30 opponent snapshots received calculated race-start allowances;
none had an unknown count. Every calculation was independently checked
against the fresh archived race-17 response, including returned race and
team number. All 35 global prices and all roster prices used race 18.

Calculated values carry `transfersStatus: "calculated-race-start"` and
`transfersSourceMatchdayId: 17`; live values carry `"live"` and race 18.
Known current unlimited weeks have status `"unlimited"` and a null numeric
count. Missing or ambiguous data has status `"unknown"` and null values.
The first-team-week counter is not used to infer ordinary carry-over.
Telegram summaries distinguish calculated allowances from live counts.

Private raw responses and the local validation harness are stored under
`/tmp/f1-weekly-investigation`. The validation run suppressed Telegram sends
and Azure uploads. No commits, pushes, or PRs were made.
