import { route } from "@/lib/http";
import { ingestPdf, UserError } from "@/lib/service";

type P = { pid: string };
export const POST = route<P>(async (req, { pid }) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw new UserError("Choose a PDF to upload.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { document: await ingestPdf(pid, { name: file.name || "report.pdf", bytes }) };
});
