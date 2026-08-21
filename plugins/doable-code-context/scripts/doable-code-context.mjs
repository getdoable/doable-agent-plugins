#!/usr/bin/env node

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const CLIENT = Object.freeze({ name: "doable-code-context", version: "0.2.3" });
const STATE_SCHEMA_VERSION = "1";
const SUBMISSION_SCHEMA_VERSION = "1";

const TRUTH_PLANES = new Set([
  "implemented_behavior",
  "desired_behavior",
  "artifact_observation",
  "inference",
  "unknown",
]);
const SOURCE_TYPES = new Set([
  "code",
  "human_clarification",
  "artifact",
  "runtime",
  "inference",
]);
const ANSWER_STATUSES = new Set(["answered", "skipped"]);
const ROUND_CODE_RE = /^DQ-[A-Z0-9]{4,16}$/;
const OPAQUE_REPO_RE = /^repo_[a-z0-9]{8,64}$/;
const EVIDENCE_ID_RE = /^ev_[a-z0-9]{8,80}$/;
const FINDING_REF_RE = /^f_[a-z0-9]{8,80}$/;
const JOURNEY_REF_RE = /^j_[a-z0-9_]{1,40}$/;
const JOURNEY_ROLES = new Set(["entry", "precondition", "action", "outcome", "failure"]);
const CONFLICT_SOURCE_TYPES = new Set(["code", "human_clarification", "artifact", "runtime"]);
const INTERNAL_SNAKE_IDENTIFIER_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const CALLABLE_ANCHOR_RE = /\(\s*\)|=>|::/;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    assert(token.startsWith("--"), `Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function requiredOption(options, key) {
  const value = options[key];
  assert(typeof value === "string" && value.length > 0, `Missing --${key}`);
  return value;
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function atomicWrite(path, contents, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temporaryPath, "wx", mode);
  try {
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporaryPath, path);
  chmodSync(path, mode);
}

function atomicWriteJson(path, value, mode = 0o600) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function ensurePrivateIgnore(statePath) {
  const doableDirectory = dirname(statePath);
  const ignorePath = join(doableDirectory, ".gitignore");
  const requiredLines = ["workspace-private.json", "workspace-candidate.json", "requests/"];
  const current = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const lines = new Set(current.split(/\r?\n/).filter(Boolean));
  let changed = false;
  for (const line of requiredLines) {
    if (!lines.has(line)) {
      lines.add(line);
      changed = true;
    }
  }
  if (changed || !existsSync(ignorePath)) {
    atomicWrite(ignorePath, `${[...lines].join("\n")}\n`, 0o644);
  }
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableClone(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableClone(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  const digest = createHash("sha256");
  const file = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(file, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    closeSync(file);
  }
  return digest.digest("hex");
}

function keyedFingerprint(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function string(value, label, { min = 1, max = 2_000 } = {}) {
  assert(typeof value === "string", `${label} must be a string`);
  const trimmed = value.trim();
  assert(trimmed.length >= min && trimmed.length <= max, `${label} must be ${min}-${max} characters`);
  return trimmed;
}

function stringArray(value, label, { min = 0, max = 50, itemMax = 160 } = {}) {
  assert(Array.isArray(value), `${label} must be an array`);
  assert(value.length >= min && value.length <= max, `${label} must contain ${min}-${max} items`);
  return value.map((item, index) => string(item, `${label}[${index}]`, { max: itemMax }));
}

function unique(values, label) {
  assert(new Set(values).size === values.length, `${label} must not contain duplicates`);
  return values;
}

function git(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    const detail = error.stderr?.toString().trim();
    fail(`Git inspection failed for ${root}${detail ? `: ${detail}` : ""}`);
  }
}

function inside(path, root) {
  const relative = path.slice(root.length);
  return path === root || (path.startsWith(root) && relative.startsWith(sep));
}

function sanitizedServerDetail(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/(?:Bearer|Token)\s+\S+/gi, "[credential redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[credential redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240)
    .trim();
}

function readMcpResponse(path, label) {
  const response = readJson(resolve(path), label);
  const error = response?.error;
  assert(
    !error,
    `${label} failed${response?.message ? `: ${sanitizedServerDetail(response.message)}` : ""}`,
  );
  return response;
}

function newRepoRef() {
  return `repo_${randomBytes(8).toString("hex")}`;
}

function validateSafeSlug(value, label) {
  const result = string(value, label, { max: 80 });
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result), `${label} must be a sanitized product identifier`);
  return result;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNoLocalProvenance(value, label, state) {
  const lower = value.toLowerCase();
  for (const repository of state.repositories || []) {
    for (const exact of [repository.path, repository.revision]) {
      if (typeof exact === "string" && exact.length >= 8) {
        assert(!lower.includes(exact.toLowerCase()), `${label} exposes local repository provenance`);
      }
    }
    const identityTokens = [repository.name, basename(repository.path || "")];
    const branch = repository.branch;
    if (typeof branch === "string" && !["main", "master", "trunk", "develop", "detached"].includes(branch.toLowerCase())) {
      identityTokens.push(branch);
    }
    for (const token of identityTokens) {
      if (typeof token !== "string" || token.trim().length < 4) continue;
      const boundary = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(token.trim())}($|[^A-Za-z0-9])`, "i");
      assert(!boundary.test(value), `${label} exposes local repository provenance`);
    }
  }
  for (const privatePath of state.artifactRoots || []) {
    if (typeof privatePath !== "string" || !privatePath) continue;
    assert(!lower.includes(privatePath.toLowerCase()), `${label} exposes a local artifact root`);
  }
  for (const privatePath of state.localEvidencePaths || []) {
    if (typeof privatePath !== "string" || !privatePath) continue;
    assert(!lower.includes(privatePath.toLowerCase()), `${label} exposes local artifact provenance`);
    const privateName = basename(privatePath);
    if (privateName.length < 4) continue;
    const boundary = new RegExp(
      `(^|[^A-Za-z0-9])${escapeRegex(privateName)}($|[^A-Za-z0-9])`,
      "i",
    );
    assert(!boundary.test(value), `${label} exposes a local artifact identity`);
  }
}

