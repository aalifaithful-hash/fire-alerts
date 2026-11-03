import { body, route } from "@/lib/http";
import { openProjectForAssignment } from "@/lib/intake";

// Create (or reuse) the project for this assignment and start its visit.
export const POST = route<{ aid: string }>(async (req, { aid }) => {
  const b = await body<{ projectId?: string | null }>(req).catch(() => ({}) as { projectId?: string | null });
  return openProjectForAssignment(aid, { projectId: b.projectId ?? null });
});
