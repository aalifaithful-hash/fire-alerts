import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { VISIT_TYPES, type VisitType } from "@/lib/schemas";
import { todayNY } from "@/lib/time";
import { UserError } from "@/lib/service";
import { SERVICE_LINES, VISIT_STAGES, type ServiceLine, type VisitStage } from "@/lib/fnol";

type P = { pid: string };
export const POST = route<P>(async (req, { pid }) => {
  const b = await body<{ type?: string; visitDate?: string; appointmentTime?: string; stage?: string | null; serviceLine?: string | null }>(req);
  if (!VISIT_TYPES.includes(b.type as VisitType)) throw new UserError("Choose a visit type.");
  const date = b.visitDate && /^\d{4}-\d{2}-\d{2}$/.test(b.visitDate) ? b.visitDate : todayNY();
  const stage = (VISIT_STAGES as readonly string[]).includes(b.stage ?? "") ? (b.stage as VisitStage) : null;
  const serviceLine = (SERVICE_LINES as readonly string[]).includes(b.serviceLine ?? "") ? (b.serviceLine as ServiceLine) : null;
  return { visit: await repo.createVisit(pid, { type: b.type as VisitType, visitDate: date, appointmentTime: b.appointmentTime || null, stage, serviceLine }) };
});
