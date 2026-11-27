import { YukiClient } from '../yuki-client.js';

/** A session for a call that Yuki scopes by API key, plus what the caller should be told about that scope. */
export interface ScopedSession {
  sessionID: string;
  /** The administration the session was opened for, when one could be determined. */
  adminId: string | undefined;
  /** Set when the session could not be tied to that administration's own API key. */
  warning?: string;
}

/**
 * Open the session for a method that Yuki scopes by the session's API key instead of by an
 * administrationID parameter: the Archive listing methods (DocumentsInFolder, SearchDocuments,
 * DocumentBinaryData) and the Contact web service. Those methods act on whatever the session's API
 * key belongs to, so the session has to be opened with the key of the administration the caller
 * means. Opened with any other key the call still succeeds, against the wrong administration, and
 * typically returns nothing.
 *
 * With a keys file loaded there are several keys to choose from, so an administration is required.
 * With a single YUKI_API_KEY that key is the only candidate and none is needed.
 */
export async function openScopedSession(
  client: YukiClient,
  administrationId: string | undefined,
): Promise<ScopedSession> {
  const adminId = administrationId || client.defaultDomainId || undefined;
  const keysLoaded = client.apiKeyCount > 0;

  if (!adminId && keysLoaded) {
    throw new Error(
      'administrationId is required when a keys file is loaded (or set YUKI_DOMAIN_ID env var): ' +
        'this tool reads the administration that the API key belongs to',
    );
  }

  const sessionID = await client.getSessionID(adminId);

  if (adminId && keysLoaded && !client.hasKeyFor(adminId)) {
    return {
      sessionID,
      adminId,
      warning:
        `Administration ${adminId} has no entry in the keys file, so the server-wide YUKI_API_KEY was used. ` +
        'The result comes from the administration that key belongs to.',
    };
  }
  return { sessionID, adminId };
}

/** The administration a result belongs to, for a tool's JSON output. */
export function sessionScope(session: ScopedSession): { administrationId?: string; warning?: string } {
  return {
    ...(session.adminId ? { administrationId: session.adminId } : {}),
    ...(session.warning ? { warning: session.warning } : {}),
  };
}
