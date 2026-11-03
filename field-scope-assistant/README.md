# Field Scope Assistant

A mobile-first web app for a restoration project manager. It turns CompanyCam photo-report PDFs, photo captions and your field notes (typed or dictated) into room-by-room scopes and visit updates. You can then correct the result in plain language.

Workflow: **open a project → upload the CompanyCam PDF → type or dictate the loss and damage → generate → correct by voice or text → copy to Slack, or export a PDF or DOCX.**

## Setup

Requirements: Node.js 20 or later (tested on 22) and npm.

```bash
cd field-scope-assistant
npm install
cp .env.example .env.local      # then set ANTHROPIC_API_KEY
npm run dev                     # http://localhost:3000
```

For production the app runs on **Vercel + Neon Postgres + Vercel Blob** (current setup). It also runs on any Node host with a Postgres database.

### Hosting on Vercel (current)

- **Database:** Neon Postgres connected to the project. The integration sets `DATABASE_URL` / `POSTGRES_URL`. Tables are created and migrated automatically on first request; migrations only add columns or defaults and never drop data.
- **Files:** a **private** Vercel Blob store connected to the project, which sets `BLOB_READ_WRITE_TOKEN`. The browser uploads PDFs straight to Blob (any size up to 200 MB, so there is no 4.5 MB function-body limit). The server then reads the PDF from Blob to extract text and analyze pages. There are no public file URLs.
- **Links:** open the **production domain**. Deployment-specific URLs (`fire-alerts-<hash>-<team>.vercel.app`) are behind Vercel Deployment Protection, which shows a Vercel sign-in page to anyone not logged in to Vercel. Use `APP_PASSCODE` to protect the app itself.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` (or `POSTGRES_URL`) | Yes | Postgres connection, set by the Neon integration. Without it, API calls return a clear 503. |
| `BLOB_READ_WRITE_TOKEN` | Yes on Vercel | Private Blob store for PDFs and manuals, set by connecting the Blob store. Without it, uploads go through the server, which is fine locally but fails on Vercel. |
| `ANTHROPIC_API_KEY` | For AI features | Server-side only. Without it, everything except AI analysis works and the app shows setup instructions. |
| `APP_PASSCODE` | Recommended | Passcode screen for every page and API call. |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-opus-5-5`. |
| `DATA_DIR` | No | Local-only file storage when there is no Blob token. Default `./.data`. |

Local development: `DATABASE_URL=pglite://memory npm run dev` runs real Postgres in-process (data is lost on restart), or point it at a Neon dev branch.

### Without an Anthropic API key

Verified behavior with no `ANTHROPIC_API_KEY`:

- **Works:** projects and search, floors, units and rooms; visits, times, access outcome and history; field notes (typed or dictated, autosaved); PDF upload and storage; page-text extraction at upload (Photos → View text); writing the scope by hand (Start the scope manually, then add, edit, move or remove bullets, or Edit text); versions and restore; Copy for Slack, PDF and DOCX; checklist template editing.
- **Waits for the key:** AI photo analysis. Uploaded PDFs show "Photo analysis (AI): waiting for the Anthropic API key", and their batches stay queued (they are not failed). They run the next time the Photos tab is opened after the key is added.
- **Needs the key:** AI-drafted scopes, plain-language corrections, AI questions and suggestions, checklist auto-fill, and company-manual rule extraction.

**Turning AI on later:** set `ANTHROPIC_API_KEY` as a server environment variable and redeploy. Nothing else in the app changes. This is on hold for now by the owner's decision.

### Tests

```bash
npm test          # 35 tests on in-process Postgres (PGlite): rules, renderers, corrections, isolation,
                  # PDF pipeline, notes persistence through the real routes, Blob upload guards.
                  # Tests never use DATABASE_URL from your environment, so they cannot touch the hosted DB.
npm run typecheck
```

## What's implemented

**Screens.** All screens are phone-sized, with large controls and a light variant for sunlight.
- Project list with search, and a clearly labeled DEMO project you can load.
- Project workspace tabs:
  - **Scope**: visit picker and new visit; visit details (output type, date, appointment time, actual arrival and departure, access outcome); field notes with voice dictation; Generate; questions; suggestions you can accept, edit or reject; the editable scope; review flags; checklist; draft versions with restore; delete visit.
  - **Photos**: PDF upload with progress, per-report batch progress, retry and resume, and an evidence list grouped by room with "needs a room" first.
  - **Rooms**: floor → unit → room tree. Add, rename or delete rooms.
  - **History**: list of visits.
  - **Info**: all project fields (none required) and project deletion.
- **Persistent correction box** pinned to the bottom of the Scope tab, with a mic. After each correction it shows a short summary of what changed, or asks a one-line clarification.
- **Settings**: AI and passcode status, checklist template editor, company manual upload with extracted rules and flagged conflicts.