function assertSafeText(value, label, state, { max = 2_000 } = {}) {
  const result = string(value, label, { max });
  const forbiddenPatterns = [
    [/(?:^|[^A-Za-z0-9])(?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\Users\\|file:\/\/)/i, "an absolute local path"],
    [/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}/, "a secret-looking token"],
    [/gh[opusr]_[A-Za-z0-9]{16,}/, "a GitHub credential"],
    [/(?:authorization|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/i, "a credential value"],
    [/```|`[^`\n]{12,}`|\b(?:class|function|const|def)\s+[A-Za-z_$][\w$]*\s*(?:\(|\{|=)/, "source-shaped content"],
  ];
  for (const [pattern, description] of forbiddenPatterns) {
    assert(!pattern.test(result), `${label} contains ${description}`);
  }
  assertNoLocalProvenance(result, label, state);
  return result;
}

function assertObservableAnchor(value, label, state, evidenceSymbols) {
  const anchor = assertSafeText(value, label, state, { max: 300 });
  assert(
    !CALLABLE_ANCHOR_RE.test(anchor),
    `${label} "${anchor}" is shaped like an internal callable. Replace it with an externally observable UI label, route, API name, or protocol value, or move the fact to the local ledger.`,
  );
  assert(
    !(INTERNAL_SNAKE_IDENTIFIER_RE.test(anchor) && evidenceSymbols.has(anchor)),
    `${label} "${anchor}" is the local evidence symbol, not an externally observable anchor. Replace it with the API field name, UI label, route, or protocol value established by evidence, or move the fact to the local ledger.`,
  );
  return anchor;
}

function normalizeHandshake(data, localWorkspaceId) {
  const organization = data.organization || {};
  const organizationId = string(
    organization.id || data.organization_id,
    "handshake organization id",
    { max: 160 },
  );
  const displayName = string(
    organization.display_name || organization.displayName || data.organization_display_name || "Doable organization",
    "handshake organization display name",
    { max: 160 },
  );
  const workspace = data.workspace || null;
  const workspaceServerId = workspace
    ? string(workspace.id || workspace.workspace_id, "handshake workspace id", { max: 160 })
    : null;
  const workspaceClientRef = workspace
    ? string(
        workspace.client_workspace_id || workspace.clientWorkspaceId || localWorkspaceId,
        "handshake client workspace id",
        { max: 160 },
      )
    : null;
  const workspaceProfileRevision = workspace?.profile_revision ?? workspace?.profileRevision ?? 0;
  assert(
    Number.isInteger(Number(workspaceProfileRevision)) && Number(workspaceProfileRevision) >= 0,
    "handshake workspace profile revision must be nonnegative",
  );
  const workspaceProfileFingerprint = workspace?.profile_fingerprint || workspace?.profileFingerprint || null;
  const workspaceDisplayName = workspace?.display_name || workspace?.displayName || null;
  const workspaceRepositories = Array.isArray(workspace?.repositories)
    ? workspace.repositories
    : [];
  return {
    organizationId,
    displayName,
    workspaceServerId,
    workspaceClientRef,
    workspaceProfileRevision: Number(workspaceProfileRevision),
    workspaceProfileFingerprint,
    workspaceDisplayName,
    workspaceRepositories,
  };
}

function readState(path) {
  const state = readJson(path, "workspace private state");
  assert(state.schemaVersion === STATE_SCHEMA_VERSION, `workspace state schema must be ${STATE_SCHEMA_VERSION}`);
  assert(typeof state.workspace?.localId === "string", "workspace state is missing local identity");
  state.workspace.clientRef ||= state.workspace.localId;
  assert(typeof state.workspace.clientRef === "string", "workspace state is missing client workspace identity");
  assert(
    state.workspace.serverId === null || typeof state.workspace.serverId === "string",
    "workspace state has an invalid server identity",
  );
  assert(typeof state.organization?.id === "string", "workspace state is missing organization binding");
  assert(typeof state.privateFingerprintKey === "string", "workspace state is missing private fingerprint key");
  assert(Array.isArray(state.repositories), "workspace state repositories must be an array");
  state.artifactRoots ||= [];
  assert(Array.isArray(state.artifactRoots), "workspace state artifactRoots must be an array");
  return state;
}

function inspectArtifactRoots(value) {
  assert(Array.isArray(value), "workspace candidate artifactRoots must be an array");
  const roots = value.map((candidate, index) => {
    const declaredPath = string(candidate, `artifactRoots[${index}]`, { max: 4_096 });
    assert(isAbsolute(declaredPath), `artifactRoots[${index}] must be an absolute directory supplied by the user`);
    const root = realpathSync(declaredPath);
    assert(statSync(root).isDirectory(), `artifact root is not a directory: ${root}`);
    assert(dirname(root) !== root, "the filesystem root cannot be used as an artifact root");
    return root;
  });
  return unique(roots, "artifact roots");
}

function inspectRepository(candidate, existingState, privateKey, remoteRepositories = []) {
  const path = realpathSync(string(candidate.path, "repository path", { max: 4_096 }));
  assert(statSync(path).isDirectory(), `repository path is not a directory: ${path}`);
  const gitRoot = realpathSync(git(path, ["rev-parse", "--show-toplevel"]));
  assert(path === gitRoot, `repository path must be the Git root: ${path}`);
  const requestedRepoRef = candidate.repoRef;
  if (requestedRepoRef !== undefined) {
    assert(OPAQUE_REPO_RE.test(requestedRepoRef), "candidate repoRef is not a valid opaque reference");
  }
  const productRole = validateSafeSlug(candidate.productRole, "repository productRole");
  const surfaces = unique(
    stringArray(candidate.surfaces, "repository surfaces", { min: 1, max: 40, itemMax: 80 }).map((surface, index) =>
      validateSafeSlug(surface, `repository surfaces[${index}]`),
    ),
    "repository surfaces",
  ).sort();
  const userFacing = Boolean(candidate.userFacing);
  const safeDescription = string(candidate.safeDescription, "repository safeDescription", { max: 320 });
  const byPath = existingState?.repositories?.find((repository) => repository.path === path);
  const byRef = requestedRepoRef
    ? existingState?.repositories?.find((repository) => repository.repoRef === requestedRepoRef)
    : undefined;
  const remoteByRef = requestedRepoRef
    ? remoteRepositories.find((repository) => repository.repo_ref === requestedRepoRef)
    : undefined;
  assert(
    !requestedRepoRef || byRef || remoteByRef,
    "candidate repoRef is not known to the local or remote workspace map",
  );
  assert(!(byPath && byRef && byPath.repoRef !== byRef.repoRef), "repository identity is ambiguous; repair the candidate repoRef");
  const remoteMatches = remoteRepositories.filter((repository) => {
    const remoteSurfaces = Array.isArray(repository.surfaces)
      ? [...repository.surfaces].sort()
      : [];
    return (
      OPAQUE_REPO_RE.test(repository.repo_ref || "") &&
      repository.product_role === productRole &&
      stableJson(remoteSurfaces) === stableJson(surfaces) &&
      Boolean(repository.user_facing) === userFacing &&
      (repository.description || "") === safeDescription
    );
  });
  assert(
    requestedRepoRef || byPath || byRef || remoteMatches.length <= 1,
    "multiple remote repository identities match this routing role; provide the intended existing repoRef",
  );
  const repoRef =
    requestedRepoRef ||
    byPath?.repoRef ||
    byRef?.repoRef ||
    remoteMatches[0]?.repo_ref ||
    newRepoRef();
  const revision = git(path, ["rev-parse", "HEAD"]);
  const branch = git(path, ["branch", "--show-current"], { allowFailure: true }) || "detached";
  const status = git(path, ["status", "--porcelain=v1"], { allowFailure: true });
  return {
    repoRef,
    name: string(candidate.name, "repository name", { max: 240 }),
    path,
    branch,
    revision,
    dirty: Boolean(status),
    localStatusFingerprint: keyedFingerprint(privateKey, stableJson({ revision, status })),
    productRole,
    surfaces,
    userFacing,
    safeDescription,
  };
}

function buildRemoteProfile(state) {
  const displayName = assertSafeText(
    state.workspace.safeDisplayName,
    "workspace safe display name",
    state,
    { max: 120 },
  );
  const repositories = state.repositories.map((repository) => ({
    repo_ref: repository.repoRef,
    product_role: repository.productRole,
    surfaces: repository.surfaces,
    user_facing: repository.userFacing,
    description: assertSafeText(repository.safeDescription, "repository description", state, { max: 320 }),
    fingerprint: keyedFingerprint(
      state.privateFingerprintKey,
      stableJson({ repoRef: repository.repoRef, localStatusFingerprint: repository.localStatusFingerprint }),
    ),
  }));
  const materialShape = {
    displayName,
    repositories: repositories.map(({ fingerprint: _fingerprint, ...repository }) => repository),
  };
  const materialFingerprint = keyedFingerprint(state.privateFingerprintKey, stableJson(materialShape));
  const profileFingerprint = keyedFingerprint(
    state.privateFingerprintKey,
    stableJson({ displayName, repositories }),
  );
  const prior = state.profile || {};
  const changed = prior.profileFingerprint !== profileFingerprint;
  return {
    profileRevision: changed ? Math.max(1, Number(prior.profileRevision || 0) + 1) : Number(prior.profileRevision || 1),
    displayName,
    materialFingerprint,
    profileFingerprint,
    repositories,
  };
}

function remoteMaterialMatches(profile, handshake) {
  if (handshake.workspaceProfileRevision < 1 || handshake.workspaceDisplayName === null) {
    return false;
  }
  const canonicalRepositories = (repositories) =>
    repositories
      .map((repository) => ({
        repo_ref: repository.repo_ref,
        product_role: repository.product_role,
        surfaces: [...(repository.surfaces || [])].sort(),
        user_facing: Boolean(repository.user_facing),
        description: repository.description || "",
      }))
      .sort((left, right) => left.repo_ref.localeCompare(right.repo_ref));
  return stableJson({
    displayName: profile.displayName,
    repositories: canonicalRepositories(profile.repositories),
  }) === stableJson({
    displayName: handshake.workspaceDisplayName,
    repositories: canonicalRepositories(handshake.workspaceRepositories),
  });
}

function assertRemotePayloadSafe(value, state, label = "remote payload", key = "") {
  const forbiddenKeys = new Set([
    "path",
    "local_path",
    "repo_name",
    "repository_name",
    "branch",
    "commit",
    "sha",
    "revision_hash",
    "symbol",
    "start_line",
    "end_line",
    "source_text",
    "snippet",
  ]);
  assert(!forbiddenKeys.has(key), `${label} contains forbidden key ${key}`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertRemotePayloadSafe(item, state, `${label}[${index}]`, key));
  } else if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      assertRemotePayloadSafe(childValue, state, `${label}.${childKey}`, childKey);
    }
  } else if (typeof value === "string") {
    assertSafeText(value, label, state, { max: 8_000 });
  }
}

