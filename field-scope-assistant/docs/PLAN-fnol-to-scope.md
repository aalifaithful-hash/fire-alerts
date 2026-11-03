# Plan: Slack FNOL intake → senior-PM scope

Status: **phases a1–a3, a7, the data-model split and the room workflow (c, d1, d4, e1–e2) are built**; the rest is planned. Nothing in this plan adds Slack tokens, AI keys, payment, or Vercel settings. Every phase keeps the current no-AI behavior working.

Revision 2 (Nov 3): adds a professional critique, sketch output, the room-by-room scan workflow, and customer-preference exclusions.
Revision 3 (Nov 3): owner decision to proceed with professional defaults. See "Build status" and "Defaults chosen" below.

## Build status (Nov 3, revision 3)

The owner decided: no more questions; build with the best professional defaults. Every default is listed below and can be changed in the app under **Settings → Rules & defaults**. That page is backed by one file, `src/lib/defaults.ts`, and no default is hard-coded anywhere else.

**Built** (rules only, no AI; no Slack token, AI key, passcode, payment or Vercel setting changes):

| Piece | Where |
|---|---|
| a1–a3 Paste-in FNOL inbox, rules-based parser, review and edit before saving | `/inbox`, `src/lib/fnol.ts`, `src/lib/intake.ts` |
| Properties with multiple assignments and full history, same-claim linking, property page (year built, multi-unit and adjacent-unit checks) | `/properties/:id` |
| a7 Program deadline timers from FNOL receipt | `deadlinesFor()` and the review screen |
| Data model: kind of work (service line) separate from kind of visit (stage); assignment → project → visit with the right output format | `visits.stage`, `visits.service_line` |
| e1–e2 Room-by-room scan: cause and location, affected materials and contents, manual measurements, proposed lines with math and justification, accept or reject, questions | project → **Scan** tab |
| c1 What-goes-with-it, c2b equipment math, c3 cleaning methods, c4/c7 estimator line items, c5 reconstruction only when requested, c8 hazard flags, c9 exclusions, c11 pre-send checks | `src/lib/roomRules.ts`, `src/lib/scans.ts` |
| d1 manual measurements and d4 sketch, printed after the scope in PDF and DOCX | `src/lib/takeoff.ts`, `src/lib/sketch.ts`, `src/lib/export.ts` |
| b5 (partial) moisture points with readings and dry goals per room | Scan tab, step 5 |
| h2 (cheap version) PM / estimator / crew views of the accepted lines | Scan tab → Views |

**Still planned:**
- a4–a5 Slack connection (needs a token added by the user).
- a6, c6, e3, f3 AI pieces (AI is off by owner decision).
- b2 a "Today" list across all projects.
- b5 daily readings trended across visits.
- c2 crew calculator (needs production rates; crew counts stay PM-entered, e.g. "CC+4").
- c10 supplements.
- d2–d3 scan-app import and a native LiDAR app.
- f1–f2 checklist by program.
- h1 offline capture.
- h2 real per-user roles.

## Defaults chosen

All values are in `src/lib/defaults.ts` and editable under Settings → Rules & defaults (one section per row group). They are starting points for the PM to confirm. Nothing is ever accepted automatically.

