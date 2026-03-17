import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { YukiClient } from '../yuki-client.js';

/**
 * Register tools related to Yuki administrations.
 *
 * A Yuki account can contain multiple administrations (companies/entities).
 * Use get_administrations to discover the correct administrationID / domainID
 * to pass to all other tools.
 *
 * Yuki service: Accounting.asmx
 * Auth flow:    Authenticate(accessKey) → sessionID → Administrations(sessionID)
 */
export function registerAdministrationTools(server: McpServer, client: YukiClient): void {
  /**
   * get_administrations
   *
   * List all administrations accessible with the current API key.
   * Always run this first to find the correct administrationID (GUID).
   *
   * Rate cost: 2 requests (1× Authenticate + 1× Administrations).
   * On subsequent calls within the same session, Authenticate is skipped: 1 request.
   */
  server.registerTool(
    'get_administrations',
    {
      description:
        'List all Yuki administrations (companies) accessible with the configured API key. ' +
        'Run this first to discover the correct administrationID to pass to other tools.',
    },
    async () => {
      try {
        // Step 1 — Authenticate and obtain (cached) sessionID
        const sessionID = await client.getSessionID();

        // Step 2 — Fetch administrations for this session
        const result = await client.callSoap({
          service: 'Accounting.asmx',
          method: 'Administrations',
          params: { sessionID },
        });

        const administrations = normalizeAdministrations(result);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, count: administrations.length, administrations }, null, 2),
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

/** Normalise the parsed SOAP result into a flat array of administration objects. */
function normalizeAdministrations(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;

  const rec = result as Record<string, unknown>;

  // The Administrations response wraps items in <Administrations><Administration>
  const containers = [rec['Administrations'], rec['administrations'], result];
  for (const c of containers) {
    if (!c) continue;
    if (Array.isArray(c)) return c;
    const inner = (c as Record<string, unknown>)['Administration'];
    if (Array.isArray(inner)) return inner;
    if (inner) return [inner];
  }

  return [result];
}
