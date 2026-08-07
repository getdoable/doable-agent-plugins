#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCHEMA_VERSION = "doable.feature-intake/v3";
const CONTEXT_SCHEMA_VERSION = "doable.trd-context/v1";
const SKILL_VERSION = "0.1.5";
const ID_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const FEATURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const TRUTH_PLANES = new Set(["desired", "implemented", "deployed", "reference", "inference"]);
const FORBIDDEN_KEYS = /^(?:sourceCode|rawSource|rawContent|snippet|diff|patch|secret|token|password|cookie|environmentValue)$/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\b(?:ghp|github_pat|sk_live|sk_test)_[A-Za-z0-9_\-]{12,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bnpm_[A-Za-z0-9]{24,}\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/]+:[^@\s/]+@/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;]{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i,
];
const WORKFLOW_CONSTRAINT = /\b(?:repository|source code|network|modify the repo|coding agent|pinned commit)\b/i;
const META_SUCCESS_CRITERION = /(?:\b(?:TRD|intake)\b|\b(?:prepare|create|generate).{0,30}\bcontext\b|上下文|准备.{0,20}(?:TRD|context)|创建.{0,12}TRD)/i;
const SUSPECTED_RUNTIME_DEFECT = /\b(?:stale|remain(?:s)? visible|continue(?:s)? to (?:show|display)|not (?:refresh|update|invalidate)|missing invalidation)\b/i;
const SELF_RESOLVABLE_RUNTIME_UNKNOWN = /(?:通过|using|by).{0,40}(?:运行时|runtime|browser|UI).{0,30}(?:观察|observe|test|验证|confirm)/i;
const LOCAL_LINEAGE_UNKNOWN = /(?:\blocal\s+(?:feature\s+)?(?:identity|lineage|revision\s+history)\b|\blost\s+(?:feature\s+)?(?:identity|lineage|revision\s+history)\b|\bfeature\s*ID\b.{0,50}\b(?:revision|history|lineage)\b|\b(?:revision|history|lineage)\b.{0,50}\bfeature\s*ID\b|(?:丢失|旧|本地).{0,40}(?:feature\s*ID|身份|修订历史|版本历史))/i;
const REPOSITORY_LOCATOR_LEAK = /(?:\b(?:Users|home)\/[A-Za-z0-9_.\/-]+|(?:[A-Za-z0-9_.-]+\/){2,}[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|py|go|rs|java|rb|cs|php|swift|kt|sql|proto|ya?ml|toml|json|md)\b|\b[A-Za-z0-9][A-Za-z0-9_.-]{1,}\.(?:tsx?|jsx?|py|go|rs|java|rb|cs|php|swift|kt|sql|proto|ya?ml|toml|json|md|png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?)\b|(?:^|[\s`])\.(?:doable|git)(?:\/|\b)|\b(?:line|lines)\s+\d+\b)/im;
const URL_LEAK = /\bhttps?:\/\/[^\s)>]+/i;
const COMMIT_LEAK = /\b[0-9a-f]{40,64}\b/i;
const EMAIL_LEAK = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/i;
const INTERNAL_HOST_LEAK = /\b(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:internal|local|localhost|lan|corp|private|test|invalid))(?::\d{1,5})?\b|\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|127\.(?:\d{1,3}\.){2}\d{1,3})\b/i;
const BUSINESS_IDENTIFIER_LEAK = /(?:\b(?:tenant|customer|account|organization|org|workspace|order|invoice|subscription|user)(?:\s+(?:id|number|key))?\s*(?:[:=#-]\s*)?(?:[A-Z][A-Z0-9_]*-\d{3,}|\d{6,}|[0-9a-f]{8}-[0-9a-f-]{27,})\b|\b(?:cus|acct|ws|sub|ord|inv)_[A-Za-z0-9]{6,}\b)/i;
const CODE_SHAPED_PATTERNS = [
  /```/,
  /\b(?:const|let|var)\s+[$A-Z_][\w$]*\s*=/i,
  /(?:if|for|while)\s*\([^\n)]{1,200}\)\s*(?:\{|\breturn\b)/i,
  /\breturn\s+(?:null|undefined|true|false|[$A-Z_][\w$]*(?:\.|\())[^;\n]*;/i,
  /\bdef\s+[A-Za-z_]\w*\s*\([^\n)]*\)\s*:/,
  /\bawait\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*(?:\([^\n)]*\))?)+/,
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*\([^\n)]*\)(?:\.[A-Za-z_$][\w$]*(?:\([^\n)]*\))?)*/,
  /\b[A-Za-z_]\w*\s*\([^\n)]*\$[A-Za-z_]\w*[^\n)]*\)\s*\{[^\n}]*\{[^\n}]*\}/,
  /<\/?[a-z][a-z0-9-]*(?:\s+[a-z_:][-a-z0-9_:.]*(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/,
  /(?:\bSELECT\s+[^;\n]{1,120}\s+FROM\s+[A-Za-z_]|\bINSERT\s+INTO\s+[A-Za-z_]|\bUPDATE\s+[A-Za-z_][\w]*\s+SET\s+|\bDELETE\s+FROM\s+[A-Za-z_]|\bWHERE\s+[A-Za-z_][\w]*\s*(?:=|<>|!=|IN\b|LIKE\b))/,
];
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (isObject(value)) Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsDeclaredRepositoryName(text, name) {
  if (typeof name !== "string" || !name.trim()) return false;
  const escaped = escapeRegExp(name.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

function containsStructuredPayload(value) {
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{" && value[start] !== "[") continue;
    const stack = [value[start]];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < value.length && index - start <= 4096; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const expected = character === "}" ? "{" : "[";
        if (stack.at(-1) !== expected) break;
        stack.pop();
        if (stack.length === 0) {
          try {
            const parsed = JSON.parse(value.slice(start, index + 1));
            if (parsed !== null && typeof parsed === "object") return true;
          } catch {
            // A bracketed product phrase is not a structured payload.
          }
          break;
        }
      }
    }
  }
  return false;
}

function containsCodeShapedContent(value) {
  return CODE_SHAPED_PATTERNS.some((pattern) => pattern.test(value)) || containsStructuredPayload(value);
}

export async function atomicWriteFile(targetPath, data, { beforeRename } = {}) {
  const resolvedTarget = path.resolve(targetPath);
  const directory = path.dirname(resolvedTarget);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolvedTarget)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let renamed = false;
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(data, typeof data === "string" ? { encoding: "utf8" } : undefined);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeRename) await beforeRename(temporaryPath);
    await fs.rename(temporaryPath, resolvedTarget);
    renamed = true;
    if (process.platform !== "win32") await fs.chmod(resolvedTarget, 0o600);
    try {
      const directoryHandle = await fs.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Directory fsync is unavailable on some platforms; the same-directory rename is still atomic.
    }
  } finally {
    if (!renamed) await fs.unlink(temporaryPath).catch(() => {});
  }
}

function at(value, pointer) {
  return pointer ? `${pointer}.${value}` : value;
}

function requireObject(value, pointer, errors) {
  if (!isObject(value)) {
    errors.push(`${pointer} must be an object`);
    return false;
  }
  return true;
}

function requireArray(value, pointer, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${pointer} must be an array`);
    return false;
  }
  return true;
}

function requireString(value, pointer, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${pointer} must be a non-empty string`);
    return false;
  }
  return true;
}

function requireId(value, pointer, errors) {
  if (!requireString(value, pointer, errors)) return false;
  if (!ID_PATTERN.test(value)) {
    errors.push(`${pointer} must match ${ID_PATTERN}`);
    return false;
  }
  return true;
}

