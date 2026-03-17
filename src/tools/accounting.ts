import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { YukiClient } from '../yuki-client.js';

/**
 * Register tools for working with the Yuki chart of accounts.
 *
 * GLAccountBalance returns all GL accounts with their balance at a given date.
 * This is the closest the Yuki SOAP API comes to a "list all GL accounts" call.
 *
 * Yuki service: Accounting.asmx
 * Method:       GLAccountBalance(sessionID, administrationID, transactionDate)
 */
export function registerAccountingTools(server: McpServer, client: YukiClient): void {
  /**
   * get_gl_accounts
   *
   * Retrieve all GL accounts (grootboekrekeningen) with their balance at a
   * given date. Returns account code, name, and debit/credit balance.
   *
   * Use this to:
   *   - Find the GL account code for a bank account before calling get_transactions
   *   - Understand the account structure before booking a journal entry
   *   - Get a financial snapshot (balance sheet / P&L) at a specific date
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_gl_accounts',
    {
      description:
        'Retrieve all GL accounts (grootboekrekeningen) with their balance at a given date. ' +
        'Use this to find account codes (e.g. bank account codes) or get a financial snapshot. ' +
        "Defaults to today's date if no date is provided.",
      inputSchema: {
        date: z.string().optional().describe('Date for the balance snapshot in YYYY-MM-DD format. Defaults to today.'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ date, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');
        }

        const sessionID = await client.getSessionID();

        // Default to today's date in ISO format when not specified
        const transactionDate = date ?? new Date().toISOString().split('T')[0];

        const result = await client.callSoap({
          service: 'Accounting.asmx',
          method: 'GLAccountBalance',
          params: {
            sessionID,
            administrationID: adminId,
            transactionDate,
          },
        });

        const accounts = normalizeGLAccounts(result);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  count: accounts.length,
                  balanceDate: transactionDate,
                  accounts,
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
}

/** Unwrap the parsed SOAP GL account balance result into a flat array. */
function normalizeGLAccounts(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;

  const rec = result as Record<string, unknown>;

  const wrappers = ['GLAccounts', 'Accounts', 'Rows'];
  const itemTags = ['GLAccount', 'Account', 'Row'];

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
