import { route } from "@/lib/http";
import { getVisitScans } from "@/lib/scans";

type P = { pid: string; vid: string };
export const GET = route<P>(async (_req, { pid, vid }) => getVisitScans(pid, vid));
