import { route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { extractManualRules } from "@/lib/service";

type P = { mid: string };
export const maxDuration = 300;
export const DELETE = route<P>(async (_req, { mid }) => {
  await repo.deleteManual(mid);
  return { ok: true };
});
export const POST = route<P>(async (_req, { mid }) => {
  await extractManualRules(mid);
  return { manuals: await repo.listManuals(), conflicts: await repo.listConflicts() };
});
