"use client";
import { useEffect } from "react";

const RELOAD_KEY = "fsa-chunk-reload";

/** Chunk/asset failures: a newer deployment replaced the files, or the request was intercepted (e.g. a sign-in wall). */
export function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /ChunkLoadError|Loading chunk|Failed to load chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg);
}

export default function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  const chunk = isChunkError(error);

  useEffect(() => {
    // One automatic hard reload for stale/blocked chunks; never loop.
    if (!chunk) return;
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
      if (Date.now() - last > 60_000) {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
        window.location.reload();
      }
    } catch {
      // storage blocked (private mode): fall through to the manual button
    }
  }, [chunk]);

  return (
    <main className="page" style={{ maxWidth: 520, paddingTop: 60 }}>
      <h1>Something went wrong</h1>
      <p style={{ margin: "10px 0" }}>
        {chunk
          ? "The app could not load its files. This usually means a new version was just published, or the link opened a sign-in page instead of the app."
          : "This screen hit an error. Your saved projects and notes are not affected."}
      </p>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        {reset && !chunk && (
          <button className="btn" onClick={() => reset()}>
            Try again
          </button>
        )}
        <a className="btn ghost" href="/">
          All projects
        </a>
      </div>
      <p className="small muted" style={{ marginTop: 18 }}>
        Details: {error.message || "unknown error"}
        {error.digest ? ` (ref ${error.digest})` : ""}
      </p>
    </main>
  );
}