function rejectUnknownKeys(value, pointer, allowed, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${pointer}.${key} is not allowed by the canonical contract`);
  }
}

function requireStringList(value, pointer, errors) {
  if (!requireArray(value, pointer, errors)) return false;
  value.forEach((item, index) => requireString(item, `${pointer}[${index}]`, errors));
  if (new Set(value).size !== value.length) errors.push(`${pointer} must not contain duplicates`);
  return true;
}

function requireStringHistory(value, pointer, errors) {
  if (!requireArray(value, pointer, errors)) return false;
  value.forEach((item, index) => requireString(item, `${pointer}[${index}]`, errors));
  return true;
}

function collectForbiddenAndSecrets(value, pointer, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenAndSecrets(item, `${pointer}[${index}]`, errors));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPointer = at(key, pointer);
      if (FORBIDDEN_KEYS.test(key)) errors.push(`${childPointer} is a forbidden raw/source/secret field`);
      collectForbiddenAndSecrets(child, childPointer, errors);
    }
    return;
  }
  if (typeof value === "string" && SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    errors.push(`${pointer} appears to contain a credential or secret`);
  }
}

function validateRepositoryLocator(locator, pointer, errors) {
  if (!requireObject(locator, pointer, errors)) return;
  rejectUnknownKeys(locator, pointer, new Set(["path", "startLine", "endLine", "symbol"]), errors);
  if (requireString(locator.path, `${pointer}.path`, errors)) {
    if (path.isAbsolute(locator.path) || locator.path.split(/[\\/]+/).includes("..")) {
      errors.push(`${pointer}.path must be repository-relative and cannot traverse upward`);
    }
  }
  if (!Number.isInteger(locator.startLine) || locator.startLine < 1) errors.push(`${pointer}.startLine must be a positive integer`);
  if (!Number.isInteger(locator.endLine) || locator.endLine < 1) errors.push(`${pointer}.endLine must be a positive integer`);
  if (Number.isInteger(locator.startLine) && Number.isInteger(locator.endLine)) {
    if (locator.endLine < locator.startLine) errors.push(`${pointer}.endLine must be >= startLine`);
  }
}

function validateAuthorityBasis(authorityBasis, pointer, clarificationCount, subsequentRequestCount, errors) {
  if (!requireObject(authorityBasis, pointer, errors)) return;
  if (authorityBasis.type === "original_request") {
    rejectUnknownKeys(authorityBasis, pointer, new Set(["type"]), errors);
    return;
  }
  if (authorityBasis.type === "confirmed_clarification") {
    rejectUnknownKeys(authorityBasis, pointer, new Set(["type", "clarificationIndex"]), errors);
    if (!Number.isInteger(authorityBasis.clarificationIndex)
      || authorityBasis.clarificationIndex < 0
      || authorityBasis.clarificationIndex >= clarificationCount) {
      errors.push(`${pointer}.clarificationIndex must reference an existing clarification`);
    }
    return;
  }
  if (authorityBasis.type === "subsequent_request") {
    rejectUnknownKeys(authorityBasis, pointer, new Set(["type", "requestIndex"]), errors);
    if (!Number.isInteger(authorityBasis.requestIndex)
      || authorityBasis.requestIndex < 0
      || authorityBasis.requestIndex >= subsequentRequestCount) {
      errors.push(`${pointer}.requestIndex must reference an existing subsequent request`);
    }
    return;
  }
  errors.push(`${pointer}.type is invalid`);
}

function validateEvidence(item, pointer, clarificationCount, subsequentRequestCount, errors) {
  if (!requireObject(item, pointer, errors)) return;
  rejectUnknownKeys(item, pointer, new Set([
    "id", "repositoryId", "supplementalSourceId", "authorityBasis", "kind", "truthPlane",
    "summary", "locator", "sourceAnchor",
  ]), errors);
  requireId(item.id, `${pointer}.id`, errors);
  const hasRepository = item.repositoryId !== undefined;
  const hasSupplementalSource = item.supplementalSourceId !== undefined;
  const hasAuthority = item.authorityBasis !== undefined;
  if ([hasRepository, hasSupplementalSource, hasAuthority].filter(Boolean).length !== 1) {
    errors.push(`${pointer} must reference exactly one repositoryId, supplementalSourceId, or authorityBasis`);
  }
  if (hasRepository) requireId(item.repositoryId, `${pointer}.repositoryId`, errors);
  if (hasSupplementalSource) requireId(item.supplementalSourceId, `${pointer}.supplementalSourceId`, errors);
  if (hasAuthority) validateAuthorityBasis(item.authorityBasis, `${pointer}.authorityBasis`, clarificationCount, subsequentRequestCount, errors);
  if (!["user_authority", "implementation", "test", "schema", "route", "migration", "configuration", "documentation", "design", "runtime_observation"].includes(item.kind)) {
    errors.push(`${pointer}.kind is invalid`);
  }
  if (!TRUTH_PLANES.has(item.truthPlane)) {
    errors.push(`${pointer}.truthPlane is invalid`);
  }
  requireString(item.summary, `${pointer}.summary`, errors);
  if (hasRepository) {
    validateRepositoryLocator(item.locator, `${pointer}.locator`, errors);
    if (item.sourceAnchor !== undefined) errors.push(`${pointer}.sourceAnchor is only valid for supplemental evidence`);
    if (item.authorityBasis !== undefined) errors.push(`${pointer}.authorityBasis is only valid for user-authority evidence`);
    if (["desired", "deployed"].includes(item.truthPlane)) {
      errors.push(`${pointer}.truthPlane ${item.truthPlane} cannot be established from repository evidence alone`);
    }
  }
  if (hasSupplementalSource) {
    requireString(item.sourceAnchor, `${pointer}.sourceAnchor`, errors);
    if (item.locator !== undefined) errors.push(`${pointer}.locator is only valid for repository evidence`);
    if (item.authorityBasis !== undefined) errors.push(`${pointer}.authorityBasis is only valid for user-authority evidence`);
  }
  if (hasAuthority) {
    if (item.locator !== undefined || item.sourceAnchor !== undefined) {
      errors.push(`${pointer} user-authority evidence cannot have a source locator`);
    }
    if (item.kind !== "user_authority") errors.push(`${pointer}.kind must be user_authority when authorityBasis is used`);
    if (item.truthPlane !== "desired") errors.push(`${pointer}.truthPlane must be desired for user-authority evidence`);
  } else if (item.kind === "user_authority") {
    errors.push(`${pointer}.kind user_authority requires authorityBasis`);
  }
}

function validateSupplementalSources(sources, clarificationCount, subsequentRequestCount, errors) {
  const sourceIds = new Set();
  if (sources === undefined) return sourceIds;
  if (!requireArray(sources, "supplementalSources", errors)) return sourceIds;
  sources.forEach((source, index) => {
    const pointer = `supplementalSources[${index}]`;
    if (!requireObject(source, pointer, errors)) return;
    rejectUnknownKeys(source, pointer, new Set([
      "id", "kind", "role", "name", "locator", "freshnessMarker", "authorityBasis", "inspectedAt",
    ]), errors);
    if (requireId(source.id, `${pointer}.id`, errors)) {
      if (sourceIds.has(source.id)) errors.push(`${pointer}.id duplicates supplemental source ID ${source.id}`);
      sourceIds.add(source.id);
    }
    if (!["figma", "image", "design_document", "ticket", "runtime_capture", "other"].includes(source.kind)) {
      errors.push(`${pointer}.kind is invalid`);
    }
    if (!["desired_behavior", "current_runtime", "reference_context"].includes(source.role)) {
      errors.push(`${pointer}.role is invalid`);
    }
    requireString(source.name, `${pointer}.name`, errors);
    requireString(source.locator, `${pointer}.locator`, errors);
    if (requireString(source.freshnessMarker, `${pointer}.freshnessMarker`, errors)
      && (source.freshnessMarker.length < 8 || source.freshnessMarker.length > 256)) {
      errors.push(`${pointer}.freshnessMarker must be 8-256 characters`);
    }
    if (source.inspectedAt !== undefined && (!requireString(source.inspectedAt, `${pointer}.inspectedAt`, errors) || Number.isNaN(Date.parse(source.inspectedAt)))) {
      errors.push(`${pointer}.inspectedAt must be an ISO date-time`);
    }
    if (source.role === "desired_behavior") {
      if (!requireObject(source.authorityBasis, `${pointer}.authorityBasis`, errors)) return;
      if (source.authorityBasis.type === "original_request") {
        rejectUnknownKeys(source.authorityBasis, `${pointer}.authorityBasis`, new Set(["type"]), errors);
      } else if (source.authorityBasis.type === "confirmed_clarification") {
        rejectUnknownKeys(source.authorityBasis, `${pointer}.authorityBasis`, new Set(["type", "clarificationIndex"]), errors);
        if (!Number.isInteger(source.authorityBasis.clarificationIndex) || source.authorityBasis.clarificationIndex < 0 || source.authorityBasis.clarificationIndex >= clarificationCount) {
          errors.push(`${pointer}.authorityBasis.clarificationIndex must reference an existing clarification`);
        }
      } else if (source.authorityBasis.type === "subsequent_request") {
        rejectUnknownKeys(source.authorityBasis, `${pointer}.authorityBasis`, new Set(["type", "requestIndex"]), errors);
        if (!Number.isInteger(source.authorityBasis.requestIndex) || source.authorityBasis.requestIndex < 0 || source.authorityBasis.requestIndex >= subsequentRequestCount) {
          errors.push(`${pointer}.authorityBasis.requestIndex must reference an existing subsequent request`);
        }
      } else {
        errors.push(`${pointer}.authorityBasis.type is invalid`);
      }
    } else if (source.authorityBasis !== undefined) {
      errors.push(`${pointer}.authorityBasis is only valid for desired_behavior sources`);
    }
  });
  return sourceIds;
}

function validateRepositories(repositories, errors, { allowMissingFingerprints = false } = {}) {
  const repositoryIds = new Set();
  if (!requireArray(repositories, "repositories", errors)) return repositoryIds;
  repositories.forEach((repository, index) => {
    const pointer = `repositories[${index}]`;
    if (!requireObject(repository, pointer, errors)) return;
    rejectUnknownKeys(repository, pointer, new Set(["id", "name", "vcs", "evidenceContentHash", "inspectedAt"]), errors);
    if (requireId(repository.id, `${pointer}.id`, errors)) {
      if (repositoryIds.has(repository.id)) errors.push(`${pointer}.id duplicates repository ID ${repository.id}`);
      repositoryIds.add(repository.id);
    }
    requireString(repository.name, `${pointer}.name`, errors);
    if (repository.evidenceContentHash === undefined && allowMissingFingerprints) {
      // Initial authoring can ask the CLI to populate this after binding repositories.
    } else if (!requireString(repository.evidenceContentHash, `${pointer}.evidenceContentHash`, errors)
      || !CONTENT_HASH_PATTERN.test(repository.evidenceContentHash)) {
      errors.push(`${pointer}.evidenceContentHash must be a lowercase SHA-256 digest`);
    }
    if (repository.inspectedAt !== undefined) {
      if (!requireString(repository.inspectedAt, `${pointer}.inspectedAt`, errors) || Number.isNaN(Date.parse(repository.inspectedAt))) {
        errors.push(`${pointer}.inspectedAt must be an ISO date-time`);
      }
    }
    if (!requireObject(repository.vcs, `${pointer}.vcs`, errors)) return;
    const vcsPointer = `${pointer}.vcs`;
    if (repository.vcs.type === "git") {
      rejectUnknownKeys(repository.vcs, vcsPointer, new Set(["type", "commit", "dirty"]), errors);
      if (requireString(repository.vcs.commit, `${vcsPointer}.commit`, errors) && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(repository.vcs.commit)) {
        errors.push(`${vcsPointer}.commit must be a full Git commit hash`);
      }
      if (typeof repository.vcs.dirty !== "boolean") errors.push(`${vcsPointer}.dirty must be boolean`);
    } else if (repository.vcs.type === "unversioned") {
      rejectUnknownKeys(repository.vcs, vcsPointer, new Set(["type"]), errors);
    } else {
      errors.push(`${vcsPointer}.type must be git or unversioned`);
    }
  });
  return repositoryIds;
}

function validateEvidenceRefs(ids, pointer, evidenceIds, errors, { required = true } = {}) {
  if (!requireStringList(ids, pointer, errors)) return;
  if (required && ids.length === 0) errors.push(`${pointer} requires at least one evidence ID`);
  for (const id of ids) {
    if (!evidenceIds.has(id)) errors.push(`${pointer} references missing evidence ${id}`);
  }
}

function collectItemIds(intake, errors) {
  const ids = new Set();
  const add = (id, pointer) => {
    if (!requireId(id, pointer, errors)) return;
    if (ids.has(id)) errors.push(`${pointer} duplicates item ID ${id}`);
    ids.add(id);
  };
  for (const [collectionName, collection] of [
    ["capabilities", intake.capabilities], ["actors", intake.actors], ["preconditions", intake.preconditions], ["testData", intake.testData],
    ["environment", intake.environment], ["flows", intake.flows],
    ["rules", intake.rules], ["interfaces", intake.interfaces], ["unknowns", intake.unknowns], ["conflicts", intake.conflicts],
  ]) {
    if (!Array.isArray(collection)) continue;
    collection.forEach((item, index) => add(item?.id, `${collectionName}[${index}].id`));
  }
  if (Array.isArray(intake.flows)) {
    intake.flows.forEach((flow, flowIndex) => {
      if (!Array.isArray(flow?.operations)) return;
      flow.operations.forEach((operation, operationIndex) => add(operation?.id, `flows[${flowIndex}].operations[${operationIndex}].id`));
    });
  }
  return ids;
}

export function validateIntake(intake, { allowMissingFingerprints = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!requireObject(intake, "$", errors)) return { errors, warnings };
  rejectUnknownKeys(intake, "$", new Set([
    "schemaVersion", "featureId", "contextRevision", "feature", "repositories", "producer", "supplementalSources", "capabilities", "actors", "preconditions",
    "testData", "environment",
    "flows", "rules", "interfaces", "unknowns", "conflicts", "evidence",
  ]), errors);
  collectForbiddenAndSecrets(intake, "$", errors);
  if (intake.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must equal ${SCHEMA_VERSION}`);
  if (typeof intake.featureId !== "string" || !FEATURE_ID_PATTERN.test(intake.featureId)) {
    errors.push(`featureId must match ${FEATURE_ID_PATTERN}`);
  }
  if (!Number.isInteger(intake.contextRevision) || intake.contextRevision < 1) {
    errors.push("contextRevision must be a positive integer");
  }
  const repositoryIds = validateRepositories(intake.repositories, errors, { allowMissingFingerprints });

  if (requireObject(intake.feature, "feature", errors)) {
    rejectUnknownKeys(intake.feature, "feature", new Set(["originalRequest", "subsequentRequests", "confirmedClarifications", "name", "query"]), errors);
    requireString(intake.feature.originalRequest, "feature.originalRequest", errors);
    requireStringHistory(intake.feature.subsequentRequests, "feature.subsequentRequests", errors);
    if (requireArray(intake.feature.confirmedClarifications, "feature.confirmedClarifications", errors)) {
      intake.feature.confirmedClarifications.forEach((clarification, index) => {
        const pointer = `feature.confirmedClarifications[${index}]`;
        if (!requireObject(clarification, pointer, errors)) return;
        rejectUnknownKeys(clarification, pointer, new Set(["questionContext", "answer"]), errors);
        requireString(clarification.questionContext, `${pointer}.questionContext`, errors);
        requireString(clarification.answer, `${pointer}.answer`, errors);
      });
    }
    requireString(intake.feature.name, "feature.name", errors);
    if (typeof intake.feature.name === "string" && /[\r\n]/.test(intake.feature.name)) {
      errors.push("feature.name must be a single line");
    }
    if (requireObject(intake.feature.query, "feature.query", errors)) {
      rejectUnknownKeys(intake.feature.query, "feature.query", new Set([
        "requestedScope", "explicitInScope", "explicitOutOfScope", "successCriteria", "testConstraints",
      ]), errors);
      requireString(intake.feature.query.requestedScope, "feature.query.requestedScope", errors);
      for (const key of ["explicitInScope", "explicitOutOfScope", "successCriteria", "testConstraints"]) {
        requireStringList(intake.feature.query[key], `feature.query.${key}`, errors);
      }
      for (const [index, constraint] of (intake.feature.query.testConstraints ?? []).entries()) {
        if (WORKFLOW_CONSTRAINT.test(constraint)) {
          warnings.push(`feature.query.testConstraints[${index}] looks like a coding-agent workflow instruction, not user feature authority`);
        }
      }
      for (const [index, criterion] of (intake.feature.query.successCriteria ?? []).entries()) {
        if (META_SUCCESS_CRITERION.test(criterion)) {
          errors.push(`feature.query.successCriteria[${index}] is an intake/TRD meta-goal, not an observable product outcome`);
        }
      }
    }
  }
  if (requireObject(intake.producer, "producer", errors)) {
    rejectUnknownKeys(intake.producer, "producer", new Set(["skillVersion", "host", "model"]), errors);
    if (intake.producer.skillVersion !== SKILL_VERSION) {
      errors.push(`producer.skillVersion must equal ${SKILL_VERSION}; reload the current Doable Skill before continuing`);
    }
    requireString(intake.producer.host, "producer.host", errors);
    requireString(intake.producer.model, "producer.model", errors);
  }
  const supplementalSourceIds = validateSupplementalSources(
    intake.supplementalSources,
    intake.feature?.confirmedClarifications?.length ?? 0,
    intake.feature?.subsequentRequests?.length ?? 0,
    errors,
  );
  const supplementalSourceById = new Map(
    (intake.supplementalSources ?? []).map((source) => [source?.id, source]),
  );

  for (const key of ["capabilities", "actors", "preconditions", "testData", "environment", "flows", "rules", "interfaces", "unknowns", "conflicts", "evidence"]) {
    requireArray(intake[key], key, errors);
  }
  if (Array.isArray(intake.flows) && intake.flows.length === 0) errors.push("flows requires at least one flow");
  if (Array.isArray(intake.capabilities) && intake.capabilities.length === 0) errors.push("capabilities requires at least one item");
  if (Array.isArray(intake.evidence) && intake.evidence.length === 0) errors.push("evidence requires at least one item");

  const evidenceIds = new Set();
  const evidenceById = new Map();
  const evidenceRepositoryIds = new Set();
  const evidenceSupplementalSourceIds = new Set();
  if (Array.isArray(intake.evidence)) {
    intake.evidence.forEach((item, index) => {
      validateEvidence(
        item,
        `evidence[${index}]`,
        intake.feature?.confirmedClarifications?.length ?? 0,
        intake.feature?.subsequentRequests?.length ?? 0,
        errors,
      );
      if (typeof item?.repositoryId === "string" && !repositoryIds.has(item.repositoryId)) {
        errors.push(`evidence[${index}].repositoryId references missing repository ${item.repositoryId}`);
      }
      if (typeof item?.repositoryId === "string") evidenceRepositoryIds.add(item.repositoryId);
      if (typeof item?.supplementalSourceId === "string" && !supplementalSourceIds.has(item.supplementalSourceId)) {
        errors.push(`evidence[${index}].supplementalSourceId references missing supplemental source ${item.supplementalSourceId}`);
      }
      if (typeof item?.supplementalSourceId === "string") evidenceSupplementalSourceIds.add(item.supplementalSourceId);
      const supplementalSource = supplementalSourceById.get(item?.supplementalSourceId);
      if (supplementalSource?.role === "desired_behavior" && item?.truthPlane !== "desired") {
        errors.push(`evidence[${index}].truthPlane must be desired for desired_behavior`);
      }
      if (supplementalSource?.role === "current_runtime" && item?.truthPlane !== "deployed") {
        errors.push(`evidence[${index}].truthPlane must be deployed for current_runtime`);
      }
      if (supplementalSource?.role === "reference_context" && item?.truthPlane !== "reference") {
        errors.push(`evidence[${index}].truthPlane must be reference for reference_context`);
      }
      if (item?.kind === "design" && typeof item?.supplementalSourceId !== "string") {
        errors.push(`evidence[${index}].kind design requires a supplemental source`);
      }
      if (typeof item?.id === "string") {
        if (evidenceIds.has(item.id)) errors.push(`evidence[${index}].id duplicates evidence ID ${item.id}`);
        evidenceIds.add(item.id);
        evidenceById.set(item.id, item);
      }
    });
  }
  for (const repositoryId of repositoryIds) {
    if (!evidenceRepositoryIds.has(repositoryId)) errors.push(`repository ${repositoryId} has no evidence; remove repositories that were not materially inspected`);
  }
  for (const sourceId of supplementalSourceIds) {
    if (!evidenceSupplementalSourceIds.has(sourceId)) errors.push(`supplemental source ${sourceId} has no evidence; remove sources that were not materially inspected`);
  }
  const itemIds = collectItemIds(intake, errors);
  const capabilityIds = new Set((intake.capabilities ?? []).map((item) => item?.id).filter((id) => typeof id === "string"));
  const actorIds = new Set((intake.actors ?? []).map((item) => item?.id).filter((id) => typeof id === "string"));
  const preconditionIds = new Set((intake.preconditions ?? []).map((item) => item?.id).filter((id) => typeof id === "string"));
  const flowIds = new Set((intake.flows ?? []).map((item) => item?.id).filter((id) => typeof id === "string"));

  const validateClaimEvidencePlane = (refs, pointer) => {
    if (!Array.isArray(refs) || refs.length === 0) return undefined;
    const referencedPlanes = new Set(refs.map((id) => evidenceById.get(id)?.truthPlane).filter(Boolean));
    if (referencedPlanes.size > 1) {
      errors.push(`${pointer} mixes truth planes; split the claim so each claim has one plane`);
    }
    return [...referencedPlanes][0];
  };
  const validateExecutablePlane = (plane, pointer) => {
    if (plane && !["desired", "implemented", "deployed"].includes(plane)) {
      errors.push(`${pointer} cannot use ${plane} as executable behavior or an oracle; move it to a rule, interface, unknown, or conflict`);
    }
  };

  const validateGroundedCollection = (collectionName, collection) => {
    if (!Array.isArray(collection)) return;
    collection.forEach((item, index) => {
      const pointer = `${collectionName}[${index}].evidenceIds`;
      validateEvidenceRefs(item?.evidenceIds, pointer, evidenceIds, errors);
      validateClaimEvidencePlane(item?.evidenceIds, pointer);
    });
  };
  validateGroundedCollection("actors", intake.actors);
  validateGroundedCollection("capabilities", intake.capabilities);
  validateGroundedCollection("preconditions", intake.preconditions);
  validateGroundedCollection("testData", intake.testData);
  validateGroundedCollection("environment", intake.environment);
  validateGroundedCollection("rules", intake.rules);
  validateGroundedCollection("interfaces", intake.interfaces);

  for (const [collectionName, collection, allowedKeys, requiredStrings] of [
    ["capabilities", intake.capabilities, ["id", "name", "description", "evidenceIds"], ["name", "description"]],
    ["actors", intake.actors, ["id", "name", "description", "evidenceIds"], ["name", "description"]],
    ["preconditions", intake.preconditions, ["id", "description", "evidenceIds"], ["description"]],
    ["rules", intake.rules, ["id", "kind", "statement", "appliesToIds", "evidenceIds"], ["kind", "statement"]],
    ["interfaces", intake.interfaces, ["id", "kind", "name", "contractSummary", "evidenceIds"], ["kind", "name", "contractSummary"]],
  ]) {
    if (!Array.isArray(collection)) continue;
    collection.forEach((item, index) => {
      const pointer = `${collectionName}[${index}]`;
      if (!requireObject(item, pointer, errors)) return;
      rejectUnknownKeys(item, pointer, new Set(allowedKeys), errors);
      requiredStrings.forEach((key) => requireString(item[key], `${pointer}.${key}`, errors));
    });
  }
  if (Array.isArray(intake.testData)) {
    const unknownRelatedIds = new Set(
      (intake.unknowns ?? []).flatMap((unknown) => unknown?.relatedIds ?? []),
    );
    intake.testData.forEach((item, index) => {
      const pointer = `testData[${index}]`;
      if (!requireObject(item, pointer, errors)) return;
      rejectUnknownKeys(item, pointer, new Set([
        "id", "stateIntent", "preparation", "cleanupSteps", "relatedIds", "evidenceIds",
      ]), errors);
      requireString(item.stateIntent, `${pointer}.stateIntent`, errors);
      requireStringList(item.relatedIds, `${pointer}.relatedIds`, errors);
      requireStringList(item.cleanupSteps ?? [], `${pointer}.cleanupSteps`, errors);
      for (const id of item.relatedIds ?? []) {
        if (!itemIds.has(id)) errors.push(`${pointer}.relatedIds references missing item ${id}`);
      }
      if (item.preparation !== undefined) {
        if (!requireObject(item.preparation, `${pointer}.preparation`, errors)) return;
        rejectUnknownKeys(item.preparation, `${pointer}.preparation`, new Set(["strategy", "steps"]), errors);
        if (!["chained", "externalized"].includes(item.preparation.strategy)) {
          errors.push(`${pointer}.preparation.strategy is invalid`);
        }
        requireStringList(item.preparation.steps, `${pointer}.preparation.steps`, errors);
        if ((item.preparation.steps?.length ?? 0) === 0) errors.push(`${pointer}.preparation.steps requires at least one step`);
      } else if (!unknownRelatedIds.has(item.id)) {
        errors.push(`${pointer} has no grounded preparation recipe or related unknown explaining how the prerequisite state will be obtained`);
      }
    });
  }
  if (Array.isArray(intake.environment)) {
    intake.environment.forEach((item, index) => {
      const pointer = `environment[${index}]`;
      if (!requireObject(item, pointer, errors)) return;
      rejectUnknownKeys(item, pointer, new Set([
        "id", "description", "readinessCheck", "freshnessMarker", "relatedIds", "evidenceIds", "blocking",
      ]), errors);
      requireString(item.description, `${pointer}.description`, errors);
      requireString(item.readinessCheck, `${pointer}.readinessCheck`, errors);
      if (item.freshnessMarker !== undefined
        && (typeof item.freshnessMarker !== "string" || item.freshnessMarker.length < 8 || item.freshnessMarker.length > 256)) {
        errors.push(`${pointer}.freshnessMarker must be 8-256 characters when present`);
      }
      requireStringList(item.relatedIds, `${pointer}.relatedIds`, errors);
      for (const id of item.relatedIds ?? []) {
        if (!itemIds.has(id)) errors.push(`${pointer}.relatedIds references missing item ${id}`);
      }
      if (typeof item.blocking !== "boolean") errors.push(`${pointer}.blocking must be boolean`);
    });
  }
  if (Array.isArray(intake.rules)) {
    const allowedKinds = new Set(["permission", "validation", "business", "persistence", "data", "integration", "testability"]);
    intake.rules.forEach((item, index) => {
      if (!allowedKinds.has(item?.kind)) errors.push(`rules[${index}].kind is invalid`);
      validateClaimEvidencePlane(item?.evidenceIds, `rules[${index}].evidenceIds`);
    });
  }
  if (Array.isArray(intake.interfaces)) {
    const allowedKinds = new Set(["ui", "route", "http_api", "event", "job", "storage", "configuration", "external_service"]);
    intake.interfaces.forEach((item, index) => {
      if (!allowedKinds.has(item?.kind)) errors.push(`interfaces[${index}].kind is invalid`);
      validateClaimEvidencePlane(item?.evidenceIds, `interfaces[${index}].evidenceIds`);
    });
  }

  if (Array.isArray(intake.flows)) {
    intake.flows.forEach((flow, flowIndex) => {
      const pointer = `flows[${flowIndex}]`;
      if (isObject(flow)) rejectUnknownKeys(flow, pointer, new Set([
        "id", "capabilityId", "name", "purpose", "parentFlowId", "parentRelation", "actorIds",
        "preconditionIds", "operations", "evidenceIds",
      ]), errors);
      if (!requireId(flow?.capabilityId, `${pointer}.capabilityId`, errors)
        || !capabilityIds.has(flow.capabilityId)) {
        errors.push(`${pointer}.capabilityId references missing capability ${flow?.capabilityId ?? ""}`);
      }
      requireString(flow?.name, `${pointer}.name`, errors);
      requireString(flow?.purpose, `${pointer}.purpose`, errors);
      validateEvidenceRefs(flow?.evidenceIds, `${pointer}.evidenceIds`, evidenceIds, errors);
      validateExecutablePlane(
        validateClaimEvidencePlane(flow?.evidenceIds, `${pointer}.evidenceIds`),
        `${pointer}.evidenceIds`,
      );
      requireStringList(flow?.actorIds, `${pointer}.actorIds`, errors);
      if ((flow?.actorIds?.length ?? 0) === 0) errors.push(`${pointer}.actorIds requires at least one actor`);
      requireStringList(flow?.preconditionIds, `${pointer}.preconditionIds`, errors);
      for (const id of flow?.actorIds ?? []) if (!actorIds.has(id)) errors.push(`${pointer}.actorIds references missing actor ${id}`);
      for (const id of flow?.preconditionIds ?? []) if (!preconditionIds.has(id)) errors.push(`${pointer}.preconditionIds references missing precondition ${id}`);
      if ((flow?.parentFlowId && !flow?.parentRelation) || (!flow?.parentFlowId && flow?.parentRelation)) {
        errors.push(`${pointer} must set parentFlowId and parentRelation together`);
      }
      if (flow?.parentRelation && !["alternative", "continuation"].includes(flow.parentRelation)) {
        errors.push(`${pointer}.parentRelation is invalid`);
      }
      if (flow?.parentFlowId && !flowIds.has(flow.parentFlowId)) errors.push(`${pointer}.parentFlowId references missing flow ${flow.parentFlowId}`);
      if (!requireArray(flow?.operations, `${pointer}.operations`, errors)) return;
      if (flow.operations.length === 0) errors.push(`${pointer}.operations requires at least one operation`);
      const indexes = [];
      flow.operations.forEach((operation, operationIndex) => {
        const operationPointer = `${pointer}.operations[${operationIndex}]`;
        if (!requireObject(operation, operationPointer, errors)) return;
        rejectUnknownKeys(operation, operationPointer, new Set([
          "id", "sequenceIndex", "name", "entry", "inputs", "actions", "states", "notes", "evidenceIds",
        ]), errors);
        requireString(operation.name, `${operationPointer}.name`, errors);
        if (!Number.isInteger(operation.sequenceIndex) || operation.sequenceIndex < 0) errors.push(`${operationPointer}.sequenceIndex must be a non-negative integer`);
        else indexes.push(operation.sequenceIndex);
        requireStringList(operation.inputs, `${operationPointer}.inputs`, errors);
        requireStringList(operation.actions, `${operationPointer}.actions`, errors);
        requireStringList(operation.notes, `${operationPointer}.notes`, errors);
        validateEvidenceRefs(operation.evidenceIds, `${operationPointer}.evidenceIds`, evidenceIds, errors);
        validateExecutablePlane(
          validateClaimEvidencePlane(operation.evidenceIds, `${operationPointer}.evidenceIds`),
          `${operationPointer}.evidenceIds`,
        );
        if ((operation.inputs?.length ?? 0) + (operation.actions?.length ?? 0) === 0 && !operation.entry) {
          errors.push(`${operationPointer} requires an entry, input, or action`);
        }
        if (!requireArray(operation.states, `${operationPointer}.states`, errors)) return;
        if (operation.states.length === 0) errors.push(`${operationPointer} requires at least one observable state`);
        operation.states.forEach((state, stateIndex) => {
          const statePointer = `${operationPointer}.states[${stateIndex}]`;
          if (!requireObject(state, statePointer, errors)) return;
          rejectUnknownKeys(state, statePointer, new Set(["role", "description", "evidenceIds"]), errors);
          if (!["initial", "intermediate", "terminal", "error"].includes(state.role)) errors.push(`${statePointer}.role is invalid`);
          requireString(state.description, `${statePointer}.description`, errors);
          validateEvidenceRefs(state.evidenceIds, `${statePointer}.evidenceIds`, evidenceIds, errors);
          const statePlane = validateClaimEvidencePlane(state.evidenceIds, `${statePointer}.evidenceIds`);
          validateExecutablePlane(statePlane, `${statePointer}.evidenceIds`);
          if (["implemented", "deployed"].includes(statePlane) && SUSPECTED_RUNTIME_DEFECT.test(state.description ?? "")) {
            const kinds = (state.evidenceIds ?? []).map((id) => evidenceById.get(id)?.kind).filter(Boolean);
            if (!kinds.some((kind) => kind === "test" || kind === "runtime_observation" || kind === "documentation")) {
              warnings.push(`${statePointer} states a suspected visible defect without test, runtime, or documentation evidence; model it as an unknown or conflict`);
            }
          }
        });
        if (!operation.states.some((state) => state?.role === "terminal" || state?.role === "error")) {
          errors.push(`${operationPointer} requires a terminal or error observable state`);
        }
      });
      indexes.sort((a, b) => a - b);
      if (indexes.some((value, index) => value !== index)) errors.push(`${pointer}.operations sequenceIndex values must be contiguous from 0`);
      const firstOperation = flow.operations.find((operation) => operation?.sequenceIndex === 0);
      if (!firstOperation?.entry) errors.push(`${pointer} requires a reachable entry on its first operation`);
    });
  }

  if (Array.isArray(intake.flows)) {
    const parentByFlow = new Map(intake.flows.filter((flow) => flow?.id).map((flow) => [flow.id, flow.parentFlowId]));
    for (const flow of intake.flows) {
      const seen = new Set();
      let current = flow?.id;
      while (current && parentByFlow.get(current)) {
        if (seen.has(current)) {
          errors.push(`flows contains a parent relationship cycle involving ${current}`);
          break;
        }
        seen.add(current);
        current = parentByFlow.get(current);
      }
    }
  }

  for (const capabilityId of capabilityIds) {
    if (!(intake.flows ?? []).some((flow) => flow?.capabilityId === capabilityId)) {
      errors.push(`capability ${capabilityId} has no flow`);
    }
  }

  for (const [collectionName, collection, refKeys] of [
    ["rules", intake.rules, ["appliesToIds"]],
    ["unknowns", intake.unknowns, ["relatedIds"]],
    ["conflicts", intake.conflicts, ["relatedIds"]],
  ]) {
    if (!Array.isArray(collection)) continue;
    collection.forEach((item, index) => {
      for (const key of refKeys) {
        if (!requireStringList(item?.[key], `${collectionName}[${index}].${key}`, errors)) continue;
        for (const id of item[key]) if (!itemIds.has(id)) errors.push(`${collectionName}[${index}].${key} references missing item ${id}`);
      }
    });
  }

  if (Array.isArray(intake.unknowns)) {
    intake.unknowns.forEach((item, index) => {
      if (isObject(item)) rejectUnknownKeys(item, `unknowns[${index}]`, new Set([
        "id", "question", "impact", "resolutionGoal", "relatedIds", "evidenceIds", "blocking",
      ]), errors);
      for (const key of ["question", "impact", "resolutionGoal"]) requireString(item?.[key], `unknowns[${index}].${key}`, errors);
      validateEvidenceRefs(item?.evidenceIds, `unknowns[${index}].evidenceIds`, evidenceIds, errors, { required: false });
      if (typeof item?.blocking !== "boolean") errors.push(`unknowns[${index}].blocking must be boolean`);
      const lineageText = `${item?.question ?? ""} ${item?.impact ?? ""} ${item?.resolutionGoal ?? ""}`;
      if (LOCAL_LINEAGE_UNKNOWN.test(lineageText)) {
        errors.push(`unknowns[${index}] describes local lineage recovery rather than product behavior; report it only in the completion response`);
      }
      if (item?.blocking === true && SELF_RESOLVABLE_RUNTIME_UNKNOWN.test(item?.resolutionGoal ?? "")) {
        warnings.push(`unknowns[${index}] is marked blocking but appears resolvable by the requested runtime test; use non-blocking unless authoring truly cannot proceed`);
      }
    });
  }
  if (Array.isArray(intake.conflicts)) {
    intake.conflicts.forEach((item, index) => {
      const pointer = `conflicts[${index}]`;
      if (isObject(item)) rejectUnknownKeys(item, pointer, new Set([
        "id", "summary", "claims", "impact", "resolutionGoal", "relatedIds", "blocking",
      ]), errors);
      for (const key of ["summary", "impact", "resolutionGoal"]) requireString(item?.[key], `${pointer}.${key}`, errors);
      if (!requireArray(item?.claims, `${pointer}.claims`, errors)) return;
      if (item.claims.length < 2) errors.push(`${pointer}.claims requires at least two grounded claims`);
      const claimPlanes = new Set();
      item.claims.forEach((claim, claimIndex) => {
        if (isObject(claim)) rejectUnknownKeys(claim, `${pointer}.claims[${claimIndex}]`, new Set(["statement", "evidenceIds"]), errors);
        requireString(claim?.statement, `${pointer}.claims[${claimIndex}].statement`, errors);
        validateEvidenceRefs(claim?.evidenceIds, `${pointer}.claims[${claimIndex}].evidenceIds`, evidenceIds, errors);
        const claimPlane = validateClaimEvidencePlane(
          claim?.evidenceIds,
          `${pointer}.claims[${claimIndex}].evidenceIds`,
        );
        if (claimPlane) claimPlanes.add(claimPlane);
      });
      if (typeof item?.blocking !== "boolean") errors.push(`${pointer}.blocking must be boolean`);
      if (item?.blocking === true && claimPlanes.has("desired")
        && [...claimPlanes].some((plane) => ["implemented", "deployed"].includes(plane))) {
        errors.push(`${pointer} is a desired-versus-current implementation/deployment gap with an authoritative oracle and cannot be blocking`);
      }
    });
  }

  const blockingUnknowns = (intake.unknowns ?? []).filter((item) => item?.blocking === true).length;
  const blockingConflicts = (intake.conflicts ?? []).filter((item) => item?.blocking === true).length;
  const blockingEnvironment = (intake.environment ?? []).filter((item) => item?.blocking === true).length;
  if (blockingUnknowns) errors.push(`intake has ${blockingUnknowns} blocking unknown(s); resolve them before rendering`);
  if (blockingConflicts) errors.push(`intake has ${blockingConflicts} blocking conflict(s); resolve them before rendering`);
  if (blockingEnvironment) errors.push(`intake has ${blockingEnvironment} blocking environment requirement(s); resolve them before rendering`);
  if (errors.length === 0) {
    const renderedContext = renderContextMarkdown(intake);
    const shareableStrings = collectStrings([intake.feature?.name, buildContextPayload(intake)]);
    if (REPOSITORY_LOCATOR_LEAK.test(renderedContext)) {
      errors.push("rendered context appears to contain repository/file metadata or a local locator");
    }
    if ((intake.repositories ?? []).some((repository) => containsDeclaredRepositoryName(renderedContext, repository?.name))) {
      errors.push("rendered context contains a declared repository name; replace it with a product-level description");
    }
    if (URL_LEAK.test(renderedContext)) {
      errors.push("rendered context appears to contain a URL; replace it with a product-level entry description");
    }
    if (COMMIT_LEAK.test(renderedContext)) {
      errors.push("rendered context appears to contain a commit or revision identifier");
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(renderedContext))) {
      errors.push("rendered context appears to contain a credential or secret");
    }
    if (shareableStrings.some((value) => EMAIL_LEAK.test(value))) {
      errors.push("rendered context appears to contain an email address; replace it with a fixture role description");
    }
    if (shareableStrings.some((value) => INTERNAL_HOST_LEAK.test(value))) {
      errors.push("rendered context appears to contain an internal hostname or private network address");
    }
    if (shareableStrings.some((value) => BUSINESS_IDENTIFIER_LEAK.test(value))) {
      errors.push("rendered context appears to contain a customer or business record identifier; replace it with state intent");
    }
    if (shareableStrings.some((value) => containsCodeShapedContent(value))) {
      errors.push("rendered context appears to contain source or code-shaped content; rewrite it as product behavior");
    }
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function truthPlaneFor(intake, evidenceIds) {
  const evidenceById = new Map(intake.evidence.map((item) => [item.id, item]));
  const planes = [...new Set((evidenceIds ?? []).map((id) => evidenceById.get(id)?.truthPlane).filter(Boolean))];
  return planes[0] ?? "inference";
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

export function buildContextPayload(intake) {
  return {
    userAuthority: {
      originalRequest: intake.feature.originalRequest,
      subsequentRequests: intake.feature.subsequentRequests ?? [],
      confirmedClarifications: intake.feature.confirmedClarifications.map((item) => ({
        questionContext: item.questionContext,
        userAnswer: item.answer,
      })),
    },
    groundedContext: {
      scopeProjection: {
        requestedScope: intake.feature.query.requestedScope,
        explicitInScope: intake.feature.query.explicitInScope,
        explicitOutOfScope: intake.feature.query.explicitOutOfScope,
        successCriteria: intake.feature.query.successCriteria,
        testConstraints: intake.feature.query.testConstraints,
        truthPlane: "desired",
        basis: "Structured from User Authority requests and confirmed clarification answers",
      },
      capabilities: intake.capabilities.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        truthPlane: truthPlaneFor(intake, item.evidenceIds),
      })),
      actors: intake.actors.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        truthPlane: truthPlaneFor(intake, item.evidenceIds),
      })),
      preconditions: intake.preconditions.map((item) => ({
        id: item.id,
        description: item.description,
        truthPlane: truthPlaneFor(intake, item.evidenceIds),
      })),
      testData: (intake.testData ?? []).map((item) => ({
        id: item.id,
        stateIntent: item.stateIntent,
        truthPlane: truthPlaneFor(intake, item.evidenceIds),
        ...(item.preparation ? { preparation: item.preparation } : {}),
        cleanupSteps: item.cleanupSteps ?? [],
        relatedIds: item.relatedIds,
      })),
      environment: (intake.environment ?? []).map((item) => ({
        id: item.id,
        description: item.description,
        readinessCheck: item.readinessCheck,
        truthPlane: truthPlaneFor(intake, item.evidenceIds),
        relatedIds: item.relatedIds,
      })),
      flows: intake.flows.map((flow) => ({
        id: flow.id,
        capabilityId: flow.capabilityId,
        name: flow.name,
        purpose: flow.purpose,
        truthPlane: truthPlaneFor(intake, flow.evidenceIds),
        actorIds: flow.actorIds,
        preconditionIds: flow.preconditionIds,
        ...(flow.parentFlowId ? {
          relationship: {
            type: flow.parentRelation,
            parentFlowId: flow.parentFlowId,
          },
        } : {}),
        operations: [...flow.operations].sort((a, b) => a.sequenceIndex - b.sequenceIndex).map((operation) => ({
          id: operation.id,
          sequence: operation.sequenceIndex + 1,
          name: operation.name,
          truthPlane: truthPlaneFor(intake, operation.evidenceIds),
          ...(operation.entry ? { entry: operation.entry } : {}),
          inputs: operation.inputs,
          actions: operation.actions,
          states: operation.states.map((state) => ({
            role: state.role,
            description: state.description,
            truthPlane: truthPlaneFor(intake, state.evidenceIds),
          })),
          notes: operation.notes,
        })),
      })),
      rules: intake.rules.map((item) => ({
        id: item.id,
        kind: item.kind,
        statement: item.statement,
        truthPlane: truthPlaneFor(intake, item.evidenceIds),
        appliesToIds: item.appliesToIds,
      })),
      interfaces: intake.interfaces.map((item) => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        contractSummary: item.contractSummary,
        truthPlane: truthPlaneFor(intake, item.evidenceIds),
      })),
      nonBlockingUnknowns: intake.unknowns.map((item) => ({
        id: item.id,
        question: item.question,
        impact: item.impact,
        resolutionGoal: item.resolutionGoal,
        relatedIds: item.relatedIds,
      })),
      nonBlockingConflicts: intake.conflicts.map((item) => ({
        id: item.id,
        summary: item.summary,
        claims: item.claims.map((claim) => ({
          statement: claim.statement,
          truthPlane: truthPlaneFor(intake, claim.evidenceIds),
        })),
        impact: item.impact,
        resolutionGoal: item.resolutionGoal,
        relatedIds: item.relatedIds,
      })),
    },
  };
}

