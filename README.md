# yuki-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects AI agents to [Yuki](https://www.yukiworks.nl) accounting via Yuki's SOAP API.

Built with Node.js, TypeScript, and [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

---

## Installation

```bash
npm install @codemill-solutions/yuki-mcp
```

Then add it to your MCP host configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "yuki": {
      "command": "node",
      "args": ["node_modules/@codemill-solutions/yuki-mcp/dist/index.js"],
      "env": {
        "YUKI_API_KEY": "your-api-key-here",
        "YUKI_DOMAIN_ID": "your-administration-guid-here"
      }
    }
  }
}
```

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

## Available tools (29)

### Administrations

| Tool | Description |
|------|-------------|
| `get_administrations` | List all administrations (companies) for this API key. **Run this first** to find the correct `administrationId`. |
| `get_administration_id` | Look up an administration's GUID by its exact name. Useful when you know the name but not the GUID. |

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
| `get_gl_accounts` | `date?` | Retrieve all GL accounts with their balance at a given date (commercial view). Use this to find account codes before calling `get_transactions`. |
| `get_gl_accounts_fiscal` | `date?` | Same as `get_gl_accounts` but including fiscal corrections. Use for balance sheets and P&L views that must match Yuki's fiscal reports. |
| `get_net_revenue` | `startDate`, `endDate`, `fiscal?` | Retrieve net revenue (netto-omzet) for a date range. Set `fiscal=true` to include fiscal corrections. |

### Accounting info

Richer read-only views from the `AccountingInfo.asmx` service — not available through the standard `Accounting.asmx`.

| Tool | Key parameters | Description |
|------|----------------|-------------|
| `get_gl_account_scheme` | — | Retrieve the complete GL account scheme (rekeningschema): all codes with type, subtype, description, and active/inactive status. Use to validate GL codes or build account pickers. |
| `get_period_table` | `yearId` | Retrieve the fiscal period table for a year: period numbers, names, and date ranges. Use to translate transaction dates into human-readable period names for reports. |
| `get_gl_transactions_detailed` | `startDate`, `endDate`, `glAccountCode?`, `financialMode?` | Detailed transaction listing with document type, archive folder, fiscal period ID, project code, and mutation user. More complete than `get_transactions`. Leave `glAccountCode` empty for all accounts. |
| `get_transaction_document` | `transactionId` | Download the source PDF for a booked transaction as base64. Use the `id` or `hID` from `get_gl_transactions_detailed`. |
| `get_start_balances` | `yearId`, `financialMode?` | Retrieve opening balances (beginbalansen) per GL account for a fiscal year. |

### Documents

| Tool | Key parameters | Description |
|------|----------------|-------------|
| `upload_document` | `fileName`, `dataBase64`, `folder?`, `amount?` | Upload a PDF to the Yuki archive by passing its content as a base64 string. Use `get_document_folders` first to find the right folder ID. |
| `upload_document_from_path` | `filePath`, `fileName?`, `folder?`, `amount?` | Upload a PDF from a local file path. Reads and encodes the file internally — preferred over `upload_document` when the file is available on disk. Validates that the file exists and is a valid PDF before uploading. |
| `get_document_folders` | — | List all archive folders available in the administration. |
| `list_documents` | `folderId` | List documents in a specific archive folder. Returns document IDs, file names, dates, and amounts. |
| `search_documents` | `searchText` | Full-text search across all archived documents (file names, amounts, OCR content). |
| `get_document` | `documentId` | Retrieve metadata for a single archived document by its ID (name, folder, date, amount, status). |
| `download_document` | `documentId` | Download an archived document as a base64-encoded string. |
| `get_cost_categories` | — | List available GL cost categories for use as the `costCategory` parameter in upload tools. |

### Backoffice

| Tool | Key parameters | Description |
|------|----------------|-------------|
| `get_workflow` | `administrationId?` | Retrieve backoffice workflow items — documents that could not be processed automatically and are awaiting review by the accountant. |
| `get_outstanding_questions` | `administrationId?` | Retrieve outstanding questions raised by the accountant that require a response before the related documents can be processed. |

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
├── index.ts                  # Entry point — loads env, registers tools, starts stdio transport
├── yuki-client.ts            # SOAP client: envelope builder, axios HTTP, fast-xml-parser, XmlValue
└── tools/
    ├── administrations.ts    # get_administrations, get_administration_id
    ├── relations.ts          # search_relations, upsert_contact
    ├── invoices.ts           # get_sales_invoices, get_purchase_invoices,
    │                         # process_sales_invoice, process_purchase_invoice
    ├── transactions.ts       # get_transactions, get_transaction_details, process_journal
    ├── accounting.ts         # get_gl_accounts, get_gl_accounts_fiscal, get_net_revenue
    ├── accounting-info.ts    # get_gl_account_scheme, get_period_table,
    │                         # get_gl_transactions_detailed, get_transaction_document,
    │                         # get_start_balances
    ├── documents.ts          # upload_document, upload_document_from_path,
    │                         # get_document_folders, list_documents, search_documents,
    │                         # get_document, download_document, get_cost_categories
    └── backoffice.ts         # get_workflow, get_outstanding_questions

scripts/
└── test-agent.ts             # Agent test harness (Claude + MCP client loop)
```

### Auth flow

Yuki uses a two-step authentication pattern:

1. `Authenticate(accessKey)` → returns a temporary `sessionID`
2. All subsequent calls include that `sessionID`

`YukiClient.getSessionID()` handles this transparently and caches the session for the lifetime of the process.

> **Note:** Parameter casing differs across Yuki's services — `sessionId` (lowercase d) on `Sales.asmx` and `Purchase.asmx`; `sessionID` (uppercase D) on `Accounting.asmx`, `AccountingInfo.asmx`, `Contact.asmx`, and `Archive.asmx`. This is handled per-tool.

### XML documents

Write tools (`process_sales_invoice`, `process_purchase_invoice`, `process_journal`, `upsert_contact`) pass structured data to Yuki as an XML string inside the `xmlDoc` SOAP parameter. The `XmlValue` wrapper ensures this XML is embedded raw (not entity-encoded) in the SOAP envelope. All user-supplied values are XML-escaped via `escapeXml()`.

---

## Rate limits

Yuki enforces **1,000 API requests per day** (upgradeable to 5,000–10,000). Each tool call is 1 request. The session ID is cached so `Authenticate` is only called once per server process, not once per tool call.

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

## About CodeMill Solutions

[CodeMill Solutions](https://codemill.dev/en/) is a Dutch software company based in the Netherlands. We build smart, scalable, and customized solutions that help organizations grow, optimize processes, and realize their digital ambitions.

Our services include:

- **Custom applications** — portals, dashboards, business software, and fully tailored platforms that truly add value.
- **API integrations** — connecting your application with other systems and external platforms via smart API connections.
- **Mobile apps** — iOS and Android apps as a logical extension of your web application(s).

`yuki-mcp` is one of our open-source integrations, making Yuki's accounting platform accessible to AI agents through the Model Context Protocol.

📧 [info@codemill.dev](mailto:info@codemill.dev)  
🌐 [codemill.dev](https://codemill.dev/en/)  
💼 [LinkedIn](https://www.linkedin.com/company/codemill-solutions/)  
🐙 [GitHub](https://github.com/CodeMill-Solutions)

---

## License

MIT — see [LICENSE](./LICENSE).
