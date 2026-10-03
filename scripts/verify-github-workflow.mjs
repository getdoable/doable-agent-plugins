import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const release = JSON.parse(readFileSync(new URL('templates/github/release.json', root), 'utf8'));
const workflow = readFileSync(new URL('templates/github/doable-code-context.yml', root));
const digest = createHash('sha256').update(workflow).digest('hex');
if (!/^\d+\.\d+\.\d+$/.test(release.version) || release.workflow !== 'doable-code-context.yml' ||
    release.customer_path !== '.github/workflows/doable-code-context.yml' ||
    release.default_provider !== 'codex' || release.automatic_updates !== false ||
    JSON.stringify(release.providers) !== JSON.stringify(['codex', 'claude']) || digest !== release.sha256) {
  throw new Error('GitHub workflow release manifest is invalid or does not match the published bytes');
}
console.log(`Verified GitHub workflow ${release.version}: ${digest}`);
