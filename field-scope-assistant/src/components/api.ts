"use client";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public retryable?: boolean) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data?.error === "Passcode required") {
    window.location.reload();
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status, data?.code, data?.retryable);
  return data as T;
}

/** Upload with progress (fetch has no upload progress events).
 *
 * For project document uploads, files larger than ~4 MB are sent straight to
 * Vercel Blob storage, bypassing the ~4.5 MB serverless-function
 * request-body limit. Smaller files use the regular multipart upload.
 */
export function uploadWithProgress<T>(url: string, form: FormData, onProgress: (pct: number) => void): Promise<T> {
  const file = form.get("file");
  const docsMatch = url.match(/\/api\/projects\/([^/]+)\/documents$/);
  if (file instanceof File && docsMatch && file.size > 4 * 1024 * 1024) {
    return uploadPdfViaBlob<T>(docsMatch[1], file, onProgress);
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(data.error ?? `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Upload failed — check your connection.", 0, undefined, true));
    xhr.send(form);
  });
}

/**
 * Upload a large PDF directly to Vercel Blob storage. The server ingests the
 * PDF from Blob when the upload completes. Returns the same { document }
 * shape the caller expects.
 */
async function uploadPdfViaBlob<T>(pid: string, file: File, onProgress: (pct: number) => void): Promise<T> {
  const { upload } = await import("@vercel/blob/client");
  onProgress(0);
  await upload(`projects/${pid}/${Date.now()}.pdf`, file, {

    handleUploadUrl: `/api/projects/${pid}/documents/blob`,
    clientPayload: file.name,
  });
  onProgress(100);
  // The server ingests the PDF in onUploadCompleted before upload() resolves.
  const ws = await api<{ documents: Array<{ id: string; filename: string; scannedPages: number; pageCount: number }> }>(`/api/projects/${pid}`);
  const doc = ws.documents.find((d) => d.filename === file.name) ?? ws.documents[ws.documents.length - 1];
  if (!doc) throw new ApiError("Upload completed but the document was not found. Please reload.", 500);
  return { document: doc } as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
