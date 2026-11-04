import { route } from "@/lib/http";
import { reportView } from "@/lib/report/service";

type P = { pid: string; vid: string };
// Mold report(s) for this project, the rules analyzer's findings, and what they would change in this visit's scan.
export const GET = route<P>(async (_req, { pid, vid }) => reportView(pid, vid));