function prepareWorkspace(options) {
  const candidatePath = resolve(requiredOption(options, "candidate"));
  const handshakePath = resolve(requiredOption(options, "handshake"));
  const statePath = resolve(options.state || ".doable/workspace-private.json");
  const candidate = readJson(candidatePath, "workspace candidate");
  chmodSync(candidatePath, 0o600);
  const repositoryCandidates = candidate.repositories || [];
  assert(Array.isArray(repositoryCandidates), "workspace candidate repositories must be an array");
  const existingState = existsSync(statePath) ? readState(statePath) : null;
  const artifactRoots = inspectArtifactRoots(
    candidate.artifactRoots === undefined
      ? existingState?.artifactRoots || []
      : candidate.artifactRoots,
  );
  assert(
    repositoryCandidates.length > 0 || artifactRoots.length > 0,
    "workspace candidate needs at least one repository or explicitly supplied artifact root",
  );
  const localWorkspaceId = existingState?.workspace?.localId || randomUUID();
  const privateFingerprintKey = existingState?.privateFingerprintKey || randomBytes(32).toString("hex");
  const roundCode = options["round-code"]
    ? string(options["round-code"], "round code", { max: 64 }).toUpperCase()
    : null;
  if (roundCode) assert(ROUND_CODE_RE.test(roundCode), "round code has an invalid format");
  const handshake = normalizeHandshake(
    readMcpResponse(handshakePath, "MCP workspace handshake"),
    localWorkspaceId,
  );
  if (existingState) {
    assert(
      existingState.organization.id === handshake.organizationId,
      "the configured API key belongs to a different organization than this workspace state",
    );
  }
  const repositories = repositoryCandidates.map((repository) =>
    inspectRepository(
      repository,
      existingState,
      privateFingerprintKey,
      handshake.workspaceRepositories,
    ),
  );
  unique(repositories.map((repository) => repository.path), "repository paths");
  unique(repositories.map((repository) => repository.repoRef), "repository repoRefs");

  const localProfileRevision = Number(existingState?.profile?.profileRevision || 0);
  const useRemoteProfileBase = handshake.workspaceProfileRevision > localProfileRevision;
  let remoteProfileAhead = Boolean(existingState) && useRemoteProfileBase;
  const priorProfile = useRemoteProfileBase
    ? {
        profileRevision: handshake.workspaceProfileRevision,
        profileFingerprint: handshake.workspaceProfileFingerprint,
        materialFingerprint: null,
        repositories: [],
      }
    : existingState?.profile ||
      (handshake.workspaceProfileRevision > 0
        ? {
            profileRevision: handshake.workspaceProfileRevision,
            profileFingerprint: handshake.workspaceProfileFingerprint,
            materialFingerprint: null,
            repositories: [],
          }
        : null);
  let state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    client: CLIENT,
    organization: { id: handshake.organizationId, displayName: handshake.displayName },
    workspace: {
      localId: localWorkspaceId,
      clientRef: handshake.workspaceClientRef || existingState?.workspace?.clientRef || localWorkspaceId,
      serverId: handshake.workspaceServerId || existingState?.workspace?.serverId || null,
      pendingRoundCode:
        roundCode || existingState?.workspace?.pendingRoundCode || null,
      remoteProfileAhead,
      label: string(candidate.workspaceLabel || basename(dirname(statePath)), "workspace label", { max: 240 }),
      safeDisplayName: string(candidate.safeDisplayName, "workspace safe display name", { max: 120 }),
    },
    privateFingerprintKey,
    repositories,
    artifactRoots,
    profile: priorProfile,
    sync: remoteProfileAhead ? null : existingState?.sync || null,
  };
  state.profile = buildRemoteProfile(state);
  const recoveredMatchingRemoteProfile = remoteMaterialMatches(state.profile, handshake);
  if (recoveredMatchingRemoteProfile) {
    // A deleted/stale private file changes the local HMAC key, so its opaque
    // fingerprints cannot equal the server's. The sanitized material itself
    // is still comparable. An exact, unambiguous match is a revision refresh,
    // not a new disclosure or material profile change.
    state.sync = {
      materialFingerprint: state.profile.materialFingerprint,
      profileFingerprint: handshake.workspaceProfileFingerprint || state.profile.profileFingerprint,
      payloadDigest: null,
      syncedAt: null,
    };
    state.workspace.remoteProfileAhead = false;
    remoteProfileAhead = false;
  }
  const requiresApproval = state.sync?.materialFingerprint !== state.profile.materialFingerprint;
  assertRemotePayloadSafe(
    {
      profile_revision: state.profile.profileRevision,
      display_name: state.profile.displayName,
      profile_fingerprint: state.profile.profileFingerprint,
      repositories: state.profile.repositories,
    },
    state,
  );
  ensurePrivateIgnore(statePath);
  atomicWriteJson(statePath, state);

  console.log(`Organization: ${state.organization.displayName}`);
  console.log(`Workspace binding: ${state.workspace.serverId || "pending first profile sync"}`);
  console.log(`Shared workspace name: ${state.profile.displayName}`);
  console.log(`Repositories mapped: ${repositories.length}`);
  console.log(`Private artifact roots: ${artifactRoots.length}`);
  console.log(`Product surfaces: ${unique(repositories.flatMap((repository) => repository.surfaces), "product surfaces").sort().join(", ")}`);
  console.log("Shared routing profile:");
  for (const repository of repositories) {
    console.log(
      `- ${repository.productRole}; surfaces: ${repository.surfaces.join(", ")}; user-facing: ${repository.userFacing ? "yes" : "no"}; ${repository.safeDescription}`,
    );
  }
  console.log(`Material profile approval required: ${requiresApproval ? "yes" : "no"}`);
  if (remoteProfileAhead) {
    console.log("Remote profile changed since this local state; approval is required before replacing it.");
  }
  console.log(`Private state: ${statePath}`);
}

