"use client";
import { useState } from "react";

export default function Login() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="page" style={{ maxWidth: 420, paddingTop: 80 }}>
      <div className="brand" style={{ fontSize: 30 }}>
        Field <b>Scope</b> Assistant
      </div>
      <p className="muted" style={{ margin: "8px 0 20px" }}>Enter the passcode to open your projects.</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr("");
          const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: code }) });
          setBusy(false);
          if (r.ok) window.location.reload();
          else setErr("Wrong passcode.");
        }}
      >
        <input className="in" type="password" autoFocus autoComplete="current-password" placeholder="Passcode" value={code} onChange={(e) => setCode(e.target.value)} />
        {err && <div style={{ color: "var(--fire)" }}>{err}</div>}
        <button className="btn primary big" disabled={busy || !code}>
          Open
        </button>
      </form>
    </main>
  );
}
