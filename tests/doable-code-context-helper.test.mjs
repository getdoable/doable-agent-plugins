import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
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

function jsonResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
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

  let incomingClientWorkspaceId;
  let serverClientWorkspaceId;
  const serverWorkspaceId = "workspace-server-safe";
  let capturedProfile;
  let capturedSubmission;
  let submissionCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    assert.match(request.headers.authorization || "", /^Bearer /);
    if (request.method === "POST" && request.url === "/code-context/workspaces/handshake") {
      assert.equal(body.round_code, "DQ-7F3K");
      incomingClientWorkspaceId = body.local_workspace_id;
      return jsonResponse(response, 200, {
        organization: { id: "org-safe", display_name: "Example Org" },
        workspace: capturedProfile
          ? {
              id: serverWorkspaceId,
              client_workspace_id: serverClientWorkspaceId,
              display_name: capturedProfile.display_name,
              profile_revision: capturedProfile.profile_revision,
              profile_fingerprint: capturedProfile.profile_fingerprint,
              repositories: capturedProfile.repositories,
            }
          : null,
      });
    }
    const expectedClientWorkspaceId = serverClientWorkspaceId || incomingClientWorkspaceId;
    if (request.method === "PUT" && request.url === `/code-context/workspaces/${expectedClientWorkspaceId}/profile`) {
      assert.equal(body.client_workspace_id, expectedClientWorkspaceId);
      if (!capturedProfile) {
        assert.equal(body.round_code, "DQ-7F3K");
        assert.equal(body.material_change_approved, true);
      } else {
        // An existing workspace does not prove that this round is bound. The
        // idempotent profile sync must retain the copy-prompt round code.
        assert.equal(body.round_code, "DQ-7F3K");
        assert.equal(body.material_change_approved, false);
      }
      capturedProfile = body;
      serverClientWorkspaceId ||= body.client_workspace_id;
      return jsonResponse(response, 200, {
        workspace: { id: serverWorkspaceId, client_workspace_id: serverClientWorkspaceId },
      });
    }
    if (request.method === "GET" && request.url === "/code-context/rounds/by-code/DQ-7F3K") {
      return jsonResponse(response, 200, {
        round_id: "round-safe",
        round_code: "DQ-7F3K",
        workspace_id: serverWorkspaceId,
        revision: 1,
        status: "open_for_agent",
        feature_scope: "Staff promotion creation",
        questions: [
          {
            id: "question-save-label",
            purpose: "base_context",
            question: "What exact label submits the promotion creation form?",
            // Platform-user questions may intentionally omit planner-authored
            // rationale and answer expectations.
            why: "",
            answer_requirements: "",
            required: true,
            scope_hints: {
              surfaces: ["promotion-management"],
              repo_refs: [capturedProfile.repositories[0].repo_ref],
            },
          },
        ],
      });
    }
    if (request.method === "POST" && request.url === "/code-context/rounds/round-safe/submissions") {
      submissionCalls += 1;
      capturedSubmission = body;
      return jsonResponse(response, 201, { accepted: true });
    }
    return jsonResponse(response, 404, { detail: "not found" });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  t.after(() => server.close());
  const address = server.address();
  const environment = {
    TEST_WORKSPACE: testRoot,
    DOABLE_API_KEY: "local-test-credential",
    DOABLE_API_BASE_URL: `http://127.0.0.1:${address.port}`,
  };

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
    ["prepare-workspace", "--candidate", candidatePath, "--state", statePath, "--round-code", "DQ-7F3K"],
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
    runHelper(["pull-round", "--code", "DQ-7F3K", "--state", statePath], environment),
    /awaiting workspace sync/i,
  );

  await assert.rejects(
    runHelper(["sync-workspace", "--state", statePath], environment),
    /approved/i,
  );
  await runHelper(["sync-workspace", "--state", statePath, "--approved"], environment);
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
    ["prepare-workspace", "--candidate", candidatePath, "--state", statePath, "--round-code", "DQ-7F3K"],
    environment,
  );
  assert.match(refreshOutput, /Material profile approval required: no/);
  await runHelper(["sync-workspace", "--state", statePath], environment);
  privateState = JSON.parse(readFileSync(statePath, "utf8"));

  await runHelper(["pull-round", "--code", "DQ-7F3K", "--state", statePath], environment);
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
  await runHelper(["submit", "--state", statePath, "--candidate", submissionPath], environment);
  await runHelper(["submit", "--state", statePath, "--candidate", submissionPath], environment);
  assert.equal(submissionCalls, 1);
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
    runHelper(["submit", "--state", statePath, "--candidate", submissionPath], environment),
    /already submitted with a different payload/i,
  );

  const originalRepoRef = privateState.repositories[0].repoRef;
  rmSync(join(testRoot, ".doable"), { recursive: true, force: true });
  const recoveryOutput = await runHelper(
    ["prepare-workspace", "--candidate", candidatePath, "--state", statePath, "--round-code", "DQ-7F3K"],
    environment,
  );
  assert.match(recoveryOutput, /Material profile approval required: no/);
  const recoveredState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(recoveredState.workspace.serverId, serverWorkspaceId);
  assert.equal(recoveredState.workspace.clientRef, serverClientWorkspaceId);
  assert.equal(recoveredState.workspace.pendingRoundCode, "DQ-7F3K");
  assert.equal(recoveredState.repositories[0].repoRef, originalRepoRef);
  assert.deepEqual(recoveredState.artifactRoots, [realpathSync(artifactRoot)]);
  await runHelper(["sync-workspace", "--state", statePath], environment);
});

