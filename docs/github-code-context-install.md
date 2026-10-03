# Install GitHub Code Context with a coding agent

This guide installs Doable's self-contained runner in a customer's repository.
It is separate from the local Doable MCP plugin. No private Doable repository,
backend package, or long-lived Doable API key is required on the runner.

## Give your coding agent this task

```text
Install Doable GitHub Code Context in the product repository in this workspace.
Read https://github.com/getdoable/doable-agent-plugins/blob/main/docs/github-code-context-install.md
and follow its agent installation procedure. Use the public release template.
Preserve existing workflows and credentials. Ask me to choose Codex or Claude
only if the existing provider configuration does not establish my choice.
Use masked credential input, never chat, for any missing provider credential.
Create a focused installation PR; do not merge without my approval.
Report the exact repository, release commit, provider, checks, and remaining
GitHub App or Doable connection actions. Do not start a paid analysis run.
```

The agent can finish repository changes with authorized GitHub access.
Subscription login, secret input, App approval, and Doable connection require
the customer's authenticated access. Report a specific missing permission;
do not claim installation is complete when these prerequisites are missing.

## Agent installation procedure

Prerequisites: Git, authenticated `gh` access to the target repository, and
Node.js 20 or newer for release verification. Secrets/App changes need the
corresponding repository or organization permissions. Do not request broader
permissions when the existing access is sufficient.

1. Confirm the customer's exact product repository from its Git remote and
   `gh repo view --json nameWithOwner,defaultBranchRef`. Inspect the working tree
   and existing `.github/workflows/doable-code-context.yml`. Do not use a sample
   or neighboring repository. Preserve uncommitted work.
2. Read existing provider variables and secret **names** with
   `gh variable list --repo OWNER/REPO` and `gh secret list --repo OWNER/REPO`.
   Preserve an existing valid provider. For a new installation, obtain the
   customer's choice before configuring credentials or switching billing.
3. Download the public release from one immutable Git commit. Clone
   `https://github.com/getdoable/doable-agent-plugins.git` into a separate
   temporary checkout. Record `git rev-parse HEAD` there. Read
   `templates/github/release.json` and run `npm run verify:github-workflow` in
   that checkout. Stop if verification fails. Do not combine a manifest from
   one revision with a template from another.
4. Create a focused installation branch in the customer's repository. Copy
   `templates/github/doable-code-context.yml` from that verified checkout to
   `.github/workflows/doable-code-context.yml`. Keep the full file unchanged.
   If a customer copy exists, review its differences first. Stop for approval
   if replacing it would remove customer-specific behavior.
5. Configure the selected provider using the instructions below. Never read,
   print, commit, or upload secret values. A secret name proves existence,
   not validity. Do not delete the other provider's credential.
6. Check the installed file's SHA-256 against `release.json`. Run `actionlint`
   if available; report explicitly when it was unavailable. Review the diff
   for unrelated changes, credentials, and permission increases.
7. Commit only the reviewed installation changes and open an installation PR.
   Record the public release version and full release commit in the PR.
   The workflow must reach the customer's **default branch** before dispatch.
   A pending PR is not an installed workflow.
8. After the customer merges, verify the default-branch file still matches the
   approved template. Confirm Actions is enabled and **Doable Code Context**
   appears under the repository's **Actions** tab. Check organization Actions
   policies permit the referenced actions; do not weaken policies silently.
9. Complete or request the GitHub App approval and Doable connection described
   below. Report their status separately from the workflow installation.
10. Return a checklist: repository/default branch, release version/commit/hash,
    file present on default branch, provider variable, secret name present,
    App repository access, Doable organization connection, and tests performed.
    Leave the first paid end-to-end run to the customer unless authorized.

`OWNER/REPO` means the verified customer's repository, not this public plugin
repository. Replace it in commands before execution.

## Provider A: Codex with an OpenAI API key

1. Open the customer's repository **Settings > Secrets and variables > Actions**.
2. On **Secrets**, choose **New repository secret**.
3. Set **Name** to `OPENAI_API_KEY`. Enter only the actual API key in **Secret**.
4. On **Variables**, create `DOABLE_CODE_CONTEXT_PROVIDER` with value `codex`.

The provider also defaults to Codex when the variable is absent. Explicit
configuration makes the selected billing path clear.

CLI alternatives, with the key entered at the secret command's prompt:

```sh
gh secret set OPENAI_API_KEY --repo OWNER/REPO
gh variable set DOABLE_CODE_CONTEXT_PROVIDER --repo OWNER/REPO --body codex
```

