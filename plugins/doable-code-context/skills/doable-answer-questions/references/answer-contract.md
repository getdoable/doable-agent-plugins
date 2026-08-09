# Private answer candidate contract

`pull-round` creates the candidate for the frozen request. Preserve its round identity and question IDs. Fill only `answers`, `agentObservations`, `conflicts`, and `evidence`.

```json
{
  "schemaVersion": "1",
  "round": {
    "id": "server round id",
    "code": "DQ-7F3K",
    "revision": 1,
    "workspaceId": "server workspace id"
  },
  "answers": [
    {
      "questionId": "question id",
      "status": "answered",
      "findings": [
        {
          "findingRef": "f_savecode01",
          "statement": "The creation form shows a button labeled ‘Save’.",
          "truthPlane": "implemented_behavior",
          "sourceType": "code",
          "observableAnchors": ["Save"],
          "evidenceRefIds": ["ev_savelabel"]
        },
        {
          "findingRef": "f_savedesire01",
          "statement": "The submit control should be labeled ‘Create promotion’.",
          "truthPlane": "desired_behavior",
          "sourceType": "human_clarification",
          "observableAnchors": ["Create promotion"],
          "evidenceRefIds": []
        }
      ],
      "humanClarifications": [
        {
          "question": "What should the creation submit control be labeled?",
          "answer": "The submit control should be labeled ‘Create promotion’."
        }
      ]
    }
  ],
  "agentObservations": [],
  "conflicts": [
    {
      "leftFindingRef": "f_savecode01",
      "rightFindingRef": "f_savedesire01",
      "description": "The implemented label is ‘Save’, while the approved product label is ‘Create promotion’."
    }
  ],
  "evidence": [
    {
      "id": "ev_savelabel",
      "repoRef": "repo_opaque_id",
      "kind": "code",
      "path": "/local/path/kept-private",
      "symbol": "local symbol kept private",
      "startLine": 10,
      "endLine": 12,
      "revision": "local revision kept private"
    },
    {
      "id": "ev_designstate",
      "kind": "artifact",
      "path": "/local/supplied-artifact-root/design-export.png"
    }
  ]
}
```

## Answer fields

- `status`: `answered` or `skipped`. A skipped answer has `unknownReason` and no fabricated finding.
- `findingRef`: optional stable `f_...` identifier. The helper derives one when omitted. Set it explicitly for every finding named by a conflict; values must be unique across the full submission.
- `truthPlane`: `implemented_behavior`, `desired_behavior`, `artifact_observation`, `inference`, or `unknown`.
- `sourceType`: `code`, `human_clarification`, `artifact`, `runtime`, or `inference`.
- `statement`: one independently citable product proposition or one causally coherent state transition. Split unrelated lifecycle operations, validation families, outcomes, roles, and fixture facts. A statement that lists more than two independent operations or joins independent actions without one shared observable result is invalid; summary findings have no exception.
- Before submitting an executable transition, establish its entry or trigger, action or required input, and observable result. A capability inventory may route further inspection, but it is not itself an executable flow. If one of those elements remains material and unproven, narrow the confirmed finding and preserve the missing proposition as `unknown` instead of inventing a generic action or outcome.
- Include a remote finding only when it changes test scope, fixture/setup data, an observable oracle, or a material environment boundary. Internal model fields, event taxonomies, webhook payloads, generated clients, and implementation helpers stay in the private ledger. A user-reachable operation that changes persistent state, or a configuration dimension that changes validation, fixtures, or outcomes, is not an internal inventory item: evaluate it on its merits and submit it as an atomic finding when it passes the selection gate. Delete executable-operation findings that still lack a grounded result or state change.
- Represent inspected code as `implemented_behavior`; represent an observed runtime as `artifact_observation` with `sourceType: runtime`. Runtime reachability alone is not feature behavior.
- Do not encode test strategy as implemented product behavior. Keep factual preconditions separate from derived fixture naming, isolation, or cleanup advice; use `inference` for a material evidence-backed recommendation or keep it local.
- `observableAnchors`: exact user-visible labels, messages, routes, states, protocol values, external API names, or product entities that directly support the finding's complete statement. The first anchor must be independently quotable: an exact rendered UI string, user-visible route, returned protocol value, or externally exposed API operation for an API-scoped behavior. Never use an internal storage field, function, class, module, or handler name. When source uses a different internal spelling, translate it only through UI or external-schema evidence; otherwise drop the anchor. If no one anchor can represent the statement without becoming misleading, narrow or split the finding. Do not attach a nearby label merely because it appears in the same question or source. An `unknown` or `inference` finding may leave this empty when no exact observable anchor is established.
- `evidenceRefIds`: IDs from the local evidence ledger. Do not put paths or symbols here.
- `sourceFingerprint` is generated by the helper from the private evidence locator or exact matching clarification. Do not author or upload a local fingerprint field yourself.
- `humanClarifications`: exact `{ "question": "...", "answer": "..." }` pairs. Preserve the user's wording except mandatory secret or personal-data redaction.
- For a `human_clarification` finding, `statement` must exactly equal one submitted clarification answer. Put interpretation in a separate `inference` finding.

