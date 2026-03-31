import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { YukiClient } from '../yuki-client.js';

/**
 * Register tools for the Yuki Backoffice service.
 *
 * Backoffice.asmx exposes documents and questions that require manual
 * review by the accountant before they can be processed.
 *
 * Yuki service: Backoffice.asmx
 * Note: uses sessionID / administrationID (uppercase D), same as Accounting.asmx.
 */
export function registerBackofficeTools(server: McpServer, client: YukiClient): void {
  /**
   * get_workflow
   *
   * Retrieve backoffice workflow items — documents (purchase and sales invoices)
   * that could not be processed automatically and are waiting to be reviewed
   * and booked by the accountant.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_workflow',
    {
      description:
        'Retrieve the Yuki backoffice workflow items for an administration. ' +
        'These are documents (purchase and sales invoices) that could not be processed ' +
        'automatically and are waiting to be reviewed and booked by the accountant.',
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
        if (!adminId) {
          throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');
        }

        const sessionID = await client.getSessionID(adminId);

        // Backoffice.asmx uses sessionID / administrationID (uppercase D)
        const result = await client.callSoap({
          service: 'Backoffice.asmx',
          method: 'GetWorkflow',
          params: {
            sessionID,
            administrationID: adminId,
          },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, result }, null, 2),
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
   * get_outstanding_questions
   *
   * Retrieve outstanding backoffice questions for an administration.
   * These are questions raised by the accountant that require a response
   * before the related documents can be processed.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_outstanding_questions',
    {
      description:
        'Retrieve outstanding backoffice questions for an administration in Yuki. ' +
        'These are questions raised by the accountant that require a response ' +
        'before the related documents can be processed.',
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
        if (!adminId) {
          throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');
        }

        const sessionID = await client.getSessionID(adminId);

        const result = await client.callSoap({
          service: 'Backoffice.asmx',
          method: 'GetOutstandingQuestions',
          params: {
            sessionID,
            administrationID: adminId,
          },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, result }, null, 2),
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
