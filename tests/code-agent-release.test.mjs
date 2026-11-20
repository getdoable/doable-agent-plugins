import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = 'plugins/doable-code-context/skills/doable-code-agent/SKILL.md';
// Built from two parts, so that the release verifier does not find the removed policy file's name in this test.
const removedPolicyFile = ['.doable', 'code-agent.md'].join('/');

// Runs the release verifier on a copy of the release in which `path` holds the text that `change` makes of it.
function verifyWith(directory, path, change) {
  const file = join(directory, path);
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, change(original));
  try {
    return spawnSync(process.execPath, [join(directory, 'scripts/verify-release.mjs')], { encoding: 'utf8' });
  } finally {
    writeFileSync(file, original);
  }
}

test('the release verifier refuses a code agent skill without the one-off session or its take tool, and a text that names the removed policy file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'doable-code-agent-release-test-'));
  try {
    cpSync(root, directory, {
      recursive: true,
      filter: (source) => !/[\\/](?:\.git|node_modules)(?:[\\/]|$)/.test(source.slice(root.length - 1)),
    });
    const unchanged = verifyWith(directory, skill, (text) => text);
    assert.equal(unchanged.status, 0, unchanged.stderr);

    const noOneOff = verifyWith(directory, skill, (text) =>
      text.replace('## Serve one request, then stop (a one-off session)', '## Serve one request by its id'));
    assert.notEqual(noOneOff.status, 0, 'a skill without the one-off section must fail');
    assert.match(noOneOff.stderr, /missing machine rule: ## Serve one request, then stop \(a one-off session\)/);

    // A one-off session that follows "Serve one request" to its "go back to the loop" would take other requests.
    const oneOffBackToLoop = verifyWith(directory, skill, (text) =>
      text.replace('Where another\n   part of this skill says "go back to the loop", do this instead.', ''));
    assert.notEqual(oneOffBackToLoop.status, 0, 'a one-off section that does not replace "go back to the loop" must fail');
    assert.match(oneOffBackToLoop.stderr, /missing machine rule: Where another part of this skill says "go back to the loop"/);

    const noTakeTool = verifyWith(directory, skill, (text) =>
      text.replace('  mcp__doable__take_code_agent_request\n', ''));
    assert.notEqual(noTakeTool.status, 0, 'a skill that does not allow take_code_agent_request must fail');
    assert.match(noTakeTool.stderr, /allowed-tools must name mcp__doable__take_code_agent_request/);

    const namesPolicyFile = verifyWith(directory, 'README.md', (text) =>
      `${text}\nWrite the policy file \`${removedPolicyFile}\`.\n`);
    assert.notEqual(namesPolicyFile.status, 0, 'a README that names the removed policy file must fail');
    assert.match(namesPolicyFile.stderr, /README\.md names \.doable\/code-agent\.md, the removed policy file/);

    // The changelog keeps the history of the file.
    const historyNamesPolicyFile = verifyWith(directory, 'CHANGELOG.md', (text) =>
      `${text}\n- The machine's policy file \`${removedPolicyFile}\`.\n`);
    assert.equal(historyNamesPolicyFile.status, 0, historyNamesPolicyFile.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
