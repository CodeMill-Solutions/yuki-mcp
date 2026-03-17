import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { YukiClient, XmlValue, escapeXml } from '../yuki-client.js';

/**
 * Register tools for retrieving GL account transactions from Yuki.
 *
 * Yuki exposes transactions per GL account code (e.g. "1200" for a bank account).
 * Use get_gl_accounts first to find the right GL account code for a bank account.
 *
 * Yuki service: Accounting.asmx
 * Method:       GLAccountTransactions(sessionID, administrationID, GLAccountCode,
 *                                     StartDate, EndDate)
 */
export function registerTransactionTools(server: McpServer, client: YukiClient): void {
  /**
   * get_transactions
   *
   * Retrieve all journal entries / transactions for a specific GL account
   * (e.g. a bank account) within a date range.
   *
   * Returns transaction date, description, debit/credit amounts, and
   * the counterpart GL account. Use this to inspect bank movements or
   * verify bookings for a specific account.
   *
   * To get bank transactions: first call get_gl_accounts to find the GL
   * account code for your bank account (typically in the 1100–1299 range),
   * then pass that code here.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_transactions',
    {
      description:
        'Retrieve all journal entries for a specific GL account code within a date range. ' +
        'Use this for bank transactions (find the bank GL code with get_gl_accounts first). ' +
        'Returns date, description, debit/credit amounts, and counterpart GL account.',
      inputSchema: {
        glAccountCode: z
          .string()
          .describe(
            "GL account code to retrieve transactions for (e.g. '1200' for a bank account). " +
              'Use get_gl_accounts to find the right code.',
          ),
        startDate: z.string().describe('Start date in YYYY-MM-DD format (inclusive)'),
        endDate: z.string().describe('End date in YYYY-MM-DD format (inclusive)'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ glAccountCode, startDate, endDate, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');
        }

        const sessionID = await client.getSessionID();

        const result = await client.callSoap({
          service: 'Accounting.asmx',
          method: 'GLAccountTransactions',
          params: {
            sessionID,
            administrationID: adminId,
            GLAccountCode: glAccountCode,
            StartDate: startDate,
            EndDate: endDate,
          },
        });

        const transactions = normalizeTransactions(result);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  count: transactions.length,
                  glAccountCode,
                  period: { startDate, endDate },
                  transactions,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /**
   * get_transaction_details
   *
   * Check whether an outstanding item with a given reference still exists,
   * and retrieve its current status and amount.
   *
   * Use this after get_sales_invoices or get_purchase_invoices to verify
   * the current state of a specific invoice reference.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_transaction_details',
    {
      description:
        'Check whether an outstanding item (invoice) with a given reference still exists in Yuki ' +
        'and retrieve its current open amount and status.',
      inputSchema: {
        reference: z.string().describe("Invoice reference number as shown in Yuki (e.g. '2024-0042')"),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ reference, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        const sessionID = await client.getSessionID();

        // CheckOutstandingItemAdmin checks a specific reference within an administration
        const result = await client.callSoap({
          service: 'Accounting.asmx',
          method: 'CheckOutstandingItemAdmin',
          params: {
            sessionID,
            adminID: adminId,
            Reference: reference,
          },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, reference, result }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/**
 * Register the process_journal write tool.
 * Call this from registerTransactionTools — same server/client instance.
 */
export function registerJournalWriteTools(server: McpServer, client: YukiClient): void {
  /**
   * process_journal
   *
   * Post a general journal entry (memoriaal) in Yuki.
   * This is the primary method for recording bank reconciliation,
   * corrections, and any double-entry booking not covered by
   * ProcessSalesInvoices or ProcessPurchaseInvoices.
   *
   * CRITICAL RULE — Yuki will reject the entry if the amounts don't balance:
   *   - The sum of all entry amounts must equal exactly 0.00
   *   - Positive amounts = debit, negative amounts = credit
   *   - Example bank receipt: bank account +100.00, debtor account -100.00
   *
   * Use this for:
   *   - Bank reconciliation: match a bank mutation to an outstanding invoice
   *   - Opening balances
   *   - Corrections and reclassifications
   *   - Any custom double-entry booking
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'process_journal',
    {
      description:
        'Post a general journal entry (memoriaal) in Yuki for bank reconciliation, corrections, or custom bookings. ' +
        'IMPORTANT: all entry amounts must sum to exactly 0 (positive = debit, negative = credit). ' +
        'Yuki will reject the entry if this rule is violated.',
      inputSchema: {
        subject: z
          .string()
          .describe("Document subject / description shown in Yuki (e.g. 'Bank reconciliation April 2024')"),
        journalType: z
          .enum(['GeneralJournal', 'EndOfYearCorrection', 'FiscalCorrection'])
          .optional()
          .default('GeneralJournal')
          .describe(
            'Journal type. Year-end and fiscal corrections must have entry dates on the last day of the financial year.',
          ),
        entries: z
          .array(
            z.object({
              entryDate: z.string().describe('Entry date in YYYY-MM-DD format'),
              glAccount: z.string().describe("GL account code (e.g. '1200' for bank, '1300' for debtors)"),
              amount: z.number().describe('Amount: positive = debit, negative = credit. All entries must sum to 0.'),
              description: z.string().optional().describe('Line description (max 256 characters)'),
              contactCode: z.string().optional().describe('Yuki contact code to link this entry to a relation'),
              contactName: z.string().optional().describe('Contact name (used if contactCode is not provided)'),
            }),
          )
          .min(2)
          .describe('Journal entries — must contain at least 2 lines and sum to zero'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ subject, journalType, entries, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');

        // Validate balance before sending — save a request on obvious errors
        const total = entries.reduce((sum, e) => sum + e.amount, 0);
        if (Math.abs(total) > 0.001) {
          throw new Error(
            `Journal entries do not balance: sum is ${total.toFixed(2)} (must be 0.00). ` +
              `Check your debit/credit amounts.`,
          );
        }

        const sessionID = await client.getSessionID();
        const xmlDoc = buildJournalXml({ administrationId: adminId, subject, journalType, entries });

        // Accounting.asmx uses sessionID / administrationID (uppercase D)
        const result = await client.callSoap({
          service: 'Accounting.asmx',
          method: 'ProcessJournal',
          params: {
            sessionID,
            administrationID: adminId,
            xmlDoc: new XmlValue(xmlDoc),
          },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, subject, entryCount: entries.length, result }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
          isError: true,
        };
      }
    },
  );
}

// ── XML document builder ──────────────────────────────────────────────────────

/** Build the xmlDoc string for ProcessJournal. */
function buildJournalXml(args: {
  administrationId: string;
  subject: string;
  journalType?: string;
  entries: Array<{
    entryDate: string;
    glAccount: string;
    amount: number;
    description?: string;
    contactCode?: string;
    contactName?: string;
  }>;
}): string {
  const x = escapeXml;

  const entriesXml = args.entries
    .map(
      (e) => `
    <JournalEntry>
      <EntryDate>${x(e.entryDate)}</EntryDate>
      <GLAccount>${x(e.glAccount)}</GLAccount>
      <Amount>${e.amount}</Amount>
      ${e.description ? `<Description>${x(e.description.slice(0, 256))}</Description>` : ''}
      ${e.contactCode ? `<ContactCode>${x(e.contactCode)}</ContactCode>` : ''}
      ${!e.contactCode && e.contactName ? `<ContactName>${x(e.contactName)}</ContactName>` : ''}
    </JournalEntry>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<Journal xmlns="urn:xmlns:http://www.theyukicompany.com:journal"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <AdministrationID>${x(args.administrationId)}</AdministrationID>
  <DocumentSubject>${x(args.subject)}</DocumentSubject>
  <JournalType>${x(args.journalType ?? 'GeneralJournal')}</JournalType>
  ${entriesXml}
</Journal>`;
}

/** Unwrap the parsed SOAP GL transaction result into a flat array. */
function normalizeTransactions(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;

  const rec = result as Record<string, unknown>;

  const wrappers = ['Transactions', 'GLTransactions', 'Rows'];
  const itemTags = ['Transaction', 'GLTransaction', 'Row'];

  for (const wrapper of wrappers) {
    const c = rec[wrapper];
    if (!c) continue;
    if (Array.isArray(c)) return c;
    const inner = c as Record<string, unknown>;
    for (const tag of itemTags) {
      if (Array.isArray(inner[tag])) return inner[tag] as unknown[];
      if (inner[tag]) return [inner[tag]];
    }
  }

  for (const tag of itemTags) {
    if (Array.isArray(rec[tag])) return rec[tag] as unknown[];
    if (rec[tag]) return [rec[tag]];
  }

  return [result];
}
