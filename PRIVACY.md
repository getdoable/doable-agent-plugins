# Privacy and data handling

The `doable-trd-context` plugin is a local, context-only workflow. Its code does not authenticate to Doable, call a Doable API or MCP server, upload files, or make network requests.

Repository inspection happens inside the coding agent selected by the user and remains subject to that agent provider's own data-handling terms. The plugin writes two local files beneath `.doable/features/<feature-slug>/`:

- `doable-context.md`, a privacy-scrubbed product-behavior document that the user may choose to upload to Doable;
- `doable-intake.json`, a local provenance record that the plugin explicitly marks as not for upload.

The uploadable context excludes source code and snippets, repository and file metadata, commit identifiers, secrets and environment values, raw logs and attachments, private URLs, and real customer or business data.

See the [Doable Privacy Policy](https://qa.getdoable.ai/privacy-policy) for the Doable platform's data handling. Questions may be sent to support@getdoable.ai.
