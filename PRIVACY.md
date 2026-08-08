# Privacy and data handling

Repository inspection happens inside the coding agent selected by the customer and remains subject to that agent provider's data-handling terms. Neither Doable plugin grants Doable repository access.

## Doable TRD Context

`doable-trd-context` is a local, context-only workflow. Its bundled code does not authenticate to Doable, call a Doable API or MCP server, upload files, or make network requests.

It writes:

- `.doable/features/<feature-slug>/doable-context.md`, a privacy-scrubbed product-behavior document the user may upload;
- `.doable/features/<feature-slug>/doable-intake.json`, a local provenance record that must not be uploaded.

## Doable Code Context

`doable-code-context` connects only to the configured Doable REST API. The API key is read from `DOABLE_API_KEY` at request time, used as a Bearer credential, and never written to disk or included in a generated payload.

Its local `.doable/workspace-candidate.json`, `.doable/workspace-private.json`, and `.doable/requests/` records may contain real repository identities, explicitly user-supplied artifact roots, local paths, Git provenance, exact evidence locators, and frozen Doable questions. They are written with private permissions and ignored by Git. Artifact roots are never serialized into the remote workspace profile.

The helper validates every outbound workspace profile and answer payload. Doable may receive only:

- opaque workspace, repository, evidence, round, and question identifiers;
- a sanitized workspace display name, product roles, surfaces, descriptions, feature scope, and externally observable findings;
- truth planes, source types, observable anchors, exact user-authorized clarifications, explicit finding-to-finding conflicts, explicit unknowns, and nonblocking same-scope observations;
- keyed fingerprints that cannot be reversed into a branch, commit, local path, or source span.

Code evidence is always bound to an opaque repository reference and kept inside its mapped repository. A user-supplied PRD, screenshot, Figma export, or runtime capture outside Git is accepted only from an explicitly declared private artifact root; its remote evidence reference uses `repo_ref: null`, while its root, file name, path, and content remain local.

The first profile upload and material role/surface/description changes require user approval. A specific round copy prompt authorizes pulling that frozen round and submitting its validated answers; idempotent retries do not create additional submissions.

## Excluded data

Neither upload path may contain source code or snippets, real repository or file identities, branches or commits, secrets or environment values, raw logs or attachments, private URLs, internal infrastructure topology, or real customer/business data.

See the [Doable Privacy Policy](https://qa.getdoable.ai/privacy-policy) for platform data handling. Questions may be sent to support@getdoable.ai.
