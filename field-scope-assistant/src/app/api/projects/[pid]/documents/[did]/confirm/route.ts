import { route } from "@/lib/http";
import { confirmReport } from "@/lib/report/service";

type P = { pid: string; did: string };
// "Wrong report?" → the PM confirms it is still this job's report.
export const POST = route<P>(async (_req, { pid, did }) => ({ document: await confirmReport(pid, did) }));