export function renderContextMarkdown(intake) {
  const payload = buildContextPayload(intake);
  return [
    "---",
    `schema: ${CONTEXT_SCHEMA_VERSION}`,
    `featureId: ${yamlString(intake.featureId)}`,
    `contextRevision: ${intake.contextRevision}`,
    `featureName: ${yamlString(intake.feature.name)}`,
    "---", "",
    `# Doable TRD Context: ${intake.feature.name}`, "",
    "> This typed context was prepared by the customer's coding agent. User Authority is the only product-intent authority; Grounded Context is agent-asserted source analysis, not source material independently inspected by Doable.", "",
    "## User Authority", "",
    "```json",
    JSON.stringify(payload.userAuthority, null, 2),
    "```", "",
    "## Grounded Context", "",
    "```json",
    JSON.stringify(payload.groundedContext, null, 2),
    "```", "",
  ].join("\n");
}

function summaryItems(values, emptyLabel = "None") {
  if (!values.length) return [`- ${emptyLabel}`];
  return values.map((value) => `- ${normalizedComparableLine(value)}`);
}

export function renderCompletionSummary(intake, contextPath) {
  return [
    "## Doable context ready", "",
    `Upload file: ${contextPath}`,
    "Next step: Create a suite in the Doable platform and upload `doable-context.md` to create the TRD.", "",
    `Scope: ${normalizedComparableLine(intake.feature.query.requestedScope)}`, "",
    "Flows:",
    ...summaryItems((intake.flows ?? []).map((flow) => flow.name)),
  ].join("\n");
}

function normalizedComparableLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

export async function validateRepositoryEvidence(intake, repositoryRoots, { updateFingerprints = false } = {}) {
  const errors = [];
  const repositoryById = new Map((intake.repositories ?? []).map((repository) => [repository?.id, repository]));
  const declaredIds = new Set(repositoryById.keys());
  const roots = new Map();
  const physicalRoots = new Map();
  for (const [repositoryId, configuredRoot] of repositoryRoots) {
    if (!declaredIds.has(repositoryId)) {
      errors.push(`repository root binding references undeclared repository ${repositoryId}`);
      continue;
    }
    let root;
    try {
      root = await fs.realpath(path.resolve(configuredRoot));
    } catch {
      errors.push(`repository root for ${repositoryId} does not exist or is not readable`);
      continue;
    }
    if (root === path.parse(root).root) {
      errors.push(`repository root for ${repositoryId} cannot be a filesystem root`);
      continue;
    }
    const repository = repositoryById.get(repositoryId);
    let gitMarker;
    try {
      gitMarker = await fs.lstat(path.join(root, ".git"));
    } catch {
      gitMarker = undefined;
    }
    if (repository?.vcs?.type === "git" && (!gitMarker || gitMarker.isSymbolicLink())) {
      errors.push(`repository root for ${repositoryId} is not a Git repository boundary`);
      continue;
    }
    if (repository?.vcs?.type === "git") {
      try {
        const [revisionResult, statusResult] = await Promise.all([
          execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
          execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
            cwd: root,
            encoding: "utf8",
          }),
        ]);
        const actualCommit = revisionResult.stdout.trim();
        const actualDirty = statusResult.stdout.trim().length > 0;
        if (repository.vcs.commit.toLowerCase() !== actualCommit.toLowerCase()) {
          errors.push(`repository ${repositoryId} commit does not match the bound Git checkout`);
        }
        if (repository.vcs.dirty !== actualDirty) {
          errors.push(`repository ${repositoryId} dirty state does not match the bound Git checkout`);
        }
      } catch {
        errors.push(`repository ${repositoryId} Git revision or dirty state could not be verified`);
        continue;
      }
    }
    if (repository?.vcs?.type === "unversioned") {
      if (gitMarker) {
        errors.push(`repository ${repositoryId} is declared unversioned but its root is a Git repository`);
        continue;
      }
      const entries = await fs.readdir(root, { withFileTypes: true });
      let nestedGitRoot;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        try {
          await fs.lstat(path.join(root, entry.name, ".git"));
          nestedGitRoot = entry.name;
          break;
        } catch {
          // Not an immediate child repository.
        }
      }
      if (nestedGitRoot) {
        errors.push(`unversioned root for ${repositoryId} contains child Git repository ${nestedGitRoot}; bind independent repositories separately`);
        continue;
      }
    }
    if (physicalRoots.has(root)) {
      errors.push(`repositories ${physicalRoots.get(root)} and ${repositoryId} resolve to the same root`);
      continue;
    }
    roots.set(repositoryId, root);
    physicalRoots.set(root, repositoryId);
  }
  for (const repositoryId of declaredIds) {
    if (!roots.has(repositoryId)) errors.push(`missing repository root binding for ${repositoryId}`);
  }
  const renderedContext = normalizedComparableLine(
    renderContextMarkdown(intake).replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
  );
  const auditedFiles = new Map();
  const filesByRepository = new Map();
  for (const evidence of intake.evidence ?? []) {
    const repositoryId = evidence?.repositoryId;
    const root = roots.get(repositoryId);
    if (!root) continue;
    const locatorPath = evidence?.locator?.path;
    const auditKey = `${repositoryId}\0${locatorPath}`;
    if (typeof locatorPath !== "string") continue;
    let audited = auditedFiles.get(auditKey);
    if (!audited) {
      const candidate = path.resolve(root, locatorPath);
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
        errors.push(`evidence ${evidence.id} locator resolves outside repository ${repositoryId}`);
        continue;
      }
      let resolved;
      let stat;
      try {
        resolved = await fs.realpath(candidate);
        stat = await fs.lstat(candidate);
      } catch {
        errors.push(`evidence ${evidence.id} locator file does not exist`);
        continue;
      }
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        errors.push(`evidence ${evidence.id} locator resolves outside repository ${repositoryId}`);
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        errors.push(`evidence ${evidence.id} locator must be a regular non-symlink file`);
        continue;
      }
      if (stat.size > 1_048_576) {
        errors.push(`evidence ${evidence.id} locator file exceeds the 1 MiB audit limit`);
        continue;
      }
      try {
        const sourceBytes = await fs.readFile(candidate);
        const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
        audited = { sourceBytes, sourceLines: source.split(/\r?\n/) };
        auditedFiles.set(auditKey, audited);
        if (!filesByRepository.has(repositoryId)) filesByRepository.set(repositoryId, new Map());
        filesByRepository.get(repositoryId).set(locatorPath, sourceBytes);
        for (const rawLine of audited.sourceLines) {
          const line = normalizedComparableLine(rawLine);
          if (line.length < 32 || (line.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 16) continue;
          if (renderedContext.includes(line)) {
            errors.push(`rendered context contains an exact source-line overlap associated with ${evidence.id}`);
            break;
          }
        }
      } catch {
        errors.push(`evidence ${evidence.id} locator file is not readable UTF-8 text`);
        continue;
      }
    }
    const sourceLines = audited.sourceLines;
    if (evidence.locator.endLine > sourceLines.length) {
      errors.push(`evidence ${evidence.id} locator ends beyond the file's ${sourceLines.length} lines`);
    }
    if (evidence.locator.startLine > sourceLines.length) {
      errors.push(`evidence ${evidence.id} locator starts beyond the file's ${sourceLines.length} lines`);
    }
  }
  const repositoryFingerprints = new Map();
  for (const repositoryId of declaredIds) {
    if (!roots.has(repositoryId)) continue;
    const hash = createHash("sha256");
    const files = [...(filesByRepository.get(repositoryId)?.entries() ?? [])]
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [locatorPath, sourceBytes] of files) {
      hash.update(locatorPath);
      hash.update("\0");
      hash.update(sourceBytes);
      hash.update("\0");
    }
    const actualFingerprint = hash.digest("hex");
    repositoryFingerprints.set(repositoryId, actualFingerprint);
    const declaredFingerprint = repositoryById.get(repositoryId)?.evidenceContentHash;
    if (!updateFingerprints && declaredFingerprint !== actualFingerprint) {
      errors.push(`repository ${repositoryId} evidence content fingerprint does not match the bound files`);
    }
  }
  return { errors: [...new Set(errors)], warnings: [], repositoryFingerprints };
}

