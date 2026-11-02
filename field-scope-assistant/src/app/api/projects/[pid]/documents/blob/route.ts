import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { ingestPdf } from "@/lib/service";
import { route } from "@/lib/http";

type P = { pid: string };

// Direct-to-Blob upload endpoint for large PDFs.
//
// The browser uploads the file straight to Vercel Blob storage, bypassing the
// ~4.5 MB serverless-function request-body limit on Hobby. When the upload
// finishes, the server downloads the PDF from Blob and ingests it into the
// project exactly like the regular multipart upload path.
export const POST = route<P>(async (req, { pid }) => {
  const body = (await req.json()) as HandleUploadBody;
  const jsonResponse = await handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async (_pathname, clientPayload) => {
      return {
        allowedContentTypes: ["application/pdf"],
        tokenPayload: JSON.stringify({
          pid,
          filename:
            typeof clientPayload === "string" && clientPayload ? clientPayload : "report.pdf",
        }),
      };
    },
    onUploadCompleted: async ({ blob, tokenPayload }) => {
      const payload = JSON.parse(tokenPayload || "{}") as { pid?: string; filename?: string };
      const targetPid = payload.pid || pid;
      // Private blobs require the read-write token to download.
      const res = await fetch(blob.url, {
        headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      });
      if (!res.ok) throw new Error(`Failed to download uploaded PDF from storage (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await ingestPdf(targetPid, { name: payload.filename || "report.pdf", bytes });
    },
  });
  return NextResponse.json(jsonResponse);
});
