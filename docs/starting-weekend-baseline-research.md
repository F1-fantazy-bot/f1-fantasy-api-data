# Starting-weekend roster and budget reconstruction

Research date: 11 October 2026. The user approved implementation after reviewing
the research; the calculation is now implemented locally.
Team display names are anonymized; raw responses remain local.

## Required baseline

The user wants the lineup, budget, and transfer allowance when the new race's
planning window opens, before any subsequent changes. A private live opponent
lineup is unnecessary for that requirement. The result must be labeled as a
race-start baseline, rather than the team's currently edited state.

## Sources and method

Read F1's archived team state directly, validating account/team selection and
returned race. Use the immediately previous race's roster, budget, and price
feed together with the new race's price feed. Saved weekly Singapore output
must not supply the reconstruction.

For an ordinary previous race, its roster carries into the new planning window.
Wildcard changes remain permanent. Restore temporary changes before valuing
the baseline:

- Final Fix: remove the temporary incoming driver and restore the outgoing
  driver. Archived responses identify these with `finalfxnewplayerid`,
  `finalfxoldplayerid`, and `isfinal` markers, and contain eight player rows.
- Limitless: retrieve the original pre-chip roster from the previous archived
  race; do not value the temporary Limitless squad as the carried roster.

The [official F1 FAQ](https://fantasy.formula1.com/en/faqs) confirms original
roster restoration after Limitless and Final Fix. The
[official 2026 F1 Strategist preview](https://www.formula1.com/en/latest/article/f1-fantasy-strategist-preview-the-mclaren-mini-league-and-what-you-need-to.6ZavXlTg6eT3GQOsvJ8Dax)
specifically confirms that price changes during a Limitless weekend apply to
the pre-Limitless team.

Calculate the new starting cost cap as:

`previousRaceCostCap + sum(newPrices(carriedRoster) - previousRacePrices(carriedRoster))`

Equivalently, it is the carried roster's new value plus its restored unspent
cash. After Final Fix, nested `team_info.teamBal` can reflect the temporary
swap; it cannot be copied blindly as the reverted roster's cash. Derive restored
cash from the previous cost cap minus that restored roster's previous-price
value, and validate the swap metadata. Missing prices, ambiguous reversions,
or missing original rosters must remain unknown.

## Checks

Downloaded all 18 available race price feeds directly from F1 using the normal
authenticated browser session. Compared reconstruction against 83 adjacent
archived team-state pairs from the prior chip investigation.

An initial calculation that valued Limitless's temporary roster failed every
one of the 11 Limitless transitions. Restoring the original roster resolved
all of them. The complete chip-aware calculation matched **83/83** next-race
archived cost caps:

| Previous chip   | Checked transitions | Matches |
| --------------- | ------------------: | ------: |
| None            |                  21 |      21 |
| Limitless       |                  11 |      11 |
| Wildcard        |                   6 |       6 |
| Final Fix       |                   4 |       4 |
| Autopilot       |                  10 |      10 |
| No Negative     |                  16 |      16 |
| Extra DRS Boost |                  15 |      15 |

These are cached adjacent pairs across teams and races, not 83 independent
owners. The next archived cost cap is used as a budget check even when that
week has a chip; this does not assert an ordinary transfer quota for an
unlimited week. Opponents' race-18 reconstructed values have not been verified
against their private live current endpoint, which remains unavailable.

An independent check against the bot account's fresh authenticated race-18
response gave:

- Archived race-17 budget: 105.2.
- New-price value of the carried roster: 107.9.
- Carried cash: 0.9.
- Reconstructed race-18 budget: **108.8**, matching its live API value.
- Archived roster IDs matched the live API's `gd_initial_team` exactly.

All 21 distinct opponents in the captured race-17 responses have an ordinary
or Wildcard roster, rather than an active Limitless/Final Fix reversion case.
The current 30 opponent league snapshots can therefore use the direct
carried-roster calculation, subject to fresh input validation.

## Implemented scraper output and planned consumer changes

Prefer a verified live source where available. Otherwise publish the reconstructed
race-start roster and budget alongside the already calculated transfer allowance.
Expose explicit race-start statuses and source races for both roster and budget;
do not label them as live. Stop treating a complete validated baseline as a
missing-budget failure, while retaining warnings for genuinely missing inputs.

The bot and agent should use this baseline for recommended changes, preserving
the source/status fields and explaining that recommendations assume no changes
since the planning window opened. Later edits do not affect the requested
baseline. Locked weekend scoring should continue using actual locked snapshots.

The implementation exposes `teamStateStatus: "reconstructed-race-start"` and
keeps `teamStateMatchdayId` as the archived lineup-source race. The target race
remains the snapshot's canonical `matchdayId`. Budgets have `budgetStatus`
(`live`, `calculated-race-start`, or `unknown`) and `budgetSourceMatchdayId`.
Validated reconstructed caps also populate the new race's `raceBudgets` entry.
Complete baselines generate informational logs and a successful completion
notification; genuinely missing inputs remain warnings.

Replayed the implemented helper against the same 83 archived transitions:
**83/83** budgets matched. This replay identified Final Fix captain IDs that
refer to the temporary incoming driver; those IDs now revert to the outgoing
driver along with the roster. Nested temporary cash is never used blindly.
The live local race-18 scrape reconstructed all 30 opponent snapshots,
retained three live bot snapshots, and produced no partial-data warning.
Validation suppressed all Telegram sends and Azure uploads. Consumer changes
in the bot repository remain separate work.
