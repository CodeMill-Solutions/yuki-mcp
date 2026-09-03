import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Yuki runs region-specific API hosts. An administration only exists on the
// host for its own region, so calls to the wrong region authenticate fine but
// then fail on every data call with "Domain has no active database".
const YUKI_REGION_HOSTS: Record<string, string> = {
  nl: 'https://api.yukiworks.nl/ws/',
  be: 'https://api.yukiworks.be/ws/',
};
const DEFAULT_YUKI_REGION = 'nl';
const SUPPORTED_REGIONS = Object.keys(YUKI_REGION_HOSTS).join(', ');

/** Ensure a base URL ends with a slash so `${baseUrl}${service}` composes. */
function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** Look up the API host for a region code; case- and whitespace-insensitive. */
function regionHost(region: string): string | undefined {
  return YUKI_REGION_HOSTS[region.trim().toLowerCase()];
}

/**
 * Append a hint when a fault looks like the caller is talking to the wrong
 * regional host. Yuki returns the same opaque message for a genuinely
 * unscoped API key and for a valid key pointed at the wrong region, which is
 * otherwise very hard to diagnose.
 */
function regionHint(fault: string | null, url: string): string {
  if (!fault || !/no active database/i.test(fault)) return '';
  const alternatives = Object.entries(YUKI_REGION_HOSTS)
    .filter(([, host]) => !url.startsWith(host))
    .map(([region]) => region);
  if (alternatives.length === 0) return '';
  return (
    ` (called ${url}. If this administration belongs to a different region, set YUKI_REGION` +
    ` to one of: ${alternatives.join(', ')} — or "region" for this administration in the keys file —` +
    ' or point YUKI_BASE_URL at the right host.)'
  );
}

/**
 * Resolve the server-wide Yuki API base URL.
 *
 * `YUKI_BASE_URL` (a full URL) takes precedence, so unlisted or future hosts
 * can be reached without a code change. Otherwise `YUKI_REGION` selects a
 * known regional host. Defaults to the Dutch host for backwards compatibility.
 * Keys-file entries can override the host per administration (see
 * `loadApiKeysFile`).
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['YUKI_BASE_URL']?.trim();
  if (explicit) return normalizeBaseUrl(explicit);

  const region = (env['YUKI_REGION']?.trim() || DEFAULT_YUKI_REGION).toLowerCase();
  const host = regionHost(region);
  if (!host) {
    throw new Error(
      `Unknown YUKI_REGION "${region}". Supported regions: ${SUPPORTED_REGIONS}. ` +
        'Alternatively set YUKI_BASE_URL to a full API URL.',
    );
  }
  return host;
}

export const YUKI_BASE_URL = resolveBaseUrl();
const YUKI_NAMESPACE = 'http://www.theyukicompany.com/';

// Tags that should always be treated as arrays even when there is only one element
const ALWAYS_ARRAY_TAGS = new Set([
  // Administrations
  'Administration',
  // Invoices
  'SalesInvoice',
  'PurchaseInvoice',
  'InvoiceLine',
  'Line',
  // Relations / contacts
  'Contact',
  'Relation',
  // Transactions (Accounting.asmx)
  'Transaction',
  'BankTransaction',
  'Row',
  // Transactions (AccountingInfo.asmx)
  'TransactionInfo',
  // GL accounts
  'GLAccount',
  'Account',
  // Debtor / creditor outstanding items (Accounting.asmx)
  'DebtorItem',
  'CreditorItem',
  'Item',
  // Fiscal periods (AccountingInfo.asmx)
  'Period',
  'AdministrationPeriod',
  // Opening balances (AccountingInfo.asmx)
  'StartBalance',
  'AccountStartBalance',
  // Archive documents
  'Document',
  'SearchResult',
  'CostCategory',
  'Folder',
]);

/**
 * Wraps a raw XML string so it is embedded directly into the SOAP body
 * without being HTML-entity-encoded.
 *
 * Use this for the `xmlDoc` parameter of ProcessSalesInvoices,
 * ProcessPurchaseInvoices, ProcessJournal, UpdateContact, etc.
 *
 * @example
 *   params: { sessionId: sid, xmlDoc: new XmlValue('<Root>...</Root>') }
 */
