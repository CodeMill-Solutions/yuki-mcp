# yuki-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects AI agents to [Yuki](https://www.yukiworks.nl) accounting via Yuki's SOAP API.

Built with Node.js, TypeScript, and [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

---

## Prerequisites

- Node.js 20+
- A Yuki account with API access enabled
- Your Yuki API key (Yuki → Settings → API)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
YUKI_API_KEY=your-api-key-here
YUKI_DOMAIN_ID=your-administration-guid-here  # optional at startup
```

`YUKI_DOMAIN_ID` can be left empty — the server starts without it. Call `get_administrations` to discover the correct GUID, then pass it via the `administrationId` parameter on individual tools.

### 3. Build

```bash
npm run build
```

### 4. Connect to an MCP host

Add to your MCP host configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "yuki": {
      "command": "node",
      "args": ["/absolute/path/to/yuki-mcp/dist/index.js"],
      "env": {
        "YUKI_API_KEY": "your-api-key-here",
        "YUKI_DOMAIN_ID": "your-administration-guid-here"
      }
    }
  }
}
```

---

## Available tools

### Administrations

| Tool | Description |
|------|-------------|
| `get_administrations` | List all administrations (companies) for this API key. **Run this first** to find the correct `administrationId`. |

### Relations

| Tool | Key parameters | Description |
|------|----------------|-------------|
| `search_relations` | `searchValue`, `searchOption?`, `active?`, `pageNumber?` | Search customers and suppliers by name, code, VAT number, email, etc. Returns up to 100 results per page. |
| `upsert_contact` | `fullName`, `contactCode?`, `contactType?`, … | Create or update a contact. When `contactCode` matches an existing record it is updated; otherwise a new contact is created. |

### Sales invoices

| Tool | Key parameters | Description |
|------|----------------|-------------|
| `get_sales_invoices` | `dateOutstanding?`, `sortOrder?`, `includeBankTransactions?` | Retrieve outstanding (unpaid) sales invoices. |
| `process_sales_invoice` | `reference`, `subject`, `date`, `dueDate`, `contact`, `lines` | Create and book a new sales invoice. Optionally email it to the customer. |

### Purchase invoices

| Tool | Key parameters | Description |
|------|----------------|-------------|
| `get_purchase_invoices` | `dateOutstanding?`, `sortOrder?`, `includeBankTransactions?` | Retrieve outstanding (unpaid) purchase invoices. |
| `process_purchase_invoice` | `date`, `invoiceAmount`, `invoiceVatAmount`, `contact`, `lines` | Book an incoming purchase invoice. Accepts an optional PDF as base64. |

### Transactions & bank

| Tool | Key parameters | Description |
|------|----------------|-------------|
| `get_transactions` | `glAccountCode`, `startDate`, `endDate` | Retrieve journal entries for a GL account (e.g. a bank account) in a date range. Use `get_gl_accounts` to find the right code. |
| `get_transaction_details` | `reference` | Check if an outstanding item still exists and retrieve its current status. |
| `process_journal` | `subject`, `entries[]` | Post a general journal entry (memoriaal). All entry amounts must sum to exactly 0. Used for bank reconciliation, corrections, and custom bookings. |

### Accounting

| Tool | Key parameters | Description |
|------|----------------|-------------|
| `get_gl_accounts` | `date?` | Retrieve all GL accounts with their balance at a given date. Use this to find bank account codes before calling `get_transactions`. |

### Documents

| Tool | Key parameters | Description |
|------|----------------|-------------|
| `upload_document` | `fileName`, `dataBase64`, `folder?`, `amount?` | Upload a PDF to the Yuki archive by passing its content as a base64 string. Use `get_document_folders` first to find the right folder ID. |
| `upload_document_from_path` | `filePath`, `fileName?`, `folder?`, `amount?` | Upload a PDF from a local file path. Reads and encodes the file internally — preferred over `upload_document` when the file is available on disk. Validates that the file exists and is a valid PDF before uploading. |
| `get_document_folders` | — | List all archive folders available in the administration. |

---

## Testing

### Option 1 — MCP Inspector (tool-level, no LLM)

```bash
npm run inspect
```

Opens a browser UI at `http://localhost:5173` where you can call individual tools and inspect raw responses.

### Option 2 — Agent test harness (with Claude)

Runs a full agentic loop: Claude reasons about the task, calls tools, and returns a final answer — exactly as an AI agent would use this MCP.

Add your Anthropic API key to `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

Then run a scenario:

```bash
npm run agent                                              # default: get_administrations
npm run agent -- --scenario outstanding-invoices
npm run agent -- --scenario search-relations --arg "Bedrijf BV"
npm run agent -- --scenario gl-accounts
npm run agent -- --scenario bank-transactions --arg "1200"
npm run agent -- --scenario full-workflow
```

Available scenarios: `get-administrations`, `search-relations`, `outstanding-invoices`, `outstanding-payables`, `gl-accounts`, `bank-transactions`, `full-workflow`.

---

## Architecture

```
src/
├── index.ts              # Entry point — loads env, registers tools, starts stdio transport
├── yuki-client.ts        # SOAP client: envelope builder, axios HTTP, fast-xml-parser, XmlValue
└── tools/
    ├── administrations.ts  # get_administrations
    ├── relations.ts        # search_relations, upsert_contact
    ├── invoices.ts         # get_sales_invoices, get_purchase_invoices,
    │                       # process_sales_invoice, process_purchase_invoice
    ├── transactions.ts     # get_transactions, get_transaction_details, process_journal
    ├── accounting.ts       # get_gl_accounts
    └── documents.ts        # upload_document, upload_document_from_path, get_document_folders

scripts/
└── test-agent.ts         # Agent test harness (Claude + MCP client loop)
```

### Auth flow

Yuki uses a two-step authentication pattern:

1. `Authenticate(accessKey)` → returns a temporary `sessionID`
2. All subsequent calls include that `sessionID`

`YukiClient.getSessionID()` handles this transparently and caches the session for the lifetime of the process.

> **Note:** Parameter casing differs across Yuki's services — `sessionId` (lowercase d) on `Sales.asmx` and `Purchase.asmx`; `sessionID` (uppercase D) on `Accounting.asmx`, `Contact.asmx`, and `Archive.asmx`. This is handled per-tool.

### XML documents

Write tools (`process_sales_invoice`, `process_purchase_invoice`, `process_journal`, `upsert_contact`) pass structured data to Yuki as an XML string inside the `xmlDoc` SOAP parameter. The `XmlValue` wrapper ensures this XML is embedded raw (not entity-encoded) in the SOAP envelope. All user-supplied values are XML-escaped via `escapeXml()`.

---

## Rate limits

Yuki enforces **1,000 API requests per day**. Each tool call is 1 request. The session ID is cached so `Authenticate` is only called once per server process, not once per tool call.

Design agent workflows to fetch broad lists once and reference them from the agent's context window rather than re-fetching on every step.

---

## Troubleshooting

| Error | Likely cause |
|-------|-------------|
| `SOAP Fault: Authentication failed` | `YUKI_API_KEY` is incorrect or API access is not enabled in Yuki Settings |
| `SOAP Fault: Administration not found` | Wrong `administrationId` — run `get_administrations` to get the correct GUID |
| `Journal entries do not balance` | Amounts in `process_journal` don't sum to 0 — check debit/credit signs |
| `HTTP 500 from api.yukiworks.nl` | Usually a wrong XML namespace or malformed `xmlDoc` — check the WSDL at `https://api.yukiworks.nl/ws/{Service}.asmx?wsdl` |
| `File does not appear to be a PDF` | The file at `filePath` does not start with the `%PDF` magic bytes — check you're pointing at a valid PDF |
| `File not found` | `filePath` passed to `upload_document_from_path` does not exist or is inaccessible |
| `Network error` | No connectivity to `api.yukiworks.nl` — requests time out after 30 seconds |

---

## License

MIT — see [LICENSE](./LICENSE).
