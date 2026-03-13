import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { basename } from "path";
import { YukiClient } from "../yuki-client.js";

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
export function registerDocumentTools(
  server: McpServer,
  client: YukiClient
): void {
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
    "upload_document",
    {
      description:
        "Upload a document (PDF) to the Yuki archive with financial metadata. " +
        "Use this to attach source documents to purchase invoices or store receipts. " +
        "The document must be provided as a base64-encoded string. " +
        "Call get_document_folders first to find the correct folder ID.",
      inputSchema: {
        fileName: z.string()
          .describe("File name including extension (e.g. 'invoice-2024-0042.pdf')"),
        dataBase64: z.string()
          .describe("File content encoded as a base64 string"),
        folder: z.number().int().optional()
          .describe("Archive folder ID. Use get_document_folders to list available folders."),
        currency: z.string().optional().default("EUR")
          .describe("ISO 4217 currency code for the document amount"),
        amount: z.number().optional()
          .describe("Total amount on the document (e.g. invoice total including VAT)"),
        costCategory: z.string().optional()
          .describe("GL account code for automatic cost categorisation (e.g. '4000')"),
        paymentMethod: z.number().int().optional()
          .describe("Payment method code. 0 = unknown, 1 = transfer, 2 = direct collection"),
        project: z.string().optional()
          .describe("Project code to link this document to a Yuki project"),
        remarks: z.string().optional()
          .describe("Internal remarks shown in the archive"),
        administrationId: z.string().optional()
          .describe("Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var."),
      },
    },
    async ({ fileName, dataBase64, folder, currency, amount, costCategory,
             paymentMethod, project, remarks, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error(
            "administrationId is required (or set YUKI_DOMAIN_ID env var)"
          );
        }

        const sessionID = await client.getSessionID();

        // Archive.asmx uses sessionID / administrationID (uppercase D)
        const result = await client.callSoap({
          service: "Archive.asmx",
          method: "UploadDocumentWithData",
          params: {
            sessionID,
            fileName,
            data: dataBase64,
            ...(folder !== undefined && { folder }),
            administrationID: adminId,
            currency: currency ?? "EUR",
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
              type: "text" as const,
              text: JSON.stringify(
                { success: true, fileName, result },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
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
    "upload_document_from_path",
    {
      description:
        "Upload a PDF from a local file path to the Yuki archive. " +
        "Reads and encodes the file internally — no need to pass base64 strings. " +
        "Use this instead of upload_document when the file is available on disk. " +
        "Call get_document_folders first to find the correct folder ID.",
      inputSchema: {
        filePath: z.string()
          .describe("Absolute path to the file on the local filesystem (e.g. '/tmp/invoice-2024-0042.pdf')"),
        fileName: z.string().optional()
          .describe("Override the file name sent to Yuki. Defaults to the basename of filePath."),
        folder: z.number().int().optional()
          .describe("Archive folder ID. Use get_document_folders to list available folders."),
        currency: z.string().optional().default("EUR")
          .describe("ISO 4217 currency code for the document amount"),
        amount: z.number().optional()
          .describe("Total amount on the document (e.g. invoice total including VAT)"),
        costCategory: z.string().optional()
          .describe("GL account code for automatic cost categorisation (e.g. '4000')"),
        paymentMethod: z.number().int().optional()
          .describe("Payment method code. 0 = unknown, 1 = transfer, 2 = direct collection"),
        project: z.string().optional()
          .describe("Project code to link this document to a Yuki project"),
        remarks: z.string().optional()
          .describe("Internal remarks shown in the archive"),
        administrationId: z.string().optional()
          .describe("Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var."),
      },
    },
    async ({ filePath, fileName, folder, currency, amount, costCategory,
             paymentMethod, project, remarks, administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error(
            "administrationId is required (or set YUKI_DOMAIN_ID env var)"
          );
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
            `Cannot read file at ${filePath}: ${readErr instanceof Error ? readErr.message : String(readErr)}`
          );
        }

        // Check for PDF magic bytes (%PDF)
        if (
          fileBuffer.length < 4 ||
          fileBuffer[0] !== 0x25 || // %
          fileBuffer[1] !== 0x50 || // P
          fileBuffer[2] !== 0x44 || // D
          fileBuffer[3] !== 0x46    // F
        ) {
          throw new Error(
            `File does not appear to be a PDF (missing %PDF header): ${filePath}`
          );
        }

        const resolvedFileName = fileName ?? basename(filePath);
        const dataBase64 = fileBuffer.toString("base64");

        const sessionID = await client.getSessionID();

        const result = await client.callSoap({
          service: "Archive.asmx",
          method: "UploadDocumentWithData",
          params: {
            sessionID,
            fileName: resolvedFileName,
            data: dataBase64,
            ...(folder !== undefined && { folder }),
            administrationID: adminId,
            currency: currency ?? "EUR",
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
              type: "text" as const,
              text: JSON.stringify(
                { success: true, filePath, fileName: resolvedFileName,
                  fileSizeBytes: fileBuffer.length, result },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
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
    "get_document_folders",
    {
      description:
        "List all archive folders in the Yuki administration. " +
        "Use this to find the correct folder ID to pass to upload_document.",
      inputSchema: {
        administrationId: z.string().optional()
          .describe("Administration ID (GUID). Defaults to YUKI_DOMAIN_ID env var."),
      },
    },
    async ({ administrationId }) => {
      try {
        const adminId = administrationId ?? client.defaultDomainId;
        if (!adminId) {
          throw new Error(
            "administrationId is required (or set YUKI_DOMAIN_ID env var)"
          );
        }

        const sessionID = await client.getSessionID();

        const result = await client.callSoap({
          service: "Archive.asmx",
          method: "DocumentFolders",
          params: {
            sessionID,
            administrationID: adminId,
          },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, result }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