## Explicit conflicts

`conflicts` is an optional top-level submission array:

```json
{
  "leftFindingRef": "f_savecode01",
  "rightFindingRef": "f_savedesire01",
  "description": "The implemented label is ‘Save’, while the approved product label is ‘Create promotion’."
}
```

Both references must identify different findings anywhere in this frozen-round submission, so a contradiction may cross questions or nonblocking observations. Add a relation only when grounded code, human clarification, artifact, or runtime claims make incompatible assertions about the same product behavior. Do not infer a conflict merely because truth planes differ, and do not relate `inference` or `unknown` findings. The description must state the externally meaningful contradiction without local provenance.

## Nonblocking observations

An `agentObservation` has:

```json
{
  "question": "Should voucher codes remain reusable after the first redemption?",
  "why": "This changes the same-scope redemption oracle.",
  "findings": [
    {
      "statement": "No, single-use codes must reject a second redemption.",
      "truthPlane": "desired_behavior",
      "sourceType": "human_clarification",
      "observableAnchors": ["single-use", "second redemption"],
      "evidenceRefIds": []
    }
  ],
  "humanClarifications": [
    {
      "question": "Should a voucher code remain reusable after the first redemption?",
      "answer": "No, single-use codes must reject a second redemption."
    }
  ]
}
```

The helper always serializes observations as optional. Outside-scope discoveries do not belong in this file.

## Evidence rules

- Prefer a minimal progressive evidence graph: public entry or operation → owning handler/domain transition → exact observable outcome. Stop deepening once this chain and its material boundary are established, but perform one bounded directory-, route-, or schema-level sweep of sibling user-reachable lifecycle operations and configuration dimensions. Record an explicit include/exclude/ask-user decision locally for each; do not collect sibling call sites, tests, generated clients, translations, or internal helpers.
- Capture the smallest independently useful source span or artifact, not one item per finding. Do not impose a hard line limit when a larger factual span is required.
- Reuse evidence IDs across separate atomic findings when the same span supports them; never merge unrelated findings just to reduce evidence items.
- A positive existence claim needs direct evidence.
- An absence claim needs a deliberately broad search recorded in the local ledger. Otherwise submit an `unknown` finding or skip the answer.
- An `unknown` must be a material product, fixture, acceptance, permission, or target-environment proposition. Missing tests, build tooling, framework setup, internal persistence machinery, or other repository-completeness observations are not TRD context unless they leave a requested externally observable behavior materially unresolved.
- Keep exact local locators and revisions in `evidence`; the helper converts them to opaque remote references.
- `code` evidence always includes `repoRef` and must be inside that mapped repository.
- `artifact` or `runtime` evidence inside a repository may include `repoRef`. When a user-supplied PRD, screenshot, Figma export, or runtime capture is outside Git, omit `repoRef` and keep the file inside an explicit private `artifactRoot` from workspace setup. Text evidence may use a line span; binary evidence omits it and fingerprints the complete file. The remote evidence reference then contains `repo_ref: null`; the root, file name, path, lines, and content remain local.
- Never paste source text into any candidate field.

Commands:

```bash
node <plugin-directory>/scripts/doable-code-context.mjs pull-round \
  --code DQ-7F3K \
  --state .doable/workspace-private.json

node <plugin-directory>/scripts/doable-code-context.mjs validate-submission \
  --state .doable/workspace-private.json \
  --candidate .doable/requests/DQ-7F3K/submission-r1.json

node <plugin-directory>/scripts/doable-code-context.mjs submit \
  --state .doable/workspace-private.json \
  --candidate .doable/requests/DQ-7F3K/submission-r1.json
```
