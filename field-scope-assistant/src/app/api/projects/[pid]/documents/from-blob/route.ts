import { body, route } from "@/lib/http";
import { ingestPdf, UserError } from "@/lib/service";
import { blobEnabled, blobStoredPath, checkUploadedBlob, projectKey, readStoredFile } from "@/lib/storage";

type P = { pid: string };
export const maxDuration = 300;

/**
 * Step 2 of a direct-to-Blob upload: the browser reports the blob it just
 * uploaded; the server reads it from the private store and ingests it exactly
 * like a regular upload (text extraction + page batches).
 */
export const POST = route<P>(async (req, { pid }) => {
  if (!blobEnabled()) throw new UserError("Direct uploads are not configured.");
  const b = await body<{ url?: string; pathname?: string; filename?: string }>(req);
  let url: string;
  try {
    // Only blobs inside this project's folder can be attached to this project.
    url = checkUploadedBlob(b, projectKey(pid, ""));
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const stored = blobStoredPath(url);
  const bytes = await readStoredFile(stored);
  const name = String(b.filename || "report.pdf").slice(0, 200);
  return { document: await ingestPdf(pid, { name, bytes, blobUrl: url }) };
});
