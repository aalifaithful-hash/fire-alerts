import { route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { readStoredFile } from "@/lib/storage";

type P = { pid: string; did: string };
// Served only through this authenticated route. The Blob store is private, so
// there is no public URL for customer documents.
export const GET = route<P>(async (_req, { pid, did }) => {
  const d = await repo.getDocument(pid, did);
  const bytes = await readStoredFile(d.storedPath);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'inline; filename="document.pdf"',
      "X-Robots-Tag": "noindex",
    },
  });
});
