"use client";

export default function SetupBanner() {
  return (
    <div className="card warn" style={{ marginBottom: 14 }}>
      <strong>AI analysis is not set up yet.</strong>
      <p className="small" style={{ marginTop: 6 }}>
        Projects, rooms, notes, uploads and manual editing work now. To read PDFs and draft scopes, the server needs an Anthropic API key
        named <span className="mono">ANTHROPIC_API_KEY</span>:
      </p>
      <ul className="small" style={{ marginTop: 6, paddingLeft: 18 }}>
        <li>Hosted on Vercel: Project → Settings → Environment Variables, then redeploy.</li>
        <li>Running locally: add it to <span className="mono">field-scope-assistant/.env.local</span> and restart.</li>
      </ul>
      <p className="small" style={{ marginTop: 6 }}>The key stays on the server and is never sent to the browser.</p>
    </div>
  );
}