function buildWorkspaceProfile(options) {
  const statePath = resolve(options.state || ".doable/workspace-private.json");
  const outputPath = resolve(requiredOption(options, "output"));
  const state = readState(statePath);
  const profile = buildRemoteProfile(state);
  state.profile = profile;
  const requiresApproval = state.sync?.materialFingerprint !== profile.materialFingerprint;
  assert(!requiresApproval || options.approved === true, "material workspace profile changes require --approved after user review");
  const payload = {
    client_workspace_id: state.workspace.clientRef,
    display_name: profile.displayName,
    profile_revision: profile.profileRevision,
    profile_fingerprint: profile.profileFingerprint,
    material_change_approved: options.approved === true,
    repositories: profile.repositories,
    ...(state.workspace.pendingRoundCode
      ? { round_code: state.workspace.pendingRoundCode }
      : {}),
  };
  assertRemotePayloadSafe(payload, state);
  const payloadDigest = sha256(stableJson(payload));
  atomicWriteJson(statePath, state);
  atomicWriteJson(outputPath, {
    workspace_ref: state.workspace.clientRef,
    profile: payload,
    payload_digest: payloadDigest,
  });
  console.log(`Workspace profile ready: ${outputPath}`);
  console.log(`Workspace ref: ${state.workspace.clientRef}`);
  console.log(`Profile revision: ${profile.profileRevision}`);
}

function recordWorkspaceSync(options) {
  const statePath = resolve(options.state || ".doable/workspace-private.json");
  const payloadPath = resolve(requiredOption(options, "payload"));
  const responsePath = resolve(requiredOption(options, "response"));
  const state = readState(statePath);
  const envelope = readJson(payloadPath, "workspace profile payload");
  assert(envelope.workspace_ref === state.workspace.clientRef, "workspace profile payload belongs to a different workspace");
  assert(envelope.profile && typeof envelope.profile === "object", "workspace profile payload is missing profile");
  const payloadDigest = sha256(stableJson(envelope.profile));
  assert(envelope.payload_digest === payloadDigest, "workspace profile payload digest changed");
  const response = readMcpResponse(responsePath, "MCP workspace sync");
  const remoteWorkspace = response.workspace || response;
  state.workspace.serverId = string(
    remoteWorkspace.id || remoteWorkspace.workspace_id,
    "synced workspace id",
    { max: 160 },
  );
  state.workspace.clientRef = string(
    remoteWorkspace.client_workspace_id || remoteWorkspace.clientWorkspaceId || state.workspace.clientRef,
    "synced client workspace id",
    { max: 160 },
  );
  state.workspace.pendingRoundCode = null;
  state.workspace.remoteProfileAhead = false;
  state.sync = {
    materialFingerprint: state.profile.materialFingerprint,
    profileFingerprint: state.profile.profileFingerprint,
    payloadDigest,
    syncedAt: new Date().toISOString(),
  };
  atomicWriteJson(statePath, state);
  console.log(`Workspace connected: ${state.workspace.serverId}`);
  console.log(`Profile revision: ${state.profile.profileRevision}`);
  console.log(`Product surfaces: ${unique(state.repositories.flatMap((repository) => repository.surfaces), "product surfaces").sort().join(", ")}`);
}

function watchAction(roundUse, status, openQuestions) {
  if (["creating", "consumed", "cancelled"].includes(status)) {
    return roundUse === "follow_up" ? "wait" : "stop";
  }
  if (status === "open_for_agent" && openQuestions.length > 0) return "answer";
  return "wait";
}

function normalizeEstablishedQuestion(question, index) {
  assert(question && typeof question === "object" && !Array.isArray(question), `established_context[${index}] must be an object`);
  const status = string(question.status, `established_context[${index}] status`, { max: 20 });
  assert(
    ["answered", "skipped", "deferred", "waived"].includes(status),
    `established_context[${index}] has an invalid status`,
  );
  const purpose = question.purpose || "supplemental";
  assert(
    purpose === "base_context" || purpose === "supplemental",
    `established_context[${index}] has an invalid purpose`,
  );
  const answer = question.answer && typeof question.answer === "object" ? question.answer : null;
  const findings = Array.isArray(answer?.findings) ? answer.findings : [];
  return {
    id: string(question.id || question.question_id, `established_context[${index}] id`, { max: 160 }),
    purpose,
    question: string(question.question, `established_context[${index}] question`, { max: 4_000 }),
    status,
    skipReason: string(question.skip_reason ?? question.skipReason ?? "", `established_context[${index}] skip reason`, { min: 0, max: 2_000 }),
    answer: answer
      ? {
          findings: findings.map((finding, findingIndex) => ({
            findingRef: finding.finding_ref ?? finding.findingRef ?? null,
            statement: string(
              finding.statement,
              `established_context[${index}].findings[${findingIndex}] statement`,
              { max: 4_000 },
            ),
            truthPlane: string(
              finding.truth_plane ?? finding.truthPlane ?? "unknown",
              `established_context[${index}].findings[${findingIndex}] truth plane`,
              { max: 40 },
            ),
            sourceType: string(
              finding.source_type ?? finding.sourceType ?? "inference",
              `established_context[${index}].findings[${findingIndex}] source type`,
              { max: 40 },
            ),
            observableAnchors: stringArray(
              finding.observable_anchors ?? finding.observableAnchors ?? [],
              `established_context[${index}].findings[${findingIndex}] anchors`,
              { max: 20, itemMax: 160 },
            ),
          })),
          humanClarifications: Array.isArray(answer.human_clarifications || answer.humanClarifications)
            ? (answer.human_clarifications || answer.humanClarifications).map((item, clarificationIndex) => ({
                question: string(
                  item.question,
                  `established_context[${index}].human_clarifications[${clarificationIndex}] question`,
                  { max: 2_000 },
                ),
                answer: string(
                  item.answer,
                  `established_context[${index}].human_clarifications[${clarificationIndex}] answer`,
                  { max: 4_000 },
                ),
              }))
            : [],
          unknownReason: string(
            answer.unknown_reason ?? answer.unknownReason ?? "",
            `established_context[${index}] unknown reason`,
            { min: 0, max: 2_000 },
          ),
        }
      : null,
  };
}

function emptyAnswer(question) {
  return {
    questionId: question.id,
    status: null,
    findings: [],
    humanClarifications: [],
  };
}

function reconcileCandidateAnswers(existingAnswers, openQuestions) {
  const openIds = new Set(openQuestions.map((question) => question.id));
  const kept = (Array.isArray(existingAnswers) ? existingAnswers : []).filter((answer) =>
    openIds.has(answer.questionId),
  );
  const keptIds = new Set(kept.map((answer) => answer.questionId));
  const added = openQuestions.filter((question) => !keptIds.has(question.id)).map(emptyAnswer);
  return [...kept, ...added];
}

