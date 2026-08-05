declare module 'pdf-parse/lib/pdf-parse.js' {
  type PdfResult = { numpages: number; text: string; info?: Record<string, unknown>; metadata?: unknown };
  export default function pdfParse(buffer: Buffer | Uint8Array): Promise<PdfResult>;
}
