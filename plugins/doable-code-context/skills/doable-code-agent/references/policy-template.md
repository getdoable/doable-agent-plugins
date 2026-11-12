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
for a bug report and runs the repository's tests only when this section names those commands.

- Example: `npm test` and `npm run dev` in `web/`
- Example: `curl` to https://staging.example.com

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
reset key, or an API key of a test login). Login passwords go to Doable through `add_test_account`
only. If this section names no place, the code agent does not keep these secrets.

- Example: the macOS keychain, service `doable-code-agent`, one item for each username

## Code excerpts

Results sent to Doable may always hold file paths and line numbers. Write `no` to keep code
excerpts (10 lines or fewer each) on this machine.

- Code excerpts may leave this machine: yes

## Ask a person

Cases where the code agent must ask a person before it goes on, in addition to the skill's own
cases.

- Example: before it makes more than 5 logins for one request