function normalizeRound(data, state, requestedCode) {
  const round = data.round || data;
  const id = string(round.round_id || round.id, "round id", { max: 160 });
  const code = string(round.round_code || round.code, "round code", { max: 64 });
  const connectionCode = string(
    round.connection_round_code || round.connectionRoundCode || code,
    "connection round code",
    { max: 64 },
  );
  assert(
    connectionCode.toLowerCase() === requestedCode.toLowerCase(),
    "Doable returned a different context connection",
  );
  const workspaceId = round.workspace_id || round.workspaceId || "";
  const revision = Number(round.revision);
  assert(Number.isInteger(revision) && revision > 0, "round revision must be a positive integer");
  const roundUse = round.round_use || round.roundUse || "pre_create";
  assert(
    roundUse === "pre_create" || roundUse === "follow_up",
    "round use must be pre_create or follow_up",
  );
  assert(
    code.toLowerCase() === requestedCode.toLowerCase() || roundUse === "follow_up",
    "Doable returned a different pre-create round code",
  );
  const rawTestSuitePublicId = round.test_suite_public_id || round.testSuitePublicId || "";
  const testSuitePublicId = rawTestSuitePublicId
    ? string(rawTestSuitePublicId, "test suite public id", { max: 160 })
    : null;
  if (roundUse === "follow_up") {
    assert(testSuitePublicId, "follow-up round is missing its test suite public id");
  }
  const status = round.status || "open_for_agent";
  assert(
    ["open_for_agent", "needs_attention", "ready_to_create", "creating", "consumed", "cancelled"].includes(status),
    `round cannot be watched by the coding agent (status: ${status})`,
  );
  if (!["creating", "consumed", "cancelled"].includes(status)) {
    assert(typeof workspaceId === "string" && workspaceId.length > 0, "round workspace id must be a string");
    assert(workspaceId === state.workspace.serverId, "the requested round belongs to a different workspace");
  } else if (workspaceId) {
    assert(workspaceId === state.workspace.serverId, "the requested round belongs to a different workspace");
  }
  const featureScope = string(round.feature_scope || round.featureScope, "round feature scope", { max: 2_000 });
  assert(Array.isArray(round.questions), "round questions must be an array");
  const establishedContext = Array.isArray(round.established_context || round.establishedContext)
    ? (round.established_context || round.establishedContext).map(normalizeEstablishedQuestion)
    : [];
  const questions = round.questions.map((question, index) => {
    const scopeHints = question.scope_hints || question.scopeHints || {};
    const repoRefs = stringArray(scopeHints.repo_refs || scopeHints.repoRefs || [], `questions[${index}] repo refs`, { max: 100 });
    for (const repoRef of repoRefs) {
      assert(state.repositories.some((repository) => repository.repoRef === repoRef), `question ${index + 1} refers to an unknown repository`);
    }
    const purpose = question.purpose || "supplemental";
    assert(
      purpose === "base_context" || purpose === "supplemental",
      `questions[${index}] has an invalid purpose`,
    );
    return {
      id: string(question.id || question.question_id, `questions[${index}] id`, { max: 160 }),
      purpose,
      question: string(question.question, `questions[${index}] question`, { max: 4_000 }),
      why: string(question.why, `questions[${index}] why`, { min: 0, max: 2_000 }),
      answerRequirements: string(
        question.answer_requirements ?? question.answerRequirements ?? "",
        `questions[${index}] answer requirements`,
        { min: 0, max: 3_000 },
      ),
      required: question.required !== false,
      scopeHints: {
        surfaces: stringArray(scopeHints.surfaces || [], `questions[${index}] surfaces`, { max: 100 }),
        repoRefs,
      },
    };
  });
  unique(questions.map((question) => question.id), "question ids");
  unique(
    [...questions.map((question) => question.id), ...establishedContext.map((question) => question.id)],
    "open and established question ids",
  );
  if (status === "open_for_agent") {
    assert(questions.length > 0, "published round has no open questions");
    const baseCount = [...questions, ...establishedContext].filter(
      (question) => question.purpose === "base_context",
    ).length;
    if (roundUse === "pre_create") {
      assert(baseCount === 1, "pre-create round must contain exactly one base feature context request");
    } else {
      // New follow-up rounds contain only supplements. Accept one legacy base
      // item so an already-published round can still reach a terminal state.
      assert(baseCount <= 1, "follow-up round contains multiple base feature context requests");
    }
  }
  const action = watchAction(roundUse, status, questions);
  return {
    id,
    code,
    connectionCode,
    workspaceId: workspaceId || null,
    revision,
    roundUse,
    testSuitePublicId,
    status,
    action,
    featureScope,
    questions,
    establishedContext,
  };
}

function recordRound(options) {
  const code = string(requiredOption(options, "code"), "round code", { max: 64 }).toUpperCase();
  const responsePath = resolve(requiredOption(options, "response"));
  assert(ROUND_CODE_RE.test(code), "round code has an invalid format");
  const statePath = resolve(options.state || ".doable/workspace-private.json");
  const state = readState(statePath);
  assert(
    !state.workspace.pendingRoundCode,
    `round ${state.workspace.pendingRoundCode || "binding"} is awaiting workspace sync; complete setup first`,
  );
  assert(state.sync?.profileFingerprint === state.profile?.profileFingerprint, "workspace profile is not synced; complete Doable setup first");
  assert(state.workspace.serverId, "workspace has no server binding; sync the workspace profile first");
  const round = normalizeRound(
    readMcpResponse(responsePath, "MCP code-context round"),
    state,
    code,
  );
  const requestDirectory = join(dirname(statePath), "requests", round.code);
  const roundPath = join(requestDirectory, `round-r${round.revision}.json`);
  const candidatePath = join(requestDirectory, `submission-r${round.revision}.json`);
  ensurePrivateIgnore(statePath);
  atomicWriteJson(roundPath, round);
  if (round.action === "answer") {
    if (!existsSync(candidatePath)) {
      atomicWriteJson(candidatePath, {
        schemaVersion: SUBMISSION_SCHEMA_VERSION,
        round: {
          id: round.id,
          code: round.code,
          revision: round.revision,
          workspaceId: round.workspaceId,
        },
        answers: round.questions.map(emptyAnswer),
        agentObservations: [],
        conflicts: [],
        evidence: [],
      });
    } else {
      const candidate = readJson(candidatePath, "submission candidate");
      candidate.answers = reconcileCandidateAnswers(candidate.answers, round.questions);
      atomicWriteJson(candidatePath, candidate);
    }
  }
  if (options.suite) {
    const suiteId = validateSafeSlug(options.suite, "suite id");
    atomicWriteJson(join(requestDirectory, "agent-origin.json"), {
      schemaVersion: "1",
      suiteId,
      roundId: round.id,
      roundCode: round.code,
      revision: round.revision,
      status: round.status,
      action: round.action,
      featureScope: round.featureScope,
      createdAt: new Date().toISOString(),
    });
  }
  console.log(`Round: ${round.code} revision ${round.revision}`);
  if (round.connectionCode !== round.code) {
    console.log(`Connection: ${round.connectionCode}`);
  }
  console.log(`Status: ${round.status}`);
  console.log(`Next action: ${round.action}`);
  console.log(`Scope: ${round.featureScope}`);
  console.log(`Open questions: ${round.questions.length}`);
  console.log(`Established context: ${round.establishedContext.length}`);
  console.log(`Round file: ${roundPath}`);
  console.log(`Submission file: ${candidatePath}`);
}

