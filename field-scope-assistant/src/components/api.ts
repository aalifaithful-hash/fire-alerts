"use client";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public retryable?: boolean,
  ) {
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

/**
 * Uploads a CompanyCam PDF to a project.
 *
 * - `direct` (server has BLOB_READ_WRITE_TOKEN): the browser sends the file
 *   straight to the private Vercel Blob store (multipart for large files, with
 *   real progress), then asks the server to ingest it from Blob. Works for any
 *   size up to 200 MB and never hits the ~4.5 MB serverless body limit.
 * - otherwise: regular multipart POST through the server (local/dev setups).
 */
export async function uploadProjectPdf<T>(
  projectId: string,
  file: File,
  onProgress: (pct: number) => void,
  opts: { direct: boolean },
): Promise<T> {
  if (opts.direct) {
    const { upload } = await import("@vercel/blob/client");
    onProgress(0);
    const safeName = file.name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "report";
    const pathname = `projects/${projectId}/${safeName.replace(/\.pdf$/i, "")}.pdf`;
    let blob: { url: string; pathname: string };
    try {
      blob = await upload(pathname, file, {
        access: "private",
        contentType: "application/pdf",
        handleUploadUrl: `/api/projects/${projectId}/documents/blob`,
        multipart: file.size > 8 * 1024 * 1024,
        onUploadProgress: (e) => onProgress(Math.min(99, Math.round(e.percentage))),
      });
    } catch (e) {
      throw new ApiError(`Upload to storage failed: ${(e as Error).message}`, 0, "STORAGE", true);
    }
    onProgress(100);
    // Ingest (text extraction + page batches) runs on the server from Blob.
    return api<T>(`/api/projects/${projectId}/documents/from-blob`, { body: { url: blob.url, pathname: blob.pathname, filename: file.name } });
  }
  const form = new FormData();
  form.append("file", file);
  return uploadWithProgress<T>(`/api/projects/${projectId}/documents`, form, onProgress);
}

/** Multipart upload with progress (fetch has no upload progress events). */
export function uploadWithProgress<T>(url: string, form: FormData, onProgress: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error body */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else if (xhr.status === 413) reject(new ApiError("This PDF is too large for a direct server upload. Ask for Blob uploads to be enabled.", 413));
      else reject(new ApiError(data.error ?? `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Upload failed — check your connection.", 0, undefined, true));
    xhr.send(form);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
