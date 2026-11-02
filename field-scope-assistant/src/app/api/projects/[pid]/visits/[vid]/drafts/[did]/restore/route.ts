import { route } from "@/lib/http";
import { restoreDraft } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string; did: string };
export const POST = route<P>(async (_req, { pid, vid, did }) => {
  restoreDraft(pid, vid, did);
  return visitPayload(pid, vid);
});
