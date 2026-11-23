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

// A copy of the release, without .git and node_modules, that `use` may change; it is deleted after `use`.
function withReleaseCopy(use) {
  const directory = mkdtempSync(join(tmpdir(), 'doable-code-agent-release-test-'));
  try {
    cpSync(root, directory, {
      recursive: true,
      filter: (source) => !/[\\/](?:\.git|node_modules)(?:[\\/]|$)/.test(source.slice(root.length - 1)),
    });
    use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Runs the release verifier on the copy in `directory`, in which `path` holds the text that `change` makes of it.
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

test('the release verifier lets the code agent skill allow only the three tools of a machine, and refuses a text that names a removed tool', () => {
  withReleaseCopy((directory) => {
    // The skill as released names ask_code_agent (a serving session never calls it): that is not the removed ask_agent.
    const unchanged = verifyWith(directory, skill, (text) => text);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(readFileSync(join(directory, skill), 'utf8'), /`ask_code_agent`/);

    // The asking tool of a person's Claude Code: a serving session in dontAsk mode must not be allowed to call it.
    const allowsAskTool = verifyWith(directory, skill, (text) =>
      text.replace('  mcp__doable__update_code_agent_request\n', '  mcp__doable__update_code_agent_request\n  mcp__doable__ask_code_agent\n'));
    assert.notEqual(allowsAskTool.status, 0, 'a skill that allows ask_code_agent must fail');
    assert.match(allowsAskTool.stderr, /allowed-tools may name only the three Doable MCP tools of a code agent machine, not mcp__doable__ask_code_agent/);

    const noUpdateTool = verifyWith(directory, skill, (text) =>
      text.replace('  mcp__doable__update_code_agent_request\n', ''));
    assert.notEqual(noUpdateTool.status, 0, 'a skill that does not allow update_code_agent_request must fail');
    assert.match(noUpdateTool.stderr, /allowed-tools must name mcp__doable__update_code_agent_request/);

    // The mail read of a machine: without it in allowed-tools, its first call stops at a permission prompt.
    const noMailTool = verifyWith(directory, skill, (text) =>
      text.replace('  mcp__plugin_doable-code-context_doable__read_code_agent_mail\n', ''));
    assert.notEqual(noMailTool.status, 0, 'a skill that does not allow read_code_agent_mail must fail');
    assert.match(noMailTool.stderr, /allowed-tools must name mcp__plugin_doable-code-context_doable__read_code_agent_mail/);

    const namesOldTool = verifyWith(directory, skill, (text) =>
      `${text}\nSend the result with \`submit_code_agent_result\`, or ask with \`mcp__doable__ask_agent\`.\n`);
    assert.notEqual(namesOldTool.status, 0, 'a skill that names a removed tool must fail');
    assert.match(namesOldTool.stderr, /SKILL\.md names submit_code_agent_result, a removed code agent tool/);
    assert.match(namesOldTool.stderr, /SKILL\.md names ask_agent, a removed code agent tool/);

    // An old name of the machine's question: the message names the tool of this release, not the removed ask_agent.
    const namesOldStatus = verifyWith(directory, skill, (text) => `${text}\nWait while the request is \`needs_person\`.\n`);
    assert.notEqual(namesOldStatus.status, 0, 'a skill that names an old status of the question must fail');
    assert.match(namesOldStatus.stderr, /SKILL\.md names needs_person, an old name of the machine's question: ask with update_code_agent_request and its question/);
    assert.doesNotMatch(namesOldStatus.stderr, /use ask_agent/);

    // The changelog keeps the history of the removed tools.
    const historyNamesOldTool = verifyWith(directory, 'CHANGELOG.md', (text) =>
      `${text}\n- \`add_test_account\` registered a login.\n`);
    assert.equal(historyNamesOldTool.status, 0, historyNamesOldTool.stderr);
  });
});

test('the release verifier refuses a README that allows the whole Doable MCP server or misses an update, a skill without its login and mail rules, and a text that names the removed policy file', () => {
  withReleaseCopy((directory) => {
    const wholeServer = verifyWith(directory, 'README.md', (text) =>
      `${text}\n\`\`\`bash\nclaude --permission-mode dontAsk --allowedTools "mcp__plugin_doable-code-context_doable"\n\`\`\`\n`);
    assert.notEqual(wholeServer.status, 0, 'a README that allows the whole server must fail');
    assert.match(wholeServer.stderr, /README allows the whole Doable MCP server \("mcp__plugin_doable-code-context_doable"\)/);

    // A 0.5.0 session that still runs after the Doable MCP release takes requests that it cannot end: the update
    // stops it first.
    const noStopFirst = verifyWith(directory, 'README.md', (text) =>
      text.replace('Before the Doable MCP release, stop the 0.5.0 session', 'Stop the 0.5.0 session'));
    assert.notEqual(noStopFirst.status, 0, 'a README that does not stop a 0.5.0 session before the Doable MCP release must fail');
    assert.match(noStopFirst.stderr, /README is missing code agent setup: Before the Doable MCP release, stop the 0\.5\.0 session/);

    // A password goes only in its login of the result: a skill that drops the rule can leave it in a summary or a file.
    const noPasswordRule = verifyWith(directory, skill, (text) => text.replace('A password goes in no other place.', ''));
    assert.notEqual(noPasswordRule.status, 0, 'a skill without the password rule must fail');
    assert.match(noPasswordRule.stderr, /missing machine rule: A password goes in no other place\./);

    // A login that the environment already has: the machine makes a new one and sends the result again.
    const noUsernameExists = verifyWith(directory, skill, (text) =>
      text.replace('put it in place of the refused one, and send the result again.', 'and stop.'));
    assert.notEqual(noUsernameExists.status, 0, 'a skill that does not send the result again after username_exists must fail');
    assert.match(noUsernameExists.stderr, /missing machine rule: Make a new login with a new username in the app/);

    // A test inbox mail's link or code works like a password: a skill that drops the rule can put it in a result. The
    // rule wraps across lines in the skill.
    const mailLinkRule = /Never put the link or the code in a progress text, a\s+question or a result/;
    assert.match(readFileSync(join(directory, skill), 'utf8'), mailLinkRule);
    const noMailLinkRule = verifyWith(directory, skill, (text) => text.replace(mailLinkRule, 'Use the link or the code'));
    assert.notEqual(noMailLinkRule.status, 0, 'a skill without the rule for the link of a test inbox mail must fail');
    assert.match(noMailLinkRule.stderr, /missing machine rule: Never put the link or the code in a progress text, a question or a result/);

    // A 0.6.0 machine gets the mail tool's rule only from a start of this release: the README says how.
    const noUpdateFrom060 = verifyWith(directory, 'README.md', (text) => text.replace('### Update from 0.6.0', '### Update'));
    assert.notEqual(noUpdateFrom060.status, 0, 'a README without the update from 0.6.0 must fail');
    assert.match(noUpdateFrom060.stderr, /README is missing code agent setup: ### Update from 0\.6\.0/);

    const namesPolicyFile = verifyWith(directory, 'README.md', (text) =>
      `${text}\nWrite the policy file \`${removedPolicyFile}\`.\n`);
    assert.notEqual(namesPolicyFile.status, 0, 'a README that names the removed policy file must fail');
    assert.match(namesPolicyFile.stderr, /README\.md names \.doable\/code-agent\.md, the removed policy file/);

    // The changelog keeps the history of the file.
    const historyNamesPolicyFile = verifyWith(directory, 'CHANGELOG.md', (text) =>
      `${text}\n- The machine's policy file \`${removedPolicyFile}\`.\n`);
    assert.equal(historyNamesPolicyFile.status, 0, historyNamesPolicyFile.stderr);
  });
});
