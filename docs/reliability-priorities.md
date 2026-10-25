# API data reliability priorities

Agreed with Doron on 2026-10-25. Apply this order to the weekly and locked
data-fetch pipelines. Task 1 is implemented; production execution and the
controlled delivery check remain separate. The login fix (task 3) was brought
forward ahead of persistent logging (task 2). Tasks 2, 4, and 5 remain deferred.

1. **Send failure logs to Telegram — implemented.** One collector per weekly
   or locked execution records fatal login/discovery/fetch/upload/cleanup
   failures and partial team/league failures. After awaited browser cleanup,
   `index.js` flushes one consolidated plain-text report independently to the
   existing log and error channels. Categories include occurrence counts,
   stage/context, and at most three sanitized examples with bounded stacks.
   Credentials, tokens, connection strings, private paths, account identifiers,
   and URLs are redacted; multipart messages stay below Telegram's limit.
   Healthy runs, expected opponent unavailability, successful reconstruction,
   and recovered locked candidate probes do not generate failure reports.
   Empty/degraded locked results are reported without changing fetch
   resilience, uploads, or success/failure rules. Fatal status uses
   `process.exitCode = 1`; cleanup and notification errors preserve the
   original failure. Weekly concise/debug formatting and local preview remain.
   Automated coverage mocks F1, storage, and Telegram; it sends/uploads nothing.
2. **Persist logs and make notifications traceable — deferred.** Persist run logs and
   include mode, trigger, attempt, and session time in notifications so an
   unexpected message can be traced to its originating execution.
3. **Fix the login failure — implemented locally.** The existing account entry
   URL follows redirects to `id.formula1.com` with dynamic authorization state.
   Optional/delayed consent is handled before credentials; the labeled fields
   and submit button are scoped to `#loginForm`, with legacy-form support and
   explicit password targeting. Authentication requires the exact Fantasy origin
   and a usable session GUID. Repeated/concurrent initialization reuses the
   validated session; login errors are bounded and sanitized, and cleanup is
   awaited. Offline Chromium fixtures cover both forms and failure cases.
   Guarded local entrypoints on 2026-10-25 fetched all 3 private leagues and
   prices in weekly mode, then 3 locked snapshot payloads during a genuine open
   capture window. Locked mode reused one login across two init calls and made
   four fresh schedule checks (initial plus each of three guarded uploads).
   All uploads were intercepted, all Telegram methods were suppressed, and SDK
   upload methods were guarded. Both entrypoints exited successfully. This is
   local verification; publication and production execution remain separate.
4. **Bound retries and add a deadline.** Replace unlimited restarts with
   bounded retries and a deadline. Locked snapshot attempts must stay within
   the valid capture window.
5. **Discuss whether the runner should check the scrape's final result.**
   Doron is unsure this is needed. Discuss the need and tradeoffs with him
   when this task is reached, before deciding whether to plan or implement it.

Release publishing is separate from execution: merges publish `latest` and SHA
tags, then stop only freshly confirmed crash loops. They do not deploy or start
fetchers. Both Azure groups were verified to use `:latest` on 2026-10-25; the
next existing scheduled/manual start pulls the new image. Publishing does not
prove the failure-reporting version executed. Locked writes also require a
verified capture window, refreshed before each upload, to preserve snapshots
on out-of-window runs.

Next: review the login diff and local validation, then establish that the
published version actually runs after the next scheduled or separately
authorized manual start. Verify task 1 delivery to both destinations separately
with uploads disabled in a controlled harness. Do not deliberately fail the
existing production containers while unlimited restarts remain enabled.
Persistent logs, new trigger/attempt/session metadata, dependency upgrades,
saved sessions, retry/deadline changes, and runner-result monitoring remain
outside this login phase. Do not merge, redeploy, or initiate production runs
as part of local verification.
