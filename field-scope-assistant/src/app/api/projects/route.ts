import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { UserError } from "@/lib/service";

export const GET = route(async (req) => ({ projects: repo.listProjects(req.nextUrl.searchParams.get("q") ?? undefined) }));
export const POST = route(async (req) => {
  const b = await body(req);
  if (!String(b.address ?? "").trim() && !String(b.name ?? "").trim()) throw new UserError("Enter a property address.");
  return { project: repo.createProject(b) };
});
