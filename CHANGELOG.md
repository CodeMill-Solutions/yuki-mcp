# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] - 2026-09-03

Regions per administration, plus fixes and improvements prompted by feedback
from a user running the server against a Belgian administration via Claude
Desktop.

### Added

- **Per-administration region in the keys file.** A keys-file value may now
  be an object instead of a bare API key —
  `{ "<administrationId>": { "apiKey": "…", "region": "be" } }`, or
  `"baseUrl": "https://…/ws/"` for a custom host — so one server instance can
  serve Dutch and Belgian administrations side by side. Plain string entries
  keep using the server-wide `YUKI_REGION` / `YUKI_BASE_URL`, so existing
  files work unchanged. Sessions are bound to the host that issued them and
  data calls are routed by their session ID, so no tool signatures change.
  `reload_keys` treats a changed region like a changed key and
  re-authenticates. An unknown region in the file is reported instead of
  silently falling back to the default host, and the startup log counts the
  entries with an override.
- **`bin` entry (`yuki-mcp`)** plus a `#!/usr/bin/env node` shebang on the
  entry point, so MCP hosts can start the server with
  `npx -y @codemill-solutions/yuki-mcp` — the standard MCP install pattern —
  instead of a `node` command pointing at `dist/index.js`. Previously `npx`
  failed with `could not determine executable to run`, which hosts surface as
  a bare "Server disconnected". README quick start updated accordingly, with
  a note about desktop hosts not inheriting the shell `PATH`.
- **`get_missing_invoices` diagnostics** — the response now includes
  `totalItems` and `typesSeen` (a count per `<Type>` label in the raw
  OutstandingCreditorItems result), each item carries its `type`, and an
  optional `types` parameter overrides which labels are treated as unmatched
  bank payments. An unrecognised label is now visible instead of a silent
  `count: 0`.
- Startup log line reports the resolved API host, so a wrong `YUKI_REGION`
  is visible in the MCP host's logs.

### Fixed

- **`get_missing_invoices` returned `count: 0` on Belgian administrations.**
  The tool only matched the Dutch `<Type>` label `Afschriftregel`; Belgian
  administrations report `Banktransactie` and `Creditcardbetaling` for the
  same bank-side items. All three labels are now accepted (case-insensitive).
  `DEFAULT_MISSING_INVOICE_TYPES`, `readItemType()` and
  `isMissingInvoiceType()` are exported from `tools/accounting-info.ts` for
  testability.

### Changed

- **Region-neutral fault hint.** The hint appended to
  `Domain has no active database` faults read "If this administration is not
  Dutch…" even when the call had gone to the Belgian host. It now says
  "belongs to a different region", lists the other known regions, and points
  at the per-administration `region` option in the keys file.
- `@anthropic-ai/sdk` moved from `dependencies` to `devDependencies`. It is
  only used by `scripts/test-agent.ts` (`npm run agent`), which is not part
  of the published package, so installs are lighter.
- Server version string in `src/index.ts` bumped from `1.6.0` to `1.7.0`
  so the `McpServer` handshake reports the published package version.

## [1.6.0] - 2026-08-26

