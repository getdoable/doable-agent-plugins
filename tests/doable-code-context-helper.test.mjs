import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "plugins", "doable-code-context", "scripts", "doable-code-context.mjs");

function runHelper(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [helper, ...args], {
      cwd: env.TEST_WORKSPACE,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`helper exited ${code}: ${stderr}`));
    });
  });
}

test("connected helper preserves the local/private boundary and retries idempotently", async (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "doable-code-context-test-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  const repository = join(testRoot, "private-admin-repository");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  const sourcePath = join(repository, "form.js");
  writeFileSync(sourcePath, "export const label = 'Save';\nexport const cancel = 'Cancel';\n");
  execFileSync("git", ["-C", repository, "add", "form.js"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "fixture"]);
  const artifactRoot = join(testRoot, "supplied-product-artifacts");
  mkdirSync(artifactRoot);
  const artifactPath = join(artifactRoot, "promotion-requirements.md");
  writeFileSync(
    artifactPath,
    "A rejected date range must show a visible validation message.\n",
  );
  const screenshotPath = join(artifactRoot, "promotion-design.png");
  writeFileSync(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]));

  const serverWorkspaceId = "workspace-server-safe";
  const environment = { TEST_WORKSPACE: testRoot };
  const handshakePath = join(testRoot, "mcp-handshake.json");
  writeFileSync(
    handshakePath,
    JSON.stringify({
      organization: { id: "org-safe", display_name: "Example Org" },
      workspace: null,
    }),
  );

  const candidatePath = join(testRoot, "workspace-candidate.json");
  writeFileSync(
    candidatePath,
    JSON.stringify({
      workspaceLabel: "private local workspace",
      safeDisplayName: "Commerce administration",
      artifactRoots: [artifactRoot],
      repositories: [
        {
          path: repository,
          name: "private-admin-repository",
          productRole: "staff-console",
          surfaces: ["promotion-management"],
          userFacing: true,
          safeDescription: "Staff-facing management for promotion lifecycle and validation.",
        },
      ],
    }),
  );
  const statePath = join(testRoot, ".doable", "workspace-private.json");
  await runHelper(
    ["prepare-workspace", "--candidate", candidatePath, "--handshake", handshakePath, "--state", statePath, "--round-code", "DQ-7F3K"],
    environment,
  );
  let privateState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(privateState.repositories[0].path, realpathSync(repository));
  assert.equal(privateState.repositories[0].name, "private-admin-repository");
  assert.deepEqual(privateState.artifactRoots, [realpathSync(artifactRoot)]);
  assert.equal(statSync(candidatePath).mode & 0o777, 0o600);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.match(
    readFileSync(join(testRoot, ".doable", ".gitignore"), "utf8"),
    /^workspace-candidate\.json$/m,
  );

  await assert.rejects(
    runHelper(["record-round", "--code", "DQ-7F3K", "--response", handshakePath, "--state", statePath], environment),
    /awaiting workspace sync/i,
  );

  const profilePayloadPath = join(testRoot, ".doable", "workspace-profile.json");
  await assert.rejects(
    runHelper(["build-workspace-profile", "--state", statePath, "--output", profilePayloadPath], environment),
    /approved/i,
  );
  await runHelper(["build-workspace-profile", "--state", statePath, "--output", profilePayloadPath, "--approved"], environment);
  const profileEnvelope = JSON.parse(readFileSync(profilePayloadPath, "utf8"));
  const capturedProfile = profileEnvelope.profile;
  const serverClientWorkspaceId = profileEnvelope.workspace_ref;
  assert.equal(capturedProfile.client_workspace_id, serverClientWorkspaceId);
  assert.equal(capturedProfile.round_code, "DQ-7F3K");
  assert.equal(capturedProfile.material_change_approved, true);
  const profileResponsePath = join(testRoot, "mcp-profile-response.json");
  writeFileSync(
    profileResponsePath,
    JSON.stringify({
      workspace: { id: serverWorkspaceId, client_workspace_id: serverClientWorkspaceId },
    }),
  );
  await runHelper(
    ["record-workspace-sync", "--state", statePath, "--payload", profilePayloadPath, "--response", profileResponsePath],
    environment,
  );
  privateState = JSON.parse(readFileSync(statePath, "utf8"));
  privateState.workspace.localId = "93b35e98-0000-4000-8000-000000000001";
  writeFileSync(statePath, `${JSON.stringify(privateState, null, 2)}\n`);
  const remoteProfileText = JSON.stringify(capturedProfile);
  assert.doesNotMatch(remoteProfileText, /private-admin-repository/);
  assert.doesNotMatch(remoteProfileText, /supplied-product-artifacts|promotion-requirements\.md/);
  assert.doesNotMatch(remoteProfileText, new RegExp(repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(remoteProfileText.includes(privateState.repositories[0].revision), false);
  assert.equal(remoteProfileText.includes(privateState.repositories[0].branch), false);
  assert.match(capturedProfile.repositories[0].repo_ref, /^repo_[a-f0-9]{16}$/);
  assert.equal(capturedProfile.profile_revision, 1);
  assert.equal(capturedProfile.display_name, "Commerce administration");

  writeFileSync(sourcePath, "export const label = 'Save';\nexport const cancel = 'Cancel';\nexport const ready = true;\n");
  execFileSync("git", ["-C", repository, "add", "form.js"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "revision-only refresh"]);
  const refreshOutput = await runHelper(
    ["prepare-workspace", "--candidate", candidatePath, "--handshake", handshakePath, "--state", statePath, "--round-code", "DQ-7F3K"],
    environment,
  );
  assert.match(refreshOutput, /Material profile approval required: no/);
  privateState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(privateState.workspace.clientRef, serverClientWorkspaceId);
  await runHelper(["build-workspace-profile", "--state", statePath, "--output", profilePayloadPath], environment);
  const refreshEnvelope = JSON.parse(readFileSync(profilePayloadPath, "utf8"));
  assert.equal(refreshEnvelope.profile.round_code, "DQ-7F3K");
  assert.equal(refreshEnvelope.profile.material_change_approved, false);
  await runHelper(
    ["record-workspace-sync", "--state", statePath, "--payload", profilePayloadPath, "--response", profileResponsePath],
    environment,
  );
  privateState = JSON.parse(readFileSync(statePath, "utf8"));

  const roundResponsePath = join(testRoot, "mcp-round-response.json");
  writeFileSync(
    roundResponsePath,
    JSON.stringify({
      round_id: "round-safe",
      round_code: "DQ-7F3K",
      workspace_id: serverWorkspaceId,
      revision: 1,
      status: "open_for_agent",
      feature_scope: "Staff promotion creation",
      journey_map: { requested: true, how: "Declare one journey per leaf with nav_path, the same path as a list from area to leaf; order, its position within its parent.", may_skip: "" },
      questions: [
        {
          id: "question-save-label",
          purpose: "base_context",
          question: "What exact label submits the promotion creation form?",
          why: "",
          answer_requirements: "",
          required: true,
          scope_hints: {
            surfaces: ["promotion-management"],
            repo_refs: [privateState.repositories[0].repoRef],
          },
        },
      ],
    }),
  );
  const fullRoundOutput = await runHelper(
    ["record-round", "--code", "DQ-7F3K", "--response", roundResponsePath, "--state", statePath],
    environment,
  );
  // The investigation tier no longer changes behaviour, so it is not printed as guidance.
  assert.doesNotMatch(fullRoundOutput, /Investigation:/);
  assert.match(fullRoundOutput, /Journey map: requested/);
  // The server's journey-map instructions are part of the contract, so the Round file keeps them.
  const recordedRound = JSON.parse(
    readFileSync(join(testRoot, ".doable", "requests", "DQ-7F3K", "round-r1.json"), "utf8"),
  );
  assert.deepEqual(recordedRound.journeyMap, { requested: true, how: "Declare one journey per leaf with nav_path, the same path as a list from area to leaf; order, its position within its parent.", maySkip: "" });
  const submissionPath = join(testRoot, ".doable", "requests", "DQ-7F3K", "context-local-r1.json");
  const submission = JSON.parse(readFileSync(submissionPath, "utf8"));
  submission.answers[0] = {
    questionId: "question-save-label",
    status: "answered",
    findings: [
      {
        findingRef: "f_savecode01",
        statement: "The promotion creation form has a submit control labeled ‘Save’.",
        truthPlane: "implemented_behavior",
        sourceType: "code",
        observableAnchors: ["Save"],
        evidenceRefIds: ["ev_savelabel"],
      },
      {
        findingRef: "f_savedesire01",
        statement: "The submit control should be labeled ‘Create promotion’.",
        truthPlane: "desired_behavior",
        sourceType: "human_clarification",
        observableAnchors: ["Create promotion"],
        evidenceRefIds: [],
      },
    ],
    humanClarifications: [
      {
        question: "What should the promotion creation submit control be labeled?",
        answer: "The submit control should be labeled ‘Create promotion’.",
      },
    ],
  };
  submission.agentObservations = [
    {
      question: "What should happen when the supplied date range is invalid?",
      why: "The supplied product brief establishes a same-scope validation oracle.",
      findings: [
        {
          statement: "A rejected date range must show a visible validation message.",
          truthPlane: "artifact_observation",
          sourceType: "artifact",
          observableAnchors: ["visible validation message"],
          evidenceRefIds: ["ev_datebrief"],
        },
      ],
      humanClarifications: [],
    },
    {
      question: "Should a successful save remain on the creation view?",
      why: "This same-scope navigation outcome requires product authority.",
      findings: [
        {
          statement: "No, a successful save should open the promotion details view.",
          truthPlane: "desired_behavior",
          sourceType: "human_clarification",
          observableAnchors: ["promotion details view"],
          evidenceRefIds: [],
        },
      ],
      humanClarifications: [
        {
          question: "Should a successful save remain on the creation view?",
          answer: "No, a successful save should open the promotion details view.",
        },
      ],
    },
    {
      question: "Which validation state is shown in the supplied design image?",
      why: "The supplied design establishes a same-scope artifact observation.",
      findings: [
        {
          statement: "The supplied design image shows an inline invalid-date state.",
          truthPlane: "artifact_observation",
          sourceType: "artifact",
          observableAnchors: ["inline invalid-date state"],
          evidenceRefIds: ["ev_designshot"],
        },
      ],
      humanClarifications: [],
    },
  ];
  submission.conflicts = [
    {
      leftFindingRef: "f_savecode01",
      rightFindingRef: "f_savedesire01",
      description: "The implemented label is ‘Save’, while the approved product label is ‘Create promotion’.",
    },
  ];
  submission.evidence = [
    {
      id: "ev_savelabel",
      repoRef: privateState.repositories[0].repoRef,
      kind: "code",
      path: sourcePath,
      symbol: "label",
      startLine: 1,
      endLine: 1,
      revision: privateState.repositories[0].revision,
    },
    {
      id: "ev_datebrief",
      kind: "artifact",
      path: artifactPath,
      startLine: 1,
      endLine: 1,
    },
    {
      id: "ev_designshot",
      kind: "artifact",
      path: screenshotPath,
    },
  ];
  writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);
  chmodSync(submissionPath, 0o600);

  const orderedJourney = structuredClone(submission);
  Object.assign(orderedJourney.answers[0].findings[0], {
    journeyRef: "j_submit_promotion",
    step: 1,
    role: "action",
  });
  Object.assign(orderedJourney.agentObservations[0].findings[0], {
    journeyRef: "j_submit_promotion",
    step: 2,
    role: "failure",
  });
  writeFileSync(submissionPath, `${JSON.stringify(orderedJourney, null, 2)}\n`);
  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);

  const gappedJourney = structuredClone(orderedJourney);
  gappedJourney.agentObservations[0].findings[0].step = 3;
  writeFileSync(submissionPath, `${JSON.stringify(gappedJourney, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /steps must be consecutive/i,
  );

  const unknownJourney = structuredClone(orderedJourney);
  unknownJourney.answers[0].findings[0] = {
    statement: "Whether the submit action is available remains unknown.",
    truthPlane: "unknown",
    sourceType: "inference",
    observableAnchors: [],
    evidenceRefIds: [],
    journeyRef: "j_submit_promotion",
    step: 1,
    role: "action",
  };
  writeFileSync(submissionPath, `${JSON.stringify(unknownJourney, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /cannot carry executable order/i,
  );
  // A declaration names journeys the findings already ordered. It must not be able to
  // introduce one, or the journey map could assert structure no evidence supports.
  const declaredJourneys = structuredClone(orderedJourney);
  declaredJourneys.journeys = [
    {
      journeyRef: "j_submit_promotion",
      name: "Submit a promotion",
      goal: "Turn a drafted promotion into one buyers can redeem.",
      actor: "Store staff",
      alternatePaths: ["Submitting an expired date range is rejected"],
    },
  ];
  writeFileSync(submissionPath, `${JSON.stringify(declaredJourneys, null, 2)}\n`);
  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);

  // A declaration without navPath or order is sent exactly as before 0.2.15.
  const journeyPayloadPath = join(testRoot, "journey-payload.json");
  const buildJourneyPayload = async (candidate) => {
    writeFileSync(submissionPath, `${JSON.stringify(candidate, null, 2)}\n`);
    await runHelper(
      ["build-submission", "--state", statePath, "--candidate", submissionPath, "--output", journeyPayloadPath],
      environment,
    );
    return JSON.parse(readFileSync(journeyPayloadPath, "utf8")).submission;
  };
  const olderStylePayload = await buildJourneyPayload(declaredJourneys);
  assert.deepEqual(olderStylePayload.journeys, [
    {
      journey_ref: "j_submit_promotion",
      name: "Submit a promotion",
      goal: "Turn a drafted promotion into one buyers can redeem.",
      actor: "Store staff",
      alternate_paths: ["Submitting an expired date range is rejected"],
    },
  ]);

  // A leaf journey carries its navigation path and its position within its parent.
  const navJourney = structuredClone(declaredJourneys);
  navJourney.journeys[0].name = "Promotions › Create › Submit";
  navJourney.journeys[0].navPath = ["Promotions", " Create ", "Submit"];
  navJourney.journeys[0].order = 2;
  writeFileSync(submissionPath, `${JSON.stringify(navJourney, null, 2)}\n`);
  const navOutput = await runHelper(
    ["validate-submission", "--state", statePath, "--candidate", submissionPath],
    environment,
  );
  assert.doesNotMatch(navOutput, /Warning:|not sent/);
  const navPayload = await buildJourneyPayload(navJourney);
  assert.deepEqual(navPayload.journeys[0].nav_path, ["Promotions", "Create", "Submit"]);
  assert.equal(navPayload.journeys[0].order, 2);
  assert.equal(navPayload.journeys[0].navPath, undefined);
  assert.deepEqual(
    { ...navPayload, journeys: undefined },
    { ...olderStylePayload, journeys: undefined },
  );

  // A name that does not end with the leaf is allowed (older helpers only carry the
  // name) but called out, since the name is meant to be the joined path.
  const mismatchedName = structuredClone(navJourney);
  mismatchedName.journeys[0].name = "Submit a promotion";
  mismatchedName.journeys[0].navPath = ["Promotions", "Create"];
  writeFileSync(submissionPath, `${JSON.stringify(mismatchedName, null, 2)}\n`);
  const mismatchOutput = await runHelper(
    ["validate-submission", "--state", statePath, "--candidate", submissionPath],
    environment,
  );
  assert.match(mismatchOutput, /Warning: journeys\[0\]\.name does not end with its navPath leaf "Create"/);

  // A server that predates nav_path/order rejects a journey carrying them, so the helper
  // sends them only when the Round's journey-map instructions ask for them.
  const legacyMapRoundPath = join(testRoot, "mcp-round-legacy-map-response.json");
  writeFileSync(
    legacyMapRoundPath,
    JSON.stringify({
      ...JSON.parse(readFileSync(roundResponsePath, "utf8")),
      journey_map: { requested: true, how: "Order the findings, then declare each journey once.", may_skip: "" },
    }),
  );
  await runHelper(["record-round", "--code", "DQ-7F3K", "--response", legacyMapRoundPath, "--state", statePath], environment);
  writeFileSync(submissionPath, `${JSON.stringify(navJourney, null, 2)}\n`);
  const legacyMapOutput = await runHelper(
    ["validate-submission", "--state", statePath, "--candidate", submissionPath],
    environment,
  );
  assert.match(legacyMapOutput, /^Journey navPath\/order not sent: this Doable server does not ask for them$/m);
  const legacyMapPayload = await buildJourneyPayload(navJourney);
  assert.equal(legacyMapPayload.journeys[0].nav_path, undefined);
  assert.equal(legacyMapPayload.journeys[0].order, undefined);
  // Only the two fields are dropped; the name, and everything else, is sent unchanged.
  assert.deepEqual(legacyMapPayload, {
    ...olderStylePayload,
    journeys: [{ ...olderStylePayload.journeys[0], name: "Promotions › Create › Submit" }],
  });
  // The fields are still validated locally, so the candidate stays well-formed.
  const legacyInvalid = structuredClone(navJourney);
  legacyInvalid.journeys[0].order = 0;
  writeFileSync(submissionPath, `${JSON.stringify(legacyInvalid, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /journeys\[0\]\.order must be a positive integer/,
  );
  // A candidate without them prints no drop notice.
  writeFileSync(submissionPath, `${JSON.stringify(declaredJourneys, null, 2)}\n`);
  assert.doesNotMatch(
    await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /not sent/,
  );
  await runHelper(["record-round", "--code", "DQ-7F3K", "--response", roundResponsePath, "--state", statePath], environment);

  const invalidNavPaths = [
    [["A", "B", "C", "D", "E", "F", "G"], /navPath must contain 1-6 labels/],
    [[], /navPath must contain 1-6 labels/],
    [["Promotions", "  "], /navPath\[1\] must be 1-120 characters/],
    [["Promotions", "x".repeat(121)], /navPath\[1\] must be 1-120 characters/],
    ["Promotions › Create", /navPath must be an array/],
    [["Promotions", 7], /navPath\[1\] must be a string/],
    [["private-admin-repository", "Submit"], /navPath\[0\] exposes local repository provenance/],
  ];
  for (const [navPath, message] of invalidNavPaths) {
    const invalid = structuredClone(navJourney);
    invalid.journeys[0].navPath = navPath;
    writeFileSync(submissionPath, `${JSON.stringify(invalid, null, 2)}\n`);
    await assert.rejects(
      runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
      message,
    );
  }
  for (const order of [0, -1, 1.5, "2"]) {
    const invalid = structuredClone(navJourney);
    invalid.journeys[0].order = order;
    writeFileSync(submissionPath, `${JSON.stringify(invalid, null, 2)}\n`);
    await assert.rejects(
      runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
      /journeys\[0\]\.order must be a positive integer/,
    );
  }

  const unbackedJourney = structuredClone(declaredJourneys);
  unbackedJourney.journeys[0].journeyRef = "j_nothing_orders_this";
  writeFileSync(submissionPath, `${JSON.stringify(unbackedJourney, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /has no ordered findings/i,
  );

  const duplicateJourney = structuredClone(declaredJourneys);
  duplicateJourney.journeys.push(structuredClone(declaredJourneys.journeys[0]));
  writeFileSync(submissionPath, `${JSON.stringify(duplicateJourney, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /more than once/i,
  );

  // The journey's own wording crosses the boundary like any other prose, so it gets the
  // same provenance check rather than riding along unexamined.
  const leakyJourney = structuredClone(declaredJourneys);
  leakyJourney.journeys[0].goal = "Turn a draft into a live promotion in private-admin-repository.";
  writeFileSync(submissionPath, `${JSON.stringify(leakyJourney, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /journeys\[0\]\.goal exposes local repository provenance/i,
  );

  // A Round that did not ask for a map must never receive one: a backend that predates
  // the field rejects the whole submission. Re-record the same Round without the request.
  const unrequestedRoundPath = join(testRoot, "mcp-round-unrequested-response.json");
  writeFileSync(
    unrequestedRoundPath,
    JSON.stringify({ ...JSON.parse(readFileSync(roundResponsePath, "utf8")), journey_map: undefined }),
  );
  await runHelper(["record-round", "--code", "DQ-7F3K", "--response", unrequestedRoundPath, "--state", statePath], environment);
  writeFileSync(submissionPath, `${JSON.stringify(declaredJourneys, null, 2)}\n`);
  const unrequestedOutput = await runHelper(
    ["validate-submission", "--state", statePath, "--candidate", submissionPath],
    environment,
  );
  assert.match(unrequestedOutput, /Journey map not requested by this Round; omitted 1 declaration/);
  await runHelper(["record-round", "--code", "DQ-7F3K", "--response", roundResponsePath, "--state", statePath], environment);

  writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);

  const invalidStatus = structuredClone(submission);
  invalidStatus.answers[0].status = "deferred";
  writeFileSync(submissionPath, `${JSON.stringify(invalidStatus, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /answered or skipped/i,
  );

  const paraphrasedHumanAuthority = structuredClone(submission);
  paraphrasedHumanAuthority.agentObservations[1].findings[0].statement =
    "A successful save navigates to details.";
  writeFileSync(submissionPath, `${JSON.stringify(paraphrasedHumanAuthority, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /must exactly match one submitted answer/i,
  );

  const unknownConflictReference = structuredClone(submission);
  unknownConflictReference.conflicts[0].rightFindingRef = "f_missing000";
  writeFileSync(submissionPath, `${JSON.stringify(unknownConflictReference, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /this round submission/i,
  );

  const largeEvidencePath = join(repository, "large-evidence.txt");
  writeFileSync(
    largeEvidencePath,
    `${Array.from({ length: 405 }, (_, index) => `factual line ${index + 1}`).join("\n")}\n`,
  );
  const boundedUnknown = structuredClone(submission);
  boundedUnknown.agentObservations = [];
  boundedUnknown.conflicts = [];
  boundedUnknown.answers[0].humanClarifications = [];
  boundedUnknown.answers[0].findings = [
    {
      statement: "Whether the control has an additional conditional state remains unknown.",
      truthPlane: "unknown",
      sourceType: "inference",
      observableAnchors: [],
      evidenceRefIds: ["ev_largefact"],
    },
  ];
  boundedUnknown.evidence = [
    {
      id: "ev_largefact",
      repoRef: privateState.repositories[0].repoRef,
      kind: "code",
      path: largeEvidencePath,
      startLine: 1,
      endLine: 405,
      revision: privateState.repositories[0].revision,
    },
  ];
  writeFileSync(submissionPath, `${JSON.stringify(boundedUnknown, null, 2)}\n`);
  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);

  const evidenceFreeEnvironmentUnknown = structuredClone(boundedUnknown);
  evidenceFreeEnvironmentUnknown.answers[0].findings = [
    {
      statement: "Whether the inspected source revision matches the target deployment remains unknown.",
      truthPlane: "unknown",
      sourceType: "inference",
      observableAnchors: [],
      evidenceRefIds: [],
    },
  ];
  evidenceFreeEnvironmentUnknown.evidence = [];
  writeFileSync(
    submissionPath,
    `${JSON.stringify(evidenceFreeEnvironmentUnknown, null, 2)}\n`,
  );
  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);
  writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);

  const repoFreeCode = structuredClone(submission);
  delete repoFreeCode.evidence[0].repoRef;
  writeFileSync(submissionPath, `${JSON.stringify(repoFreeCode, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /code evidence .* requires a mapped repoRef/i,
  );

  const undeclaredArtifactPath = join(testRoot, "undeclared-requirements.md");
  writeFileSync(undeclaredArtifactPath, "This file was not supplied under an approved artifact root.\n");
  const undeclaredArtifact = structuredClone(submission);
  undeclaredArtifact.evidence[1].path = undeclaredArtifactPath;
  writeFileSync(submissionPath, `${JSON.stringify(undeclaredArtifact, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /explicitly supplied artifact root/i,
  );

  const runtimeCapture = structuredClone(submission);
  runtimeCapture.evidence[2].kind = "runtime";
  runtimeCapture.agentObservations[2].findings[0].sourceType = "runtime";
  writeFileSync(submissionPath, `${JSON.stringify(runtimeCapture, null, 2)}\n`);
  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);
  writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);

  const internalSymbolAnchor = structuredClone(submission);
  internalSymbolAnchor.answers[0].findings[0].observableAnchors = ["calculate_checkout_total_with_gift_cards"];
  internalSymbolAnchor.evidence[0].symbol = "calculate_checkout_total_with_gift_cards";
  writeFileSync(submissionPath, `${JSON.stringify(internalSymbolAnchor, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /local evidence symbol, not an externally observable anchor/i,
  );

  const callableAnchor = structuredClone(submission);
  callableAnchor.answers[0].findings[0].observableAnchors = ["calculateTotal()"];
  writeFileSync(submissionPath, `${JSON.stringify(callableAnchor, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /shaped like an internal callable/i,
  );

  const storageKeyAnchor = structuredClone(submission);
  storageKeyAnchor.answers[0].findings[0].observableAnchors = ["localStorage:has_onboarding_shown"];
  storageKeyAnchor.evidence[0].symbol = "has_onboarding_shown";
  writeFileSync(submissionPath, `${JSON.stringify(storageKeyAnchor, null, 2)}\n`);
  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);

  const bareStorageKeyAnchor = structuredClone(storageKeyAnchor);
  bareStorageKeyAnchor.answers[0].findings[0].observableAnchors = ["has_onboarding_shown"];
  writeFileSync(submissionPath, `${JSON.stringify(bareStorageKeyAnchor, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /local evidence symbol, not an externally observable anchor/i,
  );

  const unknownStoreAnchor = structuredClone(submission);
  unknownStoreAnchor.answers[0].findings[0].observableAnchors = ["redis:session_cache()"];
  writeFileSync(submissionPath, `${JSON.stringify(unknownStoreAnchor, null, 2)}\n`);
  await assert.rejects(
    runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment),
    /shaped like an internal callable/i,
  );
  writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);

  const externalSnakeCaseAnchor = structuredClone(submission);
  externalSnakeCaseAnchor.answers[0].findings[0].observableAnchors = ["external_status_code"];
  writeFileSync(submissionPath, `${JSON.stringify(externalSnakeCaseAnchor, null, 2)}\n`);
  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);
  writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);

  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);
  const submissionPayloadPath = join(testRoot, ".doable", "requests", "DQ-7F3K", "context-r1.json");
  await runHelper(
    ["build-submission", "--state", statePath, "--candidate", submissionPath, "--output", submissionPayloadPath],
    environment,
  );
  const submissionEnvelope = JSON.parse(readFileSync(submissionPayloadPath, "utf8"));
  const capturedSubmission = submissionEnvelope.submission;
  const submissionResponsePath = join(testRoot, "mcp-submission-response.json");
  writeFileSync(submissionResponsePath, JSON.stringify({ round: { id: "round-safe", state: "ready_to_create" } }));
  await runHelper(
    ["record-submission", "--state", statePath, "--candidate", submissionPath, "--payload", submissionPayloadPath, "--response", submissionResponsePath],
    environment,
  );
  await runHelper(
    ["record-submission", "--state", statePath, "--candidate", submissionPath, "--payload", submissionPayloadPath, "--response", submissionResponsePath],
    environment,
  );

  const followUp = structuredClone(submission);
  followUp.agentObservations = [];
  followUp.conflicts = submission.conflicts;
  writeFileSync(submissionPath, `${JSON.stringify(followUp, null, 2)}\n`);
  const followUpPayloadPath = join(testRoot, ".doable", "requests", "DQ-7F3K", "context-r1-batch2.json");
  await runHelper(
    ["build-submission", "--state", statePath, "--candidate", submissionPath, "--output", followUpPayloadPath],
    environment,
  );
  await runHelper(
    ["record-submission", "--state", statePath, "--candidate", submissionPath, "--payload", followUpPayloadPath, "--response", submissionResponsePath],
    environment,
  );
  await runHelper(
    ["record-submission", "--state", statePath, "--candidate", submissionPath, "--payload", followUpPayloadPath, "--response", submissionResponsePath],
    environment,
  );
  const requestDirectory = join(testRoot, ".doable", "requests", "DQ-7F3K");
  const receipts = readdirSync(requestDirectory).filter((name) => name.startsWith("receipt-r1-"));
  assert.equal(receipts.length, 2);
  assert.equal(existsSync(join(requestDirectory, "receipt-r1.json")), false);
  writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);

  const remoteSubmissionText = JSON.stringify(capturedSubmission);
  assert.doesNotMatch(remoteSubmissionText, /private-admin-repository/);
  assert.doesNotMatch(remoteSubmissionText, /supplied-product-artifacts|promotion-requirements\.md|promotion-design\.png/);
  assert.doesNotMatch(remoteSubmissionText, new RegExp(repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(remoteSubmissionText, /form\.js|local-test-credential/);
  assert.equal(capturedSubmission.answers[0].findings[0].statement.includes("Save"), true);
  assert.deepEqual(capturedSubmission.conflicts, [
    {
      left_finding_ref: "f_savecode01",
      right_finding_ref: "f_savedesire01",
      description: "The implemented label is ‘Save’, while the approved product label is ‘Create promotion’.",
    },
  ]);
  const allFindingRefs = [
    ...capturedSubmission.answers.flatMap((answer) => answer.findings.map((finding) => finding.finding_ref)),
    ...capturedSubmission.agent_observations.flatMap((observation) =>
      observation.findings.map((finding) => finding.finding_ref),
    ),
  ];
  assert.equal(new Set(allFindingRefs).size, allFindingRefs.length);
  assert.equal(allFindingRefs.every((findingRef) => /^f_[a-z0-9]{8,80}$/.test(findingRef)), true);
  assert.equal(capturedSubmission.evidence_references[0].repo_ref, privateState.repositories[0].repoRef);
  assert.equal(capturedSubmission.evidence_references[1].repo_ref, null);
  assert.equal(capturedSubmission.evidence_references[1].source_type, "artifact");
  assert.equal(capturedSubmission.evidence_references[2].repo_ref, null);
  assert.equal(capturedSubmission.evidence_references[2].source_type, "artifact");
  assert.deepEqual(capturedSubmission.agent_observations[1].human_clarifications, [
    {
      question: "Should a successful save remain on the creation view?",
      answer: "No, a successful save should open the promotion details view.",
    },
  ]);
  assert.equal(
    capturedSubmission.agent_observations[1].findings[0].statement,
    capturedSubmission.agent_observations[1].human_clarifications[0].answer,
  );

  submission.answers[0].findings[0].statement = "The submit label changed after the terminal submission.";
  writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);
  await assert.rejects(
    runHelper(["record-submission", "--state", statePath, "--candidate", submissionPath, "--payload", submissionPayloadPath, "--response", submissionResponsePath], environment),
    /context file changed after validation/i,
  );

  const originalRepoRef = privateState.repositories[0].repoRef;
  rmSync(join(testRoot, ".doable"), { recursive: true, force: true });
  const recoveryHandshakePath = join(testRoot, "mcp-recovery-handshake.json");
  writeFileSync(
    recoveryHandshakePath,
    JSON.stringify({
      organization: { id: "org-safe", display_name: "Example Org" },
      workspace: {
        id: serverWorkspaceId,
        client_workspace_id: serverClientWorkspaceId,
        display_name: capturedProfile.display_name,
        profile_revision: capturedProfile.profile_revision,
        profile_fingerprint: capturedProfile.profile_fingerprint,
        repositories: capturedProfile.repositories,
      },
    }),
  );
  const recoveryOutput = await runHelper(
    ["prepare-workspace", "--candidate", candidatePath, "--handshake", recoveryHandshakePath, "--state", statePath, "--round-code", "DQ-7F3K"],
    environment,
  );
  assert.match(recoveryOutput, /Material profile approval required: no/);
  const recoveredState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(recoveredState.workspace.serverId, serverWorkspaceId);
  assert.equal(recoveredState.workspace.clientRef, serverClientWorkspaceId);
  assert.equal(recoveredState.workspace.pendingRoundCode, "DQ-7F3K");
  assert.equal(recoveredState.repositories[0].repoRef, originalRepoRef);
  assert.deepEqual(recoveredState.artifactRoots, [realpathSync(artifactRoot)]);
  await runHelper(["build-workspace-profile", "--state", statePath, "--output", profilePayloadPath], environment);
  await runHelper(
    ["record-workspace-sync", "--state", statePath, "--payload", profilePayloadPath, "--response", profileResponsePath],
    environment,
  );
});

test("agent-origin helper records the exact MCP round and finalize result", async (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "doable-agent-round-test-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  const repository = join(testRoot, "account-recovery-ui");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  writeFileSync(join(repository, "recovery.js"), "export const recovery = true;\n");
  execFileSync("git", ["-C", repository, "add", "recovery.js"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "fixture"]);
  const environment = { TEST_WORKSPACE: testRoot };
  const candidatePath = join(testRoot, "workspace-candidate.json");
  writeFileSync(
    candidatePath,
    JSON.stringify({
      workspaceLabel: "private recovery workspace",
      safeDisplayName: "Account experience",
      repositories: [
        {
          path: repository,
          name: "account-recovery-ui",
          productRole: "customer-web",
          surfaces: ["account-recovery"],
          userFacing: true,
          safeDescription: "Customer-facing account recovery experience.",
        },
      ],
    }),
  );
  const statePath = join(testRoot, ".doable", "workspace-private.json");
  const handshakePath = join(testRoot, "mcp-handshake.json");
  writeFileSync(
    handshakePath,
    JSON.stringify({ organization: { id: "org-safe", display_name: "Example Org" }, workspace: null }),
  );
  await runHelper(
    ["prepare-workspace", "--candidate", candidatePath, "--handshake", handshakePath, "--state", statePath, "--round-code", "DQ-AGENT1"],
    environment,
  );
  const profilePayloadPath = join(testRoot, "mcp-profile-payload.json");
  await runHelper(
    ["build-workspace-profile", "--state", statePath, "--output", profilePayloadPath, "--approved"],
    environment,
  );
  const profileEnvelope = JSON.parse(readFileSync(profilePayloadPath, "utf8"));
  const profileResponsePath = join(testRoot, "mcp-profile-response.json");
  writeFileSync(
    profileResponsePath,
    JSON.stringify({ workspace: { id: "workspace-agent-safe", client_workspace_id: profileEnvelope.workspace_ref } }),
  );
  await runHelper(
    ["record-workspace-sync", "--state", statePath, "--payload", profilePayloadPath, "--response", profileResponsePath],
    environment,
  );
  const roundResponsePath = join(testRoot, "mcp-round-response.json");
  writeFileSync(
    roundResponsePath,
    JSON.stringify({
      round_id: "round-agent-safe",
      round_code: "DQ-AGENT1",
      workspace_id: "workspace-agent-safe",
      status: "open_for_agent",
      revision: 1,
      feature_scope: "Account recovery",
      investigation: "quick",
      time_budget_minutes: 4,
      questions: [
        {
          id: "question-base",
          purpose: "base_context",
          question: "Test account recovery",
          why: "",
          answer_requirements: "",
          required: true,
          scope_hints: { surfaces: ["account-recovery"], repo_refs: [] },
        },
      ],
    }),
  );
  const roundOutput = await runHelper(
    ["record-round", "--code", "DQ-AGENT1", "--response", roundResponsePath, "--state", statePath, "--suite", "ts-agentflow"],
    environment,
  );
  assert.match(roundOutput, /Round: DQ-AGENT1 revision 1/);
  assert.match(roundOutput, /Status: open_for_agent/);
  assert.match(roundOutput, /Next action: answer/);
  // An older server's tier and time budget no longer steer the agent: the Round's questions
  // and journey-map instructions define what to return, so neither is printed or kept.
  assert.doesNotMatch(roundOutput, /Investigation:|submit within/);
  const quickRound = JSON.parse(
    readFileSync(join(testRoot, ".doable", "requests", "DQ-AGENT1", "round-r1.json"), "utf8"),
  );
  assert.equal(quickRound.investigation, undefined);
  assert.equal(quickRound.timeBudgetMinutes, undefined);
  const originPath = join(testRoot, ".doable", "requests", "DQ-AGENT1", "agent-origin.json");
  assert.equal(statSync(originPath).mode & 0o777, 0o600);

  const readyResponsePath = join(testRoot, "mcp-round-ready-response.json");
  writeFileSync(
    readyResponsePath,
    JSON.stringify({
      round_id: "round-agent-safe",
      round_code: "DQ-AGENT1",
      workspace_id: "workspace-agent-safe",
      status: "ready_to_create",
      revision: 1,
      feature_scope: "Account recovery",
      questions: [],
    }),
  );
  const readyOutput = await runHelper(
    ["record-round", "--code", "DQ-AGENT1", "--response", readyResponsePath, "--state", statePath, "--suite", "ts-agentflow"],
    environment,
  );
  assert.match(readyOutput, /Status: ready_to_create/);
  assert.match(readyOutput, /Next action: wait/);
  assert.equal(JSON.parse(readFileSync(originPath, "utf8")).status, "ready_to_create");
  assert.equal(JSON.parse(readFileSync(originPath, "utf8")).action, "wait");

  const followUpResponsePath = join(testRoot, "mcp-round-follow-up-response.json");
  writeFileSync(
    followUpResponsePath,
    JSON.stringify({
      round_id: "round-agent-safe",
      round_code: "DQ-AGENT1",
      workspace_id: "workspace-agent-safe",
      status: "open_for_agent",
      revision: 1,
      feature_scope: "Account recovery",
      questions: [
        {
          id: "question-expiry",
          purpose: "supplemental",
          question: "What happens when the recovery code is expired?",
          why: "Expiry changes the rejection oracle.",
          answer_requirements: "Return the visible rejection outcome.",
          required: true,
          scope_hints: { surfaces: ["account-recovery"], repo_refs: [] },
        },
      ],
      established_context: [
        {
          id: "question-base",
          purpose: "base_context",
          question: "Test account recovery",
          status: "answered",
          answer: {
            findings: [
              {
                statement: "Account recovery starts from the Forgot password page.",
                truth_plane: "implemented_behavior",
                source_type: "code",
                observable_anchors: ["Forgot password"],
              },
            ],
            human_clarifications: [],
          },
        },
      ],
    }),
  );
  const followUpOutput = await runHelper(
    ["record-round", "--code", "DQ-AGENT1", "--response", followUpResponsePath, "--state", statePath],
    environment,
  );
  assert.match(followUpOutput, /Next action: answer/);
  assert.match(followUpOutput, /Open questions: 1/);
  assert.match(followUpOutput, /Established context: 1/);
  const followUpSnapshot = JSON.parse(
    readFileSync(join(testRoot, ".doable", "requests", "DQ-AGENT1", "round-r1.json"), "utf8"),
  );
  assert.equal(followUpSnapshot.action, "answer");
  assert.equal(followUpSnapshot.establishedContext[0].id, "question-base");
  const followUpCandidate = JSON.parse(
    readFileSync(join(testRoot, ".doable", "requests", "DQ-AGENT1", "context-local-r1.json"), "utf8"),
  );
  assert.deepEqual(
    followUpCandidate.answers.map((answer) => answer.questionId),
    ["question-expiry"],
  );

  const creatingResponsePath = join(testRoot, "mcp-round-creating-response.json");
  writeFileSync(
    creatingResponsePath,
    JSON.stringify({
      round_id: "round-agent-safe",
      round_code: "DQ-AGENT1",
      workspace_id: "workspace-agent-safe",
      status: "creating",
      revision: 1,
      feature_scope: "Account recovery",
      questions: [],
      established_context: followUpSnapshot.establishedContext,
    }),
  );
  const creatingOutput = await runHelper(
    ["record-round", "--code", "DQ-AGENT1", "--response", creatingResponsePath, "--state", statePath],
    environment,
  );
  assert.match(creatingOutput, /Next action: stop/);

  // Without next_action the local rule still stops a pre-create Round (an older server).
  // With one, the server wins: it can see the follow-up Rounds this code now reaches.
  const handedOverResponsePath = join(testRoot, "mcp-round-handed-over-response.json");
  writeFileSync(
    handedOverResponsePath,
    JSON.stringify({ ...JSON.parse(readFileSync(creatingResponsePath, "utf8")), status: "consumed", next_action: "wait" }),
  );
  const handedOverOutput = await runHelper(
    ["record-round", "--code", "DQ-AGENT1", "--response", handedOverResponsePath, "--state", statePath],
    environment,
  );
  assert.match(handedOverOutput, /Next action: wait/);

  const finalizeResponsePath = join(testRoot, "mcp-finalize-response.json");
  writeFileSync(
    finalizeResponsePath,
    JSON.stringify({
      round_id: "round-agent-safe",
      mode: "create",
      test_spec_id: "test-spec-agent-safe",
      test_spec_session_id: "session-agent-safe",
    }),
  );
  const finalizeOutput = await runHelper(
    ["record-finalize", "--code", "DQ-AGENT1", "--response", finalizeResponsePath],
    environment,
  );
  assert.match(finalizeOutput, /Test spec mode: create/);
  const receipt = JSON.parse(
    readFileSync(
      join(testRoot, ".doable", "requests", "DQ-AGENT1", "finalize-receipt.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.testSpecId, "test-spec-agent-safe");
  assert.equal(receipt.testSpecSessionId, "session-agent-safe");

  // A Doable MCP server from before the TRD -> test spec rename returns only the old keys.
  const legacyFinalizeResponsePath = join(testRoot, "mcp-finalize-legacy-response.json");
  writeFileSync(
    legacyFinalizeResponsePath,
    JSON.stringify({
      round_id: "round-agent-safe",
      mode: "create",
      trd_id: "trd-agent-safe",
      trd_session_id: "session-agent-legacy",
    }),
  );
  await runHelper(
    ["record-finalize", "--code", "DQ-AGENT1", "--response", legacyFinalizeResponsePath],
    environment,
  );
  const legacyReceipt = JSON.parse(
    readFileSync(
      join(testRoot, ".doable", "requests", "DQ-AGENT1", "finalize-receipt.json"),
      "utf8",
    ),
  );
  assert.equal(legacyReceipt.testSpecId, "trd-agent-safe");
  assert.equal(legacyReceipt.testSpecSessionId, "session-agent-legacy");

  const postCreateResponsePath = join(testRoot, "mcp-post-create-round-response.json");
  writeFileSync(
    postCreateResponsePath,
    JSON.stringify({
      round_id: "round-follow-up-safe",
      round_code: "DQ-FOLLOW1",
      round_use: "follow_up",
      test_suite_public_id: "ts-agentflow",
      workspace_id: "workspace-agent-safe",
      status: "open_for_agent",
      revision: 1,
      feature_scope: "Account recovery",
      questions: [
        {
          id: "question-expired-state",
          purpose: "supplemental",
          question: "What visible state appears for an expired recovery code?",
          why: "This resolves U-recovery-1.",
          answer_requirements: "Return the grounded current observable state.",
          required: true,
          scope_hints: { surfaces: ["account-recovery"], repo_refs: [] },
        },
      ],
    }),
  );
  const postCreateOutput = await runHelper(
    ["record-round", "--code", "DQ-FOLLOW1", "--response", postCreateResponsePath, "--state", statePath],
    environment,
  );
  assert.match(postCreateOutput, /Next action: answer/);
  const postCreateSnapshot = JSON.parse(
    readFileSync(join(testRoot, ".doable", "requests", "DQ-FOLLOW1", "round-r1.json"), "utf8"),
  );
  assert.equal(postCreateSnapshot.roundUse, "follow_up");
  assert.equal(postCreateSnapshot.testSuitePublicId, "ts-agentflow");
  assert.deepEqual(
    postCreateSnapshot.questions.map((question) => question.purpose),
    ["supplemental"],
  );
  // First code connection after a walkthrough can carry the same base purpose
  // as pre-create, alongside focused gaps; Apply still leaves watch running.
  const firstBaseline = JSON.parse(readFileSync(postCreateResponsePath, "utf8"));
  firstBaseline.questions.unshift({
    id: "question-feature-baseline", purpose: "base_context",
    question: "Test account recovery", why: "Establish the feature baseline from code.",
    answer_requirements: "Ground user-visible flows, roles, prerequisites and outcomes.",
    required: true, scope_hints: { surfaces: ["account-recovery"], repo_refs: [] },
  });
  writeFileSync(postCreateResponsePath, JSON.stringify(firstBaseline));
  assert.match(await runHelper(
    ["record-round", "--code", "DQ-FOLLOW1", "--response", postCreateResponsePath, "--state", statePath], environment,
  ), /Next action: answer/);
  const baselineSnapshot = JSON.parse(readFileSync(
    join(testRoot, ".doable", "requests", "DQ-FOLLOW1", "round-r1.json"), "utf8",
  ));
  assert.deepEqual(baselineSnapshot.questions.map(q => q.purpose), ["base_context", "supplemental"]);
  writeFileSync(postCreateResponsePath, JSON.stringify({ ...firstBaseline, status: "consumed", questions: [] }));
  assert.match(await runHelper(
    ["record-round", "--code", "DQ-FOLLOW1", "--response", postCreateResponsePath, "--state", statePath], environment,
  ), /Next action: wait/);

});

test("a pre-create successor requires the original connection and matching workspace", async (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "doable-resume-connection-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  mkdirSync(join(testRoot, ".doable"));
  const statePath = join(testRoot, ".doable", "workspace-private.json");
  writeFileSync(statePath, JSON.stringify({
    schemaVersion: "1", workspace: { localId: "local-fixture", serverId: "workspace-safe" },
    organization: { id: "org-safe" }, repositories: [],
    privateFingerprintKey: "local-test-only",
    sync: { profileFingerprint: "fixture" }, profile: { profileFingerprint: "fixture" },
  }));
  const responsePath = join(testRoot, "resume-round.json");
  const round = {
    round_id: "resume-round", round_code: "DQ-RESUME1", connection_round_code: "DQ-ORIGIN1",
    round_use: "pre_create", workspace_id: "workspace-safe", status: "open_for_agent",
    next_action: "answer", revision: 1, feature_scope: "Account recovery",
    questions: [{ id: "base-question", purpose: "base_context", question: "Ground account recovery.", why: "Resume creation." }],
  };
  const environment = { TEST_WORKSPACE: testRoot };
  const args = ["record-round", "--code", "DQ-ORIGIN1", "--response", responsePath, "--state", statePath];
  writeFileSync(responsePath, JSON.stringify(round));
  assert.match(await runHelper(args, environment), /Next action: answer/);
  const candidate = JSON.parse(readFileSync(join(testRoot, ".doable", "requests", "DQ-RESUME1", "context-local-r1.json"), "utf8"));
  assert.equal(candidate.round.id, "resume-round");
  assert.deepEqual(candidate.answers.map(answer => answer.questionId), ["base-question"]);

  for (const changes of [{ connection_round_code: undefined }, { connection_round_code: "DQ-OTHER1" }]) {
    writeFileSync(responsePath, JSON.stringify({ ...round, ...changes }));
    await assert.rejects(runHelper(args, environment), /different context connection/);
  }
  writeFileSync(responsePath, JSON.stringify({ ...round, workspace_id: "workspace-other" }));
  await assert.rejects(runHelper(args, environment), /different workspace/);
});

test("record-round keeps the Round's app under test and accepts a Round without one", async (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "doable-target-app-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  mkdirSync(join(testRoot, ".doable"));
  const statePath = join(testRoot, ".doable", "workspace-private.json");
  writeFileSync(statePath, JSON.stringify({
    schemaVersion: "1", workspace: { localId: "local-fixture", serverId: "workspace-safe" },
    organization: { id: "org-safe" }, repositories: [],
    privateFingerprintKey: "local-test-only",
    sync: { profileFingerprint: "fixture" }, profile: { profileFingerprint: "fixture" },
  }));
  const responsePath = join(testRoot, "target-app-round.json");
  const roundPath = join(testRoot, ".doable", "requests", "DQ-APP1", "round-r1.json");
  const round = {
    round_id: "app-round", round_code: "DQ-APP1", round_use: "pre_create", workspace_id: "workspace-safe",
    status: "open_for_agent", revision: 1, feature_scope: "Team scheduling",
    questions: [{ id: "base-question", purpose: "base_context", question: "Ground team scheduling.", why: "" }],
  };
  const environment = { TEST_WORKSPACE: testRoot };
  const args = ["record-round", "--code", "DQ-APP1", "--response", responsePath, "--state", statePath];
  const record = async (changes) => {
    writeFileSync(responsePath, JSON.stringify({ ...round, ...changes }));
    const output = await runHelper(args, environment);
    return { output, recorded: JSON.parse(readFileSync(roundPath, "utf8")) };
  };

  let { output, recorded } = await record({
    target_app: { name: "teamspire", entry_url: "https://teamspire.example.invalid/login" },
  });
  assert.match(output, /^App under test: teamspire \(https:\/\/teamspire\.example\.invalid\/login\)$/m);
  assert.deepEqual(recorded.targetApp, { name: "teamspire", entryUrl: "https://teamspire.example.invalid/login" });

  ({ output, recorded } = await record({ targetApp: { name: null, entryUrl: "https://app.example.invalid" } }));
  assert.match(output, /^App under test: https:\/\/app\.example\.invalid$/m);
  assert.deepEqual(recorded.targetApp, { name: null, entryUrl: "https://app.example.invalid" });

  // Older servers send no app, and a suite without an entry URL sends null.
  for (const changes of [{}, { target_app: null }]) {
    ({ output, recorded } = await record(changes));
    assert.doesNotMatch(output, /App under test/);
    assert.match(output, /Next action: answer/);
    assert.equal(recorded.targetApp, null);
  }

  for (const target_app of [
    "https://teamspire.example.invalid",
    ["https://teamspire.example.invalid"],
    { name: "teamspire" },
    { name: 7, entry_url: "https://teamspire.example.invalid" },
    { name: "teamspire", entry_url: `https://teamspire.example.invalid/${"a".repeat(2_048)}` },
  ]) {
    writeFileSync(responsePath, JSON.stringify({ ...round, target_app }));
    await assert.rejects(runHelper(args, environment), /round target app/);
  }
});

function runHelperResult(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [helper, ...args], {
      cwd: env.TEST_WORKSPACE,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("submit sends the context file with the Round's one-time token and falls back to MCP without one", async (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "doable-direct-submit-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  mkdirSync(join(testRoot, ".doable"));
  const statePath = join(testRoot, ".doable", "workspace-private.json");
  writeFileSync(statePath, JSON.stringify({
    schemaVersion: "1", workspace: { localId: "local-fixture", serverId: "workspace-safe" },
    organization: { id: "org-safe" }, repositories: [],
    privateFingerprintKey: "local-test-only",
    sync: { profileFingerprint: "fixture" }, profile: { profileFingerprint: "fixture" },
  }));

  const requests = [];
  let reply = { status: 200, body: { round: { id: "direct-round", status: "ready_to_create" } } };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  t.after(() => server.close());
  const submitPath = "/be/code-context/rounds/direct-round/direct-submissions";
  const submitUrl = `http://127.0.0.1:${server.address().port}${submitPath}`;
  const token = `dcs1.${"opaque-test-token-".repeat(3)}`;
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const requestDirectory = join(testRoot, ".doable", "requests", "DQ-DIRECT1");
  const responsePath = join(testRoot, "direct-round.json");
  const candidatePath = join(requestDirectory, "context-local-r1.json");
  const contextPath = join(requestDirectory, "context-r1.json");
  const roundPath = join(requestDirectory, "round-r1.json");
  const round = {
    round_id: "direct-round", round_code: "DQ-DIRECT1", round_use: "pre_create", workspace_id: "workspace-safe",
    status: "open_for_agent", next_action: "answer", revision: 1, feature_scope: "Team scheduling",
    questions: [{ id: "base-question", purpose: "base_context", question: "Ground team scheduling.", why: "" }],
  };
  const environment = { TEST_WORKSPACE: testRoot };
  const recordArgs = ["record-round", "--code", "DQ-DIRECT1", "--response", responsePath, "--state", statePath];
  const submitArgs = ["submit", "--candidate", candidatePath, "--state", statePath];
  const record = async (changes) => {
    writeFileSync(responsePath, JSON.stringify({ ...round, ...changes }));
    const output = await runHelper(recordArgs, environment);
    return { output, recorded: JSON.parse(readFileSync(roundPath, "utf8")) };
  };
  const answerCandidate = (reason) => {
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
    candidate.answers = [{ questionId: "base-question", status: "skipped", unknownReason: reason, findings: [], humanClarifications: [] }];
    writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  };

  // An in-progress candidate under the pre-0.2.14 name is renamed, not lost.
  mkdirSync(requestDirectory, { recursive: true });
  writeFileSync(join(requestDirectory, "submission-r1.json"), JSON.stringify({
    schemaVersion: "1",
    round: { id: "direct-round", code: "DQ-DIRECT1", revision: 1, workspaceId: "workspace-safe" },
    answers: [{ questionId: "base-question", status: "skipped", unknownReason: "Legacy draft reason.", findings: [], humanClarifications: [] }],
    agentObservations: [], conflicts: [], evidence: [],
  }));
  let { output, recorded } = await record({});
  assert.equal(existsSync(join(requestDirectory, "submission-r1.json")), false);
  assert.equal(JSON.parse(readFileSync(candidatePath, "utf8")).answers[0].unknownReason, "Legacy draft reason.");
  assert.equal(statSync(candidatePath).mode & 0o777, 0o600);
  assert.match(output, /^Context file: .*context-local-r1\.json$/m);
  assert.match(output, /^Direct submission: unavailable \(not offered by this Round\); submit through Doable MCP$/m);
  assert.equal(recorded.directSubmission, null);

  // No offer: submit still writes the outgoing context file, then asks for the MCP path with exit code 3.
  // Non-ASCII, a quote and a backslash exercise the Python json.dumps escaping behind the Idempotency-Key.
  const unicodeReason = 'The workspace has no 排班 "scheduling" code \\ 😀.';
  // Computed with Python for exactly this submission:
  // {"agent_observations":[],"answers":[{"findings":[],"human_clarifications":[],"question_id":"base-question",
  //  "status":"skipped","unknown_reason":"The workspace has no \u6392\u73ed \"scheduling\" code \\ \ud83d\ude00."}],
  //  "conflicts":[],"evidence_references":[],"round_revision":1,"workspace_id":"workspace-safe"}
  const EXPECTED_MCP_DIGEST = "4c4674515978949116be9405e3e0eeb1efd9f4fafb80d2019fbec5a95e03e0b1";
  answerCandidate(unicodeReason);
  let result = await runHelperResult(submitArgs, environment);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stdout, /^Direct submission: unavailable \(not offered by this Round\)\. Submit .*context-r1\.json with Doable MCP submit_code_context_round, then run record-submission\.$/m);
  const fallbackEnvelope = JSON.parse(readFileSync(contextPath, "utf8"));
  assert.equal(fallbackEnvelope.round_id, "direct-round");
  assert.equal(fallbackEnvelope.submission.answers[0].unknown_reason, unicodeReason);
  assert.match(fallbackEnvelope.payload_digest, /^[a-f0-9]{64}$/);
  assert.equal(statSync(contextPath).mode & 0o777, 0o600);
  assert.equal(requests.length, 0);

  // During rollout the server may send an offer without a url; an invalid offer also only disables direct submission.
  for (const offer of [
    { path: submitPath, token, expires_at: future },
    { url: submitUrl.replace("http://127.0.0.1", "http://qa.example.invalid"), token, expires_at: future },
    { url: submitUrl, token: "not-a-submit-token", expires_at: future },
    { url: submitUrl, token, expires_at: "not a time" },
    { url: submitUrl.replace("direct-round", "other-round"), token, expires_at: future },
  ]) {
    ({ output, recorded } = await record({ direct_submission: offer }));
    assert.equal(recorded.directSubmission, null);
    assert.match(output, /^Direct submission: unavailable \(round direct submission .+\); submit through Doable MCP$/m);
    assert.equal(output.includes(token), false);
    result = await runHelperResult(submitArgs, environment);
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stdout, /Direct submission: unavailable \(round direct submission .+\)\. Submit .*context-r1\.json with Doable MCP/);
  }
  assert.equal(requests.length, 0);

  // An expired token asks for a fresh pull before falling back.
  await record({ direct_submission: { url: submitUrl, token, expires_at: "2020-01-01T00:00:00+00:00" } });
  result = await runHelperResult(submitArgs, environment);
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stdout, /Direct submission: unavailable \(submit token expired\)\. Pull the round again/);
  assert.equal(requests.length, 0);

  // A valid offer is kept privately and never printed.
  ({ output, recorded } = await record({ direct_submission: { path: submitPath, url: submitUrl, token, expires_at: future } }));
  assert.deepEqual(recorded.directSubmission, { url: submitUrl, token, expiresAt: future });
  assert.equal(statSync(roundPath).mode & 0o777, 0o600);
  assert.match(output, new RegExp(`^Direct submission: available until ${future.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.equal(output.includes(token), false);
  assert.match(readFileSync(join(testRoot, ".doable", ".gitignore"), "utf8"), /^requests\/$/m);

  result = await runHelperResult(submitArgs, environment);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Round submitted: DQ-DIRECT1 revision 1$/m);
  assert.match(result.stdout, /^Answers: 0 answered, 1 skipped$/m);
  assert.match(result.stdout, /^Nonblocking observations: 0$/m);
  assert.match(result.stdout, /^Next action: wait$/m);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  assert.equal(requests.length, 1);
  const envelope = JSON.parse(readFileSync(contextPath, "utf8"));
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, submitPath);
  assert.equal(requests[0].headers["content-type"], "application/json");
  assert.equal(requests[0].headers["x-doable-submit-token"], token);
  // Python: hashlib.sha256(json.dumps(submission, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
  // the key Doable MCP sends for submit_code_context_round.
  assert.equal(requests[0].headers["idempotency-key"], `round:direct-round:${EXPECTED_MCP_DIGEST}`);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].body), envelope.submission);
  assert.deepEqual(envelope.submission, {
    round_revision: 1,
    workspace_id: "workspace-safe",
    answers: [{ question_id: "base-question", status: "skipped", findings: [], human_clarifications: [], unknown_reason: unicodeReason }],
    agent_observations: [],
    conflicts: [],
    evidence_references: [],
  });
  const receiptPath = join(requestDirectory, `receipt-r1-${envelope.payload_digest}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.roundId, "direct-round");
  assert.equal(receipt.payloadDigest, envelope.payload_digest);

  // The same digest is not sent twice.
  result = await runHelperResult(submitArgs, environment);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Round already submitted: DQ-DIRECT1 revision 1$/m);
  assert.match(result.stdout, /^Next action: wait$/m);
  assert.equal(requests.length, 1);

  // A rejected token asks for a fresh pull and never echoes the token, even when the server does.
  answerCandidate("The workspace has no scheduling surface.");
  reply = { status: 401, body: { detail: `Submit token ${token} is invalid or expired` } };
  result = await runHelperResult(submitArgs, environment);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^Submit token rejected or expired: pull the round again \(get_code_context_round \+ record-round\), then run submit again\.$/m);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  assert.equal(requests.length, 2);
  assert.equal(readdirSync(requestDirectory).filter((name) => name.startsWith("receipt-r1-")).length, 1);

  // A validation error shows the sanitized server detail.
  reply = { status: 422, body: { detail: [{ loc: ["body", "answers", 0], msg: "unknown question", type: "value_error" }, { msg: `echo ${token}` }] } };
  result = await runHelperResult(submitArgs, environment);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Submission rejected \(HTTP 422\): body\.answers\.0: unknown question; echo \[credential redacted\]\. Repair/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);

  reply = { status: 409, body: { detail: "Round revision changed" } };
  result = await runHelperResult(submitArgs, environment);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Submission conflict \(HTTP 409\): Round revision changed\. Pull the round again/);
  assert.equal(readdirSync(requestDirectory).filter((name) => name.startsWith("receipt-r1-")).length, 1);

  // The MCP fallback still records the submission from the default context file.
  const mcpResponsePath = join(testRoot, "mcp-submission-response.json");
  writeFileSync(mcpResponsePath, JSON.stringify({ round: { id: "direct-round", state: "ready_to_create" } }));
  await runHelper(["build-submission", "--candidate", candidatePath, "--state", statePath], environment);
  const recordOutput = await runHelper(
    ["record-submission", "--candidate", candidatePath, "--response", mcpResponsePath, "--state", statePath],
    environment,
  );
  assert.match(recordOutput, /^Round submitted: DQ-DIRECT1 revision 1$/m);
  assert.equal(readdirSync(requestDirectory).filter((name) => name.startsWith("receipt-r1-")).length, 2);
});
