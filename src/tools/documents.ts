import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import { YukiClient } from '../yuki-client.js';

/**
 * Register tools for uploading documents to the Yuki archive.
 *
 * The Yuki Archive service stores source documents (PDFs) alongside
 * their financial data. Attaching a PDF to a purchase invoice is
 * strongly recommended for audit compliance.
 *
 * Yuki service: Archive.asmx
 * Method:       UploadDocumentWithData(sessionID, fileName, data, folder,
 *                                      administrationID, currency, amount,
 *                                      costCategory, paymentMethod, project, remarks)
 *
 * Note: Archive.asmx uses sessionID / administrationID (uppercase D).
 */
export function registerDocumentTools(server: McpServer, client: YukiClient): void {
  /**
   * upload_document
   *
   * Upload a PDF (or other document) to the Yuki archive with optional
   * financial metadata. This is the recommended way to attach source
   * documents to purchase invoices in Yuki.
   *
   * Use this when:
   *   - A purchase invoice PDF needs to be stored in Yuki's archive
   *   - You want Yuki to process the document automatically (OCR)
   *   - Attaching supporting documents (receipts, bank statements) to bookings
   *
   * Folder IDs (use get_document_folders to retrieve the full list):
   *   - Common folders: purchase invoices, bank statements, general
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'upload_document',
    {
      description:
        'Upload a document (PDF) to the Yuki archive with financial metadata. ' +
        'Use this to attach source documents to purchase invoices or store receipts. ' +
        'The document must be provided as a base64-encoded string. ' +
        'Call get_document_folders first to find the correct folder ID.',
      inputSchema: {
        fileName: z.string().describe("File name including extension (e.g. 'invoice-2024-0042.pdf')"),
        dataBase64: z.string().describe('File content encoded as a base64 string'),
        folder: z
          .number()
          .int()
          .optional()
          .describe('Archive folder ID. Use get_document_folders to list available folders.'),
        currency: z.string().optional().default('EUR').describe('ISO 4217 currency code for the document amount'),
        amount: z.number().optional().describe('Total amount on the document (e.g. invoice total including VAT)'),
        costCategory: z.string().optional().describe("GL account code for automatic cost categorisation (e.g. '4000')"),
        paymentMethod: z
          .number()
          .int()
          .optional()
          .describe('Payment method code. 0 = unknown, 1 = transfer, 2 = direct collection'),
        project: z.string().optional().describe('Project code to link this document to a Yuki project'),
        remarks: z.string().optional().describe('Internal remarks shown in the archive'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({
      fileName,
      dataBase64,
      folder,
      currency,
      amount,
      costCategory,
      paymentMethod,
      project,
      remarks,
      administrationId,
    }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');
        }

        const sessionID = await client.getSessionID();

        // Archive.asmx uses sessionID / administrationID (uppercase D)
        const result = await client.callSoap({
          service: 'Archive.asmx',
          method: 'UploadDocumentWithData',
          params: {
            sessionID,
            fileName,
            data: dataBase64,
            ...(folder !== undefined && { folder }),
            administrationID: adminId,
            currency: currency ?? 'EUR',
            ...(amount !== undefined && { amount }),
            ...(costCategory !== undefined && { costCategory }),
            ...(paymentMethod !== undefined && { paymentMethod }),
            ...(project !== undefined && { project }),
            ...(remarks !== undefined && { remarks }),
          },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, fileName, result }, null, 2),
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
   * upload_document_from_path
   *
   * Upload a PDF from the local filesystem to the Yuki archive.
   * Reads the file at filePath, converts it to base64 internally, and
   * calls UploadDocumentWithData — avoiding the need to pass large base64
   * strings through the MCP context.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'upload_document_from_path',
    {
      description:
        'Upload a PDF from a local file path to the Yuki archive. ' +
        'Reads and encodes the file internally — no need to pass base64 strings. ' +
        'Use this instead of upload_document when the file is available on disk. ' +
        'Call get_document_folders first to find the correct folder ID.',
      inputSchema: {
        filePath: z
          .string()
          .describe("Absolute path to the file on the local filesystem (e.g. '/tmp/invoice-2024-0042.pdf')"),
        fileName: z
          .string()
          .optional()
          .describe('Override the file name sent to Yuki. Defaults to the basename of filePath.'),
        folder: z
          .number()
          .int()
          .optional()
          .describe('Archive folder ID. Use get_document_folders to list available folders.'),
        currency: z.string().optional().default('EUR').describe('ISO 4217 currency code for the document amount'),
        amount: z.number().optional().describe('Total amount on the document (e.g. invoice total including VAT)'),
        costCategory: z.string().optional().describe("GL account code for automatic cost categorisation (e.g. '4000')"),
        paymentMethod: z
          .number()
          .int()
          .optional()
          .describe('Payment method code. 0 = unknown, 1 = transfer, 2 = direct collection'),
        project: z.string().optional().describe('Project code to link this document to a Yuki project'),
        remarks: z.string().optional().describe('Internal remarks shown in the archive'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({
      filePath,
      fileName,
      folder,
      currency,
      amount,
      costCategory,
      paymentMethod,
      project,
      remarks,
      administrationId,
    }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');
        }

        // Validate file existence before making any API calls
        if (!existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        let fileBuffer: Buffer;
        try {
          fileBuffer = readFileSync(filePath);
        } catch (readErr) {
          throw new Error(
            `Cannot read file at ${filePath}: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
          );
        }

        // Check for PDF magic bytes (%PDF)
        if (
          fileBuffer.length < 4 ||
          fileBuffer[0] !== 0x25 || // %
          fileBuffer[1] !== 0x50 || // P
          fileBuffer[2] !== 0x44 || // D
          fileBuffer[3] !== 0x46 // F
        ) {
          throw new Error(`File does not appear to be a PDF (missing %PDF header): ${filePath}`);
        }

        const resolvedFileName = fileName ?? basename(filePath);
        const dataBase64 = fileBuffer.toString('base64');

        const sessionID = await client.getSessionID();

        const result = await client.callSoap({
          service: 'Archive.asmx',
          method: 'UploadDocumentWithData',
          params: {
            sessionID,
            fileName: resolvedFileName,
            data: dataBase64,
            ...(folder !== undefined && { folder }),
            administrationID: adminId,
            currency: currency ?? 'EUR',
            ...(amount !== undefined && { amount }),
            ...(costCategory !== undefined && { costCategory }),
            ...(paymentMethod !== undefined && { paymentMethod }),
            ...(project !== undefined && { project }),
            ...(remarks !== undefined && { remarks }),
          },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { success: true, filePath, fileName: resolvedFileName, fileSizeBytes: fileBuffer.length, result },
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

  // ── list_documents ──────────────────────────────────────────────────────────

  /**
   * list_documents
   *
   * List documents stored in a specific archive folder.
   * Session-scoped: no administrationID needed (determined by the API key / domain).
   *
   * WSDL signature (Archive.asmx · DocumentsInFolder):
   *   sessionID, folderID, sortOrder, startDate, endDate, numberOfRecords, startRecord
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'list_documents',
    {
      description:
        'List documents in a Yuki archive folder. ' +
        'Returns document IDs, file names, dates, and amounts. ' +
        'Call get_document_folders first to find the correct folder ID. ' +
        'Use the returned document ID with get_document or download_document.',
      inputSchema: {
        folderId: z
          .number()
          .int()
          .describe('Archive folder ID. Use get_document_folders to list available folders.'),
        sortOrder: z
          .enum(['DocumentDateDesc', 'DocumentDateAsc', 'CreatedDesc', 'CreatedAsc', 'ModifiedDesc', 'ModifiedAsc', 'ContactNameAsc', 'ContactNameDesc'])
          .optional()
          .default('DocumentDateDesc')
          .describe('Sort order for results.'),
        startDate: z
          .string()
          .optional()
          .describe('Filter documents from this date (YYYY-MM-DD). Defaults to 2000-01-01.'),
        endDate: z
          .string()
          .optional()
          .describe('Filter documents up to this date (YYYY-MM-DD). Defaults to today.'),
        numberOfRecords: z
          .number()
          .int()
          .optional()
          .default(50)
          .describe('Maximum number of records to return (default 50).'),
        startRecord: z
          .number()
          .int()
          .optional()
          .default(1)
          .describe('1-based offset for pagination (default 1).'),
      },
    },
    async ({ folderId, sortOrder, startDate, endDate, numberOfRecords, startRecord }) => {
      try {
        const sessionID = await client.getSessionID();
        const start = startDate ? `${startDate}T00:00:00` : '0001-01-01T00:00:00';
        const end   = endDate   ? `${endDate}T23:59:59`   : `${new Date().toISOString().split('T')[0]}T23:59:59`;

        const result = await client.callSoap({
          service: 'Archive.asmx',
          method: 'DocumentsInFolder',
          params: {
            sessionID,
            folderID:        folderId,
            sortOrder:       sortOrder ?? 'DocumentDateDesc',
            startDate:       start,
            endDate:         end,
            numberOfRecords: numberOfRecords ?? 50,
            startRecord:     startRecord ?? 1,
          },
        });

        const documents = normalizeDocuments(result);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, folderId, count: documents.length, documents }, null, 2),
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

  // ── search_documents ────────────────────────────────────────────────────────

  /**
   * search_documents
   *
   * Search archived documents by text within a specific folder (and optionally tab).
   * Session-scoped: no administrationID needed.
   *
   * WSDL signature (Archive.asmx · SearchDocuments):
   *   sessionID, searchOption, searchText, folderID, tabID,
   *   sortOrder, startDate, endDate, numberOfRecords, startRecord
   *
   * SearchOption values: All, Creator, Contact, Subject, Tag, Type
   * tabID: obtain valid IDs via get_document_folders (tab IDs are folder-specific).
   *        Pass 0 to search all tabs within the folder.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'search_documents',
    {
      description:
        'Search for documents in a Yuki archive folder by text. ' +
        'Call get_document_folders first to find the folderID. ' +
        'searchOption filters which field to match: All (default), Contact, Subject, Tag, Creator, or Type. ' +
        'tabID scopes the search to a folder tab — use 0 to search all tabs.',
      inputSchema: {
        searchText: z
          .string()
          .describe('Text to search for (e.g. supplier name, invoice number, subject).'),
        folderId: z
          .number()
          .int()
          .optional()
          .default(-1)
          .describe('Archive folder ID to search within. Use -1 to search all folders (default). Use get_document_folders to find specific folder IDs.'),
        tabId: z
          .number()
          .int()
          .optional()
          .default(-1)
          .describe('Tab ID within the folder. Use -1 to search all tabs (default).'),
        searchOption: z
          .enum(['All', 'Creator', 'Contact', 'Subject', 'Tag', 'Type'])
          .optional()
          .default('All')
          .describe("Field to search in. 'All' searches across all fields (default)."),
        sortOrder: z
          .enum(['DocumentDateDesc', 'DocumentDateAsc', 'CreatedDesc', 'CreatedAsc', 'ModifiedDesc', 'ModifiedAsc', 'ContactNameAsc', 'ContactNameDesc'])
          .optional()
          .default('DocumentDateDesc')
          .describe('Sort order for results.'),
        startDate: z
          .string()
          .optional()
          .describe('Filter documents from this date (YYYY-MM-DD). Defaults to 2000-01-01.'),
        endDate: z
          .string()
          .optional()
          .describe('Filter documents up to this date (YYYY-MM-DD). Defaults to today.'),
        numberOfRecords: z
          .number()
          .int()
          .optional()
          .default(50)
          .describe('Maximum number of records to return (default 50).'),
        startRecord: z
          .number()
          .int()
          .optional()
          .default(1)
          .describe('1-based offset for pagination (default 1).'),
      },
    },
    async ({ searchText, folderId, tabId, searchOption, sortOrder, startDate, endDate, numberOfRecords, startRecord }) => {
      try {
        const sessionID = await client.getSessionID();
        // Use '0001-01-01' as Yuki's sentinel for "all dates" (no date filter).
        // Use -1 for folderID/tabID to search across all folders/tabs.
        const start = startDate ? `${startDate}T00:00:00` : '0001-01-01T00:00:00';
        const end   = endDate   ? `${endDate}T23:59:59`   : `${new Date().toISOString().split('T')[0]}T23:59:59`;

        const result = await client.callSoap({
          service: 'Archive.asmx',
          method: 'SearchDocuments',
          params: {
            sessionID,
            searchOption:    searchOption ?? 'All',
            searchText,
            folderID:        folderId ?? -1,
            tabID:           tabId ?? -1,
            sortOrder:       sortOrder ?? 'DocumentDateDesc',
            startDate:       start,
            endDate:         end,
            numberOfRecords: numberOfRecords ?? 50,
            startRecord:     startRecord ?? 1,
          },
        });

        const documents = normalizeDocuments(result);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { success: true, searchText, folderId, count: documents.length, documents },
                null,
                2,
              ),
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

  // ── get_document ────────────────────────────────────────────────────────────

  /**
   * get_document
   *
   * Retrieve metadata for a single archived document by its ID.
   * Returns file name, folder, date, amount, status, and other metadata.
   *
   * Use list_documents or search_documents to find document IDs.
   * To download the actual file content, use download_document.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_document',
    {
      description:
        'Retrieve metadata for a single archived document by its Yuki document ID. ' +
        'Returns file name, folder, date, amount, and status. ' +
        'Use list_documents or search_documents to find document IDs. ' +
        'To download the file binary use download_document.',
      inputSchema: {
        documentId: z.string().describe('Yuki document ID (GUID or integer, from list_documents or search_documents).'),
        administrationId: z
          .string()
          .optional()
          .describe('Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var.'),
      },
    },
    async ({ documentId, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) throw new Error('administrationId is required (or set YUKI_DOMAIN_ID env var)');

        const sessionID = await client.getSessionID();

        const result = await client.callSoap({
          service: 'Archive.asmx',
          method: 'FindDocument',
          params: { sessionID, administrationID: adminId, documentID: documentId },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, documentId, result }, null, 2),
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

  // ── download_document ───────────────────────────────────────────────────────

  /**
   * download_document
   *
   * Download the binary content of an archived document, returned as a
   * base64-encoded string. The caller can decode and save the file.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'download_document',
    {
      description:
        'Download an archived document from Yuki as a base64-encoded string. ' +
        'Use list_documents or search_documents to find the document ID first. ' +
        'Returns fileName and fileDataBase64.',
      inputSchema: {
        documentId: z.string().describe('Yuki document ID (from list_documents or search_documents).'),
      },
    },
    async ({ documentId }) => {
      try {
        const sessionID = await client.getSessionID();

        // DocumentBinaryData does not take administrationID
        const result = await client.callSoap({
          service: 'Archive.asmx',
          method: 'DocumentBinaryData',
          params: { sessionID, documentID: documentId },
        });

        const doc = result as Record<string, unknown>;
        const fileName = doc['fileName'] ?? doc['FileName'] ?? null;
        const fileData = doc['fileData'] ?? doc['filedata'] ?? doc['FileData'] ?? result;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, documentId, fileName, fileDataBase64: fileData }, null, 2),
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

  // ── get_cost_categories ──────────────────────────────────────────────────────

  /**
   * get_cost_categories
   *
   * Retrieve the available cost categories (kostenrekeningen) for document
   * uploads. These are the GL account codes that can be passed as
   * `costCategory` when calling upload_document or upload_document_from_path.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_cost_categories',
    {
      description:
        'List available cost categories (GL cost accounts) for document uploads. ' +
        'Use the returned GL codes as the costCategory parameter in upload_document.',
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

        const sessionID = await client.getSessionID();

        const result = await client.callSoap({
          service: 'Archive.asmx',
          method: 'CostCategories',
          params: { sessionID, administrationID: adminId },
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
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  /**
   * get_document_folders
   *
   * List all archive folders available in this Yuki administration.
   * Use this to find the correct folder ID before calling upload_document.
   *
   * Rate cost: 1 request.
   */
  server.registerTool(
    'get_document_folders',
    {
      description:
        'List all archive folders in the Yuki administration. ' +
        'Use this to find the correct folder ID to pass to upload_document.',
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

        const sessionID = await client.getSessionID();

        const result = await client.callSoap({
          service: 'Archive.asmx',
          method: 'DocumentFolders',
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

/** Unwrap a parsed SOAP documents result into a flat array. */
function normalizeDocuments(result: unknown): unknown[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;

  const rec = result as Record<string, unknown>;
  const wrappers = ['Documents', 'SearchResults', 'Rows'];
  const itemTags = ['Document', 'SearchResult', 'Row'];

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
