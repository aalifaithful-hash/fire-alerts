import { body, route } from "@/lib/http";
import { addAssignmentNote } from "@/lib/intake";

export const POST = route<{ aid: string }>(async (req, { aid }) => {
  const { text } = await body<{ text?: string }>(req);
  return { assignment: await addAssignmentNote(aid, String(text ?? "")) };
});
