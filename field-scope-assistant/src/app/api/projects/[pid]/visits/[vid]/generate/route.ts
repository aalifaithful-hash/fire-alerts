import { route } from "@/lib/http";
import { generateVisit } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string };
export const maxDuration = 300;
export const POST = route<P>(async (_req, { pid, vid }) => {
  await generateVisit(pid, vid);
  return visitPayload(pid, vid);
});
