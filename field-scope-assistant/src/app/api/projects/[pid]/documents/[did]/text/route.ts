import { route } from "@/lib/http";
import * as repo from "@/lib/repo";

type P = { pid: string; did: string };
// Selectable text extracted from each page at upload (no AI involved).
export const GET = route<P>(async (_req, { pid, did }) => {
  const d = await repo.getDocument(pid, did); // project-scoped check
  const pages = await repo.getPages(d.id);
  return { filename: d.filename, pages: pages.map((p) => ({ page: p.page, text: p.text })) };
});
