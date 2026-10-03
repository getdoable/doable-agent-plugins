import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
test('GitHub release verifier rejects byte drift and misleading metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'doable-release-test-'));
  try {
    cpSync(new URL('templates', root), join(directory, 'templates'), { recursive: true });
    cpSync(new URL('scripts', root), join(directory, 'scripts'), { recursive: true });
    const verify = () => spawnSync(process.execPath,
      [join(directory, 'scripts/verify-github-workflow.mjs')], { encoding: 'utf8' });
    assert.equal(verify().status, 0);
    const file = join(directory, 'templates/github/doable-code-context.yml');
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from('\n# unreviewed change\n')]));
    assert.notEqual(verify().status, 0, 'changed workflow bytes must fail');
    writeFileSync(file, original);
    const manifestFile = join(directory, 'templates/github/release.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.automatic_updates = true;
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.notEqual(verify().status, 0, 'unsupported update policy must fail');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
