import { PDFDocument } from "pdf-lib";

export const PAGES_PER_BATCH = 4;
/** Keep each request well under the API's 32 MB limit (base64 inflates ~33%). */
export const MAX_CHUNK_BYTES = 18 * 1024 * 1024;
/** Pages with fewer non-space characters than this are treated as scanned (needs OCR). */
export const SCANNED_THRESHOLD = 25;

export async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((t) => (t ?? "").replace(/\u0000/g, "").trim());
}

export function planBatches(pageCount: number, size = PAGES_PER_BATCH): [number, number][] {
  const out: [number, number][] = [];
  for (let p = 1; p <= pageCount; p += size) out.push([p, Math.min(pageCount, p + size - 1)]);
  return out;
}

/** Copies original pages [from, to] (1-based, inclusive) into a standalone PDF. */
export async function buildChunk(source: Uint8Array, from: number, to: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(source, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const indices = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i).filter((i) => i < src.getPageCount());
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}
