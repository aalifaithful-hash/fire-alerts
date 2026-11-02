import { body, route } from "@/lib/http";
import * as repo from "@/lib/repo";
import { VISIT_TYPES, type VisitType } from "@/lib/schemas";
import { todayNY } from "@/lib/time";
import { UserError } from "@/lib/service";

type P = { pid: string };
export const POST = route<P>(async (req, { pid }) => {
  const b = await body<{ type?: string; visitDate?: string; appointmentTime?: string }>(req);
  if (!VISIT_TYPES.includes(b.type as VisitType)) throw new UserError("Choose a visit type.");
  const date = b.visitDate && /^\d{4}-\d{2}-\d{2}$/.test(b.visitDate) ? b.visitDate : todayNY();
  return { visit: repo.createVisit(pid, { type: b.type as VisitType, visitDate: date, appointmentTime: b.appointmentTime || null }) };
});
