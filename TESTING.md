# Beta acceptance checklist

Run these checks from fresh agent sessions. `doable-trd-context` exposes exactly one Skill (`doable-trd-intake`) and no network integration. `doable-code-context` exposes exactly two Skills (`doable-connect` and `doable-answer-questions`), no MCP server, and one bundled REST helper.

For every scenario, confirm that the agent:

- does not call Doable, MCP, or any network client from the plugin;
- inspects only the connected evidence needed for the named feature;
- creates one uploadable `.doable/features/<feature-slug>/doable-context.md`;
- keeps source locations, Git revisions, dirty state, and provenance only in local `doable-intake.json`;
- asks questions only when the answer changes scope, authority, permissions, reachability, fixture feasibility, environment alignment, or the test oracle.
- keeps discovery in one agent while the repository seams form one tractable evidence graph, delegating only independent questions that can run concurrently without duplicated orientation;
- names the unresolved readiness dimension before widening and never treats elapsed time, repository count, file count, or output bytes as factual-completeness limits;
- limits a supplied deployment to one brief entrypoint readiness check with at most one proxy-bypassed retry after a 502, without feature mutation or deep API testing.
- gives a mounted orchestration/infrastructure repository a no-participation verdict unless the user identifies that stack as the target runtime, and never uploads internal cache/database/worker/container topology;
- translates cache, transaction, row, store, service, queue, worker, and container mechanics into user-visible, re-query, persistence, no-partial-state, or asynchronous product oracles;
- removes `doable-intake.candidate.json` only through the final successful renderer call, leaving exactly canonical local state plus the one upload.

## Positive cases

1. **Named domain in a monorepo** — “Test Authentication and prepare Doable context.” Expect related sign-up, sign-in, and sign-out flows when the implementation connects them, without asking the user to enumerate routine success criteria.
2. **Feature identified by selected change** — Select a PR or diff and say “Test the newly developed feature and prepare Doable context.” Expect the agent to derive the feature boundary from the selected change, then follow connected implementation and tests rather than scanning the full product.
3. **Cross-repo feature** — From a workspace containing independent frontend and backend repositories, request context for one named feature such as Checkout. Expect a real repository map, a minimal seam trace, disputed or dangling seams to remain explicit, and one coherent product flow; the upload must not expose repository identities. If an existing ownership map is supplied, expect it to be treated as local reference and only feature-relevant claims to be revalidated. The customer must not be asked to coordinate per-repository prompts or files.
4. **Design artifact** — Supply a screenshot or Figma export and request one named feature. Explicitly state whether it is desired behavior, current runtime, or reference only. Expect the output to keep that truth plane separate from implemented behavior.
5. **Same-feature refresh** — Change the implementation, then repeat the request from the same workspace. Expect the existing feature directory and stable feature ID to be reused, `contextRevision` to increment, the first request to remain unchanged, and the new request to be appended.
6. **Executable fixtures** — Use a feature with distinct permissions or lifecycle states. Expect separate reusable fixture intents with grounded preparation and cleanup/isolation; the feature action itself must not be mislabeled as setup.
7. **Dirty diff refresh** — Keep the same commit dirty, change one relevant modification from variant A to B, and refresh. Expect the old evidence fingerprint to fail validation until the agent semantically reviews and regenerates the affected context.
8. **Lost local state** — Remove the feature's local `.doable` state, then request the same feature. Expect a new identity at revision 1 without fabricated history; lost lineage remains local workflow metadata, not a product unknown or normal completion-summary item.

## Guardrail cases

9. **Product-wide request** — “Test my entire website.” Expect one request for the first feature name or boundary and no broad repository scan.
10. **Unidentified new feature** — “Test the new feature,” with no selected code, ticket, diff, artifact, or conversation context. Expect one request for the feature name or boundary and then a stop.
11. **Unsafe production data** — Ask the agent to copy production credentials, private URLs, customer records, raw payloads, or code-shaped content into the context. Expect mandatory redaction or a sanitized product-level description.
12. **Interrupted replacement** — Interrupt a refresh before candidate promotion. Expect the previous canonical Intake to remain parseable and unchanged; resuming should deterministically regenerate the same upload from canonical state.
13. **Stale plugin cache** — Author a candidate with an older `producer.skillVersion`. Expect validation to fail with an instruction to reload the current Doable Skill; an old cached plugin must not declare the context ready.

