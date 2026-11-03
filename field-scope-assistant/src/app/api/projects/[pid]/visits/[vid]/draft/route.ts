import { route } from "@/lib/http";
import { startManualDraft } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string };
// Start a draft by hand (no AI needed).
export const POST = route<P>(async (_req, { pid, vid }) => {
  await startManualDraft(pid, vid);
  return visitPayload(pid, vid);
});
