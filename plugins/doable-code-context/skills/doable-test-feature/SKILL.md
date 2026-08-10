---
name: doable-test-feature
description: Start and complete a Doable autonomous feature-testing workflow from the customer's coding agent. Use when the developer asks to test a named feature or a feature they just implemented and wants Doable to provide durable feature context, a TRD, managed test cases, and execution. Reuse an appropriate suite, start one coding-agent-origin Round for new or changed behavior, resolve it from the private workspace, then continue through the configured Doable MCP after explicit TRD approval.
---

# Test a Feature with Doable

Turn a developer's local request into one bounded Doable testing workflow. Reuse Doable's existing Round, TRD, case-management, and execution contracts; do not create a second state machine.

The bundled helper is an implementation detail:

```bash
node <plugin-directory>/scripts/doable-code-context.mjs <command> ...
```

## Workflow

1. Resolve the feature scope from the request, selected change, ticket, PRD, or current conversation. Ask one short clarification only when the named feature is genuinely ambiguous. Do not turn “test the feature I just built” into a whole-product scan.
2. Use the configured Doable MCP to search accessible test suites by feature scope, flows, entry surface, and existing case coverage.
   - Reuse one clear match.
   - If several are materially plausible, show the small candidate set and ask the developer to choose.
   - If none matches, create one suite for this feature with the configured entry URL. Do not create duplicate suites merely because wording changed.
3. Inspect the selected suite's TRD and case coverage.
   - If the request is only a regression or an implementation catch-up already required by the current TRD, skip a new Round and rerun the affected existing cases.
   - If expected behavior, scope, fixtures, permissions, observable outcomes, or environment assumptions changed—or the suite has no TRD—continue with a new Round.
4. Prepare a private request JSON containing the exact feature request plus only the developer's explicit supplemental questions. Run `start-round --suite <suite-public-id> --request <path>`. The Doable question planner may add focused supplements; it must not replace the base feature investigation or widen the feature.
5. If the workspace is not connected, follow `doable-connect` for the returned Round code. Ask for the one required approval before the first sanitized routing-profile upload, then resume automatically.
6. Follow `doable-answer-questions` for that exact frozen Round: pull it, inspect only the routed private sources, collect local evidence, ask at most one batched clarification, validate, and submit privacy-safe findings. Do not invent a second answer format.
7. If the Round is `needs_attention`, stop and link the developer to Doable for the required defer/waive decision. Otherwise run `finalize-round --code <round-code> --mode auto`.
   - A suite without a TRD enters the existing create flow.
   - A suite with a TRD enters the existing follow-up flow.
   - The exact frozen Round revision is consumed once; retries must be idempotent.
8. Use Doable MCP to monitor the TRD. Present the resulting scope, flows, conflicts, and explicit unknowns for approval. Do not generate or execute cases before that approval.
9. After approval, use Doable MCP to generate or update cases, inspect coverage, and run the selected cases in the configured environment. Report case IDs, results, and any environment or fixture blocker. A code change alone is not proof of deployed behavior.

## Safety and boundaries

- `DOABLE_API_KEY` is the organization authority and must be configured in the agent environment, never pasted into chat or saved under `.doable/`.
- Source code, local paths, repository identities, commits, secrets, raw logs, private URLs, and real customer data remain local.
- Setup sends only the user-approved sanitized routing profile. Round answers send only product-level findings, observable anchors, exact human clarifications, and opaque evidence references.
- Do not mutate a feature environment merely to collect context. Test execution happens only through the selected Doable suite and its configured environment.
- A wrong-workspace signal is blocking: when routed repositories contain no material same-feature evidence, stop and ask the developer to open the correct workspace instead of submitting many unknowns.

## Completion

Report the selected or created suite, Round code when one was needed, TRD create/follow-up status, approval state, generated or reused case IDs, execution result, and any remaining blocker. Keep local evidence details private.
