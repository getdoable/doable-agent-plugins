# Multi-repo ownership and seam tracing

Use this guide only when a feature crosses independent Git repositories, ownership is unclear, or the mounted workspace is too large for one focused inspection.

## Local orientation pass

Before deep inspection, build a small local-only table:

| Repository | Feature role | Reachable surface | Inbound seam | Outbound seam | Confidence |
| --- | --- | --- | --- | --- | --- |

Use manifests, route registrations, public entry points, tests, and concise project documentation to establish likely ownership. Do not inventory every package. Mark uncertain ownership as unknown.

For one to three relevant repositories, keep discovery in the primary agent. Build this compact map first, then inspect only the files needed to close the named feature's actor/entry, outcome, validation/failure, fixture, environment, and seam dimensions. Do not launch one subagent per repository or capability; duplicated orientation usually costs more time and context than it saves.

If more than three repositories appear relevant, inspect them in separate focused passes. Use concurrent subagents only when the host truly runs them in parallel and each receives one isolated seam question with a fixed return format. Carry only the feature request, the local orientation table, and unresolved seam questions into each pass. The primary agent remains responsible for de-duplication, truth-plane reconciliation, privacy scrubbing, and the final artifact; do not ask the customer to coordinate multiple prompts.

Prefer evidence already used by several product claims. The normal review threshold is 24 unique repository files across the feature, not 24 evidence references: crossing it requires naming the unresolved readiness dimension that the next read will close.

## Select the connected feature graph

Start from the requested user-visible or external entry and follow only connected behavior:

1. entry surface and actor;
2. permission and tenant gate;
3. state mutation and persistence;
4. asynchronous job, event, webhook, or external provider when present;
5. observable success and failure results;
6. tests or contracts that establish the boundary.

Stop following a seam when the next component cannot change requested scope, reachability, behavior, or the test oracle. Keep unrelated sibling repositories out of `repositories[]`.

## Seam ledger

For every cross-repository boundary, keep a local ledger with:

- producer repository and consumer repository;
- direction: inbound or outbound relative to the inspected repository;
- domain concept crossing the seam;
- trigger or precondition;
- observable downstream effect;
- evidence IDs on both sides when available;
- status: connected, disputed, dangling, or unmounted.

A producer claim without a matching consumer is a dangling seam. Do not invent the missing owner. Record an unknown only when the missing owner or contract changes the TRD or test feasibility.

## Shareable interface split

- For a browser surface, public/client API, CLI contract, or third-party webhook, describe the black-box precondition, trigger, result, error behavior, and oracle.
- For an internal service-to-service seam, upload only the observable end-to-end effect. Do not upload repository names, internal routes, payload fields, queues, topics, symbols, or infrastructure topology.
- Keep repository provenance, commits, and locators in `doable-intake.json`; keep the richer ownership/orientation and seam-reconciliation ledger in temporary local notes only.

## Risk-first inspection

Prioritize only categories that exist for the feature:

1. authorization, tenant isolation, and enforcement beyond a hidden/disabled UI control;
2. destructive mutations, idempotency, concurrency, and persistence after refresh or revisit;
3. asynchronous transitions, retries, duplicate or out-of-order events, and silent failure;
4. external integration authentication, lifecycle, throttling, and degraded behavior;
5. sensitive-data visibility, retention, and error disclosure;
6. empty, partial, unavailable, and permission-denied states.

Express a suspected weakness as a behavior to verify, not an exploit recipe. Static code can establish an implementation risk; only tests, runtime observation, or explicit product documentation establish the visible outcome.
