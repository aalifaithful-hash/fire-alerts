import { body, route } from "@/lib/http";
import { deleteRoomScan, saveRoomScan } from "@/lib/scans";

type P = { pid: string; vid: string; lid: string };
// Save one room's scan; the whole visit is re-analyzed (runs cross rooms).
export const PUT = route<P>(async (req, { pid, vid, lid }) => saveRoomScan(pid, vid, lid, (await body<{ data: unknown }>(req)).data));
export const DELETE = route<P>(async (_req, { pid, vid, lid }) => deleteRoomScan(pid, vid, lid));
