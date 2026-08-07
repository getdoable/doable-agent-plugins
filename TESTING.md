# Beta acceptance checklist

Run these checks from a fresh agent session after installing the plugin. The package should expose exactly one Skill (`doable-trd-intake`) and no MCP server.

For every scenario, confirm that the agent:

- does not call Doable, MCP, or any network client from the plugin;
- inspects only the connected evidence needed for the named feature;
- creates one uploadable `.doable/features/<feature-slug>/doable-context.md`;
- keeps source locations, Git revisions, dirty state, and provenance only in local `doable-intake.json`;
- asks questions only when the answer changes scope, authority, permissions, reachability, fixture feasibility, environment alignment, or the test oracle.

## Positive cases

1. **Named domain in a monorepo** — “Test Authentication and prepare Doable context.” Expect related sign-up, sign-in, and sign-out flows when the implementation connects them, without asking the user to enumerate routine success criteria.
2. **Feature identified by selected change** — Select a PR or diff and say “Test the newly developed feature and prepare Doable context.” Expect the agent to derive the feature boundary from the selected change, then follow connected implementation and tests rather than scanning the full product.
3. **Cross-repo feature** — From a workspace containing independent frontend and backend repositories, request context for one named feature such as Checkout. Expect a real repository map, a minimal seam trace, and one coherent product flow; the upload must not expose repository identities.
4. **Design artifact** — Supply a screenshot or Figma export and request one named feature. Explicitly state whether it is desired behavior, current runtime, or reference only. Expect the output to keep that truth plane separate from implemented behavior.
5. **Same-feature refresh** — Change the implementation, then repeat the request from the same workspace. Expect the existing feature directory and stable feature ID to be reused, `contextRevision` to increment, the first request to remain unchanged, and the new request to be appended.
6. **Executable fixtures** — Use a feature with distinct permissions or lifecycle states. Expect separate reusable fixture intents with grounded preparation and cleanup/isolation; the feature action itself must not be mislabeled as setup.
7. **Dirty diff refresh** — Keep the same commit dirty, change one relevant modification from variant A to B, and refresh. Expect the old evidence fingerprint to fail validation until the agent semantically reviews and regenerates the affected context.
8. **Lost local state** — Remove the feature's local `.doable` state, then request the same feature. Expect a new identity at revision 1 without fabricated history; lost lineage appears only in the completion response, not as a product unknown.

## Guardrail cases

9. **Product-wide request** — “Test my entire website.” Expect one request for the first feature name or boundary and no broad repository scan.
10. **Unidentified new feature** — “Test the new feature,” with no selected code, ticket, diff, artifact, or conversation context. Expect one request for the feature name or boundary and then a stop.
11. **Unsafe production data** — Ask the agent to copy production credentials, private URLs, customer records, raw payloads, or code-shaped content into the context. Expect mandatory redaction or a sanitized product-level description.
12. **Interrupted replacement** — Interrupt a refresh before candidate promotion. Expect the previous canonical Intake to remain parseable and unchanged; resuming should deterministically regenerate the same upload from canonical state.

## Handoff check

The completion message should show the feature name, revision, short scope, bounded nonmaterial unknowns, and only the uploadable context path. It should tell the user to create a suite in Doable and upload that one file. It must not claim that a TRD, test cases, or tests were created.
