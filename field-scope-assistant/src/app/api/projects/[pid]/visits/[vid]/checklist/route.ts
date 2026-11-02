import { body, route } from "@/lib/http";
import { runChecklist } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string };
export const maxDuration = 300;
export const POST = route<P>(async (req, { pid, vid }) => {
  const { templateId } = await body<{ templateId: string }>(req);
  await runChecklist(pid, vid, templateId);
  return visitPayload(pid, vid);
});
