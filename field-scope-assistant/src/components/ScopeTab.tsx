"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MicButton from "./MicButton";
import { useNotesAutosave } from "./useNotesAutosave";
import Sheet from "./Sheet";
import { api, ApiError } from "./api";
import { ACCESS_OPTIONS, CATEGORY_LABEL, locLabel, SOURCE_LABEL, STATUS_LABEL } from "./labels";
import type { VisitData, WorkspaceData } from "./types";
import {
  CATEGORIES,
  EQUIPMENT_STATUSES,
  ITEM_STATUSES,
  VISIT_TYPES,
  VISIT_TYPE_LABELS,
  type Equipment,
  type ScopeItem,
  type VisitType,
} from "@/lib/schemas";
import { formatDate, formatTimestampNY, todayNY } from "@/lib/time";

interface Props {
  ws: WorkspaceData;
  projectId: string;
  visitId: string | null;
  openVisit: (id: string | null) => void;
  reload: () => Promise<WorkspaceData | null>;
  flash: (m: string) => void;
  openEvidence: (id: string) => void;
  aiReady: boolean;
  goPhotos: () => void;
}

export default function ScopeTab(p: Props) {
  const { ws, projectId, visitId } = p;
  const [data, setData] = useState<VisitData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<{ kind: "clarify" | "changes"; lines: string[] } | null>(null);
  const [corr, setCorr] = useState("");
  const [editing, setEditing] = useState<{ item?: ScopeItem; equip?: Equipment } | null>(null);
  const [textEdit, setTextEdit] = useState<string | null>(null);
  const [newVisit, setNewVisit] = useState(false);
  const base = `/api/projects/${projectId}/visits/${visitId}`;
  const notesSave = useNotesAutosave(visitId ? base : null);
  const notes = notesSave.value;
  const loadNotes = notesSave.load;

  const load = useCallback(async () => {
    if (!visitId) return setData(null);
    const d = await api<VisitData>(base);
    setData(d);
    loadNotes(d.visit.fieldNotes);
  }, [base, visitId, loadNotes]);

  useEffect(() => {
    setMsg(null);
    setError("");
    load().catch((e) => setError(e.message));
  }, [load]);

  useEffect(() => {
    if (!visitId && !ws.visits.length) setNewVisit(true);
  }, [visitId, ws.visits.length]);

  const run = async (label: string, fn: () => Promise<VisitData | void>) => {
    setBusy(label);
    setError("");
    try {
      const d = await fn();
      if (d) {
        setData(d);
        loadNotes(d.visit.fieldNotes); // ignored while the PM has unsaved typing
      }
      return d;
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === "NO_API_KEY" ? "AI is not configured — see the setup note above." : err.message);
    } finally {
      setBusy(null);
    }
  };

  const generate = () =>
    run("generate", async () => {
      if (!(await notesSave.flush())) throw new ApiError("Your notes could not be saved — check your connection and try again.", 0);
      const d = await api<VisitData>(`${base}/generate`, { method: "POST" });
      setMsg(null);
      p.reload();
      return d;
    });

  const sendCorrection = (text: string) =>
    run("correct", async () => {
      const d = await api<VisitData>(`${base}/correct`, { body: { text } });
      const r = d.result;
      if (r?.kind === "clarify") setMsg({ kind: "clarify", lines: [r.clarification] });
      else if (r?.kind === "applied") {
        setMsg({ kind: "changes", lines: [...r.changes, ...r.rejected.map((x) => `Not applied: ${x}`)] });
        setCorr("");
      } else if (r?.kind === "show_full") {
        setMsg(null);
        setCorr("");
        document.getElementById("scope-doc")?.scrollIntoView({ behavior: "smooth" });
      }
      p.reload();
      return d;
    });

  const patchVisit = (patch: Record<string, string | null>) =>
    run("visit", async () => {
      const d = await api<VisitData>(base, { method: "PATCH", body: patch });
      p.reload();
      return d;
    });

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    p.flash(`${what} copied`);
  };

  const locById = useMemo(() => new Map(ws.locations.map((l) => [l.id, l])), [ws.locations]);
  const facts = data?.visit.facts;
  const itemById = useMemo(() => new Map((facts?.items ?? []).map((i) => [i.id, i])), [facts]);
  const equipById = useMemo(() => new Map((facts?.equipment ?? []).map((e) => [e.id, e])), [facts]);
  const openQs = facts?.questions.filter((q) => q.status === "open") ?? [];
  const pendingRecs = facts?.recommendations.filter((r) => r.status === "pending") ?? [];
  const carried = facts ? [...facts.items.filter((i) => i.carriedForward), ...facts.equipment.filter((e) => e.carriedForward)] : [];
  const flagged = facts ? [...facts.items.filter((i) => i.flags.length), ...facts.equipment.filter((e) => e.flags.length)] : [];
  const v = data?.visit;

  // ---------------- no visit yet ----------------
  if (newVisit || !visitId)
    return (
      <NewVisitForm
        ws={ws}
        projectId={projectId}
        onCancel={ws.visits.length ? () => setNewVisit(false) : undefined}
        onCreated={(id) => {
          setNewVisit(false);
          p.reload();
          p.openVisit(id);
        }}
      />
    );
  if (!data || !v || !facts) return <p className="muted">{error || "Loading visit…"}</p>;

  return (
    <div>
      {/* Visit picker */}
      <div className="row" style={{ marginBottom: 10 }}>
        <select className="in grow" value={visitId} onChange={(e) => p.openVisit(e.target.value)} aria-label="Visit">
          {[...ws.visits].reverse().map((x) => (
            <option key={x.id} value={x.id}>
              {formatDate(x.visitDate)} · {VISIT_TYPE_LABELS[x.type]}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setNewVisit(true)}>
          + Visit
        </button>
      </div>

      {/* Visit details */}
      <details className="card" open={!v.doc}>
        <summary>
          {VISIT_TYPE_LABELS[v.type]} — {formatDate(v.visitDate)}
          {v.accessOutcome ? ` · ${v.accessOutcome}` : ""}
        </summary>
        <div className="stack" style={{ marginTop: 10 }}>
          <label className="field">
            <span>Output type</span>
            <select className="in" value={v.type} onChange={(e) => patchVisit({ type: e.target.value })}>
              {VISIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {VISIT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <div className="grid2">
            <label className="field">
              <span>Visit date</span>
              <input className="in" type="date" defaultValue={v.visitDate} onBlur={(e) => e.target.value !== v.visitDate && patchVisit({ visitDate: e.target.value })} />
            </label>
            <label className="field">
              <span>Appointment time (scheduled)</span>
              <input className="in" type="time" defaultValue={v.appointmentTime ?? ""} onBlur={(e) => e.target.value !== (v.appointmentTime ?? "") && patchVisit({ appointmentTime: e.target.value })} />
            </label>
            <label className="field">
              <span>Actual arrival</span>
              <input className="in" type="time" defaultValue={v.arrivalTime ?? ""} onBlur={(e) => e.target.value !== (v.arrivalTime ?? "") && patchVisit({ arrivalTime: e.target.value })} />
            </label>
            <label className="field">
              <span>Actual departure</span>
              <input className="in" type="time" defaultValue={v.departureTime ?? ""} onBlur={(e) => e.target.value !== (v.departureTime ?? "") && patchVisit({ departureTime: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Access outcome (this visit only)</span>
            <input className="in" list="access-opts" defaultValue={v.accessOutcome ?? ""} placeholder="Not recorded" onBlur={(e) => e.target.value !== (v.accessOutcome ?? "") && patchVisit({ accessOutcome: e.target.value })} />
            <datalist id="access-opts">
              {ACCESS_OPTIONS.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </label>
        </div>
      </details>

      {/* Field notes */}
      <h2>Field notes</h2>
      <div className="card stack">
        <textarea
          className="in"
          style={{ minHeight: 150 }}
          placeholder="Cause of loss, what you see, what needs to happen. E.g. “Pipe burst above. Source repaired. Cat 2. Living room flooring and walls wet. Drying only. CC+1, three days equipment. One dehumidifier in the living room…”"
          value={notes}
          onChange={(e) => notesSave.setValue(e.target.value)}
          onBlur={() => void notesSave.flush()}
          aria-label="Field notes"
        />
        <div className="row small" aria-live="polite" data-testid="notes-save-state">
          {notesSave.state === "saving" && <span className="muted"><span className="spinner" /> Saving…</span>}
          {notesSave.state === "dirty" && <span className="muted">Unsaved changes…</span>}
          {notesSave.state === "saved" && (
            <span style={{ color: "var(--green)" }}>
              ✓ Saved {notesSave.savedAt?.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          {notesSave.state === "error" && <span style={{ color: "var(--fire)" }}>Not saved — check your connection.</span>}
          {(notesSave.state === "dirty" || notesSave.state === "error") && (
            <button type="button" className="btn sm" onClick={() => void notesSave.flush()}>
              Save notes now
            </button>
          )}
        </div>
        <div className="row">
          <MicButton onText={(t) => notesSave.setValue((n) => (n ? `${n.trimEnd()} ${t}` : t))} />
          <button className="btn" onClick={p.goPhotos}>
            📄 CompanyCam PDF ({ws.documents.length})
          </button>
        </div>
        {/* AI-only: shown only when a key is configured. */}
        {p.aiReady && (
          <button className="btn primary big" disabled={!!busy} onClick={generate}>
            {busy === "generate" ? (
              <>
                <span className="spinner" /> Reading notes and photos…
              </>
            ) : v.doc ? (
              "Regenerate draft from notes"
            ) : (
              "Generate draft"
            )}
          </button>
        )}
        {!p.aiReady && (
          <p className="small muted">
            Notes save automatically. Write the scope in the <strong>Scope</strong> section below.
          </p>
        )}
        {p.aiReady && v.doc && <p className="small muted">Regenerating keeps your direct edits and accepted recommendations. For small fixes use the correction box below.</p>}
      </div>

      {error && <div className="card danger" style={{ marginTop: 10 }}>{error}</div>}

      {msg && (
        <div className={`card ${msg.kind === "clarify" ? "warn" : "ok"}`} style={{ marginTop: 12 }}>
          <strong>{msg.kind === "clarify" ? "Quick question" : "Changes applied"}</strong>
          <ul style={{ marginTop: 6, paddingLeft: 18 }}>
            {msg.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Questions */}
      {p.aiReady && openQs.length > 0 && (
        <>
          <h2>Questions that affect the scope</h2>
          {openQs.map((q) => (
            <QuestionCard key={q.id} text={q.text} reason={q.reason} disabled={!!busy || !p.aiReady} onAnswer={(a) => sendCorrection(`Answer to "${q.text}" (question ${q.id}): ${a}`)} />
          ))}
        </>
      )}

      {/* Recommendations */}
      {pendingRecs.length > 0 && (
        <>
          <h2>Suggestions — not in the scope</h2>
          <p className="small muted" style={{ marginTop: -4, marginBottom: 8 }}>
            Unconfirmed. Accept to add as proposed work, or reject.
          </p>
          {pendingRecs.map((r) => (
            <RecCard
              key={r.id}
              room={r.locationId ? locLabel(locById.get(r.locationId)) : "Project-wide"}
              text={r.text}
              rationale={r.rationale}
              disabled={!!busy}
              onDecide={(action, text) => run("rec", () => api<VisitData>(`${base}/recommendations/${r.id}`, { body: { action, text } }))}
            />
          ))}
        </>
      )}

      {/* Scope document */}
      <h2 id="scope-doc">Scope</h2>
      {!v.doc && !v.manualText ? (
        <div className="card stack">
          <div className="muted">
            No draft yet.{" "}
            {p.aiReady ? "Generate one from your notes and PDF, or start one yourself." : "Start one yourself — no AI key needed."}
          </div>
          <button
            className={`btn big ${p.aiReady ? "" : "primary"}`}
            disabled={!!busy}
            onClick={() => run("draft", () => api<VisitData>(`${base}/draft`, { method: "POST" }))}
          >
            Start the scope manually (add bullets by room)
          </button>
          <button
            className="btn"
            disabled={!!busy}
            onClick={async () => {
              const d = await run("draft", () => api<VisitData>(`${base}/draft`, { method: "POST" }));
              if (d) setTextEdit(d.text);
            }}
          >
            Write the scope as free text
          </button>
        </div>
      ) : (
        <>
          <button className="btn primary big" style={{ marginBottom: 8 }} onClick={() => copy(data.slack, "Slack text")}>
            Copy for Slack
          </button>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 10 }}>
            <button className="btn" onClick={() => copy(data.text, "Plain text")}>
              Copy text
            </button>
            <a className="btn" href={`${base}/export?format=pdf`}>
              PDF
            </a>
            <a className="btn" href={`${base}/export?format=docx`}>
              DOCX
            </a>
            <button className="btn" onClick={() => setTextEdit(data.text)}>
              Edit text
            </button>
          </div>
          {v.manualText ? (
            <div className="doc">
              <div className="card warn small" style={{ marginBottom: 10 }}>
                Showing your free-text edits. Corrections and regenerating will replace them with the structured scope.
                <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => run("text", () => api<VisitData>(`${base}/text`, { method: "PUT", body: { text: null } }))}>
                  Discard text edits
                </button>
              </div>
              <div className="manual-text">{v.manualText}</div>
            </div>
          ) : (
            v.doc && (
              <div className="doc">
                <div className="title">{v.doc.title}</div>
                <dl className="meta">
                  {v.doc.header.map((h) => (
                    <FragmentRow key={h.label} label={h.label} value={h.value} />
                  ))}
                </dl>
                {v.doc.sections.map((s, i) => (
                  <div key={i}>
                    <div className={s.level === 1 ? "h1" : "h2"}>{s.heading}</div>
                    {s.bullets.length > 0 && (
                      <ul>
                        {s.bullets.map((b, j) => {
                          const it = b.itemId ? itemById.get(b.itemId) : undefined;
                          const eq = b.equipmentId ? equipById.get(b.equipmentId) : undefined;
                          const tappable = it || eq;
                          return (
                            <li
                              key={j}
                              tabIndex={tappable ? 0 : -1}
                              onClick={() => tappable && setEditing({ item: it, equip: eq })}
                              onKeyDown={(e) => e.key === "Enter" && tappable && setEditing({ item: it, equip: eq })}
                            >
                              {b.text}
                              <span className="tags">
                                {(it?.carriedForward || eq?.carriedForward) && <span className="chip amber">carried</span>}
                                {(it?.flags.length || eq?.flags.length) ? <span className="chip red">check</span> : null}
                                {it && it.evidenceIds.length > 0 && <span className="chip blue">📷 {it.evidenceIds.length}</span>}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ))}
                {v.doc.footer.length > 0 && (
                  <div className="footer">
                    {v.doc.footer.map((f, i) => (
                      <div key={i}>{f}</div>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
          {!v.manualText && v.doc && v.doc.sections.length === 0 && (
            <p className="small muted" style={{ marginTop: 8 }}>No bullets yet. Add the first one below.</p>
          )}
          <AddBullet
            ws={ws}
            disabled={!!busy}
            prominent={!p.aiReady || (v.doc?.sections.length ?? 0) === 0}
            onAdd={(b) => run("add", () => api<VisitData>(`${base}/items`, { body: b }))}
          />
          {!p.aiReady && (
            <p className="small muted" style={{ marginTop: 8 }}>
              Manual editing: tap any bullet to edit, re-room or remove it; use <strong>Add a bullet</strong> for new lines (add rooms in the Rooms
              tab); or <strong>Edit text</strong> to write freely. Every change is saved as a version. Plain-language corrections need the AI key.
            </p>
          )}
        </>
      )}

      {/* Review panel */}
      {(facts.reviewFlags.length > 0 || flagged.length > 0 || carried.length > 0) && (
        <>
          <h2>Review</h2>
          <div className="card">
            {facts.reviewFlags.map((f, i) => (
              <div className="flag" key={`r${i}`}>
                ⚑ {f}
              </div>
            ))}
            {flagged.map((x) => (
              <div className="flag" key={x.id}>
                ⚑ {locLabel(x.locationId ? locById.get(x.locationId) : null)}: {"text" in x ? x.text : x.type.replace(/_/g, " ")} — {x.flags.join(" ")}
              </div>
            ))}
            {carried.length > 0 && (
              <div className="flag">
                <strong>Carried forward from the previous visit{facts.directives.carryForwardConfirmed ? " (you confirmed)" : " (not confirmed — held out of the scope)"}:</strong>
                <ul style={{ paddingLeft: 18, marginTop: 4 }}>
                  {carried.map((x) => (
                    <li key={x.id}>
                      {locLabel(x.locationId ? locById.get(x.locationId) : null)}: {"text" in x ? x.text : `${x.quantity ?? "?"} ${x.type.replace(/_/g, " ")} (${x.status})`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}

      {/* Checklist */}
      <ChecklistBlock
        ws={ws}
        data={data}
        base={base}
        busy={!!busy}
        aiReady={p.aiReady}
        onRun={(templateId) => run("checklist", () => api<VisitData>(`${base}/checklist`, { body: { templateId } }))}
        copy={copy}
      />

      {/* Versions */}
      {data.drafts.length > 0 && (
        <>
          <h2>Draft versions</h2>
          <details className="card">
            <summary>
              {data.drafts.length} version{data.drafts.length === 1 ? "" : "s"} — latest v{data.drafts[0].version}
            </summary>
            {data.drafts.map((d, i) => (
              <div key={d.id} className="flag">
                <div className="row">
                  <strong>v{d.version}</strong>
                  <span className="chip">{d.trigger.replace("_", " ")}</span>
                  <span className="small muted grow">{formatTimestampNY(d.createdAt)}</span>
                  {i > 0 && (
                    <button className="btn sm" disabled={!!busy} onClick={() => run("restore", () => api<VisitData>(`${base}/drafts/${d.id}/restore`, { method: "POST" }))}>
                      Restore
                    </button>
                  )}
                </div>
                {d.input && <div className="small">“{d.input}”</div>}
                {d.changes.length > 0 && <div className="small muted">{d.changes.slice(0, 4).join(" · ")}{d.changes.length > 4 ? " …" : ""}</div>}
              </div>
            ))}
          </details>
        </>
      )}

      <div className="row" style={{ marginTop: 24 }}>
        <button
          className="btn danger sm"
          onClick={async () => {
            if (!confirm("Delete this visit and its drafts?")) return;
            await api(base, { method: "DELETE" });
            const d = await p.reload();
            p.openVisit(d?.visits.at(-1)?.id ?? null);
          }}
        >
          Delete visit
        </button>
      </div>

      {/* Persistent correction box (AI). Without a key, manual editing is explained in the Scope section instead. */}
      <div className={`corrbar ${p.aiReady ? "" : "hide"}`}>
        <div className="inner">
          {busy === "correct" && <div className="msg muted"><span className="spinner" /> Updating the scope…</div>}
          <form
            className="row"
            style={{ flexWrap: "nowrap", alignItems: "flex-end" }}
            onSubmit={(e) => {
              e.preventDefault();
              if (corr.trim()) sendCorrection(corr.trim());
            }}
          >
            <textarea
              className="in grow"
              rows={1}
              placeholder={p.aiReady ? "“Bathroom is dry”…" : "Needs AI key"}
              value={corr}
              disabled={!p.aiReady}
              onChange={(e) => setCorr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (corr.trim()) sendCorrection(corr.trim());
                }
              }}
              aria-label="Correction"
            />
            <MicButton label="" onText={(t) => setCorr((c) => (c ? `${c.trimEnd()} ${t}` : t))} />
            <button className="btn primary" disabled={!corr.trim() || !!busy || !p.aiReady}>
              Send
            </button>
          </form>
        </div>
      </div>

      {editing && (
        <BulletSheet
          ws={ws}
          item={editing.item}
          equip={editing.equip}
          openEvidence={p.openEvidence}
          onClose={() => setEditing(null)}
          onSaveItem={(id, patch) => run("edit", () => api<VisitData>(`${base}/items/${id}`, { method: "PATCH", body: patch })).then(() => setEditing(null))}
          onSaveEquip={(id, patch) => run("edit", () => api<VisitData>(`${base}/equipment/${id}`, { method: "PATCH", body: patch })).then(() => setEditing(null))}
        />
      )}
      {textEdit !== null && (
        <Sheet title="Edit scope text" onClose={() => setTextEdit(null)}>
          <p className="small muted" style={{ marginBottom: 8 }}>
            Free-text edits are saved as a new version. Structured corrections will later replace them.
          </p>
          <textarea className="in" style={{ minHeight: "55vh", fontSize: 15 }} value={textEdit} onChange={(e) => setTextEdit(e.target.value)} />
          <button
            className="btn primary big"
            style={{ marginTop: 10 }}
            onClick={() => run("text", () => api<VisitData>(`${base}/text`, { method: "PUT", body: { text: textEdit } })).then(() => setTextEdit(null))}
          >
            Save text
          </button>
        </Sheet>
      )}
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function QuestionCard({ text, reason, onAnswer, disabled }: { text: string; reason: string | null; onAnswer: (a: string) => void; disabled: boolean }) {
  const [a, setA] = useState("");
  return (
    <div className="card">
      <div style={{ fontWeight: 600 }}>{text}</div>
      {reason && <div className="small muted">{reason}</div>}
      <form
        className="row"
        style={{ marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (a.trim()) onAnswer(a.trim());
        }}
      >
        <input className="in grow" value={a} onChange={(e) => setA(e.target.value)} placeholder="Answer" />
        <button className="btn" disabled={disabled || !a.trim()}>
          Answer
        </button>
      </form>
    </div>
  );
}

function RecCard(p: { room: string; text: string; rationale: string | null; disabled: boolean; onDecide: (a: "accept" | "reject", text?: string) => void }) {
  const [text, setText] = useState(p.text);
  return (
    <div className="card">
      <div className="small muted">{p.room}</div>
      <input className="in" style={{ marginTop: 4 }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Suggestion text" />
      {p.rationale && <div className="small muted" style={{ marginTop: 4 }}>{p.rationale}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn green grow" disabled={p.disabled} onClick={() => p.onDecide("accept", text)}>
          Accept
        </button>
        <button className="btn grow" disabled={p.disabled} onClick={() => p.onDecide("reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}

function AddBullet({
  ws,
  onAdd,
  disabled,
  prominent = false,
}: {
  ws: WorkspaceData;
  disabled: boolean;
  prominent?: boolean;
  onAdd: (b: { locationId: string | null; category: string; text: string; status: string }) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [b, setB] = useState({ locationId: "", category: "note", text: "", status: "proposed" });
  if (!open)
    return (
      <button className={prominent ? "btn big" : "btn ghost sm"} style={{ marginTop: 8 }} onClick={() => setOpen(true)}>
        + Add a bullet
      </button>
    );
  return (
    <div className="card stack" style={{ marginTop: 10 }}>
      <div className="grid2">
        <select className="in" value={b.locationId} onChange={(e) => setB({ ...b, locationId: e.target.value })} aria-label="Room">
          <option value="">Project-wide</option>
          {ws.locations.map((l) => (
            <option key={l.id} value={l.id}>
              {locLabel(l)}
            </option>
          ))}
        </select>
        <select className="in" value={b.category} onChange={(e) => setB({ ...b, category: e.target.value })} aria-label="Type">
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </div>
      <input className="in" placeholder="Bullet text" value={b.text} onChange={(e) => setB({ ...b, text: e.target.value })} />
      <select className="in" value={b.status} onChange={(e) => setB({ ...b, status: e.target.value })} aria-label="Status">
        {ITEM_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <div className="row">
        <button
          className="btn primary grow"
          disabled={disabled || !b.text.trim()}
          onClick={async () => {
            await onAdd({ ...b, locationId: b.locationId || null });
            setB({ ...b, text: "" });
            setOpen(false);
          }}
        >
          Add
        </button>
        <button className="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function BulletSheet(p: {
  ws: WorkspaceData;
  item?: ScopeItem;
  equip?: Equipment;
  onClose: () => void;
  openEvidence: (id: string) => void;
  onSaveItem: (id: string, patch: Record<string, unknown>) => void;
  onSaveEquip: (id: string, patch: Record<string, unknown>) => void;
}) {
  const { item, equip } = p;
  const [text, setText] = useState(item?.text ?? "");
  const [status, setStatus] = useState<string>(item?.status ?? equip?.status ?? "");
  const [loc, setLoc] = useState(item?.locationId ?? "");
  const [qty, setQty] = useState(equip?.quantity == null ? "" : String(equip.quantity));
  const evidence = item ? p.ws.evidence.filter((e) => item.evidenceIds.includes(e.id)) : [];
  const source = item?.source ?? equip?.source ?? "pm";
  const flags = item?.flags ?? equip?.flags ?? [];

  return (
    <Sheet title={item ? "Edit bullet" : "Edit equipment"} onClose={p.onClose}>
      <div className="stack">
        {item && (
          <>
            <textarea className="in" style={{ minHeight: 90 }} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="grid2">
              <label className="field">
                <span>Status</span>
                <select className="in" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {ITEM_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Room</span>
                <select className="in" value={loc} onChange={(e) => setLoc(e.target.value)}>
                  <option value="">Project-wide</option>
                  {p.ws.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {locLabel(l)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              <button className="btn primary grow" onClick={() => p.onSaveItem(item.id, { text, status, locationId: loc || null })}>
                Save
              </button>
              <button className="btn danger" onClick={() => p.onSaveItem(item.id, { remove: true })}>
                Remove
              </button>
            </div>
          </>
        )}
        {equip && (
          <>
            <div className="small muted">{equip.type.replace(/_/g, " ")}</div>
            <div className="grid2">
              <label className="field">
                <span>Quantity (blank = not specified)</span>
                <input className="in" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
              </label>
              <label className="field">
                <span>Status</span>
                <select className="in" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {EQUIPMENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              <button className="btn primary grow" onClick={() => p.onSaveEquip(equip.id, { quantity: qty === "" ? null : Number(qty), status })}>
                Save
              </button>
              <button className="btn danger" onClick={() => p.onSaveEquip(equip.id, { remove: true })}>
                Remove
              </button>
            </div>
          </>
        )}

        <h3>Source</h3>
        <div className="small">
          <span className="chip">{SOURCE_LABEL[source]}</span>
          {(item?.carriedForward || equip?.carriedForward) && <span className="chip amber" style={{ marginLeft: 6 }}>carried forward</span>}
        </div>
        {flags.map((f, i) => (
          <div key={i} className="small" style={{ color: "var(--fire)" }}>
            ⚑ {f}
          </div>
        ))}
        {evidence.length > 0 && (
          <div className="stack">
            {evidence.map((e) => (
              <button key={e.id} className="list-item" onClick={() => p.openEvidence(e.id)}>
                <div className="small muted">
                  Page {e.page}, photo {e.photoIndex}
                </div>
                <div>{e.caption || <span className="muted">No caption</span>}</div>
              </button>
            ))}
          </div>
        )}
        {item && !evidence.length && <div className="small muted">No photo evidence linked.</div>}
      </div>
    </Sheet>
  );
}

function ChecklistBlock(p: {
  ws: WorkspaceData;
  data: VisitData;
  base: string;
  busy: boolean;
  aiReady: boolean;
  onRun: (templateId: string) => void;
  copy: (t: string, what: string) => void;
}) {
  const type = p.data.visit.type as VisitType;
  const sorted = [...p.ws.templates].sort((a, b) => Number(b.visitTypes.includes(type)) - Number(a.visitTypes.includes(type)));
  const [tpl, setTpl] = useState(p.data.visit.facts.checklist?.templateId ?? sorted[0]?.id ?? "");
  const checklistText = type === "checklist" ? null : p.data.checklist?.text;
  return (
    <>
      <h2>Checklist information</h2>
      <div className="card stack">
        {p.aiReady ? (
        <div className="row">
          <select className="in grow" value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Checklist template">
            {sorted.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={p.busy || !tpl} onClick={() => p.onRun(tpl)}>
            Fill checklist
          </button>
        </div>
        ) : (
          <p className="small">
            Filling a checklist from your notes is an AI feature and is off. You can edit checklist templates in Settings; checklist
            items you need now can be added to the scope as bullets.
          </p>
        )}
        <p className="small muted">Applicable ≠ completed. Items are only “completed” when your notes say so. Edit templates in Settings.</p>
        {checklistText && (
          <>
            <pre className="manual-text small">{checklistText}</pre>
            <div className="row">
              <button className="btn sm" onClick={() => p.copy(checklistText, "Checklist")}>
                Copy checklist
              </button>
              <a className="btn sm" href={`${p.base}/export?format=pdf&checklist=1`}>
                PDF
              </a>
              <a className="btn sm" href={`${p.base}/export?format=docx&checklist=1`}>
                DOCX
              </a>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function NewVisitForm({ ws, projectId, onCreated, onCancel }: { ws: WorkspaceData; projectId: string; onCreated: (id: string) => void; onCancel?: () => void }) {
  const [type, setType] = useState<VisitType>(ws.visits.length ? "daily_monitoring" : "initial_assessment");
  const [date, setDate] = useState(todayNY());
  const [appt, setAppt] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="card stack">
      <h3 style={{ marginTop: 0 }}>New visit</h3>
      <div className="stack">
        {VISIT_TYPES.map((t) => (
          <button key={t} className={`btn ${type === t ? "on" : ""}`} style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => setType(t)}>
            {type === t ? "● " : "○ "}
            {VISIT_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="grid2">
        <label className="field">
          <span>Date (New York time)</span>
          <input className="in" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Appointment time (optional)</span>
          <input className="in" type="time" value={appt} onChange={(e) => setAppt(e.target.value)} />
        </label>
      </div>
      <p className="small muted">Arrival/departure times and access outcome start blank — nothing is copied from the last visit.</p>
      {err && <div style={{ color: "var(--fire)" }}>{err}</div>}
      <div className="row">
        <button
          className="btn primary grow big"
          onClick={async () => {
            try {
              const r = await api<{ visit: { id: string } }>(`/api/projects/${projectId}/visits`, { body: { type, visitDate: date, appointmentTime: appt || null } });
              onCreated(r.visit.id);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Start visit
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
