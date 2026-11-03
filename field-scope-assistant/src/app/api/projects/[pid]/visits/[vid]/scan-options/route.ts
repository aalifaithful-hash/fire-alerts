import { body, route } from "@/lib/http";
import { setScanOptions } from "@/lib/scans";

type P = { pid: string; vid: string };
// Exclusions (customer preferences) and the reconstruction-estimate switch.
export const PUT = route<P>(async (req, { pid, vid }) => setScanOptions(pid, vid, await body<{ exclusions?: unknown[]; reconstructionRequested?: boolean }>(req)));
