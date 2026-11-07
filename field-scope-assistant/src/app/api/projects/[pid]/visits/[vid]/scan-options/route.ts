import { body, route } from "@/lib/http";
import { setScanOptions } from "@/lib/scans";

type P = { pid: string; vid: string };
// Exclusions (customer preferences), the reconstruction-estimate switch and the crew (CC + subs).
export const PUT = route<P>(async (req, { pid, vid }) => setScanOptions(pid, vid, await body<{ exclusions?: unknown[]; reconstructionRequested?: boolean; crew?: { crewChiefs: number | null; subcontractors: number | null; trades?: string[] } | null }>(req)));
