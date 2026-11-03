import { body, route } from "@/lib/http";
import { setAssignmentStatus, type Assignment } from "@/lib/intake";

export const POST = route<{ aid: string }>(async (req, { aid }) => {
  const { status } = await body<{ status: Assignment["status"] }>(req);
  return { assignment: await setAssignmentStatus(aid, status) };
});
