"use client";

export default function SetupBanner() {
  return (
    <div className="card warn" style={{ marginBottom: 14 }}>
      <strong>AI analysis is not set up yet.</strong>
      <p className="small" style={{ marginTop: 6 }}>
        Projects, rooms, notes, uploads and manual editing work now. To read PDFs and draft scopes, add your Anthropic API key on the server:
      </p>
      <pre className="mono" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{`# field-scope-assistant/.env.local
ANTHROPIC_API_KEY=sk-ant-...`}</pre>
      <p className="small" style={{ marginTop: 6 }}>Then restart the server. The key stays on the server and is never sent to the browser.</p>
    </div>
  );
}
