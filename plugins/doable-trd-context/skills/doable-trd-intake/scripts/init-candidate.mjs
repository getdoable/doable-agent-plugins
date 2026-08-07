import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_VERSION = "0.1.5";
const SCHEMA_VERSION = "doable.feature-intake/v3";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(scriptDirectory, "../assets/doable-intake.schema.json");

function usage() {
  return "Usage: node init-candidate.mjs [--from <existing-doable-intake.json>] [--print-contract]";
}

function emptyCandidate() {
  return {
    schemaVersion: SCHEMA_VERSION,
    featureId: "replace-with-stable-feature-id",
    contextRevision: 1,
    feature: {
      originalRequest: "replace with the privacy-safe verbatim request",
      subsequentRequests: [],
      confirmedClarifications: [],
      name: "replace with feature name",
      query: {
        requestedScope: "replace with concise requested scope",
        explicitInScope: [],
        explicitOutOfScope: [],
        successCriteria: [],
        testConstraints: [],
      },
    },
    repositories: [],
    producer: {
      skillVersion: SKILL_VERSION,
      host: "replace with coding-agent host",
      model: "replace with model name",
    },
    capabilities: [],
    actors: [],
    preconditions: [],
    testData: [],
    supplementalSources: [],
    environment: [],
    flows: [],
    rules: [],
    interfaces: [],
    unknowns: [],
    conflicts: [],
    evidence: [],
  };
}

function objectShape(name, schema) {
  const required = new Set(schema?.required ?? []);
  const properties = Object.keys(schema?.properties ?? {});
  return `${name}: ${properties.map((key) => required.has(key) ? key : `${key}?`).join(", ")}`;
}

function compactContract(schema) {
  const definitions = schema.$defs ?? {};
  const lines = [
    "Compact candidate authoring contract (? means optional):",
    objectShape("feature", definitions.feature),
    "query: requestedScope, explicitInScope, explicitOutOfScope, successCriteria, testConstraints",
    objectShape("confirmedClarification", definitions.confirmedClarification),
    "repository: id, name, vcs, evidenceContentHash (omit the hash only before --update-fingerprints), inspectedAt?",
    "vcs: {type: git, commit, dirty} or {type: unversioned}",
  ];
  for (const [label, definitionName] of [
    ["capability", "capability"],
    ["actor", "actor"],
    ["precondition", "precondition"],
    ["testData", "testDataRequirement"],
    ["preparation", "preparation"],
    ["environment", "environmentRequirement"],
    ["flow", "flow"],
    ["operation", "operation"],
    ["state", "state"],
    ["rule", "rule"],
    ["interface", "interface"],
    ["unknown", "unknown"],
    ["conflict", "conflict"],
    ["conflictClaim", "conflictClaim"],
    ["evidence", "evidence"],
    ["locator", "locator"],
    ["supplementalSource", "supplementalSource"],
  ]) {
    lines.push(objectShape(label, definitions[definitionName]));
  }
  lines.push(
    "All entity and reference IDs must match ^[A-Z][A-Z0-9_-]*$; featureId is the separate lowercase stable slug-like identity.",
    "Evidence must use exactly one owner: repositoryId+locator, supplementalSourceId+sourceAnchor, or authorityBasis.",
    "Repository evidence example: {id: E_CREATE, repositoryId: REPO_API, kind: implementation, truthPlane: implemented, summary: ..., locator: {path: relative/file, startLine: 10, endLine: 30, symbol?: Name}}. Never add sourceAnchor to repository evidence.",
    "Repository example: {id: REPO_API, name: Product API, vcs: {type: git, commit: full revision, dirty: false}}. The renderer fills evidenceContentHash with --update-fingerprints.",
    "Authority basis: {type: original_request}, {type: subsequent_request, requestIndex}, or {type: confirmed_clarification, clarificationIndex}.",
    "Truth planes: desired, implemented, deployed, reference, inference.",
    "Operations use zero-based contiguous sequenceIndex values; the first operation requires entry. State roles: initial, intermediate, terminal, error. Preparation: {strategy: chained|externalized, steps: [...] }.",
    "Rule kinds: permission, validation, business, persistence, data, integration, testability.",
    "Interface kinds: ui, route, http_api, event, job, storage, configuration, external_service.",
    "Evidence kinds: user_authority, implementation, test, schema, route, migration, configuration, documentation, design, runtime_observation.",
    "Supplemental source roles: desired_behavior, current_runtime, reference_context.",
    "Use the validator's self-contained diagnostics for details; read the full schema only if a diagnostic remains ambiguous.",
  );
  return lines.join("\n");
}

async function atomicPrivateWrite(targetPath, contents) {
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporaryPath, targetPath);
    if (process.platform !== "win32") await fs.chmod(targetPath, 0o600);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function createCandidate({ fromPath } = {}) {
  let candidate = emptyCandidate();
  if (fromPath) {
    candidate = JSON.parse(await fs.readFile(path.resolve(fromPath), "utf8"));
    candidate.schemaVersion = SCHEMA_VERSION;
    candidate.contextRevision = Number(candidate.contextRevision) + 1;
    candidate.producer = {
      ...(candidate.producer ?? {}),
      skillVersion: SKILL_VERSION,
    };
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "doable-intake-"));
  const candidatePath = path.join(directory, "doable-intake.candidate.json");
  await atomicPrivateWrite(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  return candidatePath;
}

export async function runCli(argv) {
  const args = [...argv];
  let fromPath;
  let printContract = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--from") {
      fromPath = args.shift();
      if (!fromPath) throw new Error("--from requires an existing canonical intake path");
    } else if (arg === "--print-contract") {
      printContract = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return 0;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const candidatePath = await createCandidate({ fromPath });
  console.log(`Candidate: ${candidatePath}`);
  if (fromPath) console.log("Refresh copy created with the stable feature identity and next context revision.");
  if (printContract) {
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
    console.log("");
    console.log(compactContract(schema));
  }
  return 0;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