test("agent-origin helper starts and finalizes the exact round", async (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "doable-agent-round-test-"));
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  let startBody;
  let finalizeBody;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    assert.match(request.headers.authorization || "", /^Bearer /);
    if (
      request.method === "POST" &&
      request.url === "/testsuites/ts-agentflow/code-context/rounds/from-agent"
    ) {
      startBody = body;
      return jsonResponse(response, 201, {
        round_id: "round-agent-safe",
        round_code: "DQ-AGENT1",
        workspace_id: null,
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
            scope_hints: { surfaces: [], repo_refs: [] },
          },
        ],
      });
    }
    if (
      request.method === "POST" &&
      request.url === "/testsuites/ts-agentflow/code-context/rounds/round-agent-safe/finalize"
    ) {
      finalizeBody = body;
      return jsonResponse(response, 202, {
        round_id: "round-agent-safe",
        mode: "create",
        trd_id: "trd-agent-safe",
        trd_session_id: "session-agent-safe",
      });
    }
    return jsonResponse(response, 404, { detail: "not found" });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  t.after(() => server.close());
  const address = server.address();
  const environment = {
    TEST_WORKSPACE: testRoot,
    DOABLE_API_KEY: "local-test-credential",
    DOABLE_API_BASE_URL: `http://127.0.0.1:${address.port}`,
  };
  const requestPath = join(testRoot, "request.json");
  writeFileSync(
    requestPath,
    JSON.stringify({
      featureRequest: "Test account recovery",
      userQuestions: ["How is an expired recovery link rejected?"],
    }),
  );

  const startOutput = await runHelper(
    ["start-round", "--suite", "ts-agentflow", "--request", requestPath],
    environment,
  );
  assert.match(startOutput, /Round started: DQ-AGENT1 revision 1/);
  assert.equal(startBody.feature_request, "Test account recovery");
  assert.equal(startBody.user_questions[0].text, "How is an expired recovery link rejected?");
  assert.equal(startBody.workspace_id, undefined);
  const originPath = join(testRoot, ".doable", "requests", "DQ-AGENT1", "agent-origin.json");
  assert.equal(statSync(originPath).mode & 0o777, 0o600);

  const finalizeOutput = await runHelper(
    ["finalize-round", "--code", "DQ-AGENT1", "--mode", "auto"],
    environment,
  );
  assert.match(finalizeOutput, /TRD mode: create/);
  assert.deepEqual(finalizeBody, { mode: "auto" });
  const receipt = JSON.parse(
    readFileSync(
      join(testRoot, ".doable", "requests", "DQ-AGENT1", "finalize-receipt.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.trdId, "trd-agent-safe");
  assert.equal(receipt.trdSessionId, "session-agent-safe");
});
