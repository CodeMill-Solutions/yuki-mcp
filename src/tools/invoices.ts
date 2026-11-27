import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { YukiClient, XmlValue, escapeXml } from '../yuki-client.js';

/**
 * Register tools for retrieving outstanding invoices from Yuki.
 *
 * Note: The Yuki SOAP API exposes outstanding (open) invoice items via
 * the Accounting service. Full invoice history with date-range filtering
 * is not available via SOAP — use the Yuki web interface or the
 * ProcessSalesInvoices/ProcessPurchaseInvoices methods for write operations.
 *
 * Sales receivables:  OutstandingDebtorItems
 * Purchase payables:  OutstandingCreditorItems
 *
 * Yuki service: Accounting.asmx
 */
export function registerInvoiceTools(server: McpServer, client: YukiClient): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Sales invoices (debitors / receivables)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * get_sales_invoices
   *
   * Retrieve outstanding (unpaid) sales invoice items for an administration.
   * Returns debtor name, invoice reference, due date, open amount, and currency.
   *
   * Use this to track receivables: which customers still owe money, how much,
   * and for how long. Optionally filter by due date.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_sales_invoices',
    {
      description:
        'Retrieve outstanding (unpaid) sales invoices from Yuki. ' +
        'Returns debtor name, reference, due date, open amount, and currency for each item. ' +
        'Optionally filter by due date cutoff using dateOutstanding.',
      inputSchema: {
        dateOutstanding: z
          .string()
          .optional()
          .describe(
            'ISO date string (YYYY-MM-DD). When provided, returns only items ' +
              'outstanding as of this date. Omit for all outstanding items.',
          ),
        sortOrder: z
          .enum(['ContactAsc', 'ContactDesc', 'AmountAsc', 'AmountDesc', 'DateAsc', 'DateDesc'])
          .optional()
          .default('DateDesc')
          .describe('Sort order for results.'),
        includeBankTransactions: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include bank transaction data alongside invoice items.'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ dateOutstanding, sortOrder, includeBankTransactions, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');
        }

        const sessionID = await client.getSessionID(adminId);

        let result: unknown;

        if (dateOutstanding) {
          // Filter by specific outstanding date
          result = await client.callSoap({
            service: 'Accounting.asmx',
            method: 'OutstandingDebtorItemsByDateOutstanding',
            params: {
              sessionID,
              administrationID: adminId,
              DateOutstanding: dateOutstanding,
            },
          });
        } else {
          result = await client.callSoap({
            service: 'Accounting.asmx',
            method: 'OutstandingDebtorItems',
            params: {
              sessionID,
              administrationID: adminId,
              includeBankTransactions: includeBankTransactions ?? false,
              sortOrder: sortOrder ?? 'DateDesc',
            },
          });
        }

        const invoices = normalizeItems(result);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  count: invoices.length,
                  note: 'Only outstanding (unpaid) items are returned.',
                  invoices,
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

  // ──────────────────────────────────────────────────────────────────────────
  // Purchase invoices (creditors / payables)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * get_purchase_invoices
   *
   * Retrieve outstanding (unpaid) purchase invoice items for an administration.
   * Returns creditor name, invoice reference, due date, open amount, and currency.
   *
   * Use this to track payables: which suppliers are still owed money.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_purchase_invoices',
    {
      description:
        'Retrieve outstanding (unpaid) purchase invoices from Yuki. ' +
        'Returns creditor name, reference, due date, open amount, and currency for each item. ' +
        'Optionally filter by due date cutoff using dateOutstanding.',
      inputSchema: {
        dateOutstanding: z
          .string()
          .optional()
          .describe(
            'ISO date string (YYYY-MM-DD). When provided, returns only items ' +
              'outstanding as of this date. Omit for all outstanding items.',
          ),
        sortOrder: z
          .enum(['ContactAsc', 'ContactDesc', 'AmountAsc', 'AmountDesc', 'DateAsc', 'DateDesc'])
          .optional()
          .default('DateDesc')
          .describe('Sort order for results.'),
        includeBankTransactions: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include bank transaction data alongside invoice items.'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ dateOutstanding, sortOrder, includeBankTransactions, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');
        }

        const sessionID = await client.getSessionID(adminId);

        let result: unknown;

        if (dateOutstanding) {
          result = await client.callSoap({
            service: 'Accounting.asmx',
            method: 'OutstandingCreditorItemsByDateOutstanding',
            params: {
              sessionID,
              administrationID: adminId,
              DateOutstanding: dateOutstanding,
            },
          });
        } else {
          result = await client.callSoap({
            service: 'Accounting.asmx',
            method: 'OutstandingCreditorItems',
            params: {
              sessionID,
              administrationID: adminId,
              includeBankTransactions: includeBankTransactions ?? false,
              sortOrder: sortOrder ?? 'DateDesc',
            },
          });
        }

        const invoices = normalizeItems(result);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  count: invoices.length,
                  note: 'Only outstanding (unpaid) items are returned.',
                  invoices,
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