**PDF pipeline** (`src/lib/pdf.ts`, `service.ts → ingestPdf / processNextBatch`)
- Selectable text is extracted per page (`unpdf`). Pages with almost no text are marked as scanned and read visually.
- The report is split into 4-page sub-PDFs (`pdf-lib`). Each one is sent to Claude as a PDF document, together with that page's extracted text. Claude reads both the page images and the text, which covers OCR for scanned pages.
- Each photo keeps its own caption and its page and photo index. Floor, unit and room labels are detected. Low-confidence or ambiguous room assignments are flagged and never guessed. Unreadable pages are recorded as such.
- Batches are claimed atomically and retried up to 3 times. Batches interrupted mid-run (for example by a server restart) are released after 6 minutes. Oversized batches split into single pages. The UI resumes automatically and shows a progress bar.
- Tap any evidence item to see its PDF page rendered in the browser and reassign its room.

**Facts, kept separate from prose.** The AI never writes the final document. It returns schema-validated facts (structured outputs and Zod): items with category, status (reported, observed, proposed, approved, scheduled, in progress, completed, unknown) and source (your notes, accepted suggestion, your edit, photo, caption, prior visit), plus equipment with quantity and status, questions and recommendations. Deterministic renderers (`src/lib/render.ts`) then produce a separate format for each of the 8 visit types:
- Initial mitigation follows the bullet order from the brief.
- Monitoring lists equipment activity, then still elevated, now dry, changes, and remaining work.
- Final walk-through uses only confirmed completed work, keeps scheduled work separate, reports equipment removal and pickup status, and lists completion forms. It never says the file is closed.
- Reconstruction includes sequencing and access sections.
- Contents cleaning and initial assessment have their own formats.
- Checklist output groups items as Applicable, Completed, Pending, Not applicable or Not documented.

Source references appear only in the evidence panel (tap a bullet), not in the copy-ready text.

**Rules enforced in code**, not just in the prompt (`src/lib/guards.ts`), and re-run after every AI step and correction:
- Work the AI inferred becomes a *recommendation*, never a scope line. This covers antimicrobial, demolition, containment and extraction.
- "Drying only", "no demo" and similar phrases remove non-PM removal and cavity-access work and withhold demolition suggestions.
- `CC+N` is parsed as 1 crew chief + N subcontractors.
- An equipment count that doesn't appear in your notes, captions or the prior record is removed and flagged. A count seen only in a photo becomes a "confirm the count" flag.
- Numbers in bullets that don't appear anywhere in the record are flagged.
- Water category is dropped unless you stated it.
- "Completed" requires your words, or an earlier visit that recorded it as completed. Caption or photo "completion" is downgraded and flagged.
- Equipment stays "pickup scheduled" until you say it was picked up or removed. A dry room keeps its equipment.
- Conditions carried forward from the prior visit stay out of today's scope until you confirm them (for example "same as yesterday"). The review panel lists exactly what was carried.
- New visits never copy appointment times, arrival or departure times, or access outcome.

**Corrections** (`src/lib/patch.ts`). Your correction is turned into targeted operations: update, add or remove an item, update equipment, move a room's entries ("that's the closet, not the bedroom"), rename a room, set job info or a directive, answer a question, or set a visit field. Operations only touch what they name, so other rooms can't be dropped. A room name that matches more than one room (two units with a "Closet") stops the correction and asks "Which closet? …".

**Storage and exports.** Postgres (Neon) stores projects, page text, evidence, the room hierarchy, visits with their facts, and every draft version. Source PDFs live in the private Blob store. Each version records what triggered it, your correction text and the change summary, and any version can be restored. Exports: Copy for Slack (mrkdwn), plain text, PDF (`pdf-lib`) and DOCX (`docx`).

**Isolation and security**
- Every query is scoped by project id, and AI context is built only from that project. A test checks that another project's notes, rooms and evidence ids never reach a prompt or a scope.
- Uploads are served only through an authenticated route with `no-store`.
- The API key never leaves the server.
- Error logs contain the error type and message only, never document text.
- Deleting a project removes its files and records, and the delete controls cover projects, PDFs, visits, rooms, manuals and templates.
- All PDF and manual text is wrapped as evidence and treated as data, not instructions.

**Checklists and manuals.** Starter checklist templates are labeled "edit to match your company". Checklist "completed" requires an exact quote from your notes (checked in code). Uploaded manuals are turned into reusable rules that are stored separately from job facts. Rules that conflict with another manual are flagged as conflicts and never merged.

## Limitations and next steps

- **Live AI calls were not exercised during development.** No API key was available in the build environment. The Anthropic request code typechecks against the installed SDK (structured outputs and the refusal-fallback option), and every downstream step is tested with a faked model. The first real run should use a short PDF to check the extraction quality on your actual CompanyCam layouts.
- Photo-level crops aren't extracted. The evidence viewer shows the whole source page together with the photo index and caption.
- Voice dictation uses the browser's Web Speech API (Chrome, Edge, Safari). Where it isn't available, the phone keyboard's mic works in the same fields.
- Scanned company manuals (image-only PDFs) aren't supported yet. Manuals need selectable text or `.txt`.
- Single-user design: one passcode, no per-user accounts or audit of who changed what.
- Large PDFs are processed in the browser-driven batch loop. Keep the Photos tab open until it finishes. If it's interrupted, it resumes when you reopen the tab.
- Free-text "Edit text" edits are saved as a version but sit outside the structured facts. A later correction or regenerate replaces them, and the app warns you when that happens.
