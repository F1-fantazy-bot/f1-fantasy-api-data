# API data reliability priorities

Agreed with Doron on 2026-10-25. Apply this order to the weekly and locked
data-fetch pipelines. Task 1 is implemented locally; deployment and the
controlled delivery check remain separate. Tasks 2–5 remain planned.

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
2. **Persist logs and make notifications traceable.** Persist run logs and
   include mode, trigger, attempt, and session time in notifications so an
   unexpected message can be traced to its originating execution.
3. **Fix the login failure.** Investigate the F1 login timeout and fix the
   underlying cause using the failure diagnostics.
4. **Bound retries and add a deadline.** Replace unlimited restarts with
   bounded retries and a deadline. Locked snapshot attempts must stay within
   the valid capture window.
5. **Discuss whether the runner should check the scrape's final result.**
   Doron is unsure this is needed. Discuss the need and tradeoffs with him
   when this task is reached, before deciding whether to plan or implement it.

Next: review and separately authorize deployment of task 1, then validate both
destinations using a controlled failure with data uploads disabled. Do not
deliberately fail the existing production containers while unlimited restarts
remain enabled. No persistent logs, new trigger/attempt/session metadata,
login fixes, retry/deadline changes, or runner-result monitoring are included
in task 1. Continue with task 2 in the agreed order after rollout.