// ── Zod schemas shared between write tools ────────────────────────────────────

/** Contact block used in both sales and purchase invoice XML documents. */
const ContactSchema = z.object({
  contactCode: z
    .string()
    .optional()
    .describe("Existing Yuki contact code (e.g. 'CUST001'). When provided, Yuki will link to the existing contact."),
  fullName: z.string().describe('Full company or person name'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  emailAddress: z.string().optional(),
  phone: z.string().optional(),
  countryCode: z.string().optional().default('NL').describe("ISO 3166-1 alpha-2 country code, e.g. 'NL'"),
  city: z.string().optional(),
  zipcode: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  vatNumber: z.string().optional(),
  cocNumber: z.string().optional(),
  bankAccount: z.string().optional().describe('IBAN bank account number'),
  bic: z.string().optional(),
  contactType: z
    .enum(['Person', 'Company'])
    .optional()
    .describe(
      'Yuki contact type. Set Company for a business: Yuki creates a new contact as Person when this is omitted. ' +
        'Leave it out to keep the type of an existing contact unchanged.',
    ),
});

/**
 * Yuki's numeric VAT types for the named `vatType` values of process_sales_invoice, with the Dutch
 * rate that goes with each. Yuki looks up the VAT code by the combination of type and percentage and
 * cancels the invoice when that combination does not exist, so the two have to agree.
 *
 * Source: the VATType table in Yuki's "Sales - Functional description of fields sales invoices XML".
 */
const SALES_VAT_TYPES = new Map<string, { code: number; percentage: number }>([
  ['NL_Normal', { code: 1, percentage: 21 }], // high VAT rate
  ['NL_Reduced', { code: 2, percentage: 9 }], // low VAT rate
  ['NL_Zero', { code: 4, percentage: 0 }], // VAT 0%
  ['NL_None', { code: 0, percentage: 0 }], // exempt from VAT
]);

/**
 * Resolve a line's `vatType` and `vatPercentage` to the numeric VATType and the percentage Yuki
 * expects. A named type brings its own default percentage; a numeric Yuki VAT type is passed
 * through and needs an explicit percentage, because its rate cannot be guessed.
 */
function resolveSalesVat(
  vatType: string | undefined,
  vatPercentage: number | undefined,
): { code: number; percentage: number } {
  const type = (vatType ?? 'NL_Normal').trim();
  const named = SALES_VAT_TYPES.get(type);
  if (named) return { code: named.code, percentage: vatPercentage ?? named.percentage };

  if (!/^\d+$/.test(type)) {
    throw new Error(
      `Unknown vatType "${type}". Use ${[...SALES_VAT_TYPES.keys()].join(', ')}, ` +
        'or a numeric Yuki VAT type from Settings > VAT rates.',
    );
  }
  if (vatPercentage === undefined) {
    throw new Error(`vatPercentage is required with the numeric vatType ${type}`);
  }
  return { code: Number(type), percentage: vatPercentage };
}

/** What Yuki did with a submitted sales invoice, according to its own counters. */
type SalesInvoiceOutcome = {
  status: 'succeeded' | 'failed' | 'skipped' | 'unknown';
  message?: string;
};

/**
 * Read Yuki's verdict from a ProcessSalesInvoices response. Yuki answers HTTP 200 whatever happened
 * to the invoice, so the counters in <SalesInvoicesImportResponse> decide — not the transport.
 *
 * A skipped invoice and a response without counters are reported as such instead of as a plain
 * failure: in both cases the caller must look in Yuki before sending the invoice again, or it may
 * end up twice in the books.
 */
function readSalesInvoiceOutcome(result: unknown): SalesInvoiceOutcome {
  const succeeded = readCounter(result, 'TotalSucceeded');
  const failed = readCounter(result, 'TotalFailed');
  const skipped = readCounter(result, 'TotalSkipped') ?? 0;

  if (succeeded === undefined || failed === undefined) {
    return {
      status: 'unknown',
      message:
        "Yuki's response did not contain the TotalSucceeded and TotalFailed counters, so the outcome is unknown. " +
        'Check in Yuki whether the invoice exists before sending it again.',
    };
  }
  if (failed > 0) return { status: 'failed', message: 'Yuki rejected the invoice. See Message in result.' };
  if (succeeded > 0) return { status: 'succeeded' };
  if (skipped > 0) {
    return {
      status: 'skipped',
      message:
        'Yuki skipped the invoice and did not create it. See Message in result, and check in Yuki whether an ' +
        'invoice with this reference already exists before sending it again.',
    };
  }
  return { status: 'failed', message: 'Yuki processed no invoice. See result.' };
}

/** Read a counter such as TotalFailed from a parsed Yuki response, or from one that is still raw XML. */
function readCounter(result: unknown, name: string): number | undefined {
  if (typeof result === 'string') {
    const match = new RegExp(`<${name}\\b[^>]*>\\s*(\\d+)\\s*<`).exec(result);
    return match ? Number(match[1]) : undefined;
  }
  const value = findProperty(result, name);
  // fast-xml-parser wraps the text of an element that also carries attributes in { "#text": … }
  const text = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)['#text'] : value;
  if (typeof text === 'number' && Number.isInteger(text)) return text;
  if (typeof text === 'string' && /^\d+$/.test(text.trim())) return Number(text.trim());
  return undefined;
}

