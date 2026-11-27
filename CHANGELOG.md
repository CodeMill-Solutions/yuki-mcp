# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.0] - 2026-11-27

The write tools reach Yuki for the first time, servers with several
administrations read the right one, and the documentation follows the rename
of Yuki to Nmbrs Accounting. Read the notes at the end before upgrading an
agent that is allowed to write. Thanks to
[@EnoxCode](https://github.com/EnoxCode) for the sales invoice fix
([#3](https://github.com/CodeMill-Solutions/yuki-mcp/pull/3)) and to
[@jvlieshout](https://github.com/jvlieshout) for tracking down the
administration bug
([#2](https://github.com/CodeMill-Solutions/yuki-mcp/issues/2)).

### Fixed

- **Write tools no longer embed an XML declaration inside the SOAP body.** It
  made the envelope invalid XML. This affected `process_sales_invoice`,
  `process_purchase_invoice`, `process_journal` and `upsert_contact`.
- **`process_sales_invoice` follows Yuki's documented XML layout:** element
  order, a `Description` and nil `Category` on each product, and a numeric
  `VATType`.
- **All four named VAT types of `process_sales_invoice` are mapped.**
  `NL_Normal`, `NL_Reduced`, `NL_Zero` and `NL_None` become Yuki's VAT types
  1, 2, 4 and 0. `vatPercentage` now defaults to the Dutch rate that goes
  with the type (21, 9, 0 and 0) instead of always 21, because Yuki cancels
  an invoice whose type and percentage do not form an existing VAT code.
  Other VAT types, such as reverse charge, can be passed as their numeric
  Yuki code together with an explicit `vatPercentage`. An unknown `vatType`
  is rejected before a request is spent on it.
- **`ContactType` is sent only when the caller sets it**, as `Person` or
  `Company`. When a contact is matched by its contact code, Yuki overwrites
  the existing contact with the values in the XML, so a default could turn a
  person into a company. The values `Debtor`, `Creditor` and `Both` are gone
  from `contactType` of both invoice tools: Yuki's schemas never accepted
  them.
- **`process_sales_invoice` reports Yuki's real result.** Yuki answers HTTP 200
  for rejected invoices, so `success` now comes from Yuki's own counters. The
  response carries a `status` of `succeeded`, `failed`, `skipped` or
  `unknown`; on the last two, check in Yuki before sending the invoice again.
- **`process_journal` follows Yuki's journal schema.** Within an entry the
  contact now comes before the date, and `contactName` and `contactCode` are
  both sent when given. Every entry carries the mandatory `Description`,
  which defaults to the subject. Before, only entries with a description and
  without a contact produced a valid document.
- **`list_documents`, `search_documents` and `download_document` no longer
  silently read the default administration.** These Archive methods act on
  the administration their API key belongs to, yet the tools always
  authenticated with the server-wide key, so a search for a document in
  another administration came back empty without an error. They now take an
  optional `administrationId` and open the session with the key of that
  administration; the result names the administration it came from. With a
  keys file loaded and neither `administrationId` nor `YUKI_DOMAIN_ID`, the
  tools return an error instead of guessing.
- **`get_administrations` and `get_administration_id` take an optional
  `administrationId`** to choose whose API key to use, so administrations
  spread over several keys can be looked up through the server. Without it
  they use `YUKI_API_KEY` as before, and the key of `YUKI_DOMAIN_ID` when no
  server-wide key is set. That last setup used to fail with "No API key
  configured".
- **`search_relations` works without a `domainId`.** The Contact web service
  takes Yuki's own domain ID, a different GUID from the administration ID.
  The tool sent `YUKI_DOMAIN_ID`, which holds the administration ID, and Yuki
  answered "Invalid domain ID". It now reads the domain from the session,
  once per session, unless a `domainId` is passed; it takes an optional
  `administrationId` to choose the API key, and its result names the domain
  it searched. `upsert_contact` resolves its domain the same way.
- **An empty folder or a search without matches now returns `count: 0`.**
  `list_documents` and `search_documents` reported one document: the empty
  result wrapper itself.

### Added

- `process=false` now works: `reference` is optional and must be omitted, and
  Yuki assigns the number and leaves the invoice under "To be sent".
- `productDescription` on invoice lines, so several lines can share one product.

### Changed

- **Documentation and package metadata now name Nmbrs Accounting.** Since
  1 September 2026 Yuki in the Netherlands continues as Nmbrs Accounting; in
  Belgium the product is still called Yuki. The README explains the rename
  and lists the product name and API host per region. The npm description
  now reads "MCP server for the Nmbrs Accounting (formerly Yuki) SOAP API"
  and the keywords `nmbrs` and `nmbrs-accounting` were added. The package
  name, the tool names, the `YUKI_*` variables and the API hosts are
  unchanged, so there is nothing to migrate.
- README and `.env.example` now point to Settings → Web services for the API
  key (was "Settings → API"), with a link to the support article.
- README lists CodeMill's other accounting MCP servers.
- Server version string in `src/index.ts` bumped to `1.8.0`.

### Notes

- **Two write tools start writing with this release.** In every version up
  to 1.7.1 the four write tools sent an XML declaration inside the SOAP body,
  and Yuki answers such a request with HTTP 400 before processing it. From
  this release `process_sales_invoice` and `process_journal` therefore write
  to the administration for the first time. `npx -y` picks up the new version
  at the next start, so review which tools your agents may call.
- **`upsert_contact` and `process_purchase_invoice` still do not work.** The
  first does not follow the document format of `UpdateContact`. The second
  does not pass Yuki's schema validation and needs a Client-ID and Secret
  for the Purchase web service. Both say so in their tool description; see
  "Known limitations" in the README.

## [1.7.1] - 2026-09-15

Hardening of the `reload_keys` tool. No new features.

### Security

- **`reload_keys` no longer accepts a `path` argument.** The tool always
  re-reads the keys file from the location configured for the server
  (`YUKI_API_KEYS_FILE` → `~/.yuki/api-keys.json` → `./api-keys.json`), the
  same resolution as at startup. Which file holds the keys is the operator's
  decision; the model can only trigger a reload. Previously any MCP client
  could point the tool at an arbitrary local file, which the server would
  read and — if it parsed as JSON — load as the active key map. A `path`
  argument sent by an older client is ignored; the `source` field in the
  response shows which file was read.
- **Generic error for an unparsable keys file.** A file that is not valid
  JSON is now reported as `API keys file at … is not valid JSON`. The
  previous message was V8's own `SyntaxError`, which quotes up to 20
  characters of the offending text. A file that parses but is not a JSON
  object (an array, string, number or `null`) is rejected as well, instead of
  being iterated as if it were a map.

### Changed

- Startup warning for an unreadable keys file now reads
  `could not load API keys file: <reason>` instead of printing
  `at (none)` followed by an `Error:` prefix and the path a second time.
- Server version string in `src/index.ts` bumped to `1.7.1`.
- Releases are now published through npm trusted publishing (GitHub Actions
  OIDC) with provenance attestations, instead of a long-lived npm token in
  CI. No change to the package itself.

### Notes

The server runs locally over stdio under the user's own account, so the
reported behaviour never crossed a privilege boundary: the same account could
read the file directly, and `upload_document_from_path` reads local files by
design. We treat this release as hardening rather than a vulnerability fix and
have not requested a CVE.

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