export class XmlValue {
  constructor(readonly xml: string) {}
}

export type SoapParamValue = string | number | boolean | XmlValue | undefined;

export interface SoapCallOptions {
  /** Filename of the ASMX service, e.g. "Accounting.asmx" */
  service: string;
  /** SOAP method name, e.g. "GLAccountTransactions" */
  method: string;
  /** Key-value pairs serialised as child XML elements inside the method element */
  params: Record<string, SoapParamValue>;
  /**
   * API base URL to call. Only `Authenticate` needs it (there is no session
   * yet); every other call is routed by the host of the session ID it carries.
   */
  baseUrl?: string;
}

// ── API key file loading ────────────────────────────────────────────────────
//
// Resolve which JSON file holds the administrationId → apiKey map, with the
// same precedence the server uses at startup:
//   1. YUKI_API_KEYS_FILE environment variable (explicit path)
//   2. ~/.yuki/api-keys.json  (default user-level location)
//   3. ./api-keys.json  (local fallback for development)
//
// Exported so both the entry point (index.ts) and the runtime reload tool
// can share the exact same resolution logic.

/**
 * Credentials for one administration from the keys file: its API key and the
 * API base URL to call for it. A keys-file value is either a bare API key
 * (string, server-wide region) or an object with an optional `region` or
 * `baseUrl` override:
 *
 *   {
 *     "<administrationId>": "<apiKey>",
 *     "<administrationId>": { "apiKey": "<apiKey>", "region": "be" },
 *     "<administrationId>": { "apiKey": "<apiKey>", "baseUrl": "https://…/ws/" }
 *   }
 */
export interface AdministrationCredentials {
  apiKey: string;
  /** Resolved API base URL for this administration (per-entry override or the server default). */
  baseUrl: string;
}

export interface LoadedApiKeys {
  /** Absolute path that was read from. */
  path: string;
  /** Map of administrationId → credentials. Empty if the file did not exist. */
  map: Map<string, AdministrationCredentials>;
  /** True when the resolved file existed and was parsed. */
  found: boolean;
}

/** One value in the keys file, before validation. */
type RawKeyEntry = string | { apiKey?: unknown; region?: unknown; baseUrl?: unknown } | null;

export function resolveApiKeysFilePath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  if (process.env['YUKI_API_KEYS_FILE']) return process.env['YUKI_API_KEYS_FILE'];
  const userPath = join(homedir(), '.yuki', 'api-keys.json');
  if (existsSync(userPath)) return userPath;
  return 'api-keys.json';
}

