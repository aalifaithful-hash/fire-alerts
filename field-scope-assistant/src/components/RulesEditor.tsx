"use client";
import { useEffect, useState } from "react";
import Header from "./Header";
import { api } from "./api";
import type { Rules, RulesSection } from "@/lib/defaults";

type State = { rules: Rules; overridden: RulesSection[]; defaults: Rules; labels: Record<RulesSection, string> };

/**
 * Settings → Rules. Every professional default (src/lib/defaults.ts) can be
 * changed here per section. Changes are validated before saving; "Reset"
 * returns a section to the default.
 */
export default function RulesEditor() {
  const [st, setSt] = useState<State | null>(null);
  const [text, setText] = useState<Partial<Record<RulesSection, string>>>({});
  const [msg, setMsg] = useState<Partial<Record<RulesSection, { ok: boolean; text: string }>>>({});

  const load = async () => {
    const s = await api<State>("/api/rules");
    setSt(s);
    setText(Object.fromEntries(Object.keys(s.rules).map((k) => [k, JSON.stringify(s.rules[k as RulesSection], null, 2)])));
  };
  useEffect(() => {
    void load();
  }, []);

  if (!st) return (<><Header crumb="Rules & defaults" /><main className="page muted">Loading…</main></>);

  const save = async (k: RulesSection) => {
    let value: unknown;
    try {
      value = JSON.parse(text[k] ?? "");
    } catch {
      setMsg({ ...msg, [k]: { ok: false, text: "Not valid JSON — check commas and quotes." } });
      return;
    }
    try {
      const s = await api<{ rules: Rules; overridden: RulesSection[] }>(`/api/rules/${k}`, { method: "PUT", body: { value } });
      setSt({ ...st, ...s });
      setMsg({ ...msg, [k]: { ok: true, text: "Saved. New analyses use this value." } });
    } catch (e) {
      setMsg({ ...msg, [k]: { ok: false, text: (e as Error).message } });
    }
  };
  const reset = async (k: RulesSection) => {
    const s = await api<{ rules: Rules; overridden: RulesSection[] }>(`/api/rules/${k}`, { method: "DELETE" });
    setSt({ ...st, ...s });
    setText({ ...text, [k]: JSON.stringify(s.rules[k], null, 2) });
    setMsg({ ...msg, [k]: { ok: true, text: "Reset to the default." } });
  };

  return (
    <>
      <Header crumb="Rules & defaults" />
      <main className="page">
        <p className="small muted" style={{ marginTop: 4 }}>
          These are the professional defaults the room analysis, line items, exclusions, deadlines and FNOL parser use. Change any value and save;
          Reset brings back the default. They are starting points for the PM to confirm — nothing here auto-accepts work.
        </p>
        {(Object.keys(st.labels) as RulesSection[]).map((k) => (
          <details key={k} className="card" style={{ marginTop: 10 }}>
            <summary>
              {st.labels[k]}
              {st.overridden.includes(k) && (
                <span className="chip amber" style={{ marginLeft: 8 }}>
                  changed
                </span>
              )}
            </summary>
            <textarea
              className="in mono"
              style={{ minHeight: 220, marginTop: 8, fontSize: 13 }}
              value={text[k] ?? ""}
              onChange={(e) => setText({ ...text, [k]: e.target.value })}
              aria-label={`${st.labels[k]} JSON`}
              spellCheck={false}
            />
            {msg[k] && <div className="small" style={{ color: msg[k]!.ok ? "var(--green)" : "var(--fire)", marginTop: 6 }}>{msg[k]!.text}</div>}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={() => save(k)}>
                Save
              </button>
              <button className="btn ghost" disabled={!st.overridden.includes(k)} onClick={() => reset(k)}>
                Reset to default
              </button>
            </div>
          </details>
        ))}
      </main>
    </>
  );
}