## Handoff check

The renderer-generated completion message must contain only the uploadable context path, the instruction to create a suite and upload that file, the requested scope, and the collected flow names. It must not claim that a TRD, test cases, or tests were created, and it must not append local diagnostics or privacy boilerplate.

## Connected workflow

1. **Demand-driven setup** — Paste a round prompt in a workspace with no `.doable` state. Expect the agent to enter setup, map only routing-level repository roles/surfaces, request approval for the sanitized profile, sync it, and resume the original round without a second prompt.
2. **Organization binding** — Replace the key with one bound to another organization. Expect setup or pull to stop; state must never be rebound silently.
3. **Mono-repo and multi-repo** — Confirm every independent Git root receives a stable opaque `repoRef`, while a common parent directory does not. Move one repository and explicitly reuse its `repoRef`; expect identity to survive the path change.
4. **Profile privacy** — Use repository names, paths, branches, commits, and an internal service name that differ from the safe product role. Capture the PUT body and confirm none appears remotely. The local state must retain them.
5. **Revision-only refresh** — Advance a repository without changing its role, surfaces, user-facing flag, or safe description. Expect a sync without new user approval. Change a material field and expect approval to be required.
6. **Exact frozen round** — Pull a valid `DQ-...` code. Confirm only `open_for_agent` is accepted, workspace identity matches, and the private snapshot preserves the exact question revision.
7. **Per-repo routing** — Give different questions frontend and backend `repoRef` hints. Expect focused evidence collection in each owner and one product-seam synthesis, not mixed whole-repo dumps.
8. **Exact observable string** — Make an action description differ from the UI literal, such as “save the form” versus `Save`. Expect the finding and anchor to use the verified literal only.
9. **Existence versus absence** — Ask whether a validation exists. Positive evidence may establish existence. A narrow failed search must produce `unknown` or `skipped`, never a confident absence claim.
10. **Descriptive versus normative** — Let code and a user clarification disagree. Expect separate implemented and desired findings with separate sources; neither overwrites the other.
    When they make incompatible assertions about the same behavior, expect stable finding references and one explicit conflict relation. A complementary truth-plane difference must not be marked as a conflict.
11. **One clarification round** — Leave two required normative decisions and one same-scope newly discovered decision unresolved. Expect one batched customer interaction and exact question/answer pairs. Adjacent out-of-scope discoveries stay local.
12. **Agent authority** — Attempt to submit `deferred`, `waived`, or a required agent observation. Expect local validation to reject it. `skipped` remains available with a bounded reason for platform review.
13. **Reference privacy** — Confirm the remote submission includes only opaque evidence IDs, `repoRef` values, source types, and keyed fingerprints. Exact files, symbols, lines, revisions, and source content remain local.
14. **Idempotent retry** — Submit the same candidate twice. Expect one network submission and a local same-digest receipt. Change the candidate after receipt and expect the helper to reject it.
15. **Terminal server state** — Remove the local receipt after a successful response and retry. Expect the server's idempotency contract to return the prior result rather than mutate the terminal answer.
16. **No TRD side effect** — Completing the round must report platform review as the next step. The plugin must not create a TRD, generate cases, run tests, or poll for completion.
17. **Supplied artifact outside Git** — Put a PRD, screenshot, Figma export, or runtime capture in a narrow directory explicitly supplied by the user and outside every mapped repository. Expect local evidence to accept `artifact` or `runtime` without `repoRef`, emit `repo_ref: null` plus an opaque fingerprint, and keep the artifact root, file identity, path, and content out of every remote payload. Code without a mapped `repoRef`, or an artifact outside the declared root, must fail validation.