function usage() {
  return "Usage: node validate-and-render.mjs <candidate-intake.json> [--canonical-out <doable-intake.json>] [--repo <REPOSITORY_ID>=<path>]... [--workspace-root <single-repository>] [--out-dir <directory>] [--update-fingerprints] [--validate-only] [--finalize]";
}

export async function runCli(argv) {
  const args = [...argv];
  const inputPath = args.shift();
  if (!inputPath || inputPath === "--help" || inputPath === "-h") {
    console.log(usage());
    return inputPath ? 0 : 2;
  }
  let outDir = path.dirname(path.resolve(inputPath));
  let validateOnly = false;
  let finalize = false;
  let updateFingerprints = false;
  let canonicalOutPath;
  let workspaceRoot;
  const repositoryRoots = new Map();
  while (args.length) {
    const arg = args.shift();
    if (arg === "--out-dir") {
      const value = args.shift();
      if (!value) throw new Error("--out-dir requires a directory");
      outDir = path.resolve(value);
    } else if (arg === "--canonical-out") {
      const value = args.shift();
      if (!value) throw new Error("--canonical-out requires a file path");
      canonicalOutPath = path.resolve(value);
    } else if (arg === "--workspace-root") {
      const value = args.shift();
      if (!value) throw new Error("--workspace-root requires a directory");
      workspaceRoot = path.resolve(value);
    } else if (arg === "--repo") {
      const value = args.shift();
      const separator = value?.indexOf("=") ?? -1;
      if (!value || separator < 1 || separator === value.length - 1) {
        throw new Error("--repo requires REPOSITORY_ID=/absolute/or/relative/path");
      }
      const repositoryId = value.slice(0, separator);
      if (!ID_PATTERN.test(repositoryId)) throw new Error(`--repo repository ID must match ${ID_PATTERN}`);
      if (repositoryRoots.has(repositoryId)) throw new Error(`duplicate --repo binding for ${repositoryId}`);
      repositoryRoots.set(repositoryId, path.resolve(value.slice(separator + 1)));
    } else if (arg === "--validate-only") {
      validateOnly = true;
    } else if (arg === "--update-fingerprints") {
      updateFingerprints = true;
    } else if (arg === "--finalize") {
      finalize = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const resolvedInputPath = path.resolve(inputPath);
  const resolvedCanonicalOutPath = canonicalOutPath ?? resolvedInputPath;
  if (finalize && validateOnly) throw new Error("--finalize cannot be combined with --validate-only");
  if (finalize && path.basename(resolvedInputPath) !== "doable-intake.candidate.json") {
    throw new Error("--finalize requires an input named doable-intake.candidate.json");
  }
  if (finalize && resolvedInputPath === resolvedCanonicalOutPath) {
    throw new Error("--finalize requires a separate --canonical-out path");
  }
  const intake = JSON.parse(await fs.readFile(resolvedInputPath, "utf8"));
  const result = validateIntake(intake, { allowMissingFingerprints: updateFingerprints });
  if (workspaceRoot && repositoryRoots.size) {
    result.errors.push("use either --workspace-root or --repo, not both");
  }
  if (result.errors.length === 0 && workspaceRoot) {
    if (intake.repositories.length !== 1) {
      result.errors.push("--workspace-root is valid only when the intake declares exactly one repository; use repeated --repo for multi-repo intake");
    } else {
      repositoryRoots.set(intake.repositories[0].id, workspaceRoot);
    }
  }
  if (result.errors.length === 0) {
    const workspaceResult = await validateRepositoryEvidence(intake, repositoryRoots, { updateFingerprints });
    result.errors.push(...workspaceResult.errors);
    result.warnings.push(...workspaceResult.warnings);
    if (updateFingerprints && workspaceResult.errors.length === 0) {
      for (const repository of intake.repositories ?? []) {
        repository.evidenceContentHash = workspaceResult.repositoryFingerprints.get(repository.id);
      }
      const strictResult = validateIntake(intake);
      result.errors.push(...strictResult.errors);
      result.warnings.push(...strictResult.warnings);
    }
  }
  result.errors = [...new Set(result.errors)];
  result.warnings = [...new Set(result.warnings)];
  result.warnings.forEach((warning) => console.warn(`WARN ${warning}`));
  if (result.errors.length) {
    result.errors.forEach((error) => console.error(`ERROR ${error}`));
    console.error(`Validation failed with ${result.errors.length} error(s).`);
    return 1;
  }
  console.log(`Validation passed with ${result.warnings.length} warning(s).`);
  if (updateFingerprints || resolvedCanonicalOutPath !== resolvedInputPath) {
    await fs.mkdir(path.dirname(resolvedCanonicalOutPath), { recursive: true });
    await atomicWriteFile(resolvedCanonicalOutPath, `${JSON.stringify(intake, null, 2)}\n`);
    console.log(`Wrote ${resolvedCanonicalOutPath}`);
  }
  if (validateOnly) return 0;

  await fs.mkdir(outDir, { recursive: true });
  if (process.platform !== "win32") {
    await fs.chmod(resolvedInputPath, 0o600);
  }
  const contextPath = path.join(outDir, "doable-context.md");
  await atomicWriteFile(contextPath, renderContextMarkdown(intake));
  console.log(`Wrote ${contextPath}`);
  if (
    finalize
    && resolvedInputPath !== resolvedCanonicalOutPath
    && path.basename(resolvedInputPath) === "doable-intake.candidate.json"
  ) {
    await fs.unlink(resolvedInputPath);
    console.log(`Removed ${resolvedInputPath}`);
  }
  console.log("");
  console.log(renderCompletionSummary(intake, contextPath));
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
