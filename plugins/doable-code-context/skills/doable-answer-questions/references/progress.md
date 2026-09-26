# Progress visible in the TRD editor

Report actual work through `report_code_context_activity`, using the current
returned Round ID and revision. Keep the original connection code only for pulls.
Progress reports do not submit answers or keep a connection alive.

| When | phase | step | question_id |
| --- | --- | --- | --- |
| Reading a newly received batch | collecting_context | reviewing_questions | omit |
| Starting or continuing an open question | collecting_context | investigating_code | current open ID |
| Reviewing evidence and coverage | collecting_context | checking_coverage | omit |
| Validating or repairing the answer payload | preparing_answers | validating_answers | omit |
| About to submit the validated payload | preparing_answers | submitting_answers | omit |

Report stage changes and each change of question. While actively investigating or
repairing for a long time, report the current stage again after about 60 seconds
at the next tool boundary, even if the question has not changed. Track the last
report time locally; do not add sleeps just to report. A long blocking tool cannot
be interrupted for an update, so report before it and resume updates afterwards.
Do not report on every file/tool call, during setup, while waiting for a human, or
on idle connection watch polls. No background fake heartbeat. Never upload free
text, filenames, source, logs, private identifiers, or invented percent complete.

Inspect the available tool schema: if `step` is absent, omit both optional fields
and use the original phase-only reports. If a server rejects these new fields as
unsupported, retry once without them, then retain phase-only reporting for this
connection. Do not downgrade a revision/state conflict: pull the connection again
and use the newly returned identity. If reporting is unavailable or otherwise
fails, mention it once locally and continue the answer workflow; do not repeatedly
retry progress in the watch loop. Reset question/stage state for every new Round
or revision. Submitted, skipped, or established questions are no longer active.
