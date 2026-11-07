import { body, route } from "@/lib/http";
import { decideRecommendation } from "@/lib/service";
import { visitPayload } from "@/lib/payload";

type P = { pid: string; vid: string; rid: string };
export const POST = route<P>(async (req, { pid, vid, rid }) => {
  const b = await body<{ action: "accept" | "reject"; text?: string }>(req);
  await decideRecommendation(pid, vid, rid, b.action === "accept" ? "accept" : "reject", b.text);
  return visitPayload(pid, vid);
});
