import { body, route } from "@/lib/http";
import { processNextBatch } from "@/lib/service";

type P = { pid: string; did: string };
export const maxDuration = 300;
export const POST = route<P>(async (req, { pid, did }) => {
  const b = await body<{ retryFailed?: boolean }>(req).catch(() => ({}) as { retryFailed?: boolean });
  return processNextBatch(pid, did, !!b.retryFailed);
});
