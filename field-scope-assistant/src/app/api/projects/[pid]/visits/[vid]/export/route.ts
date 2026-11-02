import { route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { checklistDoc, UserError } from "@/lib/service";
import { docLines, textLines, toDocx, toPdf } from "@/lib/export";
import { docToText } from "@/lib/render";
import { VISIT_TYPE_LABELS } from "@/lib/schemas";

type P = { pid: string; vid: string };
export const GET = route<P>(async (req, { pid, vid }) => {
  const format = req.nextUrl.searchParams.get("format") ?? "pdf";
  const wantChecklist = req.nextUrl.searchParams.get("checklist") === "1";
  const visit = await repo.getVisit(pid, vid);
  const project = await repo.getProject(pid);
  const cl = wantChecklist ? await checklistDoc(pid, visit) : null;
  if (wantChecklist && !cl) throw new UserError("No checklist information for this visit yet.");
  if (!cl && !visit.doc && !visit.manualText) throw new UserError("Generate a draft first.");
  const lines = cl ? docLines(cl.doc) : visit.manualText ? textLines(visit.manualText) : docLines(visit.doc!);
  const base = `${(project.address || project.name).replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}-${VISIT_TYPE_LABELS[visit.type].replace(/[^a-z0-9]+/gi, "-")}${cl ? "-checklist" : ""}-${visit.visitDate}`;
  const headers = (type: string, ext: string) => ({
    "Content-Type": type,
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${base}.${ext}"`,
  });
  if (format === "docx") return new Response(new Uint8Array(await toDocx(lines)), { headers: headers("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx") });
  if (format === "txt") {
    const text = cl ? cl.text : visit.manualText ?? docToText(visit.doc!);
    return new Response(text, { headers: headers("text/plain; charset=utf-8", "txt") });
  }
  return new Response(new Uint8Array(await toPdf(lines)), { headers: headers("application/pdf", "pdf") });
});
