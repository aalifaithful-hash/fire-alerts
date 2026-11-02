import { route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { ingestManual, UserError } from "@/lib/service";

export const maxDuration = 300;
export const GET = route(async () => ({ manuals: await repo.listManuals(), conflicts: await repo.listConflicts() }));
export const POST = route(async (req) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw new UserError("Choose a manual (PDF or .txt).");
  await ingestManual({ name: file.name || "manual", bytes: new Uint8Array(await file.arrayBuffer()) });
  return { manuals: await repo.listManuals(), conflicts: await repo.listConflicts() };
});
