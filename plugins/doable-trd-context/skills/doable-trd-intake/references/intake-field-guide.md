# TRD context field guide

The Intake is deliberately smaller than a TRD. It gives the existing TRD extraction pipeline clean user authority and grounded product facts instead of pre-authoring the final document. Render one uploadable `doable-context.md` from the local canonical `doable-intake.json`; never author separate query and evidence files.

## Sections

- [Feature query](#feature-query-user-authority-only)
- [Named-feature gate](#named-feature-gate)
- [Feature identity and refresh](#feature-identity-and-refresh)
- [Truth planes](#truth-planes)
- [Repositories and evidence](#repository-boundaries)
- [Actors, fixtures, environment, and flows](#actors-and-preconditions)
- [Unknowns and conflicts](#unknowns-and-conflicts)
- [Rendered document](#rendered-document)

## Feature query: user authority only

- `originalRequest`: exact user feature request, copied without normalization except mandatory secret redaction.
- `subsequentRequests`: later same-feature requests, preserved verbatim and in order. Keep the original request stable; do not turn an update into a clarification that was never asked.
- `confirmedClarifications`: ordered pairs of `questionContext` and `answer`. Preserve the exact question shown to the user and the user's exact answer except for mandatory secret redaction. The question disambiguates short answers but is not itself user authority. Do not include repository findings inside the answer.
- `name`: short noun phrase for the feature.
- `requestedScope`: one concise sentence describing what the user wants tested.
- `explicitInScope`: only boundaries the user explicitly requested or confirmed.
- `explicitOutOfScope`: only explicit exclusions.
- `successCriteria`: observable feature outcomes confirmed by the user. Do not place meta-goals such as “prepare enough context” or “create a TRD” here; leave it empty when the user did not state a product outcome.
- `testConstraints`: source priority, environment, data, safety, or anti-inference constraints from the user.

The structured query is a local audit projection. Every clause must be entailed by `originalRequest`, an ordered `subsequentRequests` item, or the answer in a `confirmedClarification`; otherwise remove it. Runtime restrictions given to the Coding Agent are workflow controls, not feature testing constraints. Render the original request, later requests, and labeled question/answer pairs in the **User Authority** section so answers such as “all” and “no” cannot lose their referent.

## Named-feature gate

Resolve one named feature or suite domain before repository or diff inspection:

- proceed directly for an explicit feature or domain such as `Authentication`, `Discounts`, `Checkout`, or `Webhook Retries`;
- resolve “test the newly developed feature” from already available conversation, active selection, ticket or PR metadata, or supplied artifacts, without scanning the repository to invent a name;
- if that context still does not identify the feature, ask only for the feature name or boundary and stop;
- for a product-wide request, ask the user to choose the first feature rather than building a product coverage map.

A named domain may contain several connected capabilities and flows. `Authentication` may include sign-up, sign-in, and sign-out; `Discounts` may include vouchers, promotions, and manual discounts. Do not impose a candidate, actor, capability, or flow count merely to make the scope smaller. Split only independent product purposes that do not form one understandable testing domain.

Trace downstream consumers only far enough to understand the named feature's success semantics. Record the receiving boundary as an interface and the externally meaningful result as an observable effect, state, or rule. Do not automatically turn an adjacent product or consumer into an executable flow. Add that downstream flow only when the user explicitly includes it in scope or executing it is necessary to verify the named feature's core success oracle.

After the gate, anchor each flow with an actor, goal, reachable entry, and observable outcome. Inspect only evidence that establishes a requested flow, prerequisite, state transition, outcome, material failure, or explicit boundary.

## Feature identity and refresh

Before creating a feature directory, inspect existing `.doable/features/*/doable-intake.json` records. A unique same-feature match keeps its `featureId` and `originalRequest`, appends the new request to `subsequentRequests`, updates the same `doable-context.md` and `doable-intake.json`, and increments `contextRevision`. Verbatim preservation is subject only to mandatory privacy redaction. Several plausible matches require one concise distinction; no match creates a new feature directory.

Refresh only claims and flows affected by changed intent, relevant code or tests, supplemental artifacts, fixtures, environment conditions, or deployment. Use the previous canonical JSON as the base but author changes in a separate candidate file, preserving the last valid canonical until the renderer's atomic replacement succeeds. Preserve unaffected objects and ordered list entries exactly. A later request that emphasizes behavior already in scope adds authority; it does not authorize narrowing descriptions, deleting variants, replacing setup with the operation under test, or dropping cleanup. Review the old/new semantic diff before rendering. When local canonical state is absent, rebuild from current sources with a new identity at revision 1 and report the lost lineage only in the completion response. Do not model local feature IDs, revision history, or recovery status as a product unknown or include them in the upload.

If the user explicitly describes a planned or desired behavior that is absent from or contradicted by current implementation, keep that behavior in the verbatim query. Preserve desired and current claims as separately sourced evidence and add a conflict. Block authoring only when the user has not established which behavior is authoritative for the TRD; a known implementation gap is not itself an unknown.

## Truth planes

Classify each material claim by the question its source can answer:

- **Desired**: what the product should do, grounded in the user request or an artifact the user makes normative;
- **Implemented**: what the inspected source revision implements, grounded in code, tests, schemas, configuration, or migrations;
- **Deployed**: what the target environment currently does, grounded in runtime and deployment evidence;
- **Reference**: sourced context that aids interpretation but is not normative or verified current behavior;
- **Inference**: the Coding Agent's bounded conclusion from sourced facts; it never overrides a sourced plane.

Consistent implementation, tests, state transitions, and runtime behavior may establish an implementation-derived current contract when no detailed product specification exists. Keep it labeled as current behavior rather than user-confirmed intent. Inference never overrides sourced claims.

## Repository boundaries

Model version-control boundaries, not folders or packages:

- a monorepo has one `repositories[]` entry and one revision even when several packages participate;
- a multi-repo workspace has one entry per independent repository actually inspected;
- a design/document/runtime-only planned feature may have an empty `repositories[]`; never fabricate a repository just to satisfy provenance;
- never collapse sibling repositories into their non-Git parent directory;
- use `vcs.type=git` with the exact commit and dirty boolean for Git repositories;
- use `vcs.type=unversioned` only when the inspected source directory has no version-control identity.

Give each repository a stable artifact-local ID such as `REPO_WEB` or `REPO_TRD`. The ID is provenance, not feature scope. Assign every repository evidence item to exactly one `repositoryId`; a flow, rule, or interface can cite several evidence IDs to ground behavior across repository boundaries. Keep unrelated sibling repositories out of the intake.

Each contributing repository keeps a local `evidenceContentHash` over the unique files used as evidence. The renderer populates it with `--update-fingerprints`. Before changing an existing Intake, validate without that flag so a different dirty diff or relevant-file change cannot hide behind the same commit and `dirty` boolean. Every supplemental source keeps a local `freshnessMarker`, such as an artifact content hash, design version, preview build, or deployment observation marker.

## Evidence: local audit only

Each local evidence item contains:

- a unique ID;
- the declared `repositoryId` that owns the source location;
- `implementation`, `test`, `schema`, `route`, `migration`, `configuration`, `documentation`, or `runtime_observation` kind;
- exactly one truth plane: `desired`, `implemented`, `deployed`, `reference`, or `inference`;
- a concise behavioral proposition;
- a path relative to that repository root, narrow line range, and optional symbol.

Do not quote code. Prefer 3–20-line local anchors and never exceed 80. Use multiple anchors when a claim crosses UI, API, and persistence boundaries. Evidence IDs and locators stay in `doable-intake.json`; render only privacy-safe product behavior in `doable-context.md`.

Start from a compact feature map and retrieve incrementally. A normal target is 12 unique repository files for the first capability and about 3 more per additional capability; 24 unique files triggers a redundancy review but never licenses dropping a material behavior. Count unique locator files, not evidence references, and reuse high-signal files across claims. Prefer one entry/navigation surface, one shared contract or state model, one representative orchestration or validation path, and one relevant test before widening to equivalent components or fields.

## Supplemental sources

Model Figma frames, screenshots, design documents, tickets, and runtime captures separately from repositories:

- `desired_behavior`: use only when the original request or a paired clarification answer explicitly makes the artifact normative. Set `authorityBasis` to that exact user-authority source.
- `current_runtime`: use for a capture of the running environment. Its evidence must use the `deployed` truth plane.
- `reference_context`: use when the artifact may aid interpretation but the user has not made it desired behavior.

Each supplemental evidence item uses `supplementalSourceId` plus a stable local `sourceAnchor` such as a frame name, image region, page, or timestamp. Keep the path, private URL, filename, source anchor, and source metadata in `doable-intake.json`; render only the behavioral summary. Do not use a Figma frame to claim current implementation and do not use a runtime screenshot to rewrite desired intent.

## Actors and preconditions

Create an actor only when role or account differences materially affect a requested flow's reachability, permissions, or result. Prefer one executable test actor. Keep adjacent visitor, moderator, or administrator behavior as a rule or unknown unless the user requested that branch. Preconditions describe the state or data required before a flow starts. Ground both with evidence.

## Test data and preparation

Use `testData[]` to express the state intent needed to execute a flow, not a concrete generated fixture matrix. Examples include a staff account with one named permission, one channel with a configured currency, or one existing record in a particular status.

Add `preparation` whenever the inspected inputs ground a real path to that state:

- `chained`: a product flow can create the state and may later be incorporated into a test;
- `externalized`: CLI, seed data, infrastructure, a third-party system, or human setup creates the state outside the feature flow.

If the target must already contain the state, use an `externalized` preparation that tells the downstream planner how to select and verify it. If no preparation path is grounded, add a bounded unknown related to the test-data item; do not leave both preparation and the missing-path explanation absent.

Preparation steps must be substantive enough for a downstream fixture planner to act on: they create, select, or verify prerequisite state and do not merely repeat the feature action being tested. For a feature domain with several capabilities, do not use one omnibus “sample data” fixture: split independent role/permission, eligibility, lifecycle, transaction, and cleanup states, while reusing prerequisites that are genuinely shared. Include cleanup steps when unique data, destructive changes, or shared environments require isolation, and preserve those steps across unrelated refreshes. Never include passwords, tokens, raw environment values, or invented fixture counts.

## Environment and readiness

Use `environment[]` only for conditions that change reachability, behavior, or the oracle: required services, feature flags, seeded deployment state, or whether the deployed build contains the inspected behavior. Write an observable `readinessCheck` rather than a secret or configuration value.

Do not ask for an entry URL, organization, suite, API key, or MCP configuration in this context-only stage. If the user has not supplied a runtime, static repository evidence can still support TRD authoring; mark deployment alignment non-blocking unless a version mismatch prevents choosing the expected behavior. When code, design, and the actual deployed environment differ, preserve all three claims and ask only for the acceptance or deployment decision that affects the test oracle.

When a deployment is supplied, runtime work is a bounded readiness check rather than feature testing. Read the runtime README or status first, then check the relevant Dashboard or API entrypoint once within 60–90 seconds. Reachability establishes only an environment fact. Do not create or mutate feature data or deep-probe APIs. After a 502, inspect local proxy configuration and make at most one proxy-bypassed retry; if it still fails, keep one nonblocking environment unknown and continue from repository evidence.

## Flows

Create one flow per independently testable user goal or major mode. Use `parentFlowId` and `parentRelation` only for a real alternative or continuation.

Group flows under `capabilities[]`. Every flow has one `capabilityId`; every declared capability has at least one flow. A named feature domain can therefore stay one Intake while preserving distinct capabilities such as sign-up, sign-in, and sign-out.

Each flow should expose:

- actor and entry point;
- required preconditions;
- ordered operations;
- variants or failure behavior as their own flows when independently testable;
- evidence for the goal and reachability.

Do not turn helper controls, static policy copy, internal functions, or adjacent features into standalone flows.

Executable flows, operations, and observable states require `desired`, `implemented`, or `deployed` evidence. Reference material and Agent inference may explain a rule or interface or motivate a bounded unknown/conflict, but they cannot by themselves establish an executable path or acceptance oracle.

An adjacent consumer that merely demonstrates an effect remains an interface plus observable state or rule. Promote it to an executable flow only under the named-feature downstream boundary above.

## Operations and states

An operation is one ordered segment of executable behavior:

- `entry`: how the surface or operation becomes reachable;
- `inputs`: atomic user/system inputs, each with a verb;
- `actions`: atomic executable actions, each with a verb;
- `states`: observable or externally meaningful state around the operation;
- `notes`: stable details such as allowed values or timing constraints.

Use state roles deliberately:

- `initial`: before the operation;
- `intermediate`: immediately after an input/action or while work is pending;
- `terminal`: the successful end state;
- `error`: rejection or failure state.

For mutations, distinguish the immediate in-place result from later controls such as refresh, navigation away/back, or a new session. This prevents a persisted write from masking stale client state.

Static implementation can establish mutation calls, cache operations, and persistence mechanics. It does not by itself establish the visible runtime result of a missing update. Represent a suspected stale or divergent visible result as an unknown/conflict until a repository test, product documentation, or runtime observation establishes it.

## Rules and interfaces

Use rules for permissions, validation, business policy, persistence, data, integration, and testability constraints. Link a rule to the flows/operations it qualifies.

Use interfaces for user-visible surfaces, routes, HTTP APIs, events, jobs, storage, flags, and external services that form a test boundary. Summarize the behavioral contract; do not copy payloads or implementation syntax.

## Unknowns and conflicts

An unknown contains one answerable question, its impact, a resolution goal, related item IDs, and whether it blocks safe authoring. Examples include a runtime-only affordance, unspecified permission, unavailable test data, or code path whose visible result is not established.

Use an unknown only when its answer would change scope, expected behavior, reachability, permissions, a visible test oracle, or whether the flow can feasibly be tested. Do not use unknowns as a dump of everything static inspection did not prove. In particular:

- choose a safe representative attachment or fixture and record it as a test-data note unless repository constraints make the choice material;
- omit exact toast copy unless copy is part of the requested acceptance oracle;
- omit alternate entry mechanisms when another grounded requested entry is sufficient;
- omit incidental sorting, timestamp, and metadata effects outside the requested outcome;
- when the user declines to specify extra success criteria, preserve no extra criteria rather than creating an unknown.

It is valid and often preferable for `unknowns` to be empty.

`blocking=true` means authoring cannot proceed faithfully, not merely that static inspection lacks a runtime fact. If the requested test can observe the answer directly—such as immediate UI state followed by refresh/revisit control—keep the unknown non-blocking and encode the observation in the flow. Block only when the missing answer prevents choosing the scope, actor, entry, expected outcome, required data, or safe execution path.

A conflict requires at least two separately grounded claims. Preserve both sides; do not select a winner without authority.

Do not create assumptions merely to make the artifact look complete. A bounded gap is more useful to the TRD loop than an unsupported answer.

## Rendered document

Render one physical `doable-context.md` with two strictly labeled sections:

1. **User Authority**: the original request and exact clarification question/answer pairs;
2. **Grounded Context**: sanitized scope, capabilities, actors, preconditions, flows, states, observable outcomes, rules, fixtures, interfaces, environment alignment, conflicts, and bounded unknowns.

Generate it deterministically from `doable-intake.json`. The user uploads only `doable-context.md` after optionally reviewing it for corrections.
