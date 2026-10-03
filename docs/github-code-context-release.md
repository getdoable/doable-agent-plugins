# GitHub workflow release maintenance

The public distribution is `templates/github/doable-code-context.yml`.
Its version and SHA-256 are in `templates/github/release.json`.
The source is generated in the internal backend repository; maintainers must
update its adapters and renderer first. Do not hand-edit the public embedded
Python helpers or use a customer's repository as the template source.

1. In the source repository, run its workflow renderer with `--check` and its
   focused GitHub runner/privacy tests. Regenerate there if necessary.
2. Copy the complete reviewed source workflow into this repository unchanged.
3. Update the release version and SHA-256 in `templates/github/release.json`.
4. Run `npm test`, `npm run verify:github-workflow`, and `actionlint` on the template.
5. Confirm byte-for-byte equality with the reviewed source workflow.
6. Update the installation guide if inputs, provider configuration, or safety
   requirements changed. Record compatibility and rollback in the Change Set.
7. Open a release PR. Record the source revision internally and the public
   artifact hash in the PR. Do not publish customer traces or credentials.
8. After merge, distribute the immutable public release commit with the guide.
   Customers upgrade their default-branch copies through separate reviewed PRs.

This release does not change the local plugin version or its MCP behavior.
It does not require a schema migration or a backend/frontend deployment.
