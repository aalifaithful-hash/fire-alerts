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

/** Upload with progress (fetch has no upload progress events). */
export function uploadWithProgress<T>(url: string, form: FormData, onProgress: (pct: number) => void): Promise<T> {
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
