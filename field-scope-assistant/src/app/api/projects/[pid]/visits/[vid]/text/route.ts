import { body, route } from "@/lib/http";
import { setManualText } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string };
export const PUT = route<P>(async (req, { pid, vid }) => {
  const { text } = await body<{ text: string | null }>(req);
  setManualText(pid, vid, text);
  return visitPayload(pid, vid);
});