/** Breadth-first search for a property by name, so a counter near the root wins over anything nested deeper. */
function findProperty(root: unknown, name: string): unknown {
  let level: unknown[] = [root];
  for (let depth = 0; depth < 6 && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (node === null || typeof node !== 'object') continue;
      if (!Array.isArray(node) && name in node) return (node as Record<string, unknown>)[name];
      next.push(...Object.values(node));
    }
    level = next;
  }
  return undefined;
}

// ── process_sales_invoice ─────────────────────────────────────────────────────

/**
 * Register the write tools for sales and purchase invoices.
 * Called from registerInvoiceTools — same server/client instance.
 */
export function registerInvoiceWriteTools(server: McpServer, client: YukiClient): void {
  /**
   * process_sales_invoice
   *
   * Create and book a sales invoice in Yuki.
   * Yuki will send the invoice to the customer if emailToCustomer is true.
   *
   * Use this when:
   *   - A new sale needs to be invoiced
   *   - An order has been fulfilled and must be recorded in the ledger
   *   - An existing invoice from another system needs to be mirrored in Yuki
   *
   * Note: Sales.asmx uses sessionId / administrationId (lowercase d).
   * Rate cost: 1 request.
   */
  server.registerTool(
    'process_sales_invoice',
    {
      description:
        'Create a sales invoice in Yuki: booked at once (process=true, needs a reference) or left under ' +
        '"To be sent" (process=false, Yuki assigns the number). ' +
        'Accepts invoice header, contact, and line items. ' +
        'Optionally sends a booked invoice to the customer by email. ' +
        "Returns success, a status (succeeded, failed, skipped or unknown) and Yuki's response. " +
        'On skipped or unknown, check in Yuki before sending the invoice again.',
      inputSchema: {
        reference: z
          .string()
          .optional()
          .describe(
            "Invoice number (e.g. '2024-0042'). Required when process=true. Must be omitted when process=false: Yuki assigns the number.",
          ),
        subject: z.string().describe('Invoice title shown to the customer'),
        date: z.string().describe('Invoice date in YYYY-MM-DD format'),
        dueDate: z.string().describe('Payment due date in YYYY-MM-DD format'),
        contact: ContactSchema.describe('Customer contact details'),
        lines: z
          .array(
            z.object({
              description: z.string().describe('Line item description'),
              quantity: z.number().optional().default(1).describe('Quantity (default 1)'),
              salesPrice: z.number().describe('Unit price excluding VAT'),
              vatPercentage: z
                .number()
                .optional()
                .describe(
                  'VAT percentage. Defaults to the Dutch rate of a named vatType (21, 9 or 0). ' +
                    'Pass it for any other rate, e.g. 6 or 12 in Belgium.',
                ),
              vatIncluded: z.boolean().optional().default(false).describe('Whether salesPrice already includes VAT'),
              vatType: z
                .string()
                .optional()
                .default('NL_Normal')
                .describe(
                  'VAT type: NL_Normal (high rate), NL_Reduced (low rate), NL_Zero (0%) or NL_None (exempt). ' +
                    'For anything else pass the numeric Yuki VAT type from Settings > VAT rates ' +
                    '(e.g. 17 for reverse charge) together with vatPercentage.',
                ),
              glAccountCode: z.string().optional().describe('GL account code to post this line to'),
              productDescription: z
                .string()
                .optional()
                .describe(
                  'Name of the Yuki sales item (max 60 characters). Yuki matches on it and creates the sales item ' +
                    'when it does not exist yet. Defaults to the line description, so every new description adds ' +
                    'a sales item: pass one fixed name to reuse the same item across lines and invoices.',
                ),
              productReference: z.string().optional().describe('Product/SKU reference code'),
            }),
          )
          .min(1)
          .describe('Invoice line items'),
        paymentMethod: z
          .enum(['ElectronicTransfer', 'DirectCollection', 'Cash', 'DebitCard', 'CreditCard'])
          .optional()
          .default('ElectronicTransfer'),
        currency: z.string().optional().default('EUR').describe('ISO 4217 currency code'),
        process: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'true books the invoice (needs reference). false leaves it in Yuki under To be sent (no reference allowed).',
          ),
        emailToCustomer: z
          .boolean()
          .optional()
          .default(false)
          .describe("Send the invoice to the customer's email address"),
        remarks: z.string().optional().describe('Internal remarks (not visible on invoice)'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({
      reference,
      subject,
      date,
      dueDate,
      contact,
      lines,
      paymentMethod,
      currency,
      process: doProcess,
      emailToCustomer,
      remarks,
      administrationId,
    }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');
        if (doProcess && !reference) throw new Error('reference is required when process=true');
        if (!doProcess && reference) {
          throw new Error('Yuki does not accept a reference when process=false: omit it and Yuki assigns the number');
        }
        if (!doProcess && emailToCustomer) throw new Error('emailToCustomer needs process=true');

        // Build the document first: an invalid VAT type should fail before a request is spent on it
        const xmlDoc = buildSalesInvoiceXml({
          reference,
          subject,
          date,
          dueDate,
          contact,
          lines,
          paymentMethod,
          currency,
          process: doProcess,
          emailToCustomer,
          remarks,
        });
        const sessionId = await client.getSessionID(adminId);

        // Sales.asmx uses sessionId / administrationId (lowercase d)
        const result = await client.callSoap({
          service: 'Sales.asmx',
          method: 'ProcessSalesInvoices',
          params: {
            sessionId,
            administrationId: adminId,
            xmlDoc: new XmlValue(xmlDoc),
          },
        });

        // Yuki answers HTTP 200 even when an invoice is rejected; its own counters decide.
        const outcome = readSalesInvoiceOutcome(result);
        const ok = outcome.status === 'succeeded';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: ok, ...outcome, reference, result }, null, 2),
            },
          ],
          ...(ok ? {} : { isError: true }),
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

  // ── process_purchase_invoice ───────────────────────────────────────────────

  /**
   * process_purchase_invoice
   *
   * Book an incoming purchase invoice in Yuki.
   * Optionally attach the original PDF as a base64 string.
   *
   * Use this when:
   *   - An incoming invoice from a supplier needs to be booked
   *   - OCR has extracted invoice data from a PDF and it must be recorded
   *   - Automating the AP (accounts payable) workflow
   *
   * Note: Purchase.asmx uses sessionId / administrationId (lowercase d).
   * Rate cost: 1 request.
   */
  server.registerTool(
    'process_purchase_invoice',
    {
      description:
        'Book an incoming purchase invoice in Yuki. ' +
        'Accepts invoice totals, supplier contact, and line items. ' +
        'Optionally attach the original PDF as a base64 string. ' +
        'Returns the Yuki response including the assigned document ID. ' +
        "KNOWN LIMITATION in this version: the request does not pass Yuki's validation, so do not rely on " +
        'this tool. Use upload_document to hand a purchase invoice to Yuki instead.',
      inputSchema: {
        reference: z.string().optional().describe("Supplier's invoice number"),
        date: z.string().describe('Invoice date in YYYY-MM-DD format'),
        dueDate: z.string().optional().describe('Payment due date in YYYY-MM-DD format'),
        invoiceAmount: z.number().describe('Total invoice amount including VAT'),
        invoiceVatAmount: z.number().describe('Total VAT amount on the invoice'),
        contact: ContactSchema.describe('Supplier contact details'),
        lines: z
          .array(
            z.object({
              description: z.string().optional().describe('Line item description'),
              lineAmount: z.number().describe('Line amount excluding VAT'),
              lineVatType: z
                .number()
                .optional()
                .default(2)
                .describe('VAT type code: 1=None, 2=21% NL, 3=9% NL, 4=0% NL, 5=EU (see Yuki docs)'),
              lineVatPercentage: z
                .number()
                .optional()
                .describe('VAT percentage (e.g. 21). Derived from lineVatType if omitted.'),
              glAccountCode: z
                .string()
                .optional()
                .describe("GL account code to post this line to (e.g. '4000' for cost of goods)"),
              vatDeductibilityPercentage: z
                .number()
                .optional()
                .default(100)
                .describe('Deductible VAT percentage (0-100). Use <100 for partially deductible costs.'),
            }),
          )
          .min(1)
          .describe('Invoice line items'),
        paymentMethod: z
          .enum(['Transfer', 'DirectCollection', 'Cash', 'DebitCard', 'CreditCard'])
          .optional()
          .default('Transfer'),
        currency: z.string().optional().default('EUR'),
        process: z.boolean().optional().default(true).describe('Immediately process/finalise in Yuki'),
        documentFileName: z.string().optional().describe("PDF filename (e.g. 'invoice-2024-0042.pdf')"),
        documentBase64: z.string().optional().describe('PDF content encoded as base64 string'),
        remarks: z.string().optional(),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({
      reference,
      date,
      dueDate,
      invoiceAmount,
      invoiceVatAmount,
      contact,
      lines,
      paymentMethod,
      currency,
      process: doProcess,
      documentFileName,
      documentBase64,
      remarks,
      administrationId,
    }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');

        const sessionId = await client.getSessionID(adminId);
        const xmlDoc = buildPurchaseInvoiceXml({
          reference,
          date,
          dueDate,
          invoiceAmount,
          invoiceVatAmount,
          contact,
          lines,
          paymentMethod,
          currency,
          process: doProcess,
          documentFileName,
          documentBase64,
          remarks,
        });

        // Purchase.asmx uses sessionId / administrationId (lowercase d)
        const result = await client.callSoap({
          service: 'Purchase.asmx',
          method: 'ProcessPurchaseInvoices',
          params: {
            sessionId,
            administrationId: adminId,
            disableAutoCorrect: '',
            xmlDoc: new XmlValue(xmlDoc),
          },
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, reference, result }, null, 2) }],
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

// ── XML document builders ─────────────────────────────────────────────────────

/** Build the xmlDoc string for ProcessSalesInvoices, in Yuki's documented element order. */
function buildSalesInvoiceXml(args: {
  reference?: string;
  subject: string;
  date: string;
  dueDate: string;
  contact: z.infer<typeof ContactSchema>;
  lines: Array<{
    description: string;
    quantity?: number;
    salesPrice: number;
    vatPercentage?: number;
    vatIncluded?: boolean;
    vatType?: string;
    glAccountCode?: string;
    productDescription?: string;
    productReference?: string;
  }>;
  paymentMethod?: string;
  currency?: string;
  process?: boolean;
  emailToCustomer?: boolean;
  remarks?: string;
}): string {
  const x = escapeXml;
  const { contact } = args;

  const linesXml = args.lines
    .map((line) => {
      const vat = resolveSalesVat(line.vatType, line.vatPercentage);
      return `
      <InvoiceLine>
        <Description>${x(line.description)}</Description>
        <ProductQuantity>${line.quantity ?? 1}</ProductQuantity>
        <Product>
          <Description>${x(line.productDescription ?? line.description)}</Description>
          ${line.productReference ? `<Reference>${x(line.productReference)}</Reference>` : ''}
          <Category xsi:nil="true" />
          <SalesPrice>${line.salesPrice}</SalesPrice>
          <VATPercentage>${vat.percentage}</VATPercentage>
          <VATIncluded>${line.vatIncluded ?? false}</VATIncluded>
          <VATType>${vat.code}</VATType>
          ${line.glAccountCode ? `<GLAccountCode>${x(line.glAccountCode)}</GLAccountCode>` : ''}
        </Product>
      </InvoiceLine>`;
    })
    .join('');

  return `<SalesInvoices xmlns="urn:xmlns:http://www.theyukicompany.com:salesinvoices"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SalesInvoice>
    ${args.reference ? `<Reference>${x(args.reference)}</Reference>` : ''}
    <Subject>${x(args.subject)}</Subject>
    <PaymentMethod>${x(args.paymentMethod ?? 'ElectronicTransfer')}</PaymentMethod>
    <Process>${args.process ?? true}</Process>
    <EmailToCustomer>${args.emailToCustomer ?? false}</EmailToCustomer>
    <Date>${x(args.date)}</Date>
    <DueDate>${x(args.dueDate)}</DueDate>
    <Currency>${x(args.currency ?? 'EUR')}</Currency>
    ${args.remarks ? `<Remarks>${x(args.remarks)}</Remarks>` : ''}
    <Contact>
      ${contact.contactCode ? `<ContactCode>${x(contact.contactCode)}</ContactCode>` : ''}
      <FullName>${x(contact.fullName)}</FullName>
      ${contact.firstName ? `<FirstName>${x(contact.firstName)}</FirstName>` : ''}
      ${contact.lastName ? `<LastName>${x(contact.lastName)}</LastName>` : ''}
      ${contact.countryCode ? `<CountryCode>${x(contact.countryCode)}</CountryCode>` : ''}
      ${contact.city ? `<City>${x(contact.city)}</City>` : ''}
      ${contact.zipcode ? `<Zipcode>${x(contact.zipcode)}</Zipcode>` : ''}
      ${contact.addressLine1 ? `<AddressLine_1>${x(contact.addressLine1)}</AddressLine_1>` : ''}
      ${contact.addressLine2 ? `<AddressLine_2>${x(contact.addressLine2)}</AddressLine_2>` : ''}
      ${contact.emailAddress ? `<EmailAddress>${x(contact.emailAddress)}</EmailAddress>` : ''}
      ${contact.cocNumber ? `<CoCNumber>${x(contact.cocNumber)}</CoCNumber>` : ''}
      ${contact.vatNumber ? `<VATNumber>${x(contact.vatNumber)}</VATNumber>` : ''}
      ${contact.contactType ? `<ContactType>${x(contact.contactType)}</ContactType>` : ''}
    </Contact>
    <InvoiceLines>${linesXml}
    </InvoiceLines>
  </SalesInvoice>
</SalesInvoices>`;
}

/** Build the xmlDoc string for ProcessPurchaseInvoices. */
function buildPurchaseInvoiceXml(args: {
  reference?: string;
  date: string;
  dueDate?: string;
  invoiceAmount: number;
  invoiceVatAmount: number;
  contact: z.infer<typeof ContactSchema>;
  lines: Array<{
    description?: string;
    lineAmount: number;
    lineVatType?: number;
    lineVatPercentage?: number;
    glAccountCode?: string;
    vatDeductibilityPercentage?: number;
  }>;
  paymentMethod?: string;
  currency?: string;
  process?: boolean;
  documentFileName?: string;
  documentBase64?: string;
  remarks?: string;
}): string {
  const x = escapeXml;
  const { contact } = args;

  const linesXml = args.lines
    .map(
      (line) => `
      <InvoiceLine>
        ${line.description ? `<Description>${x(line.description)}</Description>` : ''}
        <LineAmount>${line.lineAmount}</LineAmount>
        <LineVATType>${line.lineVatType ?? 2}</LineVATType>
        ${line.lineVatPercentage !== undefined ? `<LineVATPercentage>${line.lineVatPercentage}</LineVATPercentage>` : ''}
        ${line.glAccountCode ? `<GLAccountCode>${x(line.glAccountCode)}</GLAccountCode>` : ''}
        ${line.vatDeductibilityPercentage !== undefined ? `<VATDeductibilityPercentage>${line.vatDeductibilityPercentage}</VATDeductibilityPercentage>` : ''}
      </InvoiceLine>`,
    )
    .join('');

  return `<PurchaseInvoices xmlns="urn:xmlns:http://www.theyukicompany.com:purchaseinvoices"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <PurchaseInvoice>
    <Process>${args.process ?? true}</Process>
    ${args.reference ? `<Reference>${x(args.reference)}</Reference>` : ''}
    <Date>${x(args.date)}</Date>
    ${args.dueDate ? `<DueDate>${x(args.dueDate)}</DueDate>` : ''}
    <InvoiceAmount>${args.invoiceAmount}</InvoiceAmount>
    <InvoiceVATAmount>${args.invoiceVatAmount}</InvoiceVATAmount>
    <Currency>${x(args.currency ?? 'EUR')}</Currency>
    <PaymentMethod>${x(args.paymentMethod ?? 'Transfer')}</PaymentMethod>
    ${args.remarks ? `<Remarks>${x(args.remarks)}</Remarks>` : ''}
    ${args.documentFileName ? `<DocumentFileName>${x(args.documentFileName)}</DocumentFileName>` : ''}
    ${args.documentBase64 ? `<DocumentBase64>${args.documentBase64}</DocumentBase64>` : ''}
    <Contact>
      ${contact.contactCode ? `<ContactCode>${x(contact.contactCode)}</ContactCode>` : ''}
      <FullName>${x(contact.fullName)}</FullName>
      ${contact.firstName ? `<FirstName>${x(contact.firstName)}</FirstName>` : ''}
      ${contact.lastName ? `<LastName>${x(contact.lastName)}</LastName>` : ''}
      ${contact.emailAddress ? `<EmailAddress>${x(contact.emailAddress)}</EmailAddress>` : ''}
      ${contact.countryCode ? `<CountryCode>${x(contact.countryCode)}</CountryCode>` : ''}
      ${contact.city ? `<City>${x(contact.city)}</City>` : ''}
      ${contact.zipcode ? `<Zipcode>${x(contact.zipcode)}</Zipcode>` : ''}
      ${contact.addressLine1 ? `<AddressLine_1>${x(contact.addressLine1)}</AddressLine_1>` : ''}
      ${contact.vatNumber ? `<VATNumber>${x(contact.vatNumber)}</VATNumber>` : ''}
      ${contact.cocNumber ? `<CoCNumber>${x(contact.cocNumber)}</CoCNumber>` : ''}
      ${contact.bankAccount ? `<BankAccount>${x(contact.bankAccount)}</BankAccount>` : ''}
      ${contact.bic ? `<BIC>${x(contact.bic)}</BIC>` : ''}
      ${contact.contactType ? `<ContactType>${x(contact.contactType)}</ContactType>` : ''}
    </Contact>
    <InvoiceLines>${linesXml}
    </InvoiceLines>
  </PurchaseInvoice>
</PurchaseInvoices>`;
}

/** Unwrap the parsed SOAP outstanding-items result into a flat array. */
function normalizeItems(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;

  const rec = result as Record<string, unknown>;

  // Common Yuki wrappers for outstanding items
  const wrappers = ['DebtorItems', 'CreditorItems', 'OutstandingItems', 'Items', 'Rows'];
  const itemTags = ['DebtorItem', 'CreditorItem', 'OutstandingItem', 'Item', 'Row'];

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