function remoteEvidenceReference(evidence, state) {
  assert(evidence && typeof evidence === "object" && !Array.isArray(evidence), "evidence item must be an object");
  const id = string(evidence.id, "evidence id", { max: 83 });
  assert(EVIDENCE_ID_RE.test(id), `invalid evidence id: ${id}`);
  const kind = string(evidence.kind, `evidence ${id} kind`, { max: 40 });
  assert(SOURCE_TYPES.has(kind), `evidence ${id} kind must be a source type`);
  assert(
    ["code", "artifact", "runtime"].includes(kind),
    `evidence ${id} kind must be code, artifact, or runtime`,
  );
  const hasRepoRef = evidence.repoRef !== undefined && evidence.repoRef !== null && evidence.repoRef !== "";
  const repoRef = hasRepoRef
    ? string(evidence.repoRef, `evidence ${id} repoRef`, { max: 64 })
    : null;
  if (repoRef) assert(OPAQUE_REPO_RE.test(repoRef), `evidence ${id} has an invalid repoRef`);
  const repository = repoRef
    ? state.repositories.find((item) => item.repoRef === repoRef)
    : null;
  if (repoRef) assert(repository, `evidence ${id} refers to an unknown repository`);
  if (kind === "code") {
    assert(repository, `code evidence ${id} requires a mapped repoRef`);
  } else if (!repository) {
    assert(
      (state.artifactRoots || []).length > 0,
      `repo-free ${kind} evidence ${id} requires an explicitly supplied artifact root`,
    );
  }
  if (kind === "code" && evidence.revision !== undefined) {
    assert(evidence.revision === repository.revision, `evidence ${id} revision is stale; refresh the workspace evidence`);
  }
  const path = realpathSync(string(evidence.path, `evidence ${id} path`, { max: 4_096 }));
  assert(isAbsolute(path), `evidence ${id} path must be absolute`);
  if (repository) {
    assert(inside(path, repository.path), `evidence ${id} path must stay inside its repository`);
  } else {
    assert(
      state.artifactRoots.some((root) => inside(path, root)),
      `evidence ${id} path must stay inside an explicitly supplied artifact root`,
    );
  }
  assert(statSync(path).isFile(), `evidence ${id} path must be a file`);
  const hasLineSpan = evidence.startLine !== undefined || evidence.endLine !== undefined;
  assert(
    kind !== "code" || hasLineSpan,
    `code evidence ${id} requires a line span`,
  );
  assert(
    !hasLineSpan || (evidence.startLine !== undefined && evidence.endLine !== undefined),
    `evidence ${id} must provide both startLine and endLine`,
  );
  let startLine = null;
  let endLine = null;
  let contentFingerprint;
  if (hasLineSpan) {
    startLine = Number(evidence.startLine);
    endLine = Number(evidence.endLine);
    assert(Number.isInteger(startLine) && startLine > 0, `evidence ${id} startLine must be positive`);
    assert(Number.isInteger(endLine) && endLine >= startLine, `evidence ${id} endLine must be >= startLine`);
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    assert(startLine <= lines.length, `evidence ${id} startLine exceeds the file`);
    const content = lines.slice(startLine - 1, Math.min(endLine, lines.length)).join("\n");
    contentFingerprint = sha256(content);
  } else {
    contentFingerprint = sha256File(path);
  }
  const privateLocator = {
    repoRef,
    path,
    symbol: evidence.symbol || "",
    startLine,
    endLine,
    revision: evidence.revision || repository?.revision || null,
    contentFingerprint,
  };
  return {
    localPath: path,
    localSymbol: evidence.symbol || "",
    reference: {
      evidence_ref_id: id,
      repo_ref: repoRef,
      source_type: kind,
      source_fingerprint: keyedFingerprint(state.privateFingerprintKey, stableJson(privateLocator)),
    },
  };
}

function normalizeClarifications(value, label, state) {
  assert(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => {
    assert(item && typeof item === "object" && !Array.isArray(item), `${label}[${index}] must be an object`);
    return {
      question: assertSafeText(item.question, `${label}[${index}].question`, state, { max: 2_000 }),
      answer: assertSafeText(item.answer, `${label}[${index}].answer`, state, { max: 4_000 }),
    };
  });
}

function normalizeFinding(finding, label, state, evidenceById, clarifications, namespace) {
  assert(finding && typeof finding === "object" && !Array.isArray(finding), `${label} must be an object`);
  const truthPlane = string(finding.truthPlane, `${label}.truthPlane`, { max: 40 });
  const sourceType = string(finding.sourceType, `${label}.sourceType`, { max: 40 });
  assert(TRUTH_PLANES.has(truthPlane), `${label}.truthPlane is invalid`);
  assert(SOURCE_TYPES.has(sourceType), `${label}.sourceType is invalid`);
  const allowedSources = {
    implemented_behavior: new Set(["code"]),
    desired_behavior: new Set(["human_clarification", "artifact"]),
    artifact_observation: new Set(["artifact", "runtime"]),
    inference: new Set(["inference"]),
    unknown: new Set(["inference"]),
  };
  assert(allowedSources[truthPlane].has(sourceType), `${label} has an incompatible truthPlane/sourceType pair`);
  const statement = assertSafeText(finding.statement, `${label}.statement`, state, { max: 1_200 });
  const rawObservableAnchors = unique(
    stringArray(finding.observableAnchors || [], `${label}.observableAnchors`, {
      min: truthPlane === "unknown" || truthPlane === "inference" ? 0 : 1,
      max: 30,
      itemMax: 300,
    }),
    `${label}.observableAnchors`,
  );
  const evidenceRefIds = unique(
    stringArray(finding.evidenceRefIds || [], `${label}.evidenceRefIds`, { max: 40, itemMax: 83 }),
    `${label}.evidenceRefIds`,
  );
  for (const id of evidenceRefIds) {
    assert(evidenceById.has(id), `${label} refers to missing evidence ${id}`);
  }
  const evidenceSymbols = new Set(
    evidenceRefIds
      .map((id) => state.localEvidenceSymbols?.[id])
      .filter((symbol) => typeof symbol === "string" && symbol.length > 0),
  );
  const observableAnchors = rawObservableAnchors.map((anchor, index) =>
    assertObservableAnchor(
      anchor,
      `${label}.observableAnchors[${index}]`,
      state,
      evidenceSymbols,
    ),
  );
  let authorityClarifications = [];
  if (sourceType === "human_clarification") {
    authorityClarifications = clarifications.filter(
      (clarification) => clarification.answer === statement,
    );
    assert(authorityClarifications.length > 0, `${label} human clarification statement must exactly match one submitted answer`);
  } else if (truthPlane !== "unknown") {
    assert(evidenceRefIds.length > 0, `${label} needs at least one evidence reference`);
  }
  const fingerprintParts = evidenceRefIds.map((id) => evidenceById.get(id).source_fingerprint);
  if (sourceType === "human_clarification") fingerprintParts.push(stableJson(authorityClarifications));
  const sourceFingerprint = keyedFingerprint(
    state.privateFingerprintKey,
    stableJson({ statement, truthPlane, sourceType, fingerprintParts }),
  );
  const findingRef = finding.findingRef === undefined
    ? `f_${sha256(stableJson({ namespace, statement, truthPlane, sourceType, fingerprintParts })).slice(0, 16)}`
    : string(finding.findingRef, `${label}.findingRef`, { max: 82 });
  assert(FINDING_REF_RE.test(findingRef), `${label}.findingRef is invalid`);
  const orderFields = [finding.journeyRef, finding.step, finding.role];
  const hasAnyOrderField = orderFields.some((value) => value !== undefined);
  const hasAllOrderFields = orderFields.every((value) => value !== undefined);
  assert(!hasAnyOrderField || hasAllOrderFields, `${label} journeyRef, step, and role must be provided together`);
  let journeyRef;
  let step;
  let role;
  if (hasAllOrderFields) {
    journeyRef = string(finding.journeyRef, `${label}.journeyRef`, { max: 42 });
    assert(JOURNEY_REF_RE.test(journeyRef), `${label}.journeyRef is invalid`);
    assertNoLocalProvenance(journeyRef, `${label}.journeyRef`, state);
    step = finding.step;
    assert(Number.isInteger(step) && step >= 1, `${label}.step must be an integer >= 1`);
    role = string(finding.role, `${label}.role`, { max: 20 });
    assert(JOURNEY_ROLES.has(role), `${label}.role is invalid`);
    assert(!["unknown", "inference"].includes(truthPlane), `${label} unknown or inference findings cannot carry executable order`);
  }
  return {
    finding_ref: findingRef,
    statement,
    truth_plane: truthPlane,
    source_type: sourceType,
    observable_anchors: observableAnchors,
    evidence_ref_ids: evidenceRefIds,
    source_fingerprint: sourceFingerprint,
    ...(hasAllOrderFields ? { journey_ref: journeyRef, step, role } : {}),
  };
}

