# Contributing

Thanks for helping improve Doable Agent Plugins.

## Before opening a change

- Open an issue for a new workflow or a material contract change.
- Keep each pull request focused on one plugin behavior.
- Never include credentials, customer data, source excerpts, private URLs, local paths, or `.doable/` state.
- Treat the privacy boundary in [PRIVACY.md](PRIVACY.md) as part of the public contract.

## Validate locally

Use Node.js 20 or newer and run:

```bash
npm test
claude plugin validate ./plugins/doable-code-context
```

For host-specific changes, also validate the affected manifest and complete the relevant fresh-session checks in [TESTING.md](TESTING.md).

## Pull requests

Describe:

- the user problem and intended behavior;
- any privacy, authentication, or compatibility impact;
- the commands and host versions used for verification;
- what was not tested.

Report security issues privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
