import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { YukiClient } from './yuki-client.js';

// Read tools
import { registerAdministrationTools } from './tools/administrations.js';
import { registerRelationTools } from './tools/relations.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerTransactionTools } from './tools/transactions.js';
import { registerAccountingTools } from './tools/accounting.js';

// Write tools
import { registerInvoiceWriteTools } from './tools/invoices.js';
import { registerJournalWriteTools } from './tools/transactions.js';
import { registerContactWriteTools } from './tools/relations.js';
import { registerDocumentTools } from './tools/documents.js';

// ── Environment validation ────────────────────────────────────────────────────

const apiKey = process.env['YUKI_API_KEY'];
const domainId = process.env['YUKI_DOMAIN_ID'] ?? '';

if (!apiKey) {
  // Write to stderr so the MCP host can surface the message without corrupting
  // the stdio JSON-RPC stream used by the MCP protocol.
  process.stderr.write('[yuki-mcp] Fatal: YUKI_API_KEY environment variable is not set.\n');
  process.exit(1);
}

// ── Yuki SOAP client ──────────────────────────────────────────────────────────

const yukiClient = new YukiClient(apiKey, domainId);

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'yuki-mcp',
  version: '1.0.0',
});

// ── Read tools ────────────────────────────────────────────────────────────────
registerAdministrationTools(server, yukiClient);
registerRelationTools(server, yukiClient);
registerInvoiceTools(server, yukiClient);
registerTransactionTools(server, yukiClient);
registerAccountingTools(server, yukiClient);

// ── Write tools ───────────────────────────────────────────────────────────────
registerInvoiceWriteTools(server, yukiClient);
registerJournalWriteTools(server, yukiClient);
registerContactWriteTools(server, yukiClient);
registerDocumentTools(server, yukiClient);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();

await server.connect(transport);

// Log startup info to stderr only (stdout is reserved for JSON-RPC)
process.stderr.write(
  `[yuki-mcp] Server started — 14 tools registered. ` +
    `Domain ID: ${domainId || '(none — run get_administrations to discover)'}\n`,
);