function validateFindingJourneys(findings) {
  const byJourney = new Map();
  for (const finding of findings) {
    if (!finding.journey_ref) continue;
    const members = byJourney.get(finding.journey_ref) || [];
    members.push(finding);
    byJourney.set(finding.journey_ref, members);
  }
  for (const [journeyRef, members] of byJourney) {
    const steps = [...new Set(members.map((finding) => finding.step))].sort((left, right) => left - right);
    assert(steps.length >= 2, `${journeyRef} must contain at least two distinct steps; remove ordering from isolated facts`);
    assert(steps[0] === 1, `${journeyRef} steps must start at 1`);
    assert(steps.every((step, index) => step === index + 1), `${journeyRef} steps must be consecutive`);
    assert(
      members.some((finding) => finding.role === "entry" || finding.role === "action"),
      `${journeyRef} must contain an entry or action`,
    );
  }
}

function normalizeConflicts(value, label, state, findings) {
  assert(Array.isArray(value), `${label} must be an array`);
  const findingsByRef = new Map(findings.map((finding) => [finding.finding_ref, finding]));
  assert(findingsByRef.size === findings.length, `${label} findings must have unique findingRef values`);
  const seenPairs = new Set();
  return value.map((conflict, index) => {
    assert(conflict && typeof conflict === "object" && !Array.isArray(conflict), `${label}[${index}] must be an object`);
    const left = string(conflict.leftFindingRef, `${label}[${index}].leftFindingRef`, { max: 82 });
    const right = string(conflict.rightFindingRef, `${label}[${index}].rightFindingRef`, { max: 82 });
    assert(FINDING_REF_RE.test(left), `${label}[${index}].leftFindingRef is invalid`);
    assert(FINDING_REF_RE.test(right), `${label}[${index}].rightFindingRef is invalid`);
    assert(left !== right, `${label}[${index}] cannot conflict a finding with itself`);
    const leftFinding = findingsByRef.get(left);
    const rightFinding = findingsByRef.get(right);
    assert(leftFinding && rightFinding, `${label}[${index}] must reference findings in this round submission`);
    assert(
      CONFLICT_SOURCE_TYPES.has(leftFinding.source_type) && CONFLICT_SOURCE_TYPES.has(rightFinding.source_type),
      `${label}[${index}] may relate only code, human clarification, artifact, or runtime claims`,
    );
    assert(leftFinding.statement !== rightFinding.statement, `${label}[${index}] does not describe contradictory findings`);
    const pairKey = [left, right].sort().join(":");
    assert(!seenPairs.has(pairKey), `${label}[${index}] duplicates an existing conflict pair`);
    seenPairs.add(pairKey);
    return {
      left_finding_ref: left,
      right_finding_ref: right,
      description: assertSafeText(conflict.description, `${label}[${index}].description`, state, { max: 1_000 }),
    };
  });
}

function normalizeAnswer(answer, index, state, evidenceById) {
  assert(answer && typeof answer === "object" && !Array.isArray(answer), `answers[${index}] must be an object`);
  const questionId = string(answer.questionId, `answers[${index}].questionId`, { max: 160 });
  const status = string(answer.status, `answers[${index}].status`, { max: 20 });
  assert(ANSWER_STATUSES.has(status), `answers[${index}].status must be answered or skipped`);
  const clarifications = normalizeClarifications(answer.humanClarifications || [], `answers[${index}].humanClarifications`, state);
  const findings = (answer.findings || []).map((finding, findingIndex) =>
    normalizeFinding(
      finding,
      `answers[${index}].findings[${findingIndex}]`,
      state,
      evidenceById,
      clarifications,
      `question:${questionId}`,
    ),
  );
  if (status === "answered") {
    assert(findings.length > 0, `answered question ${questionId} needs at least one finding`);
    assert(!answer.unknownReason, `answered question ${questionId} must not include unknownReason`);
  } else {
    assert(findings.length === 0, `skipped question ${questionId} must not include findings`);
    assert(clarifications.length === 0, `skipped question ${questionId} must not include human clarifications`);
  }
  const normalized = {
    question_id: questionId,
    status,
    findings,
    human_clarifications: clarifications,
  };
  if (status === "skipped") {
    normalized.unknown_reason = assertSafeText(
      answer.unknownReason,
      `answers[${index}].unknownReason`,
      state,
      { max: 1_000 },
    );
  }
  return normalized;
}

function normalizeObservation(observation, index, state, evidenceById) {
  assert(observation && typeof observation === "object" && !Array.isArray(observation), `agentObservations[${index}] must be an object`);
  assert(observation.required !== true, "coding-agent observations cannot be required");
  const question = assertSafeText(observation.question, `agentObservations[${index}].question`, state, { max: 2_000 });
  const clarifications = normalizeClarifications(
    observation.humanClarifications || [],
    `agentObservations[${index}].humanClarifications`,
    state,
  );
  const findings = (observation.findings || []).map((finding, findingIndex) =>
    normalizeFinding(
      finding,
      `agentObservations[${index}].findings[${findingIndex}]`,
      state,
      evidenceById,
      clarifications,
      `observation:${sha256(question).slice(0, 16)}`,
    ),
  );
  assert(findings.length > 0, `agentObservations[${index}] needs at least one finding`);
  return {
    question,
    why: assertSafeText(observation.why, `agentObservations[${index}].why`, state, { max: 1_000 }),
    findings,
    human_clarifications: clarifications,
  };
}

function buildSubmission(statePath, candidatePath) {
  const state = readState(statePath);
  const candidate = readJson(candidatePath, "submission candidate");
  assert(candidate.schemaVersion === SUBMISSION_SCHEMA_VERSION, `submission schema must be ${SUBMISSION_SCHEMA_VERSION}`);
  const round = candidate.round || {};
  const roundId = string(round.id, "submission round id", { max: 160 });
  const roundCode = string(round.code, "submission round code", { max: 64 });
  const roundRevision = Number(round.revision);
  assert(Number.isInteger(roundRevision) && roundRevision > 0, "submission round revision must be positive");
  assert(round.workspaceId === state.workspace.serverId, "submission belongs to a different workspace");
  const roundPath = join(dirname(candidatePath), `round-r${roundRevision}.json`);
  const frozenRound = readJson(roundPath, "frozen round snapshot");
  assert(frozenRound.id === roundId && frozenRound.code === roundCode && frozenRound.revision === roundRevision, "submission does not match the frozen round snapshot");

  assert(Array.isArray(candidate.evidence), "submission evidence must be an array");
  const localEvidence = candidate.evidence.map((item) => remoteEvidenceReference(item, state));
  const evidenceReferences = localEvidence.map((item) => item.reference);
  const privacyState = {
    ...state,
    localEvidencePaths: localEvidence.map((item) => item.localPath),
    localEvidenceSymbols: Object.fromEntries(
      localEvidence.map((item) => [item.reference.evidence_ref_id, item.localSymbol]),
    ),
  };
  unique(evidenceReferences.map((item) => item.evidence_ref_id), "evidence ids");
  const evidenceById = new Map(evidenceReferences.map((item) => [item.evidence_ref_id, item]));

  assert(Array.isArray(candidate.answers), "submission answers must be an array");
  const answers = candidate.answers.map((answer, index) => normalizeAnswer(answer, index, privacyState, evidenceById));
  unique(answers.map((answer) => answer.question_id), "answer question ids");
  const expectedIds = frozenRound.questions.map((question) => question.id).sort();
  const actualIds = answers.map((answer) => answer.question_id).sort();
  assert(stableJson(actualIds) === stableJson(expectedIds), "submission must answer or skip every frozen question exactly once");

  assert(Array.isArray(candidate.agentObservations || []), "submission agentObservations must be an array");
  const agentObservations = (candidate.agentObservations || []).map((observation, index) =>
    normalizeObservation(observation, index, privacyState, evidenceById),
  );
  const findingRefs = [
    ...answers.flatMap((answer) => answer.findings.map((finding) => finding.finding_ref)),
    ...agentObservations.flatMap((observation) => observation.findings.map((finding) => finding.finding_ref)),
  ];
  unique(findingRefs, "finding refs across the round submission");
  const allFindings = [
    ...answers.flatMap((answer) => answer.findings),
    ...agentObservations.flatMap((observation) => observation.findings),
  ];
  validateFindingJourneys(allFindings);
  const conflicts = normalizeConflicts(candidate.conflicts || [], "conflicts", privacyState, allFindings);
  const payload = {
    round_revision: roundRevision,
    workspace_id: state.workspace.serverId,
    answers,
    agent_observations: agentObservations,
    conflicts,
    evidence_references: evidenceReferences,
  };
  assertRemotePayloadSafe(payload, privacyState);
  return { state, frozenRound, payload, payloadDigest: sha256(stableJson(payload)) };
}