| # | Section | Default | Notes |
|---|---|---|---|
| 1 | Cleaning methods | **Cat 1:** extract, dry structure in place, clean affected hard surfaces | Basis: S500 practice |
| 1 | | **Cat 2 (gray):** extract, remove porous materials in contact (e.g. carpet pad), antimicrobial, clean the remainder | |
| 1 | | **Cat 3 (black):** extract, remove porous materials in contact (carpet, pad, drywall, insulation), flood cut, antimicrobial, evaluate contents for disposal with customer sign-off | |
| 1 | | **Dry smoke:** HEPA vacuum + dry chemical sponge. **Wet smoke:** degreaser wet-clean. **Protein smoke:** degreaser + odor control | Chosen per room by smoke type |
| 1 | | **Heavy char/soot on non-porous:** clean. **Porous with heavy deposits:** seal (stain-blocking primer) or remove. **Odor:** HEPA air scrubber + deodorization as needed | |
| 2 | What goes with it | **Baseboard removed:** replace baseboard, paint baseboard, seal/prime and paint the **full continuous wall to the natural break** | Corner to corner, openings deducted |
| 2 | | **Flooring replaced:** the **full continuous run to the natural break** (rooms that share a run name), reinstall base and transitions at each opening, detach and reset floor fixtures (toilet, vanity, appliances) | An unaffected room in the run is included, with the reason stated |
| 2 | | **Drywall flood cut:** remove insulation to the cut line; replace drywall (hang, tape, finish); seal/prime and paint to the natural break | |
| 2 | | **Cabinets:** remove the toe kick for drying access, or detach; reset and reattach when detached or when the flooring under them is replaced; reconnect countertop, plumbing and appliances | |
| 2 | | **Ceiling stain:** seal (stain-blocking) and paint the full ceiling | |
| 3 | Equipment ratios | 1 air mover per **50–70 SF** of wet floor (range shown, midpoint suggested) | Shown as "calculated, not installed". The installed count is only what the PM records |
| 3 | | 1 LGR dehumidifier (~70–130 pints/day AHAM) per **1,000–1,500 SF** of affected space / drying chamber | Visit-level summary |
| 3 | | **1 HEPA air scrubber** per affected area for fire, smoke, odor or Category 3 | |
| 4 | Flood cut | **24" above the highest wet line / wicking**; **12"** margin for Cat 1 with low wicking (≤ 6" wet); rounded up to sheet-efficient stops **12 / 24 / 48 / 96"** (so damage above 24" goes to 48", more goes to 96"); insulation removed to the cut line | Auto only for Cat 2/3 drywall. Cat 1 dries in place unless the PM sets a height. Plaster is never auto-cut (the app asks) |
| 5 | Line-item format | Xactimate-style **Activity \| Item \| Quantity \| Unit \| Rate \| Total \| Notes/Justification**; each line carries room, calculation, justification and evidence (moisture points) | Rates and totals stay blank until pricing is configured. Optional house category codes |
| 6 | Exclusions | A customer decline is recorded explicitly: target (contents cleaning / pack-out / all contents / room / service line), reason, who decided, date, signature status. The scope prints an **Exclusions** section ("Contents cleaning and pack-out excluded at the customer's request (date, decided by…). This scope covers the structure only…"), and "signature required" until signed | Never silently dropped. Excluded lines stay visible as "excluded". Moving contents to access the structure is kept |
| 7 | Category-change flag | Asks hours since loss and water source. Flags possible Cat 1 → 2 after **48 h** and → 3 after **72 h**. Sewage, toilet with feces, flood and groundwater are normally **Cat 3**. Toilet overflow, dishwasher, washing machine and sump pump are at least **Cat 2** | The flag never changes the category; the PM confirms it |
| 8 | Program deadlines | "Default program": customer contact **1 h**, on site **4 h**, estimate upload **24 h** from FNOL receipt (the "Received:" time in the FNOL, else the time it was saved) | Add programs with names and keywords |
| — | Hazards | Lead-safe (RRP) flag for buildings **before 1978**. Asbestos survey/clearance note on every demolition line (NYC requires an investigation before most demolition). Unknown year built raises a question | Demolition lines carry "pending hazard clearance" |
| — | FNOL keywords | The words that identify EMS, mitigation, reconstruction, contents, contents-only, special assignment, and initial / final / monitoring / kickoff | Edit to match your dispatch wording |
| — | Reconstruction | Not estimated unless "Reconstruction estimate requested" is switched on for the visit. Otherwise listed as "Pending reconstruction (separate assignment, not estimated)" | Per the requirement |
| — | Initial stage | An FNOL with no stage words is assumed to be an **initial walk-through**, and the review screen shows "assumed — confirm" | |

## The requirement, as given

> Connect to Slack to get the FNOL (First Notice of Loss): what kind of assignment this is when we receive it, and the history of the assignment. Is this an initial walk-through or a final walk-through? Is it EMS, mitigation, reconstruction or only contents cleaning? Is it a special assignment?
> Keep the history of the project, in case we do multiple daily monitoring visits on the same project or on a different project.
> The result is a complete scope written as a senior project manager would write it, including how many crew chiefs and how many subs the job needs.
> State the water category (or fire or smoke) and the proper way of cleaning it.
> Write the scope for an estimator too. The estimator usually needs to know what percent of the floor, walls and ceiling is being cleaned, and the square footage being removed, including what is behind it.
> Do not write a reconstruction estimate unless instructed to. If one is requested, write it for an estimator.
> Examples: if the baseboard is removed, the full continuous wall gets painted. For flooring damage, account for the continuous flooring and everything that goes with replacing it. Even contents and cabinets need to be reattached, and so on.
> Don't rely only on CompanyCam PDFs: take measurements with the phone's laser, measure windows and doors, and measure continuous rooms.
> Point to the cause of the loss, analyze the result and the damage, and ask for clarification to complete the scope.
> Upload a photo of a checklist and fill it out from what the app already knows about the project: monitoring, initial mitigation, reconstruction or final walk-through.
> This will be reviewed by Claude and by the Servpro command project and the Servpro scope project.

Added Nov 3:

> - The Servpro command project and the Servpro scope project are Claude projects (on claude.ai). Based on the job, they should give their professional view: whether anything else needs to be added, or could be handled much better.
> - The app should produce a sketch of the affected areas after the scope, to go along with it.
> - Room-by-room scan: after the user gives the cause of the loss in a room and where it is, the app analyzes that room. That means continuous flooring, and what needs to go in the scope (not only flooring, but walls or whatever goes with the cause of the loss), and whether there is any content damage in the room.
> - If the app has no clarification questions, the user can still modify the scope. Example: the customer does NOT want damaged contents cleaned or packed out, only the damage to the structure. The scope must respect that, exclude content cleaning and pack-out, scope the structure only, and say so explicitly.

## About the Servpro command and scope projects

They are **claude.ai projects**, and they live outside this coding session. Their instructions and knowledge files were **not shared here**, so I cannot read them, and the app cannot read them automatically either.

The critique below is my own review, written as a senior Servpro PM/estimator. For those projects to review the plan directly, the user can do either of these:

- **Share their contents here:**
  - The project instructions (custom-instructions text).
  - The knowledge files: SOPs, scope templates, line-item conventions, program or carrier guidelines, sample scopes and estimates, checklists.
- **Paste this document into each project**, ask for its critique, and bring the answers back.

Anything shared can then be loaded into the app as **company rules** (the manuals feature, which needs AI for automatic rule extraction), or written up by hand as rule tables.

## Professional critique (senior Servpro PM / estimator view)

What the plan was missing, or could handle better. Each point names where it now lives in the phases.

1. **Speak the estimator's language: line items, not just prose.** Estimators build in Xactimate. Every scope line should carry, as structured data:
   - an activity (Remove, Replace, Detach & Reset, Clean, Apply, Monitor);
   - the material or item;
   - a quantity and unit (SF, LF, EA, DA, HR);
   - the room;
   - a mitigation-or-reconstruction tag;
   - a short justification.

   Use an optional category-code mapping in your house convention (for example WTR/DRY/CLN/PNT/FCC), configured by you, not guessed. The output becomes a line-item table the estimator can key in fast. No pricing. → **c4, c7**
2. **Every removal needs a justification.** Adjusters approve removals that are justified, for example: Cat 3 contact, wicking above X", material not restorable, mold present, a cavity that needs drying access. Each removal line carries a reason and links to its evidence (photo or reading). A removal without a justification is flagged. → **c7**
3. **Drying documentation is part of the scope, not an afterthought.** Following S500 practice, the plan needs:
   - a moisture map per room with reading points;
   - a dry goal per material, taken from an unaffected reference reading the PM enters;
   - daily readings per point;
   - daily atmospheric readings (temperature, RH, GPP) for outside, affected and dehumidifier exhaust.

   Monitoring visits become "readings vs dry goal", and drying is complete only when every point meets its goal. Readings are never invented. → **b5**
4. **An equipment calculation needs its formula shown.** Dehumidifier and air-mover counts come from cubic footage, water class, and wall and floor footage, using **your** company or S500-style ratios. The result is a labeled recommendation with the math, never an installed count. The installed count is what the PM records. → **c2b**
5. **Category can change over time.** Water can degrade to Category 3, depending on time since loss, contamination, and the source path. Ask for time since loss and the source path, and flag a possible category change for the PM to decide. The app never changes the category itself. → **e2**
6. **Hazard screening before any demolition.** Check building age. Before 1978, lead (EPA RRP) applies. Asbestos survey requirements apply in many jurisdictions; NYC requires an asbestos investigation before demolition in most buildings, and this user's jobs are in NYC. Also cover Cat 3 PPE and containment, electrical safety, and mold containment with negative air. Demolition lines stay "pending hazard clearance" until the PM confirms the survey result or exemption. → **c8**
7. **Multi-unit buildings need an adjacent-unit investigation.** Above, below and beside the source; common areas; building management access; certificate of insurance (COI) and elevator or work-hour rules; and who owns which loss (unit owner vs condo or co-op master policy). Each affected unit or claim is its own assignment, linked to the building. → **b4, e1**
8. **Program and SLA timing.** National-account and TPA programs have contact, arrival and estimate-upload deadlines, plus their own photo and documentation requirements. The FNOL timestamp should start those timers, and the program should select the checklist. Special assignments usually mean such a program. → **a7, f1**
9. **Customer decisions must be documented and signed.** When a customer declines work (for example contents cleaning), a senior PM gets a signed declination or waiver. The scope states the exclusion, and the checklist shows "declination: not documented" until it is signed. The same applies to work authorization and direction to pay, and to the non-salvageable contents list. The app never marks a form signed unless the PM confirms it. → **c9**
10. **Contents need a real workflow.** Contents work is one of: manipulation (move or block), on-site cleaning, or pack-out. It needs room-by-room inventory and photos, plus a non-salvageable list with customer sign-off. Contents is often its own assignment. → **c3, c9**
11. **Supplements and change orders.** Once a scope is approved, later additions are supplements, each with a reason, evidence and approval status. Today's draft versions help, but the estimator needs a "what changed since the approved scope" view. → **c10**
12. **Show the math.** Every number in the estimator section shows how it was computed, for example "Wall 14'2" × 8' = 113.3 SF − door 3'×6'8" = 93.3 SF". Then the estimator can check it in seconds. Unmeasured rooms show "not measured", never a guessed number. → **c4, d1**
13. **Mitigation-only scopes should say what's left.** Add a clear "Pending reconstruction (separate assignment / by others)" note listing confirmed removals that will need rebuild, without writing the reconstruction estimate unless it's requested. → **c5**
14. **The field reality: offline capture.** Basements, elevator lobbies and older buildings often have no signal. Notes, measurements, readings and photos must be capturable offline and synced later; today's autosave needs a connection. → **new phase h1**
15. **Quality check before it leaves the PM.** A pre-send checklist:
    - every room has a source or migration path;
    - every removal has a justification;
    - quantities have measurements;
    - the category is confirmed;
    - exclusions are documented;
    - equipment is calculated vs installed;
    - required photos are present.

    It's a QA gate, not a blocker. → **c11**
16. **Roles.** Today there's one passcode. A PM, an estimator and crew chiefs need different views (the estimator reads the line items; crew chiefs read the day's work orders). → **h2**
17. **Customer data from Slack.** FNOLs carry names, phones and addresses. Store only what's needed, keep it scoped per project, and apply the same deletion controls. Never post scope data back into Slack automatically. → **a4**

## Data-model corrections needed first

1. **The service line and the visit stage are different things.** The FNOL needs both:
   - Service lines on an assignment, one or more of: EMS, mitigation, reconstruction, contents cleaning.
   - The visit stage: initial walk-through, kickoff, daily monitoring, final walk-through.
   - A special-assignment flag plus a free-text reason, and the program or TPA.

   The existing visit types stay as output formats.
2. **An assignment is not always a project.** One property or claim can receive several assignments over time. An assignment links to a project, and projects stay isolated.
3. **Structured scope lines.** Each line holds: room, activity, item, quantity, unit, how the quantity was computed, mitigation-or-reconstruction, justification, evidence links, status (suggested, accepted, rejected or excluded) and source (PM, rule, measurement, AI). The existing scope bullets become a view of these lines.

## Phases (in the requested order)

Legend: **No AI** = works without an Anthropic key. **AI** = needs the key (currently off by the owner's decision). **AI-optional** = a useful no-AI version exists, and AI improves it later.

### (a) Slack FNOL intake

| Piece | AI? | What it does |
|---|---|---|
| a1. Assignments table and inbox | No AI | Each FNOL becomes an assignment: raw text, parsed fields, service lines, stage, special flag and reason, program, status (new, accepted, linked or closed) and history. Inbox actions: Accept, Link to project, or Create project. |
| a2. Paste-in FNOL | No AI | Paste or forward the text. The parser fills the fields, and the PM reviews and corrects them. Usable before Slack is connected. |
| a3. Deterministic FNOL parser | No AI | Rules built from **your real FNOL samples**. Unparsed fields are left blank and flagged, never guessed. |
| a4. Slack connection | No AI | A Slack app on the FNOL channel(s). Messages are verified with the signing secret, stored and parsed. Thread replies become assignment history. It needs a bot token and a signing secret in Vercel (**added by the user later**). It reads only, with nothing posted back automatically, and stores minimal customer data. |
| a5. Backfill | No AI | A one-time import of recent channel history. |
| a6. AI fallback parser | AI | For free-form FNOLs the rules can't read. |
| a7. Program and SLA timers | No AI | FNOL time starts the configured program deadlines (contact, on-site, estimate upload), shown on the inbox and project. The deadlines are set by you per program. |

### (b) Project history and daily monitoring

| Piece | AI? | What it does |
|---|---|---|
| b1. Assignment timeline | No AI | FNOL → visits (initial, monitoring days 1 to N, final) → drafts → Slack updates → documents. |
| b2. "Today" list across projects | No AI | Jobs due for monitoring today, visit number (Day 3), and last readings. Lists only, never mixed facts. |
| b3. Start next monitoring visit | No AI | Opens with the last visit's room structure, "carried, not confirmed". Times and access outcome are never copied. |
| b4. Related projects and buildings | No AI | Link the units and claims in one building, and record adjacent-unit investigation status (above, below, beside). Facts stay per project. |
| b5. Drying log | No AI | A moisture map per room (points, material), a dry goal per material from the PM's reference reading, daily readings, and daily atmospherics (temperature, RH, GPP). Monitoring output becomes "readings vs goal" per room. Drying is complete only when all points meet their goal. |

### (c) Senior-PM scope plus estimator output

| Piece | AI? | What it does |
|---|---|---|
| c1. Company rules engine | No AI | "What goes with it" expansions. Baseboard removed → paint the full continuous wall. Flooring replaced → continuous run to the natural break, plus underlayment, transitions, base and toe kick. Cabinets detached → reset and reattach, countertop and plumbing reconnect. Drywall flood cut → insulation behind, tape/float/texture, prime and paint. Each added line names its rule, and the PM accepts or rejects it. The rules come from your SOPs. |
| c2. Crew calculator | No AI | Crew chiefs and subs from **your production rates** and the measured scope, with the formula shown. The PM confirms it, and a typed "CC+4" always wins. |
| c2b. Equipment calculator | No AI | Dehumidifiers and air movers from cubic footage, class, and wall and floor footage, using your ratios. A labeled recommendation with the math. The installed count comes only from the PM. |
| c3. Category, class and cleaning method | No AI | Category and class only as the PM states them. Cleaning and treatment from your table, keyed by loss type and category (water Cat 1/2/3; fire; smoke type; sewage; mold). Contents handling is one of: manipulation, on-site clean, or pack-out. |
| c4. Estimator section | No AI | Per room: the percentage of floor, wall and ceiling cleaned or affected; square footage removed, including what's behind; baseboard LF; opening deductions; **the math shown**. Unmeasured rooms are flagged. |
| c5. Reconstruction estimate only when asked | No AI | A per-visit switch, off by default. Without it, mitigation scopes list "Pending reconstruction (separate assignment)" items without estimating them. |
| c6. Senior-PM prose | AI | A polished narrative from confirmed facts. Without AI, the deterministic renderer writes the structured scope. |
| c7. Line-item table and justifications | No AI | Estimator-ready lines: activity, item, quantity, unit, room, mitigation-or-reconstruction, justification, and evidence. Optional house category codes. Exported in the scope PDF and DOCX, and as CSV. |
| c8. Hazard gate | No AI | Building year and jurisdiction trigger lead and asbestos flags. Demolition lines stay "pending hazard clearance" until the PM records the result or exemption. |
| c9. Exclusions and customer decisions | No AI | See the customer-preference section below. |
| c10. Supplements | No AI | After a scope is marked approved, changes are tracked as supplements, each with a reason, evidence and approval status, plus a "changes since approved" view. |
| c11. QA gate before sending | No AI | Lists what's missing (source, justification, measurements, category, documented exclusions, photos). It warns but doesn't block. |

### (d) Measurements and sketch

Web pages cannot use iPhone LiDAR, and iOS Safari cannot connect to Bluetooth lasers.

| Piece | AI? | What it does |
|---|---|---|
| d1. Fast manual entry | No AI | Room length, width and height; wall-by-wall lengths for odd shapes; doors and windows (size, which wall); continuous runs across rooms. Computes floor, wall and ceiling SF and perimeter minus openings, with the math shown. Works with any laser by reading its display. |
| d2. Import from a scanning app | No AI | Import exports from the tool you already use (DocuSketch, magicplan, Polycam, RoomScan, Canvas), depending on its export format. |
| d3. Native iOS companion app (Apple RoomPlan) | No AI | A LiDAR scan returning walls, doors, windows and openings. A separate app, built only if d1 and d2 aren't enough. |
| **d4. Sketch of affected areas (new)** | No AI | An SVG floor sketch generated from the measurements. It shows rooms and openings to scale; the source location; affected areas (flooring, wall segments with flood-cut height, ceiling area); moisture points and equipment placement; continuous-flooring runs; and excluded areas. A legend shows mitigation vs reconstruction. It's included after the scope in the PDF and DOCX exports and viewable in the app. Rectangles and L-shapes first, from d1. An imported floor plan from d2 can be the base layer. Rooms without measurements appear as labeled boxes "not to scale". |

### (e) Room-by-room scan workflow (cause + location → room analysis → scope lines)

This is the main field flow. One room at a time:

1. **Pick or create the room**, in floor → unit → room order.
2. **Cause and location in this room.** Either the source is in the room (fixture or line, for example under the sink or a supply line behind the toilet), or the water migrated in (from above, below, an adjacent room or the exterior). Where: which wall or walls, ceiling area, floor area, or a spot on the room sketch. Plus source status (repaired, stopped, active or unknown) and time since loss.
3. **Affected materials**, as quick checkboxes:
   - flooring type;
   - baseboard;
   - wall material (drywall or plaster) and wet height;
   - ceiling;
   - cabinets;
   - insulation;
   - trim and casing;
   - fixtures;
   - contents present and affected (yes or no; type: furniture, soft goods, electronics, boxes).
4. **Measurements** (d1/d2), or "not measured yet".
5. **Room analysis**, with deterministic rules and no AI:
   - **Continuous flooring:** the flooring type and every room it runs into without a natural break (the PM ticks the connected rooms, and breaks are marked at thresholds and transitions). Flooring lines cover the whole continuous run when removal or replacement is approved, and note the break points.
   - **Walls:** for each affected wall, baseboard LF, flood-cut SF at the chosen height, insulation behind, and outlets and trim to detach. Baseboard removed → paint the full continuous wall, corner to corner.
   - **Ceiling:** stain → seal and paint the ceiling; removal → SF plus insulation above. Fire or smoke → stain-blocking primer and odor seal.
   - **Cabinets:** detach and reset, toe kick, countertop and plumbing reconnect, and cavity drying access.
   - **Contents:** affected contents produce manipulation, cleaning or pack-out lines, unless excluded (see below).
   - **Mitigation vs reconstruction:** each line is tagged. Reconstruction lines appear only if requested (c5); otherwise they're listed as "pending reconstruction".
6. **Scope lines are proposed** with quantities, the math and justifications. The PM accepts, edits or rejects each one.
7. **Clarification questions**, only those that change the work. Examples: source stopped? Category confirmed, or possible change over time? Drying only, or removal approved? Is the flooring continuous into the hallway? Hazard survey done? What's above or below this unit? Answered questions are never re-asked.
8. **AI later (off now):** photo analysis around the marked source proposes affected areas and extra questions (e3).

| Piece | AI? |
|---|---|
| e1. Per-room cause and location capture (steps 1–3) | No AI |
| e2. Room analysis and rules-based questions (steps 5–7) | No AI |
| e3. Photo-based damage analysis | AI |

### Customer-preference modifications and exclusions (c9)

The scope is always editable, whether or not there are open questions. Modifications can be:

- **Exclusions:** a structured record with:
  - what is excluded (contents cleaning, contents pack-out, a room, a material, a service line);
  - the scope it applies to (project, assignment, room);
  - the reason (customer declined, owner's own contractor, not covered, other);
  - who decided and when;
  - documentation status (verbal / signed declination).
- **Effects, enforced in code like today's drying-only rule:**
  - Matching lines are removed from the scope, and the rules engine and AI can't re-add them.
  - Existing matching lines are marked "excluded", not deleted, so history stays.
  - The scope gets an explicit **Exclusions** section. Example: "Contents cleaning and pack-out excluded at customer's request (11/3/2026). Scope covers structural mitigation only. Contents remain the customer's responsibility."
  - The checklist shows "customer declination: not documented" until the PM confirms it was signed.
  - The sketch marks excluded areas.
- **Entry without AI:** an "Exclude…" control on the scope, a room or a line. With AI later, a plain-language correction ("customer doesn't want contents cleaned") creates the same structured exclusion.
- **Reversible:** removing an exclusion restores the excluded lines as suggestions. A new version is saved either way.

### (f) Checklist photo auto-fill

| Piece | AI? | What it does |
|---|---|---|
| f1. Checklist templates per stage and program | No AI | Monitoring, initial mitigation, reconstruction, final walk-through. Program-specific templates are selected by the FNOL program. |
| f2. Fill from known facts | No AI | Completed only when the record says so; pending or not documented otherwise. Includes exclusions, declinations and hazard clearance. |
| f3. Read a photo of a paper checklist | AI | Needs vision AI. Without it, type the template once (f1). |

### (h) Field and team (new)

| Piece | AI? | What it does |
|---|---|---|
| h1. Offline capture | No AI | Notes, measurements, readings, room analysis and photos saved on the phone and synced when there's signal. |
| h2. Roles | No AI | PM, estimator and crew chief views, replacing the single passcode for teams. |

## Suggested order

a1–a3 (paste-in FNOL), then the data-model corrections, then e1–e2 with d1 (the room workflow with manual measurements; this is where most scope value comes from), then c1, c4, c7, c9 (rules, estimator lines, exclusions), then d4 (sketch), then b1–b5, then c2, c2b, c3, c8, c10, c11, then a4–a7 (once Slack is connected), then f2, then h1–h2. AI pieces (a6, c6, e3, f3) and d2–d3 wait on decisions.

## Inputs that would refine the defaults (optional — the app works without them)

**From the Servpro claude.ai projects (for a direct review)**
1. Each project's instructions text and knowledge files: SOPs, scope templates, line-item and category-code conventions, program or carrier guidelines, sample scopes and estimates, checklists.
2. Or paste this document into each project and share the critique it gives.

**Slack and FNOL**
3. The workspace and FNOL channel(s), and whether they're public, private or shared.
4. Who or what posts FNOLs: a person, a dispatch bot, an email forward, or an integration.
5. 3–5 redacted FNOL samples: EMS, mitigation, reconstruction, contents-only, a special assignment, and one initial and one final walk-through. Include a thread with updates.
6. The words or fields that identify each service line, the stage, and "special". The special-assignment types, and the programs or TPAs with their deadlines.
7. Whether updates arrive as thread replies or new messages, and the assignment number format.
8. Who can install a Slack app (a workspace admin; done later by the user).

**Scope rules and numbers**
9. Production rates per task, and the crew-chief-to-sub ratio.
10. Equipment ratios (dehumidifier and air-mover sizing).
11. Cleaning and treatment methods by loss type, category and smoke type.
12. "What goes with it" rules (flooring, baseboard and paint, cabinets, drywall, ceilings, contents).
13. Flood-cut height conventions and wicking allowance.
14. Hazard policy: building-year threshold, asbestos and lead survey requirements in your area.
15. Your estimator's preferred line format and category codes (or "plain English"), and one example scope or estimate they liked.
16. Your customer declination and waiver form, and when you require a signature.

**Measurements and sketch**
17. The team's phone (an iPhone Pro with LiDAR?) and the scan or measure app in use (DocuSketch?) with its export format. Is a separate iOS app acceptable later?
18. A sketch example you consider good: what must be on it (moisture points, equipment, flood-cut lines, north arrow).

**History**
19. Is "multiple daily monitoring on the same or a different project" a daily list across all jobs, linked projects in one building or claim, or both?

**Owner decisions (no action from me)**
20. AI stays off, so a6, c6, e3 and f3 wait.
21. Slack credentials (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`) are added in Vercel by the user when ready.
