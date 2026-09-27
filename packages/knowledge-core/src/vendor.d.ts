declare module 'pdf-parse/lib/pdf-parse.js' {
  type PdfResult = { numpages: number; text: string; info?: Record<string, unknown>; metadata?: unknown };
  type PdfPageData = {
    getTextContent(options?: Record<string, unknown>): Promise<{
      items: Array<{ str?: unknown; transform?: number[] }>;
    }>;
  };
  type PdfOptions = {
    pagerender?: (page: PdfPageData) => Promise<string>;
    max?: number;
    version?: string;
  };
  export default function pdfParse(buffer: Buffer | Uint8Array, options?: PdfOptions): Promise<PdfResult>;
}