function validateSubmission(options) {
  const statePath = resolve(options.state || ".doable/workspace-private.json");
  const candidatePath = resolve(requiredOption(options, "candidate"));
  const { frozenRound, payload, payloadDigest } = buildSubmission(statePath, candidatePath);
  const answered = payload.answers.filter((answer) => answer.status === "answered").length;
  const skipped = payload.answers.length - answered;
  console.log(`Round: ${frozenRound.code} revision ${frozenRound.revision}`);
  console.log(`Answers valid: ${answered} answered, ${skipped} skipped`);
  console.log(`Nonblocking observations: ${payload.agent_observations.length}`);
  console.log(`Safe payload digest: ${payloadDigest}`);
}

function writeSubmissionPayload(options) {
  const statePath = resolve(options.state || ".doable/workspace-private.json");
  const candidatePath = resolve(requiredOption(options, "candidate"));
  const outputPath = resolve(requiredOption(options, "output"));
  const { frozenRound, payload, payloadDigest } = buildSubmission(statePath, candidatePath);
  atomicWriteJson(outputPath, {
    round_id: frozenRound.id,
    submission: payload,
    payload_digest: payloadDigest,
  });
  console.log(`Safe Round submission ready: ${outputPath}`);
  console.log(`Round: ${frozenRound.code} revision ${frozenRound.revision}`);
  console.log(`Safe payload digest: ${payloadDigest}`);
}

function recordFinalize(options) {
  const code = string(requiredOption(options, "code"), "round code", { max: 64 }).toUpperCase();
  const responsePath = resolve(requiredOption(options, "response"));
  assert(ROUND_CODE_RE.test(code), "round code has an invalid format");
  const statePath = resolve(options.state || ".doable/workspace-private.json");
  const requestDirectory = join(dirname(statePath), "requests", code);
  const origin = readJson(join(requestDirectory, "agent-origin.json"), "agent-origin round metadata");
  const suiteId = validateSafeSlug(origin.suiteId, "suite id");
  const roundId = string(origin.roundId, "round id", { max: 160 });
  const response = readMcpResponse(responsePath, "MCP Round finalization");
  assert(response.round_id === roundId, "finalize response belongs to a different round");
  const receipt = {
    schemaVersion: "1",
    suiteId,
    roundId,
    roundCode: code,
    mode: string(response.mode, "finalize mode", { max: 40 }),
    trdId: string(response.trd_id, "TRD id", { max: 160 }),
    trdSessionId: string(response.trd_session_id, "TRD session id", { max: 160 }),
    finalizedAt: new Date().toISOString(),
  };
  atomicWriteJson(join(requestDirectory, "finalize-receipt.json"), receipt);
  console.log(`Round finalized: ${code}`);
  console.log(`TRD mode: ${receipt.mode}`);
  console.log(`TRD: ${receipt.trdId}`);
  console.log(`TRD session: ${receipt.trdSessionId}`);
  console.log("Next step: monitor the TRD in Doable, then review or approve generated test cases.");
}

function submissionReceiptPath(requestDirectory, revision, payloadDigest) {
  return join(requestDirectory, `receipt-r${revision}-${payloadDigest}.json`);
}

function existingSubmissionReceiptPath(requestDirectory, revision, payloadDigest) {
  const digestPath = submissionReceiptPath(requestDirectory, revision, payloadDigest);
  if (existsSync(digestPath)) return digestPath;
  const legacyPath = join(requestDirectory, `receipt-r${revision}.json`);
  if (!existsSync(legacyPath)) return null;
  const receipt = readJson(legacyPath, "submission receipt");
  return receipt.payloadDigest === payloadDigest ? legacyPath : null;
}

function recordSubmission(options) {
  const statePath = resolve(options.state || ".doable/workspace-private.json");
  const candidatePath = resolve(requiredOption(options, "candidate"));
  const payloadPath = resolve(requiredOption(options, "payload"));
  const responsePath = resolve(requiredOption(options, "response"));
  const { frozenRound, payload, payloadDigest } = buildSubmission(statePath, candidatePath);
  const envelope = readJson(payloadPath, "safe Round submission payload");
  assert(envelope.round_id === frozenRound.id, "safe submission payload belongs to a different round");
  assert(envelope.payload_digest === payloadDigest, "safe submission payload changed after validation");
  assert(stableJson(envelope.submission) === stableJson(payload), "safe submission payload does not match the local candidate");
  readMcpResponse(responsePath, "MCP Round submission");
  const requestDirectory = dirname(candidatePath);
  if (existingSubmissionReceiptPath(requestDirectory, frozenRound.revision, payloadDigest)) {
    console.log(`Round already submitted: ${frozenRound.code} revision ${frozenRound.revision}`);
    return;
  }
  atomicWriteJson(submissionReceiptPath(requestDirectory, frozenRound.revision, payloadDigest), {
    schemaVersion: "1",
    roundId: frozenRound.id,
    roundCode: frozenRound.code,
    roundRevision: frozenRound.revision,
    payloadDigest,
    submittedAt: new Date().toISOString(),
  });
  const answered = payload.answers.filter((answer) => answer.status === "answered").length;
  const skipped = payload.answers.length - answered;
  console.log(`Round submitted: ${frozenRound.code} revision ${frozenRound.revision}`);
  console.log(`Answers: ${answered} answered, ${skipped} skipped`);
  console.log(`Nonblocking observations: ${payload.agent_observations.length}`);
  console.log("Next action: wait");
}

function usage() {
  console.error("Internal helper commands: prepare-workspace, build-workspace-profile, record-workspace-sync, record-round, validate-submission, build-submission, record-submission, record-finalize");
  process.exit(2);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "prepare-workspace") return prepareWorkspace(options);
  if (command === "build-workspace-profile") return buildWorkspaceProfile(options);
  if (command === "record-workspace-sync") return recordWorkspaceSync(options);
  if (command === "record-round") return recordRound(options);
  if (command === "validate-submission") return validateSubmission(options);
  if (command === "build-submission") return writeSubmissionPayload(options);
  if (command === "record-submission") return recordSubmission(options);
  if (command === "record-finalize") return recordFinalize(options);
  usage();
}

main().catch((error) => {
  console.error(`Doable code-context helper failed: ${sanitizedServerDetail(error.message) || "unknown error"}`);
  process.exit(1);
});
