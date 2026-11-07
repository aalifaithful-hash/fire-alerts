"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/**
 * Field-notes autosave that does not lose edits.
 *
 * - Debounced save while typing (700 ms).
 * - Every pending edit carries its own visit URL, so switching visits or tabs
 *   (which unmounts the editor) flushes the edit to the right visit instead of
 *   cancelling it.
 * - Flushes with `keepalive` when the page is hidden or unloaded (phone locked,
 *   app switched, reload), so the request survives the page going away.
 * - Saves are serialized and confirmed against the server's response; a failed
 *   save keeps the edit pending and shows an error the PM can retry.
 */
export function useNotesAutosave(url: string | null) {
  const [value, setValueState] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const pending = useRef<{ url: string; value: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const urlRef = useRef(url);
  urlRef.current = url;

  const send = async (p: { url: string; value: string }, keepalive: boolean) => {
    const body = JSON.stringify({ fieldNotes: p.value });
    const res = await fetch(p.url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
      // keepalive requests are capped at 64 KB by browsers
      keepalive: keepalive && body.length < 60_000,
    });
    if (!res.ok) throw new Error(`Save failed (${res.status})`);
    if (keepalive) return; // page is going away; don't wait on the body
    const data = (await res.json().catch(() => null)) as { visit?: { fieldNotes?: string } } | null;
    if (data?.visit && data.visit.fieldNotes !== p.value) throw new Error("Server did not store the notes");
  };

  const flush = useCallback((keepalive = false): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    if (!p) return Promise.resolve(true);
    pending.current = null;
    const isCurrent = p.url === urlRef.current;
    if (isCurrent) setState("saving");
    const run = chain.current.then(async () => {
      try {
        await send(p, keepalive);
        if (isCurrent && !pending.current) {
          setState("saved");
          setSavedAt(new Date());
        }
        return true;
      } catch {
        if (!pending.current) pending.current = p; // keep the edit for retry
        if (isCurrent) setState("error");
        return false;
      }
    });
    chain.current = run;
    return run;
  }, []);

  /** PM typed/dictated: mark dirty and schedule a save. */
  const setValue = useCallback(
    (next: string | ((prev: string) => string)) => {
      setValueState((prev) => {
        const v = typeof next === "function" ? next(prev) : next;
        if (urlRef.current) pending.current = { url: urlRef.current, value: v };
        return v;
      });
      setState("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [flush],
  );

  /** Server value loaded (visit opened/refreshed). Never overwrites unsaved typing. */
  const load = useCallback((serverValue: string) => {
    if (pending.current && pending.current.url === urlRef.current) return;
    setValueState(serverValue);
    setState("idle");
  }, []);

  // Visit changed or editor unmounted (tab switch): save what was typed.
  useEffect(() => {
    return () => {
      void flush(true);
    };
  }, [url, flush]);

  // Phone locked / app switched / reload: flush with keepalive.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush(true);
    };
    const onPageHide = () => void flush(true);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current) {
        void flush(true);
        e.preventDefault();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flush]);

  return { value, setValue, load, flush, state, savedAt, dirty: state === "dirty" || state === "error" };
}
