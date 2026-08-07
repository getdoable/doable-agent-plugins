import fs from "node:fs/promises";
import path from "node:path";

function usage() {
  return "Usage: node patch-candidate.mjs <candidate.json> <operations.json>";
}

function decodePointer(pathValue) {
  if (pathValue === "") return [];
  if (!pathValue.startsWith("/")) throw new Error(`Invalid JSON Pointer: ${pathValue}`);
  return pathValue.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function arrayIndex(segment, length, { allowAppend = false } = {}) {
  if (allowAppend && segment === "-") return length;
  if (!/^(0|[1-9][0-9]*)$/.test(segment)) throw new Error(`Invalid array index: ${segment}`);
  const index = Number(segment);
  if (index >= length + (allowAppend ? 1 : 0)) throw new Error(`Array index out of range: ${segment}`);
  return index;
}

function resolveParent(document, pointer) {
  const parts = decodePointer(pointer);
  if (parts.length === 0) return { parent: null, key: null };
  let current = document;
  for (const segment of parts.slice(0, -1)) {
    if (Array.isArray(current)) current = current[arrayIndex(segment, current.length)];
    else if (current && typeof current === "object" && Object.hasOwn(current, segment)) current = current[segment];
    else throw new Error(`JSON Pointer parent does not exist: ${pointer}`);
  }
  return { parent: current, key: parts.at(-1) };
}

function applyOperation(document, operation) {
  if (!operation || typeof operation !== "object") throw new Error("Each patch operation must be an object");
  if (!["add", "replace", "remove"].includes(operation.op)) throw new Error(`Unsupported patch operation: ${operation.op}`);
  const { parent, key } = resolveParent(document, operation.path);
  if (parent === null) {
    if (operation.op === "remove") throw new Error("Cannot remove the candidate root");
    if (!("value" in operation)) throw new Error(`${operation.op} requires value`);
    return operation.value;
  }
  if (Array.isArray(parent)) {
    if (operation.op === "add") parent.splice(arrayIndex(key, parent.length, { allowAppend: true }), 0, operation.value);
    else {
      const index = arrayIndex(key, parent.length);
      if (operation.op === "replace") parent[index] = operation.value;
      else parent.splice(index, 1);
    }
    return document;
  }
  if (!parent || typeof parent !== "object") throw new Error(`JSON Pointer parent is not a container: ${operation.path}`);
  if (operation.op !== "add" && !Object.hasOwn(parent, key)) throw new Error(`JSON Pointer target does not exist: ${operation.path}`);
  if (operation.op === "remove") delete parent[key];
  else parent[key] = operation.value;
  return document;
}

async function atomicWrite(targetPath, contents) {
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

export async function patchCandidate(candidatePath, operationsPath) {
  const resolvedCandidate = path.resolve(candidatePath);
  const operations = JSON.parse(await fs.readFile(path.resolve(operationsPath), "utf8"));
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("operations.json must contain a non-empty JSON Patch array");
  let document = JSON.parse(await fs.readFile(resolvedCandidate, "utf8"));
  for (const operation of operations) document = applyOperation(document, operation);
  await atomicWrite(resolvedCandidate, `${JSON.stringify(document, null, 2)}\n`);
  return operations.length;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [candidatePath, operationsPath, ...rest] = process.argv.slice(2);
  if (!candidatePath || !operationsPath || rest.length) {
    console.error(usage());
    process.exitCode = 2;
  } else {
    patchCandidate(candidatePath, operationsPath).then((count) => {
      console.log(`Applied ${count} candidate repair operation(s).`);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
  }
}
