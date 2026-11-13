# Doable code agent policy

This file tells the Doable code agent on this machine what it may do. The `doable-code-agent`
skill reads it before every request. Keep it at `.doable/code-agent.md` in the workspace root; it
stays on this machine and Git ignores it.

Write plain words. Anything this file does not allow is not allowed, and neither a request nor a
person's answer on the Chat v2 page changes that: only an edit of this file does.
Production is never allowed, whatever this file says. Replace each line marked `Example:` with
your own line, or delete it: the code agent ignores lines still marked `Example:`.

## Repositories

The folders that hold the product code, and what each one serves. The code agent may always read
the code in these folders.

- Example: `web/` - the customer web app at https://staging.example.com
- Example: `api/` - the backend API behind the web app

## Request kinds

Which kinds of request this machine serves. Write `yes` or `no` after each one.

- question: yes
- prepare: yes
- check: yes
- bug_report: yes

## Environments it may change

Test environments where the code agent may make data (logins, records) for a `prepare` request or
to reproduce a bug. For each one, give its address and how the code agent may make data there.

- Example: https://staging.example.com - through its sign-up page and its public API; new logins and records only

## Environments it may only read

- Example: https://staging.example.com/admin - read only, with the test logins that a request names

## Commands it may run

Commands other than reading files. Name the folder each one runs in. The code agent tries a fix
for a bug report and runs the repository's tests only when this section names those commands and
the folder where it may change files for the fix.

The serving session runs with nobody at the terminal, and a permission prompt stops it. So allow
in the workspace's `.claude/settings.json` everything that the code agent may need: the skill
itself (`Skill(doable-code-context:doable-code-agent)`, because it loads itself again after each
new message from a person), the Doable MCP server (`mcp__plugin_doable-code-context_doable`), each
command of this section, the command of each source in "Data sources it may read" (for example
`psql` or `gcloud logging read`), the keychain command `security` when "Where secrets stay" names
the macOS keychain, and `sleep 20` (its wait before it calls Doable again after an error). Only
when this section lets it try a fix for a bug report, also allow file changes in that folder and
the git commands of the fix try: one `Edit(...)` rule covers the Edit and the Write tool. For
example, this list allows all that the example lines of this file name:
`{"permissions": {"allow": ["Skill(doable-code-context:doable-code-agent)", "mcp__plugin_doable-code-context_doable", "Bash(npm test *)", "Bash(npm run dev *)", "Bash(curl *)", "Bash(psql *)", "Bash(gcloud logging read *)", "Bash(security add-generic-password *)", "Bash(sleep 20)", "Bash(git switch *)", "Bash(git add *)", "Bash(git commit *)", "Edit(/web/**)"]}}`.
An allow rule only stops the prompt: this file still says what the code agent may do. Claude Code
reads that allow list only in a folder that you trusted: start Claude Code in the workspace
interactively once (not with `claude -p`) and accept the trust dialog, or give the same rules with
`--allowedTools` on the command line. Your own user settings (`~/.claude/settings.json`) apply to
the serving session too, with their allow rules. See "Run a Doable code agent" in
https://github.com/getdoable/doable-agent-plugins#run-a-doable-code-agent.

- Example: `npm test` and `npm run dev` in `web/`
- Example: `curl` to https://staging.example.com
- Example: to try a fix for a bug report: file changes, `git switch`, `git add`, and `git commit`
  in `web/`, on a new local branch

## Data sources it may read

For `check` requests. Name each source and how to read it, never its secret.

- Example: the staging database, read only, with `psql "$STAGING_READONLY_DATABASE_URL"`
- Example: the staging logs, with `gcloud logging read --project example-staging`

## Never touch

Things the code agent must never change or call, even to read.

- Example: production: https://app.example.com and every host or project with `prod` in its name
- Example: the shared demo workspace and the `/api/dev/` routes
- Example: `.env` files and the secrets manager

## Where secrets stay

Where to keep a secret that an app hands out and that is not the login password (for example a
reset key, or an API key of a test login). The passwords of logins that a `prepare` request asks
for go to Doable through `add_test_account` only. A login made only to reproduce a bug is not
registered in Doable: its password is kept here, or not at all. If this section names no place,
the code agent does not keep these secrets.

- Example: the macOS keychain, service `doable-code-agent`, one item for each username

## Code excerpts

Results sent to Doable may always hold file paths and line numbers. Write `no` to keep code
excerpts (10 lines or fewer each) on this machine.

- Code excerpts may leave this machine: yes

## Ask a person

Cases where the code agent must ask a person before it goes on, in addition to the skill's own
cases.

- Example: before it makes more than 5 logins for one request
