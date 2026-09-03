#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { YukiClient, YUKI_BASE_URL, loadApiKeysFile, type AdministrationCredentials } from './yuki-client.js';

// Read tools
import {
  registerAdministrationTools,
  registerAdministrationLookupTools,
  registerReloadKeysTools,
} from './tools/administrations.js';
import { registerRelationTools } from './tools/relations.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerTransactionTools } from './tools/transactions.js';
import { registerAccountingTools, registerAccountingExtendedTools } from './tools/accounting.js';
import { registerAccountingInfoTools } from './tools/accounting-info.js';

// Write tools
import { registerInvoiceWriteTools } from './tools/invoices.js';
import { registerJournalWriteTools } from './tools/transactions.js';
import { registerContactWriteTools } from './tools/relations.js';
import { registerDocumentTools } from './tools/documents.js';

// Backoffice tools
import { registerBackofficeTools } from './tools/backoffice.js';

// ── API key map ───────────────────────────────────────────────────────────────
//
// Optionally load a JSON file that maps administrationId → apiKey.
// This allows the MCP server to serve multiple Yuki administrations, each with
// its own API key, without requiring a single YUKI_API_KEY for all of them.
//
// The file format is a plain JSON object. A value is either the API key, or an
// object that also pins the administration to its own API region:
//   { "<administrationId>": "<apiKey>",
//     "<administrationId>": { "apiKey": "<apiKey>", "region": "be" }, ... }
//
// Path resolution + parsing lives in `yuki-client.ts` (`loadApiKeysFile`) so
// the runtime `reload_keys` tool can share the exact same behaviour.

let apiKeyMap = new Map<string, AdministrationCredentials>();
let keysFilePath = '(none)';

try {
  const loaded = loadApiKeysFile();
  keysFilePath = loaded.path;
  apiKeyMap = loaded.map;
  if (loaded.found) {
    const overrides = [...apiKeyMap.values()].filter((entry) => entry.baseUrl !== YUKI_BASE_URL).length;
    process.stderr.write(
      `[yuki-mcp] Loaded ${apiKeyMap.size} API keys from ${keysFilePath}` +
        (overrides > 0 ? ` (${overrides} with a region/baseUrl override)` : '') +
        '\n',
    );
  }
} catch (err) {
  process.stderr.write(`[yuki-mcp] Warning: could not read API keys file at ${keysFilePath}: ${err}\n`);
}

// ── Environment validation ────────────────────────────────────────────────────

const apiKey = process.env['YUKI_API_KEY'] ?? '';
const domainId = process.env['YUKI_DOMAIN_ID'] ?? '';

if (!apiKey && apiKeyMap.size === 0) {
  // Neither a default key nor a keys file — nothing will work
  process.stderr.write(
    '[yuki-mcp] Warning: YUKI_API_KEY is not set and no api-keys.json was found.\n' +
      '           Run a full sync from the dashboard, or set YUKI_API_KEY.\n',
  );
} else if (!apiKey) {
  process.stderr.write(
    `[yuki-mcp] Note: YUKI_API_KEY not set — using per-administration keys (${apiKeyMap.size} loaded).\n`,
  );
}

// ── Yuki SOAP client ──────────────────────────────────────────────────────────

const yukiClient = new YukiClient(apiKey, domainId, apiKeyMap);

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'yuki-mcp',
  version: '1.7.0',
});

// ── Read tools ────────────────────────────────────────────────────────────────
registerAdministrationTools(server, yukiClient);
registerAdministrationLookupTools(server, yukiClient);
registerReloadKeysTools(server, yukiClient);
registerRelationTools(server, yukiClient);
registerInvoiceTools(server, yukiClient);
registerTransactionTools(server, yukiClient);
registerAccountingTools(server, yukiClient);
registerAccountingExtendedTools(server, yukiClient);
registerAccountingInfoTools(server, yukiClient);

// ── Write tools ───────────────────────────────────────────────────────────────
registerInvoiceWriteTools(server, yukiClient);
registerJournalWriteTools(server, yukiClient);
registerContactWriteTools(server, yukiClient);
registerDocumentTools(server, yukiClient);

// ── Backoffice tools ──────────────────────────────────────────────────────────
registerBackofficeTools(server, yukiClient);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();

await server.connect(transport);

// Log startup info to stderr only (stdout is reserved for JSON-RPC)
const keyInfo =
  apiKeyMap.size > 0
    ? `${apiKeyMap.size} per-admin keys loaded`
    : apiKey
      ? 'single YUKI_API_KEY'
      : 'no API keys configured';

process.stderr.write(
  `[yuki-mcp] Server started — 31 tools registered. ` +
    `Domain ID: ${domainId || '(none)'} — ${keyInfo} — API host: ${YUKI_BASE_URL}\n`,
);
