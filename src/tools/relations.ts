import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { YukiClient, XmlValue, escapeXml } from '../yuki-client.js';

/**
 * Register tools for working with Yuki relations (contacts).
 *
 * Relations are debitors (customers) and creditors (suppliers) in Yuki.
 * The Contact service uses domainID (the same GUID as your administrationID).
 *
 * Yuki service: Contact.asmx
 * Method:       SearchContacts(sessionID, domainID, searchOption, searchValue,
 *                              sortOrder, modifiedAfter, active, pageNumber)
 * Max results:  100 per page — use pageNumber for pagination.
 */
export function registerRelationTools(server: McpServer, client: YukiClient): void {
  /**
   * search_relations
   *
   * Search for contacts / relations (debitors and creditors) in Yuki.
   * Returns up to 100 matches per page with ID, name, code, type, and address.
   *
   * Use this to look up a relation ID before linking invoices, or to find
   * contact details for a customer or supplier.
   *
   * Rate cost: 1 request per page.
   */
  server.registerTool(
    'search_relations',
    {
      description:
        'Search for Yuki relations (customers/suppliers) by name, code, VAT number, or other fields. ' +
        'Returns up to 100 contacts per page with IDs, codes, names, and contact details. ' +
        'Omit searchValue (or pass an empty string) to retrieve all contacts.',
      inputSchema: {
        searchValue: z
          .string()
          .optional()
          .default('')
          .describe(
            'The value to search for (e.g. company name, relation code). ' +
              'Omit or pass an empty string to retrieve all contacts (subject to Yuki API support).',
          ),
        searchOption: z
          .enum([
            'All',
            'Name',
            'City',
            'Postcode',
            'Tag',
            'Email',
            'Website',
            'Phone',
            'Code',
            'CoCNumber',
            'VATNumber',
            'BankAccount',
            'ID',
            'ContactType',
            'HID',
          ])
          .optional()
          .default('All')
          .describe("Which field to search in. Defaults to 'All' (full-text search)."),
        active: z
          .enum(['Both', 'Active', 'Inactive'])
          .optional()
          .default('Active')
          .describe("Filter by active status. Defaults to 'Active'."),
        pageNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .default(1)
          .describe('Page number for pagination (100 results per page).'),
        domainId: z.string().optional().describe('Domain ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ searchValue, searchOption, active, pageNumber, domainId }) => {
      try {
        const domain = domainId ?? client.defaultDomainId;
        if (!domain) {
          throw new Error('domainId is required (or set YUKI_DOMAIN_ID env var)');
        }

        const sessionID = await client.getSessionID(domain);

        // Note: Contact.asmx uses 'domainID', not 'administrationID'
        const result = await client.callSoap({
          service: 'Contact.asmx',
          method: 'SearchContacts',
          params: {
            sessionID,
            domainID: domain,
            searchOption: searchOption ?? 'All',
            searchValue,
            sortOrder: 'Name',
            // modifiedAfter is optional — omit to get all
            active: active ?? 'Active',
            pageNumber: pageNumber ?? 1,
          },
        });

        const relations = normalizeContacts(result);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  count: relations.length,
                  page: pageNumber ?? 1,
                  relations,
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

/**
 * Register the upsert_contact write tool.
 * Call this from registerRelationTools — same server/client instance.
 */
export function registerContactWriteTools(server: McpServer, client: YukiClient): void {
  /**
   * upsert_contact
   *
   * Create a new contact or update an existing one in Yuki.
   * When a contactCode is provided and matches an existing record, Yuki
   * will update that contact. Otherwise a new contact is created.
   *
   * Use this before process_sales_invoice or process_purchase_invoice when:
   *   - A new customer or supplier needs to be registered
   *   - Contact details (IBAN, address, VAT number) need to be updated
   *   - You want to ensure a contact exists before linking invoices to it
   *
   * Note: Contact.asmx uses sessionID / domainID (uppercase D).
   * Rate cost: 1 request.
   */
  server.registerTool(
    'upsert_contact',
    {
      description:
        'Create or update a contact (customer or supplier) in Yuki. ' +
        'When contactCode matches an existing record it will be updated; otherwise a new contact is created. ' +
        'Returns the Yuki response with the contact ID.',
      inputSchema: {
        contactCode: z
          .string()
          .optional()
          .describe('Unique contact code. Used to identify and update existing contacts.'),
        fullName: z.string().describe('Full company or person name'),
        firstName: z.string().optional(),
        middleName: z.string().optional(),
        lastName: z.string().optional(),
        contactType: z
          .enum(['Debtor', 'Creditor', 'Both', 'Person'])
          .optional()
          .default('Both')
          .describe('Role: Debtor = customer, Creditor = supplier, Both = customer & supplier'),
        emailAddress: z.string().optional(),
        phone: z.string().optional().describe('Main phone number'),
        mobile: z.string().optional(),
        countryCode: z.string().optional().default('NL').describe('ISO 3166-1 alpha-2 country code'),
        city: z.string().optional(),
        zipcode: z.string().optional(),
        addressLine1: z.string().optional(),
        addressLine2: z.string().optional(),
        vatNumber: z.string().optional().describe("VAT / BTW number (e.g. 'NL123456789B01')"),
        cocNumber: z.string().optional().describe('KvK / Chamber of Commerce number'),
        bankAccount: z.string().optional().describe('IBAN bank account number'),
        bic: z.string().optional().describe('BIC / SWIFT code'),
        website: z.string().optional(),
        domainId: z.string().optional().describe('Domain ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({
      contactCode,
      fullName,
      firstName,
      middleName,
      lastName,
      contactType,
      emailAddress,
      phone,
      mobile,
      countryCode,
      city,
      zipcode,
      addressLine1,
      addressLine2,
      vatNumber,
      cocNumber,
      bankAccount,
      bic,
      website,
      domainId,
    }) => {
      try {
        const domain = domainId ?? client.defaultDomainId;
        if (!domain) throw new Error('domainId is required (or set YUKI_DOMAIN_ID env var)');

        const sessionID = await client.getSessionID(domain);
        const xmlDoc = buildContactXml({
          contactCode,
          fullName,
          firstName,
          middleName,
          lastName,
          contactType,
          emailAddress,
          phone,
          mobile,
          countryCode,
          city,
          zipcode,
          addressLine1,
          addressLine2,
          vatNumber,
          cocNumber,
          bankAccount,
          bic,
          website,
        });

        // Contact.asmx uses sessionID / domainID (uppercase D)
        const result = await client.callSoap({
          service: 'Contact.asmx',
          method: 'UpdateContact',
          params: {
            sessionID,
            domainID: domain,
            xmlDoc: new XmlValue(xmlDoc),
          },
        });

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ success: true, fullName, contactCode, result }, null, 2) },
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

/** Build the xmlDoc string for UpdateContact. */
function buildContactXml(args: {
  contactCode?: string;
  fullName: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  contactType?: string;
  emailAddress?: string;
  phone?: string;
  mobile?: string;
  countryCode?: string;
  city?: string;
  zipcode?: string;
  addressLine1?: string;
  addressLine2?: string;
  vatNumber?: string;
  cocNumber?: string;
  bankAccount?: string;
  bic?: string;
  website?: string;
}): string {
  const x = escapeXml;

  return `<?xml version="1.0" encoding="utf-8"?>
<Contacts xmlns="urn:xmlns:http://www.theyukicompany.com:contacts"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Contact>
    ${args.contactCode ? `<ContactCode>${x(args.contactCode)}</ContactCode>` : ''}
    <FullName>${x(args.fullName)}</FullName>
    ${args.firstName ? `<FirstName>${x(args.firstName)}</FirstName>` : ''}
    ${args.middleName ? `<MiddleName>${x(args.middleName)}</MiddleName>` : ''}
    ${args.lastName ? `<LastName>${x(args.lastName)}</LastName>` : ''}
    ${args.contactType ? `<ContactType>${x(args.contactType)}</ContactType>` : ''}
    ${args.emailAddress ? `<EmailAddress>${x(args.emailAddress)}</EmailAddress>` : ''}
    ${args.phone ? `<PhoneHome>${x(args.phone)}</PhoneHome>` : ''}
    ${args.mobile ? `<MobileHome>${x(args.mobile)}</MobileHome>` : ''}
    ${args.website ? `<Website>${x(args.website)}</Website>` : ''}
    ${args.countryCode ? `<CountryCode>${x(args.countryCode)}</CountryCode>` : ''}
    ${args.city ? `<City>${x(args.city)}</City>` : ''}
    ${args.zipcode ? `<Zipcode>${x(args.zipcode)}</Zipcode>` : ''}
    ${args.addressLine1 ? `<AddressLine_1>${x(args.addressLine1)}</AddressLine_1>` : ''}
    ${args.addressLine2 ? `<AddressLine_2>${x(args.addressLine2)}</AddressLine_2>` : ''}
    ${args.vatNumber ? `<VATNumber>${x(args.vatNumber)}</VATNumber>` : ''}
    ${args.cocNumber ? `<CoCNumber>${x(args.cocNumber)}</CoCNumber>` : ''}
    ${args.bankAccount ? `<BankAccount>${x(args.bankAccount)}</BankAccount>` : ''}
    ${args.bic ? `<BIC>${x(args.bic)}</BIC>` : ''}
  </Contact>
</Contacts>`;
}

/** Unwrap the parsed SOAP result for contacts into a flat array. */
function normalizeContacts(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;

  const rec = result as Record<string, unknown>;

  const wrappers = ['Contacts', 'contacts', 'Relations', 'relations'];
  const itemTags = ['Contact', 'contact', 'Relation', 'relation'];

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