First release with an external contribution — thanks
[@jorisvanherp](https://github.com/jorisvanherp)
([#1](https://github.com/CodeMill-Solutions/yuki-mcp/pull/1)).

### Added

- **Configurable API region.** Yuki serves each region from its own API
  host, and an administration only exists on the host for its own region —
  so Belgian administrations previously authenticated fine against the
  hardcoded Dutch host but failed on every data call with
  `SOAP Fault: Domain has no active database`. Two new optional env vars,
  both defaulting to the previous behaviour:
  - `YUKI_REGION` — `nl` (default) or `be`; selects a known regional host.
  - `YUKI_BASE_URL` — full API base URL; overrides `YUKI_REGION` entirely,
    as an escape hatch for hosts not listed.
- **Region hint on "no active database" faults.** The fault message now
  names the host that was called and the regions that could be tried
  instead, since Yuki returns the same opaque message for an unscoped API
  key and for a valid key pointed at the wrong regional host.
- **`resolveBaseUrl()` export** in `yuki-client.ts` with an injectable
  env, so URL resolution is unit-testable. Normalises `YUKI_REGION`
  (case/whitespace), appends a missing trailing slash to `YUKI_BASE_URL`,
  and fails fast at startup on an unknown region.
- README section **API region** documenting the fault and both variables;
  `YUKI_REGION` added to `.env.example` and the quick-start config block.

### Changed

- Server version string in `src/index.ts` bumped from `1.5.1` to `1.6.0`
  so the `McpServer` handshake reports the published package version.

### Notes

The region applies per server instance: a keys file mixing Dutch and
Belgian administrations still needs two instances. Per-administration
region in the keys file, plus a region-neutral wording of the fault hint,
are planned for a next release.

## [1.5.1] - 2026-05-25

### Added

- `license`, `author`, `keywords`, and `engines.node` (`>=20`) fields in
  `package.json` for better npm discoverability and to make the published
  package's runtime requirements explicit (consistent with the README's
  "Node.js 20+" prerequisite).
- README section **About CodeMill Solutions** introducing the maintainer
  and linking to the company website, LinkedIn, and GitHub organisation.
- Top-level **License** section in the README pointing at `LICENSE`.

### Changed

- Dependency housekeeping — bumped to the latest non-breaking versions
  and resolved all transitive `npm audit` advisories (was 6, now 0):
  - `@modelcontextprotocol/sdk` `^1.10.1` → `^1.29.0`
  - `axios` `^1.7.9` → `^1.16.1`
  - `dotenv` `^16.4.7` → `^16.6.1`
  - `fast-xml-parser` `^5.5.8` → `^5.8.0`
  - `zod` `^3.24.1` → `^3.25.76`
  - `@types/node` `^22.10.10` → `^22.19.19`
  - `prettier` `^3.8.1` → `^3.8.3`
  - `tsx` `^4.19.2` → `^4.22.3`
  - `typescript` `^5.7.3` → `^5.9.3`
- Server version string in `src/index.ts` bumped from `1.5.0` to `1.5.1`
  so the `McpServer` handshake reports the published package version.

## [1.5.0] - 2026-05-18

### Added

- **`reload_keys` tool** — re-read the `administrationId → apiKey` map from
  disk without restarting the MCP server. Sessions for keys that **changed**
  or were **removed** are evicted from the session cache automatically;
  sessions for unchanged keys stay warm. Returns a diff of `added`,
  `updated`, and `removed` IDs plus the resolved file path.
- **`loadApiKeysFile()` / `resolveApiKeysFilePath()` exports** in
  `yuki-client.ts` so the same file-resolution logic (env override →
  `~/.yuki/api-keys.json` → `./api-keys.json`) is used by both startup and
  the runtime reload tool.
- **`YukiClient.reloadApiKeys(next)` method** — mutates the in-memory key
  map in place (preserving the `Map` reference), invalidates only the
  sessions for changed/removed keys, and returns an `ApiKeyReloadDiff`.

### Changed

- `index.ts` now uses the shared `loadApiKeysFile()` helper at startup
  instead of reading and parsing the keys file inline. Pure refactor —
  behaviour and log output are unchanged.
- Tool count in the startup log line bumped from 30 → 31.

### Notes

Intended companion flow: after an external `create_api_key` operation (for
example from a sibling MCP server that drives the Yuki Integraties UI) has
written a new key to `~/.yuki/api-keys.json`, call `reload_keys` to make
that key immediately usable for SOAP tools — no MCP restart required.

## [1.4.0] - 2026-05-11

### Added

- `get_missing_invoices` tool to retrieve bank payments without a matching
  purchase invoice.

## [1.3.0] - 2026-03-31

### Added

- Multi-administration support via per-admin API key mapping.
- Keys-file loading at startup (`~/.yuki/api-keys.json` by default,
  overridable via `YUKI_API_KEYS_FILE`).
- Per-key session caching in `YukiClient` so that switching admins inside a
  single process does not re-authenticate against unchanged keys.

## [1.2.0] - 2026-03-27

### Added

- Tools: `get_gl_accounts_fiscal`, `get_net_revenue`, `list_documents`,
  `search_documents`, `get_document`, `download_document`,
  `get_cost_categories`, `get_administration_id`.

## [1.1.0] - 2026-03-23

### Added

- Backoffice tools: `get_workflow`, `get_outstanding_questions`.

## [1.0.0] - initial release

Initial public release of `@codemill-solutions/yuki-mcp`: an MCP server
wrapping the Yuki accounting SOAP API.
