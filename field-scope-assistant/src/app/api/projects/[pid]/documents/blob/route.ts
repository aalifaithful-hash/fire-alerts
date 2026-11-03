import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import { route } from "@/lib/http";
import { blobEnabled, projectKey } from "@/lib/storage";
import { MAX_UPLOAD_BYTES, UserError } from "@/lib/service";

type P = { pid: string };

/**
 * Step 1 of a direct-to-Blob upload: issues a short-lived client token so the
 * browser can PUT the PDF straight into the private "field-scope-uploads"
 * store, bypassing the ~4.5 MB serverless request-body limit.
 *
 * Passcode-protected like every API route. No onUploadCompleted webhook is
 * registered: that callback comes from Vercel's servers without the passcode
 * cookie (and is blocked by deployment protection), so instead the browser
 * calls POST /documents/from-blob (step 2) after upload() resolves.
 */
export const POST = route<P>(async (req, { pid }) => {
  if (!blobEnabled()) throw new UserError("Direct uploads are not configured (BLOB_READ_WRITE_TOKEN is missing).");
  await repo.getProject(pid);
  const body = (await req.json()) as HandleUploadBody;
  const prefix = projectKey(pid, "");
  const jsonResponse = await handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async (pathname) => {
      // A token can only write inside this project's folder.
      if (!pathname.startsWith(prefix) || pathname.includes("..") || !/\.pdf$/i.test(pathname))
        throw new UserError("Invalid upload path.");
      return {
        allowedContentTypes: ["application/pdf"],
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        addRandomSuffix: true,
      };
    },
  });
  return NextResponse.json(jsonResponse, { headers: { "Cache-Control": "no-store" } });
});
