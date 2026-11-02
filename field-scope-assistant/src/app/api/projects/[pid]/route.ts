import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { workspacePayload } from "@/lib/payload";

type P = { pid: string };
export const GET = route<P>(async (_req, { pid }) => workspacePayload(pid));
export const PATCH = route<P>(async (req, { pid }) => ({ project: repo.updateProject(pid, await body(req)) }));
export const DELETE = route<P>(async (_req, { pid }) => {
  repo.deleteProject(pid);
  return { ok: true };
});
