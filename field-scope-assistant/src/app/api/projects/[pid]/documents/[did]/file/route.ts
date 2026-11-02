import { readFileSync } from "node:fs";
import { route } from "@/lib/http";
import * as repo from "@/lib/repo";

type P = { pid: string; did: string };
// Served only through this authenticated route — uploads are never in /public.
export const GET = route<P>(async (_req, { pid, did }) => {
  const d = repo.getDocument(pid, did);
  return new Response(new Uint8Array(readFileSync(d.storedPath)), {
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="document.pdf"`,
      "X-Robots-Tag": "noindex",
    },
  });
});
