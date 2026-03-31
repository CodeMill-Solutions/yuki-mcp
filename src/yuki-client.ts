import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

// Confirmed via WSDL inspection of api.yukiworks.nl
const YUKI_BASE_URL = 'https://api.yukiworks.nl/ws/';
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
  // Debtor / creditor outstanding items
  'DebtorItem',
  'CreditorItem',
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
}

export class YukiClient {
  private readonly apiKey: string;
  private readonly domainId: string;
  private readonly parser: XMLParser;

  /**
   * Map from administrationId → apiKey, loaded from the JSON keys file at startup.
   * Enables per-administration authentication when querying multiple companies.
   */
  private readonly apiKeyMap: Map<string, string>;

  /**
   * Session cache keyed by apiKey. Each distinct API key authenticates once and
   * reuses the same session ID for subsequent calls.
   */
  private readonly sessionCache = new Map<string, string>();

  constructor(apiKey: string, domainId: string, apiKeyMap?: Map<string, string>) {
    this.apiKey = apiKey;
    this.domainId = domainId;
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
   * per-administration API key is used for authentication. Otherwise falls back
   * to the default `YUKI_API_KEY`.
   *
   * Session IDs are cached per API key for the lifetime of this process.
   * On session expiry (SOAP fault) callers should catch the error, reset
   * the cache via invalidateSession(), and retry.
   */
  async getSessionID(adminId?: string): Promise<string> {
    // Resolve which API key to use for this administration
    const apiKey = (adminId && this.apiKeyMap.get(adminId)) ?? this.apiKey;

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

    const result = await this.callSoap({
      service: 'Accounting.asmx',
      method: 'Authenticate',
      params: { accessKey: apiKey },
    });

    const sessionID = extractString(result);
    if (!sessionID) {
      throw new Error('Authenticate returned an empty session ID. Check your API key.');
    }

    this.sessionCache.set(apiKey, sessionID);
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
      const apiKey = this.apiKeyMap.get(adminId) ?? this.apiKey;
      if (apiKey) this.sessionCache.delete(apiKey);
    } else {
      this.sessionCache.clear();
    }
  }

  /** The default domain / administration ID from the environment. */
  get defaultDomainId(): string {
    return this.domainId;
  }

  /** Number of administration-specific API keys loaded from the keys file. */
  get apiKeyCount(): number {
    return this.apiKeyMap.size;
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
    const url = `${YUKI_BASE_URL}${service}`;
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
          if (fault) throw new Error(`SOAP Fault: ${fault}`);
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
      throw new Error(`SOAP Fault: ${fault ?? 'Unknown SOAP fault'}`);
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
