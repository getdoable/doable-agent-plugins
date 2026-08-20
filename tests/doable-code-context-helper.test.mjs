import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
  await runHelper(["build-workspace-profile", "--state", statePath, "--output", profilePayloadPath], environment);
  const refreshEnvelope = JSON.parse(readFileSync(profilePayloadPath, "utf8"));
  assert.equal(refreshEnvelope.profile.round_code, "DQ-7F3K");
  assert.equal(refreshEnvelope.profile.material_change_approved, false);
  await runHelper(
    ["record-workspace-sync", "--state", statePath, "--payload", profilePayloadPath, "--response", profileResponsePath],
    environment,
  );
  privateState = JSON.parse(readFileSync(statePath, "utf8"));

  const rootRoundResponsePath = join(testRoot, "mcp-root-round-response.json");
  writeFileSync(
    rootRoundResponsePath,
    JSON.stringify({
      round_id: "round-root",
      round_code: "DQ-ROOT99",
      workspace_id: serverWorkspaceId,
      revision: 1,
      status: "open_for_agent",
      feature_scope: "Staff promotion creation",
      prior_round_context: [],
      questions: [
        {
          id: "question-root-context",
          purpose: "base_context",
          question: "Test staff promotion creation.",
          why: "",
          answer_requirements: "",
          required: true,
          scope_hints: { surfaces: ["promotion-management"], repo_refs: [] },
        },
      ],
    }),
  );
  await runHelper(
    ["record-round", "--code", "DQ-ROOT99", "--response", rootRoundResponsePath, "--state", statePath],
    environment,
  );

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
      prior_round_context: [
        {
          round_code: "DQ-PRIOR1",
          revision: 1,
          feature_scope: "Staff promotion creation",
          items: [
            {
              question: "Which roles can create promotions?",
              resolution: "answered",
              findings: [
                {
                  statement: "Staff users with promotion-management access can open the creation form.",
                  truth_plane: "implemented_behavior",
                  source_type: "code",
                  observable_anchors: ["Create promotion"],
                },
              ],
              human_clarifications: [],
            },
          ],
        },
      ],
      questions: [
        {
          id: "question-save-label",
          purpose: "supplemental",
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
  await runHelper(["record-round", "--code", "DQ-7F3K", "--response", roundResponsePath, "--state", statePath], environment);
  const recordedRound = JSON.parse(readFileSync(
    join(testRoot, ".doable", "requests", "DQ-7F3K", "round-r1.json"),
    "utf8",
  ));
  assert.equal(recordedRound.priorRoundContext.length, 1);
  assert.equal(recordedRound.priorRoundContext[0].roundCode, "DQ-PRIOR1");
  assert.equal(recordedRound.priorRoundContext[0].items[0].findings[0].truthPlane, "implemented_behavior");
  const submissionPath = join(testRoot, ".doable", "requests", "DQ-7F3K", "submission-r1.json");
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

  const externalSnakeCaseAnchor = structuredClone(submission);
  externalSnakeCaseAnchor.answers[0].findings[0].observableAnchors = ["external_status_code"];
  writeFileSync(submissionPath, `${JSON.stringify(externalSnakeCaseAnchor, null, 2)}\n`);
  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);
  writeFileSync(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);

  await runHelper(["validate-submission", "--state", statePath, "--candidate", submissionPath], environment);
  const submissionPayloadPath = join(testRoot, ".doable", "requests", "DQ-7F3K", "safe-submission-r1.json");
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
    /safe submission payload changed after validation/i,
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
  assert.equal(JSON.parse(readFileSync(originPath, "utf8")).status, "ready_to_create");

  const finalizeResponsePath = join(testRoot, "mcp-finalize-response.json");
  writeFileSync(
    finalizeResponsePath,
    JSON.stringify({
      round_id: "round-agent-safe",
      mode: "create",
      trd_id: "trd-agent-safe",
      trd_session_id: "session-agent-safe",
    }),
  );
  const finalizeOutput = await runHelper(
    ["record-finalize", "--code", "DQ-AGENT1", "--response", finalizeResponsePath],
    environment,
  );
  assert.match(finalizeOutput, /TRD mode: create/);
  const receipt = JSON.parse(
    readFileSync(
      join(testRoot, ".doable", "requests", "DQ-AGENT1", "finalize-receipt.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.trdId, "trd-agent-safe");
  assert.equal(receipt.trdSessionId, "session-agent-safe");
});