This path uses OpenAI API billing, **not a ChatGPT subscription**. Do not put
shell assignments, quotes, session tokens, or `auth.json` into `OPENAI_API_KEY`.
For a ChatGPT subscription, use signed-in local Codex with the
[local Doable plugin](../README.md#install) instead of this GitHub workflow.
This release does not implement Codex subscription credential-cache handling.

## Provider B: Claude with a subscription setup token

1. On the customer's trusted machine, run `claude setup-token` and complete
   the subscription authorization in the browser.
2. In repository **Settings > Secrets and variables > Actions > Secrets**, add
   `CLAUDE_CODE_OAUTH_TOKEN` containing only the generated token.
3. On **Variables**, create `DOABLE_CODE_CONTEXT_PROVIDER` with value `claude`.
4. Optionally create `DOABLE_CODE_CONTEXT_CLAUDE_MODEL`; the default is `sonnet`.

```sh
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo OWNER/REPO
gh variable set DOABLE_CODE_CONTEXT_PROVIDER --repo OWNER/REPO --body claude
```

Create a **repository variable**, not a GitHub Environment named
`DOABLE_CODE_CONTEXT_PROVIDER=claude`. This workflow does not declare an
Environment. Adding the token alone does not select Claude.

Use the customer's own supported subscription. Plan limits and applicable
terms still apply; lower cost is not guaranteed. Renew expired/revoked tokens.
The workflow does not silently switch to API billing or another provider.
No separate Claude GitHub App is required. See the official
[Claude authentication guide](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)
and [GitHub Actions guide](https://code.claude.com/docs/en/github-actions).

## GitHub App and Doable connection

1. Open [Install getdoable](https://github.com/apps/getdoable/installations/new).
2. Select the customer account or organization, then **Only select repositories**.
3. Approve access to the verified product repository. If GitHub shows
   **Request**, a customer organization owner must approve it.
4. In the intended Doable environment and organization, open the test spec's
   Code Context round, then **Run in GitHub**.
5. Enter the verified `owner/repository` under **Repository** or
   **Connect another repository**, then choose **Connect**.

App installation does not automatically create the workflow, provider secrets,
or Doable connection. The repository picker shows **saved connections** for
that Doable organization, not all GitHub App installations. Staging and
production require separate saved connections. One repository cannot be bound
to multiple Doable organizations in the same database without administrative
handling.

The customer's agent may perform these UI steps with authorized authenticated
browser access. Otherwise report the exact remaining owner/user action.
Never give the customer a Doable GitHub App private key; it belongs only to
Doable's backend deployment.

## First run and expected result

1. Use a question about product code that actually exists in this repository.
2. In Doable, select the connected repository and choose **Run in GitHub**.
3. Open the repository's Actions run. The selected provider step should execute;
   the other provider step should be skipped.
4. Check result submission and the Code Context round in Doable separately.
5. Review unresolved questions before applying usable results to the test spec.

Doable supplies `doable_job_id`, `doable_api_base_url`, and
`doable_oidc_audience` through `workflow_dispatch`. Do not invent these values
or manually dispatch this workflow. Do not rerun a completed/cancelled job:
its identity is no longer reusable. Request a fresh job from Doable instead.

A green Actions run means its delivery steps completed. It does not prove
every question was answered. **Partial resolved** can represent useful findings
plus explicit unknowns, unsupported runtime claims, or unresolved questions.
Read the reported notes rather than treating partial results as deployment
failures. If delivery fails, distinguish the task-fetch, model, compilation,
and submission stages. Never publish raw logs or credentials for diagnosis.

## Security and updates

The workflow grants `contents: read` and `id-token: write`; checkout does not
persist Git credentials. Doable callbacks use fresh GitHub OIDC tokens.
Codex uses a read-only sandbox. Claude uses restricted read tools, not an
operating-system sandbox. Source context reaches the selected model provider.
Doable receives sanitized findings plus the GitHub connection/run metadata
needed for this integration. See [Privacy](../PRIVACY.md#optional-github-runner).

Run only reviewed default-branch code in trusted repositories. Do not expose
provider secrets to forked PRs, remove read-only restrictions, or upload raw
checkout/model-output artifacts. GitHub runner charges remain separate.

Public template updates do **not** update customer copies automatically.
For an upgrade, repeat the pinned-download, checksum, diff, PR, and
default-branch verification steps. Preserve customer changes deliberately.
Rollback restores the previous approved workflow copy. Switching providers
requires changing the repository variable and having that provider's secret;
it does not require a Doable backend deployment.

Maintainers: see [public release maintenance](github-code-context-release.md).
