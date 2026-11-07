"use client";
import { useCallback, useEffect, useState } from "react";
import { addressWithUnit } from "@/lib/addressUnit";
import { useRouter } from "next/navigation";
import Header from "./Header";
import { api } from "./api";
import { SERVICE_LINE_LABELS, VISIT_STAGE_LABELS } from "@/lib/fnol";
import type { Assignment, Property } from "@/lib/intake";
import { formatTimestampNY } from "@/lib/time";

const ADJ = ["above", "below", "beside (left)", "beside (right)", "common areas"];

export default function PropertyView({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const [data, setData] = useState<{ property: Property; assignments: Assignment[] } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});

  const load = useCallback(
    () => api<{ property: Property; assignments: Assignment[] }>(`/api/properties/${propertyId}`).then(setData).catch((e) => setErr(e.message)),
    [propertyId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (err) return (<><Header crumb="Property" /><main className="page"><div className="card danger">{err}</div></main></>);
  if (!data) return (<><Header crumb="Property" /><main className="page muted">Loading…</main></>);
  const p = data.property;

  const patch = async (body: Record<string, unknown>) => {
    try {
      const r = await api<{ property: Property }>(`/api/properties/${propertyId}`, { method: "PATCH", body });
      setData((d) => (d ? { ...d, property: r.property } : d));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const pre1978 = p.yearBuilt != null && p.yearBuilt < 1978;
  return (
    <>
      <Header crumb={p.address} />
      <main className="page">
        <h1 style={{ fontSize: 22 }}>
          {addressWithUnit(p.address, p.unit)}
        </h1>
        <div className="card stack" style={{ marginTop: 10 }}>
          <div className="grid2">
            <label className="field">
              <span>Year built (hazard check)</span>
              <input
                className="in"
                inputMode="numeric"
                defaultValue={p.yearBuilt ?? ""}
                onBlur={(e) => patch({ yearBuilt: e.target.value ? Number(e.target.value) : null })}
                aria-label="Year built"
              />
            </label>
            <label className="field">
              <span>Multi-unit building</span>
              <select className="in" value={p.multiUnit ? "yes" : "no"} onChange={(e) => patch({ multiUnit: e.target.value === "yes" })}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
          </div>
          {pre1978 && <div className="small" style={{ color: "var(--amber)" }}>⚑ Built before 1978: lead-safe (RRP) practices apply before demolition.</div>}
          {p.yearBuilt == null && <div className="small muted">Year built unknown — demolition lines will carry a hazard-check note.</div>}
          {p.multiUnit && (
            <div>
              <div className="small muted" style={{ fontWeight: 600 }}>Adjacent-unit investigation</div>
              {ADJ.map((k) => (
                <label key={k} className="field" style={{ marginTop: 6 }}>
                  <span>{k}</span>
                  <input
                    className="in"
                    placeholder="Not checked — e.g. 'Unit 6C checked, dry'"
                    defaultValue={p.adjacentChecks[k] ?? ""}
                    onBlur={(e) => patch({ adjacentChecks: { ...p.adjacentChecks, [k]: e.target.value } })}
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        <h2>Assignment history ({data.assignments.length})</h2>
        {data.assignments.map((a) => (
          <div key={a.id} className="card" style={{ marginBottom: 10 }}>
            <div className="row">
              <strong className="grow">
                {a.serviceLines.map((l) => SERVICE_LINE_LABELS[l]).join(" + ")}
                {a.contentsOnly ? " (contents only)" : ""}
              </strong>
              <span className={`chip ${a.status === "new" ? "amber" : a.status === "linked" ? "green" : ""}`}>{a.status}</span>
              {a.special && <span className="chip red">special</span>}
            </div>
            <div className="small muted">
              {VISIT_STAGE_LABELS[a.stage]} · received {formatTimestampNY(a.receivedAt)}
              {a.claimNumber ? ` · claim ${a.claimNumber}` : ""}
              {a.program ? ` · ${a.program}` : ""}
            </div>
            {a.special && a.specialReason && <div className="small" style={{ marginTop: 4 }}>Special: {a.specialReason}</div>}
            <ul className="small" style={{ paddingLeft: 18, marginTop: 6 }}>
              {a.history.map((h, i) => (
                <li key={i}>
                  {formatTimestampNY(h.at)} — {h.text}
                </li>
              ))}
            </ul>
            <div className="row" style={{ marginTop: 6 }}>
              <input
                className="in grow"
                placeholder="Add an update (e.g. 'Final walk-through scheduled Monday')"
                value={note[a.id] ?? ""}
                onChange={(e) => setNote({ ...note, [a.id]: e.target.value })}
              />
              <button
                className="btn sm"
                disabled={!note[a.id]?.trim()}
                onClick={async () => {
                  await api(`/api/assignments/${a.id}/note`, { body: { text: note[a.id] } });
                  setNote({ ...note, [a.id]: "" });
                  void load();
                }}
              >
                Add
              </button>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              {a.projectId && (
                <a className="btn sm" href={`/projects/${a.projectId}`}>
                  Open project
                </a>
              )}
              <button
                className="btn sm primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api<{ projectId: string; visitId: string }>(`/api/assignments/${a.id}/open`, { body: {} });
                    router.push(`/projects/${r.projectId}?visit=${r.visitId}`);
                  } catch (e) {
                    setErr((e as Error).message);
                    setBusy(false);
                  }
                }}
              >
                {a.projectId ? "Start next visit" : "Open project & start visit"}
              </button>
              {a.status !== "closed" && (
                <button
                  className="btn sm ghost"
                  onClick={async () => {
                    await api(`/api/assignments/${a.id}/status`, { body: { status: "closed" } });
                    void load();
                  }}
                >
                  Close
                </button>
              )}
            </div>
          </div>
        ))}
      </main>
    </>
  );
}
