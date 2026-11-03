"use client";

/**
 * Shown while no AI provider is configured (AI_PROVIDER + key). Every line below was checked against
 * the app's actual behavior without a key — keep it that way when editing.
 */
export const WORKS_WITHOUT_KEY = [
  "Projects, search, project details",
  "Floors, units and rooms",
  "Visits, visit times, access outcome and history",
  "Field notes, typed or dictated (saved automatically)",
  "Uploading CompanyCam PDFs and extracting their page text (Photos → View text)",
  "Writing the scope yourself: add, edit, move or remove bullets by room, or write free text",
  "Draft versions and restore",
  "Copy for Slack, PDF and DOCX export",
  "Editing checklist templates",
];

export const NEEDS_KEY = [
  "Reading the photos in a PDF and sorting them by room",
  "AI-drafted scopes from your notes and photos",
  "Plain-language corrections (“Bathroom is dry”) and AI questions/suggestions",
  "Auto-filling checklists",
  "Extracting rules from company manuals",
];

export default function SetupBanner() {
  return (
    <details className="card warn" style={{ marginBottom: 14 }}>
      <summary>
        <span>
          AI features are off — <u>see what works now</u>
        </span>
      </summary>
      <div className="small" style={{ marginTop: 8 }}>
        <strong>Works now, no key needed</strong>
        <ul style={{ paddingLeft: 18, margin: "4px 0 10px" }}>
          {WORKS_WITHOUT_KEY.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <strong>AI features (off until a key is added)</strong>
        <ul style={{ paddingLeft: 18, margin: "4px 0 10px" }}>
          {NEEDS_KEY.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <a href="/settings#ai-key">More about the AI features →</a>
      </div>
    </details>
  );
}
