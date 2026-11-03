import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * File storage for uploaded PDFs and manuals.
 *
 * - On Vercel (BLOB_READ_WRITE_TOKEN set): private Vercel Blob store. Stored
 *   paths look like "blob:projects/<pid>/<file>.pdf". Nothing is public; reads
 *   go through the server with the read-write token.
 *   Stored paths are "blob:<full blob URL>" (older rows may hold "blob:<pathname>";
 *   both are accepted by @vercel/blob's get/del).
 * - Locally (no token): files under DATA_DIR (default ./.data). Serverless
 *   filesystems are read-only, which is why Blob is required on Vercel.
 */

const BLOB_PREFIX = "blob:";

export function blobEnabled(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function dataDir() {
  return path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || path.join(process.cwd(), ".data"));
}

/** Pathname inside the store for a project's upload. Always namespaced by project. */
export function projectKey(projectId: string, file: string): string {
  return `projects/${projectId}/${file}`;
}

export async function putFile(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
  if (blobEnabled()) {
    const { put } = await import("@vercel/blob");
    const res = await put(key, Buffer.from(bytes), {
      access: "private",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return BLOB_PREFIX + res.url;
  }
  const full = path.join(dataDir(), "uploads", key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, bytes, { mode: 0o600 });
  return full;
}

/** Stored path for a file the browser already uploaded straight to Blob. */
export function blobStoredPath(urlOrPathname: string): string {
  return BLOB_PREFIX + urlOrPathname;
}

/**
 * Validates a blob reference sent by the browser after a direct upload and
 * returns the URL to read it from. The blob must sit inside `requiredPrefix`
 * (this project's folder); @vercel/blob additionally refuses URLs that are not
 * on a Vercel Blob host.
 */
export function checkUploadedBlob(ref: { url?: unknown; pathname?: unknown }, requiredPrefix: string): string {
  const pathname = String(ref.pathname ?? "");
  const url = String(ref.url ?? "");
  if (!pathname.startsWith(requiredPrefix) || pathname.includes("..")) throw new Error("Invalid upload reference.");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Invalid upload reference.");
  }
  if (decodeURIComponent(u.pathname.replace(/^\//, "")) !== pathname) throw new Error("Invalid upload reference.");
  return url;
}

export async function readStoredFile(stored: string): Promise<Uint8Array> {
  if (stored.startsWith(BLOB_PREFIX)) {
    const { get } = await import("@vercel/blob");
    const res = await get(stored.slice(BLOB_PREFIX.length), { access: "private", useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) throw new Error("Stored file not found.");
    return new Uint8Array(await new Response(res.stream).arrayBuffer());
  }
  return new Uint8Array(await readFile(stored));
}

export async function deleteFile(stored: string | null | undefined): Promise<void> {
  if (!stored) return;
  try {
    if (stored.startsWith(BLOB_PREFIX)) {
      const { del } = await import("@vercel/blob");
      await del(stored.slice(BLOB_PREFIX.length));
    } else {
      await rm(stored, { force: true });
    }
  } catch {
    // Best effort: a missing file must not block deleting the record.
  }
}

/** Deletes every stored file for a project (used when the project is deleted). */
export async function deleteProjectFiles(projectId: string): Promise<void> {
  try {
    if (blobEnabled()) {
      const { list, del } = await import("@vercel/blob");
      let cursor: string | undefined;
      do {
        const page = await list({ prefix: projectKey(projectId, ""), cursor });
        if (page.blobs.length) await del(page.blobs.map((b) => b.url));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    } else {
      await rm(path.join(dataDir(), "uploads", "projects", projectId), { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
}