export function loadApiKeysFile(explicitPath?: string, defaultBaseUrl: string = YUKI_BASE_URL): LoadedApiKeys {
  const path = resolveApiKeysFilePath(explicitPath);
  const map = new Map<string, AdministrationCredentials>();
  if (!existsSync(path)) {
    return { path, map, found: false };
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, RawKeyEntry>;
  for (const [adminId, entry] of Object.entries(raw)) {
    if (!adminId) continue;
    const credentials = parseKeyEntry(entry, defaultBaseUrl, `administration ${adminId} in ${path}`);
    if (credentials) map.set(adminId, credentials);
  }
  return { path, map, found: true };
}

/**
 * Validate one keys-file value. Entries without an API key are skipped (as
 * before); an unknown region throws so a typo is reported instead of silently
 * falling back to the default host.
 */
function parseKeyEntry(entry: RawKeyEntry, defaultBaseUrl: string, source: string): AdministrationCredentials | null {
  if (typeof entry === 'string') {
    return entry ? { apiKey: entry, baseUrl: defaultBaseUrl } : null;
  }
  if (!entry || typeof entry !== 'object') return null;

  const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey.trim() : '';
  if (!apiKey) return null;

  if (typeof entry.baseUrl === 'string' && entry.baseUrl.trim()) {
    return { apiKey, baseUrl: normalizeBaseUrl(entry.baseUrl) };
  }
  if (typeof entry.region === 'string' && entry.region.trim()) {
    const host = regionHost(entry.region);
    if (!host) {
      throw new Error(
        `Unknown region "${entry.region.trim()}" for ${source}. Supported regions: ${SUPPORTED_REGIONS}. ` +
          'Alternatively set "baseUrl" to a full API URL.',
      );
    }
    return { apiKey, baseUrl: host };
  }
  return { apiKey, baseUrl: defaultBaseUrl };
}

/**
 * Diff returned by `YukiClient.reloadApiKeys` so callers can report what changed
 * — useful for the `reload_keys` MCP tool and for log-stderr lines.
 */
export interface ApiKeyReloadDiff {
  /** Keys that did not exist before this reload. */
  added: string[];
  /** Keys that existed before but changed API key or host (session invalidated). */
  updated: string[];
  /** Keys that existed before but are no longer in the file (session invalidated). */
  removed: string[];
  /** Final size of the map after reload. */
  total: number;
}

export class YukiClient {
  private readonly apiKey: string;
  private readonly domainId: string;
  private readonly baseUrl: string;
  private readonly parser: XMLParser;

  /**
   * Map from administrationId → credentials (API key + API base URL).
   * Populated from the JSON keys file at startup and mutated in place by
   * `reloadApiKeys()` so that all tools automatically see the latest set
   * without rebuilding the client.
   */
  private readonly apiKeyMap: Map<string, AdministrationCredentials>;

  /**
   * Session cache keyed by apiKey. Each distinct API key authenticates once and
   * reuses the same session ID for subsequent calls.
   */
  private readonly sessionCache = new Map<string, string>();

  /**
   * API base URL per live session ID. A session is only valid on the host that
   * issued it, so data calls are routed by the session ID they carry. That is
   * what lets one server instance serve administrations in different regions
   * without every tool having to pass the administration along.
   */
  private readonly sessionHosts = new Map<string, string>();

  constructor(
    apiKey: string,
    domainId: string,
    apiKeyMap?: Map<string, AdministrationCredentials>,
    baseUrl: string = YUKI_BASE_URL,
  ) {
    this.apiKey = apiKey;
    this.domainId = domainId;
    this.baseUrl = baseUrl;
    this.apiKeyMap = apiKeyMap ?? new Map();
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      // Strip namespace prefixes so we can address tags by their local name
      removeNSPrefix: true,
      parseAttributeValue: true,
      parseTagValue: true,
      // Force known collection tags to always be arrays
      isArray: (tagName: string) => ALWAYS_ARRAY_TAGS.has(tagName),
    });
  }

  /**
   * Return a valid Yuki session ID, authenticating if needed.
   *
   * When `adminId` is provided and exists in the API key map, the corresponding
   * per-administration API key — and its API host — is used for authentication.
   * Otherwise falls back to the default `YUKI_API_KEY` on the server-wide host.
   *
   * Session IDs are cached per API key for the lifetime of this process.
   * On session expiry (SOAP fault) callers should catch the error, reset
   * the cache via invalidateSession(), and retry.
   */
  async getSessionID(adminId?: string): Promise<string> {
    // Resolve which credentials to use for this administration
    const entry = adminId ? this.apiKeyMap.get(adminId) : undefined;
    const apiKey = entry?.apiKey ?? this.apiKey;
    const baseUrl = entry?.baseUrl ?? this.baseUrl;

    if (!apiKey) {
      throw new Error(
        adminId
          ? `No API key found for administration ${adminId}. ` +
            'Run a full sync from the dashboard or set YUKI_API_KEY.'
          : 'No API key configured. Set YUKI_API_KEY or run a full sync from the dashboard.',
      );
    }

    // Return cached session if available
    const cached = this.sessionCache.get(apiKey);
    if (cached) return cached;

    // Authenticate has no session yet, so it is the one call that names its host
    const result = await this.callSoap({
      service: 'Accounting.asmx',
      method: 'Authenticate',
      params: { accessKey: apiKey },
      baseUrl,
    });

    const sessionID = extractString(result);
    if (!sessionID) {
      throw new Error('Authenticate returned an empty session ID. Check your API key.');
    }

    this.sessionCache.set(apiKey, sessionID);
    this.sessionHosts.set(sessionID, baseUrl);
    return sessionID;
  }

  /**
   * Clear the cached session(s).
   *
   * When `adminId` is provided, only the session for that administration's key
   * is cleared. Without arguments all cached sessions are cleared.
   */
  invalidateSession(adminId?: string): void {
    if (adminId) {
      const apiKey = this.apiKeyMap.get(adminId)?.apiKey ?? this.apiKey;
      if (apiKey) this.evictSession(apiKey);
    } else {
      this.sessionCache.clear();
      this.sessionHosts.clear();
    }
  }

  /** Drop the cached session for an API key together with its host binding. */
  private evictSession(apiKey: string): void {
    const sessionID = this.sessionCache.get(apiKey);
    if (sessionID !== undefined) this.sessionHosts.delete(sessionID);
    this.sessionCache.delete(apiKey);
  }

  /**
   * Pick the API base URL for a call: an explicit `baseUrl` on the options,
   * else the host that issued the session ID in the params, else the
   * server-wide default.
   */
  private resolveCallBaseUrl(options: SoapCallOptions): string {
    if (options.baseUrl) return options.baseUrl;
    const sessionID = options.params['sessionID'] ?? options.params['sessionId'];
    return (typeof sessionID === 'string' && this.sessionHosts.get(sessionID)) || this.baseUrl;
  }

  /** The default domain / administration ID from the environment. */
  get defaultDomainId(): string {
    return this.domainId;
  }

  /** The server-wide API base URL; keys-file entries may override it per administration. */
  get defaultBaseUrl(): string {
    return this.baseUrl;
  }

  /** Number of administration-specific API keys loaded from the keys file. */
  get apiKeyCount(): number {
    return this.apiKeyMap.size;
  }

  /**
   * Replace the in-memory `apiKeyMap` with `next`, in place. Sessions for
   * entries whose API key **or host changed**, or that were **removed**, are
   * evicted from the session cache so the next call re-authenticates against
   * Yuki with the correct credentials on the correct host. Sessions for
   * unchanged entries are kept warm.
   *
   * Designed to be called from the `reload_keys` MCP tool after a fresh
   * `api-keys.json` has been written (e.g. by a `create_api_key` flow in a
   * sibling MCP server). Avoids the need to restart the MCP server.
   *
   * Returns a diff so callers can report what changed.
   */
  reloadApiKeys(next: Map<string, AdministrationCredentials>): ApiKeyReloadDiff {
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    // Detect updates + removals against the previous state
    for (const [adminId, previous] of this.apiKeyMap) {
      const entry = next.get(adminId);
      if (entry === undefined) {
        removed.push(adminId);
        // Evict the cached session for the removed key
        this.evictSession(previous.apiKey);
      } else if (entry.apiKey !== previous.apiKey || entry.baseUrl !== previous.baseUrl) {
        updated.push(adminId);
        // Evict the session bound to the old key or host
        this.evictSession(previous.apiKey);
      }
    }

    // Detect additions
    for (const adminId of next.keys()) {
      if (!this.apiKeyMap.has(adminId)) added.push(adminId);
    }

    // Apply the new state in place (preserves the Map reference)
    this.apiKeyMap.clear();
    for (const [adminId, entry] of next) {
      this.apiKeyMap.set(adminId, entry);
    }

    return { added, updated, removed, total: this.apiKeyMap.size };
  }

  // ── Core SOAP plumbing ──────────────────────────────────────────────────────

  /** Build a SOAP 1.1 envelope around the given method body. */
  private buildSoapEnvelope(method: string, paramsXml: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <${method} xmlns="${YUKI_NAMESPACE}">
      ${paramsXml}
    </${method}>
  </soap:Body>
</soap:Envelope>`;
  }

  /**
   * Serialise a params object to sibling XML elements, skipping undefined/empty values.
   * - XmlValue instances are embedded as raw XML (no escaping).
   * - All other values are XML-escaped to prevent injection.
   */
  private serializeParams(params: Record<string, SoapParamValue>): string {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([key, v]) => {
        if (v instanceof XmlValue) {
          return `<${key}>${v.xml}</${key}>`;
        }
        return `<${key}>${escapeXml(String(v))}</${key}>`;
      })
      .join('\n      ');
  }

  /**
   * Execute a SOAP call against a Yuki web service.
   *
   * Returns the parsed inner content of `<{method}Result>`, or the full
   * `<{method}Response>` when no Result wrapper is present.
   *
   * Throws a descriptive Error on SOAP faults or HTTP errors.
   */
  async callSoap(options: SoapCallOptions): Promise<unknown> {
    const { service, method, params } = options;
    const url = `${this.resolveCallBaseUrl(options)}${service}`;
    const soapBody = this.buildSoapEnvelope(method, this.serializeParams(params));
    const soapAction = `${YUKI_NAMESPACE}${method}`;

    let responseData: string;

    try {
      const response = await axios.post<string>(url, soapBody, {
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: `"${soapAction}"`,
        },
        timeout: 30_000,
        responseType: 'text',
      });
      responseData = response.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        if (err.response?.data) {
          const fault = this.extractSoapFault(err.response.data as string);
          if (fault) throw new Error(`SOAP Fault: ${fault}${regionHint(fault, url)}`);
          throw new Error(`HTTP ${err.response.status} ${err.response.statusText} from ${url}`);
        }
        throw new Error(`Network error calling Yuki API: ${err.message}`);
      }
      throw err;
    }

    const parsed = this.parser.parse(responseData) as Record<string, unknown>;
    const body = (parsed?.Envelope as Record<string, unknown> | undefined)?.Body as Record<string, unknown> | undefined;

    if (!body) {
      throw new Error('Invalid SOAP response: missing <soap:Body>');
    }

    if (body['Fault']) {
      const fault = this.extractSoapFault(responseData);
      throw new Error(`SOAP Fault: ${fault ?? 'Unknown SOAP fault'}${regionHint(fault, url)}`);
    }

    // Unwrap <{method}Response><{method}Result> automatically
    const responseKey = `${method}Response`;
    const resultKey = `${method}Result`;
    const methodResponse = body[responseKey] as Record<string, unknown> | undefined;

    if (methodResponse) {
      return resultKey in methodResponse ? methodResponse[resultKey] : methodResponse;
    }

    return body;
  }

  /** Parse a SOAP fault string from raw XML, returning null if none found. */
  private extractSoapFault(xml: string): string | null {
    try {
      const parsed = this.parser.parse(xml) as Record<string, unknown>;
      const body = (parsed?.Envelope as Record<string, unknown> | undefined)?.Body as
        | Record<string, unknown>
        | undefined;
      const fault = body?.Fault as Record<string, unknown> | undefined;
      if (!fault) return null;

      // SOAP 1.1 faultstring
      if (typeof fault['faultstring'] === 'string') return fault['faultstring'];
      // SOAP 1.2 Reason/Text
      const text = (fault['Reason'] as Record<string, unknown> | undefined)?.Text;
      if (typeof text === 'string') return text;

      return JSON.stringify(fault);
    } catch {
      return null;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Escape special XML characters in a plain-text value.
 * Always call this before embedding user-supplied strings inside XML.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Extract a plain string value from a parsed SOAP result (handles wrapping objects). */
function extractString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  // fast-xml-parser sometimes wraps a text node in { "#text": "..." }
  if (value && typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (typeof text === 'string') return text.trim() || null;
  }
  return null;
}
