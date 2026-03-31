import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { YukiClient } from '../yuki-client.js';

/**
 * Register tools for the Yuki AccountingInfo service.
 *
 * AccountingInfo.asmx provides richer read-only views of accounting data
 * that are not available through the main Accounting.asmx service:
 *
 *   - Full GL account scheme (codes, types, subtypes, active/inactive)
 *   - Fiscal period table (period names and date ranges per year)
 *   - Detailed transaction listing (includes document type, folder, period, project)
 *   - Transaction document download (retrieve the source PDF as base64)
 *   - Opening balances per GL account per fiscal year
 *
 * Yuki service: AccountingInfo.asmx
 * Note: uses sessionID / administrationID (uppercase D), same as Accounting.asmx.
 */
export function registerAccountingInfoTools(server: McpServer, client: YukiClient): void {
  // ── get_gl_account_scheme ────────────────────────────────────────────────────

  /**
   * get_gl_account_scheme
   *
   * Retrieve the complete GL account scheme (rekeningschema) for an
   * administration: all account codes with their type, subtype, and
   * active/inactive status.
   *
   * Use this instead of get_gl_accounts when you need the full account
   * definition (type, subtype, enabled flag) rather than current balances.
   * Useful for building GL account pickers, validating codes before booking,
   * or understanding the chart-of-accounts structure.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_gl_account_scheme',
    {
      description:
        'Retrieve the complete GL account scheme (rekeningschema) for an administration. ' +
        'Returns every account code with its type, subtype, description, and active/inactive status. ' +
        'Use this to validate GL codes before booking or to build account pickers. ' +
        'For current balances use get_gl_accounts instead.',
      inputSchema: {
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');

        const sessionID = await client.getSessionID(adminId);

        const result = await client.callSoap({
          service: 'AccountingInfo.asmx',
          method: 'GetGLAccountScheme',
          params: { sessionID, administrationID: adminId },
        });

        const accounts = normalizeList(result, ['GLAccounts', 'Accounts'], ['GLAccount', 'Account', 'Row']);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, count: accounts.length, accounts }, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    },
  );

  // ── get_period_table ─────────────────────────────────────────────────────────

  /**
   * get_period_table
   *
   * Retrieve the fiscal period table for a given year: period names, numbers,
   * and the date range each period covers.
   *
   * This is essential for Theun's depreciation and salary reports, which need
   * to display "the last period in which a booking was made" in human-readable
   * form (e.g. "Periode 3 · maart 2025") rather than a raw date.
   *
   * Use the returned period names to annotate gl_balances and
   * workflow_snapshots in the monorepo dashboard.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_period_table',
    {
      description:
        'Retrieve the fiscal period table (periodeoverzicht) for a given fiscal year. ' +
        'Returns period numbers, names, and start/end dates. ' +
        'Use this to translate a transaction date into a period name for reports ' +
        '(e.g. "tot welke periode zijn afschrijvingen verwerkt").',
      inputSchema: {
        yearId: z
          .number()
          .int()
          .describe('Fiscal year as a 4-digit integer (e.g. 2025).'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ yearId, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');

        const sessionID = await client.getSessionID(adminId);

        const result = await client.callSoap({
          service: 'AccountingInfo.asmx',
          method: 'GetPeriodDateTable',
          params: { sessionID, administrationID: adminId, yearID: yearId },
        });

        const periods = normalizeList(result, ['Periods', 'AdministrationPeriods'], ['Period', 'AdministrationPeriod', 'Row']);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, yearId, count: periods.length, periods }, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    },
  );

  // ── get_gl_transactions_detailed ────────────────────────────────────────────

  /**
   * get_gl_transactions_detailed
   *
   * Retrieve a detailed transaction listing for a GL account (or all accounts)
   * within a date range. Returns richer data than get_transactions:
   * document type, archive folder, fiscal period ID, project code,
   * mutation user, and company name.
   *
   * Use this when you need to determine *when* a specific type of booking
   * (e.g. depreciation, salary journal) was last made on an account, or
   * when you need to link a transaction back to its source document.
   *
   * financialMode: '1' = fiscal (default, matches Yuki's fiscal year),
   *                '0' = commercial (calendar year).
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_gl_transactions_detailed',
    {
      description:
        'Retrieve detailed transaction data for a GL account within a date range. ' +
        'Returns richer fields than get_transactions: document type, archive folder, ' +
        'fiscal period ID, project code, and mutation user. ' +
        'Leave glAccountCode empty to fetch all accounts. ' +
        'Use this to find the last period in which a depreciation or salary booking was made.',
      inputSchema: {
        startDate: z.string().describe('Start date in YYYY-MM-DD format (inclusive)'),
        endDate: z.string().describe('End date in YYYY-MM-DD format (inclusive)'),
        glAccountCode: z
          .string()
          .optional()
          .describe('GL account code to filter (e.g. "0300" for depreciation). Leave empty for all accounts.'),
        financialMode: z
          .enum(['0', '1'])
          .optional()
          .default('1')
          .describe("Financial mode: '1' = fiscal (default), '0' = commercial."),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ startDate, endDate, glAccountCode, financialMode, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');

        const sessionID = await client.getSessionID(adminId);

        const result = await client.callSoap({
          service: 'AccountingInfo.asmx',
          method: 'GetTransactionDetails',
          params: {
            sessionID,
            administrationID: adminId,
            GLAccountCode: glAccountCode ?? '',
            StartDate: startDate,
            EndDate: endDate,
            financialMode: financialMode ?? '1',
          },
        });

        const transactions = normalizeList(
          result,
          ['TransactionInfos', 'Transactions'],
          ['TransactionInfo', 'Transaction', 'Row'],
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  count: transactions.length,
                  period: { startDate, endDate },
                  glAccountCode: glAccountCode ?? '(all)',
                  financialMode,
                  transactions,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    },
  );

  // ── get_transaction_document ─────────────────────────────────────────────────

  /**
   * get_transaction_document
   *
   * Download the source document (PDF) associated with a transaction in Yuki,
   * returned as a base64-encoded string.
   *
   * Use the transactionId from a get_gl_transactions_detailed response (the `id`
   * or `hID` field). Useful for retrieving the original invoice PDF from a
   * booked transaction for verification or re-archival.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_transaction_document',
    {
      description:
        'Download the source document (PDF) for a booked transaction, returned as base64. ' +
        'Use the transaction ID from get_gl_transactions_detailed. ' +
        'Returns fileName and base64-encoded fileData.',
      inputSchema: {
        transactionId: z
          .string()
          .describe('Transaction ID (from the id or hID field in get_gl_transactions_detailed).'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ transactionId, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');

        const sessionID = await client.getSessionID(adminId);

        const result = await client.callSoap({
          service: 'AccountingInfo.asmx',
          method: 'GetTransactionDocument',
          params: { sessionID, administrationID: adminId, transactionID: transactionId },
        });

        // Result shape: { fileName: string, filedata: string (base64) }
        const doc = result as Record<string, unknown>;
        const fileName = doc['fileName'] ?? doc['FileName'] ?? null;
        const fileData = doc['filedata'] ?? doc['fileData'] ?? doc['FileData'] ?? null;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  transactionId,
                  fileName,
                  fileDataBase64: fileData,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    },
  );

  // ── get_start_balances ───────────────────────────────────────────────────────

  /**
   * get_start_balances
   *
   * Retrieve the opening balances (beginbalansen) per GL account for a
   * specific fiscal year.
   *
   * Use this when building year-over-year comparisons or verifying that
   * opening entries match the closing balances of the prior year.
   *
   * financialMode: '1' = fiscal (default), '0' = commercial.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_start_balances',
    {
      description:
        'Retrieve opening balances (beginbalansen) per GL account for a fiscal year. ' +
        'Returns accountID, accountDescription, and startBalance for each GL account. ' +
        'Use this for year-over-year balance verification.',
      inputSchema: {
        yearId: z
          .number()
          .int()
          .describe('Fiscal year as a 4-digit integer (e.g. 2025).'),
        financialMode: z
          .enum(['0', '1'])
          .optional()
          .default('1')
          .describe("Financial mode: '1' = fiscal (default), '0' = commercial."),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ yearId, financialMode, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');

        const sessionID = await client.getSessionID(adminId);

        const result = await client.callSoap({
          service: 'AccountingInfo.asmx',
          method: 'GetStartBalanceByGLAccount',
          params: {
            sessionID,
            administrationID: adminId,
            yearID: yearId,
            financialMode: financialMode ?? '1',
          },
        });

        const balances = normalizeList(
          result,
          ['StartBalances', 'AccountStartBalances'],
          ['StartBalance', 'AccountStartBalance', 'Row'],
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { success: true, yearId, financialMode, count: balances.length, balances },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err);
      }
    },
  );
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

/** Generic list normaliser: tries wrapper tags then item tags, falls back to raw. */
function normalizeList(result: unknown, wrappers: string[], itemTags: string[]): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;

  const rec = result as Record<string, unknown>;

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

/** Uniform error response shape. */
function errorResponse(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
    isError: true,
  };
}
