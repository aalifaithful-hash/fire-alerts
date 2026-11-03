# Plan: Slack FNOL intake → senior-PM scope

Status: **proposal, not started.** Nothing in this plan adds Slack tokens, AI keys, payment, or Vercel settings. Every phase keeps the current no-AI behavior working.

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

## Two corrections to the current data model, needed first

1. **The service line and the visit stage are different things.** Today one field, the visit type, mixes them ("Initial mitigation scope", "Reconstruction scope", and so on). The FNOL needs both:
   - Service lines on an assignment, one or more of: EMS, mitigation, reconstruction, contents cleaning.
   - The stage of each visit: initial walk-through, kickoff, daily monitoring, final walk-through.
   - A special-assignment flag plus a free-text reason, and the program or TPA when one is given.

   The existing visit types stay as output formats, chosen from service line plus stage.
2. **An assignment is not always a project.** One property or claim can receive several assignments over time, for example EMS first, then reconstruction. An assignment links to a project. Project data stays isolated as it is today.

## Phases (in the requested order)

Legend: **No AI** = works without an Anthropic key. **AI** = needs the key (currently off by the owner's decision). **AI-optional** = a useful no-AI version exists, and AI improves it later.

### (a) Slack FNOL intake

| Piece | AI? | What it does |
|---|---|---|
| a1. Assignments table and inbox screen | No AI | Each FNOL becomes an assignment record. It holds the raw text, the parsed fields, the service lines, the visit stage, the special-assignment flag and reason, status (new, accepted, linked or closed) and its history. An inbox lists new assignments with Accept, Link to existing project, or Create project. |
| a2. Paste-in FNOL | No AI | Paste or forward an FNOL message's text. The parser fills the fields, and the PM reviews and corrects them before saving. Usable before any Slack connection exists. |
| a3. Deterministic FNOL parser | No AI | Rules built from **your real FNOL samples**: labels, keywords and patterns for claim number, carrier or TPA, insured, contact, address and unit, loss date, loss type, service lines, stage and special assignment. Unparsed fields are left blank and flagged, never guessed. |
| a4. Slack connection | No AI | A Slack app subscribed to the FNOL channel(s). Each new message or thread reply is verified with Slack's signing secret, stored and parsed. Thread replies become assignment history (for example "final walk-through scheduled Monday"). It needs a bot token and a signing secret as Vercel environment variables. **The user adds those later. I won't.** |
| a5. Backfill | No AI | A one-time import of recent channel history, so past assignments and their threads appear. |
| a6. AI fallback parser | AI | For free-form FNOLs the rules can't read. Off until a key exists. |

Assignment fields shown to the PM always come from the FNOL text or from PM edits. Each field keeps a link to the Slack message it came from.

### (b) Project history and daily monitoring

| Piece | AI? | What it does |
|---|---|---|
| b1. Assignment timeline per project | No AI | FNOL, then each visit (initial, monitoring days 1 to N, final), drafts, Slack updates and documents, in time order. |
| b2. "Today" list across projects | No AI | Which projects need daily monitoring today, the last visit date, and the visit number (Day 3 of monitoring). It shows lists only, never mixed facts. |
| b3. Start next monitoring visit | No AI | Opens a new monitoring visit with the room structure from the last visit, marked "carried, not confirmed" as today. Times and access outcome are never copied. This uses the existing carry-forward rules. |
| b4. Related projects | No AI | Optional link between projects for the same building or the same claim, shown as a list. Facts stay per project unless the PM copies something explicitly. |

### (c) Senior-PM scope plus estimator output

| Piece | AI? | What it does |
|---|---|---|
| c1. Company rules engine | No AI | Configurable rules that expand a confirmed item into everything that goes with it. Examples: baseboard removed → paint the full continuous wall. Flooring replaced → continuous flooring to the next break, plus underlayment, transitions, toe kick and base. Cabinets detached → reset or reattach, then countertop and plumbing reconnect as applicable. Each added line is labeled with the rule that produced it, so the PM can accept or reject it. The rules come from your manuals and SOPs. |
| c2. Crew calculator | No AI | Crew chiefs and subs come from **your production rates** (for example sq ft per sub per day for each task) and the confirmed scope and measurements. The output is labeled "calculated: formula shown", and the PM confirms it. A typed count such as "CC+4" always wins. This keeps today's rule against invented crew counts. |
| c3. Category or class and cleaning method | No AI | Water category, fire or smoke type only as the PM states it (today's guard stays). Cleaning and treatment methods come from a rules table keyed by loss type and category. The table is supplied or approved by you, for example from your manuals or IICRC-based SOPs. |
| c4. Estimator section | No AI | For each room: the percentage of floor, wall and ceiling cleaned or affected; square footage removed, including materials behind it (drywall, insulation, vapor barrier) as entered; linear feet of baseboard; opening deductions. It is computed from measurements (phase d) and the affected extents the PM marks. Rooms with no measurements are flagged and left without numbers. |
| c5. Reconstruction estimate only when asked | No AI | A per-visit switch, "Reconstruction estimate requested", off by default. When on, it writes an estimator-format reconstruction section built from confirmed removals and the rules engine. |
| c6. Senior-PM prose | AI | Turning the confirmed facts and numbers into a polished senior-PM narrative. Without AI, the existing deterministic renderer produces the structured scope. |

### (d) Phone measurements

The constraint here is real: **web pages cannot use an iPhone's LiDAR.** Safari exposes neither LiDAR depth nor Bluetooth lasers to websites, so a pure web app needs one of these:

| Option | AI? | Notes |
|---|---|---|
| d1. Fast manual entry | No AI | Length, width and height per room; doors and windows (count and size); continuous runs that span rooms. It computes floor, wall and ceiling square footage and perimeter, minus openings. Works today on any phone, and works with any laser by reading off the display. |
| d2. Import from a scanning app | No AI | Import exports from the scan tool you already use, such as DocuSketch (in your checklist), magicplan, Polycam, RoomScan or Canvas. That depends on which one and its export format (CSV, PDF, JSON or ESX). |
| d3. Native iOS companion app (Apple RoomPlan) | No AI | Scans a room with LiDAR and returns walls, doors, windows and openings, which suits continuous rooms. It's a separate Swift app distributed through TestFlight or the App Store and sends results to this app. It's the biggest piece of work, so do it only if d1 and d2 aren't enough. |

### (e) Cause of loss plus clarification questions

| Piece | AI? | What it does |
|---|---|---|
| e1. Mark the source | No AI | Tag a room, a photo or a spot on the room sketch as the cause or source, with status (repaired, stopped, active or unknown) and the migration path (above, below, adjacent). |
| e2. Rules-based questions | No AI | Missing facts that change the scope generate short questions. Examples: is the source stopped? Which category? Drying only, or approved removal? What's above or below this unit? Same rule as today: never re-ask what's already answered. |
| e3. Damage analysis from photos | AI | Reading the photos around the source to propose affected areas and further questions. Off until a key exists. |

### (f) Checklist photo auto-fill

| Piece | AI? | What it does |
|---|---|---|
| f1. Checklist templates per stage | No AI | Monitoring, initial mitigation, reconstruction, final walk-through. These exist already and are editable in Settings. |
| f2. Fill from known facts | No AI | Marks items from project data: completed only when your notes or records say so, otherwise pending, not documented, and so on, as the app already does. |
| f3. Read a photo of a paper checklist | AI | Converting the photo into checklist items needs vision AI. Without AI, type the items once as a template (f1). |

### Review by "Claude, Servpro command project and Servpro scope project"

What these are is still an open question; see the list below. If they are projects in claude.ai, this app can't read them directly. Their instructions and files can be exported and uploaded as **company manuals** (already supported; rule extraction needs AI). The review step itself would be a review queue: drafts marked "ready for review", with reviewer comments and approve or return.

## Effort and order (rough)

a1–a3 first (paste-in works with no Slack). Then a4–a5 once the user connects Slack. Then b. Then c1–c5. Then d1. Then e1–e2. Then f2. The AI pieces (a6, c6, e3, f3) and d2 and d3 wait on decisions.

## What I need from the user before starting

**Slack and FNOL**
1. The Slack workspace name, and the channel(s) where FNOLs arrive. Say whether they're public, private or shared (Slack Connect) channels.
2. Who or what posts the FNOL: a person, a dispatch bot, an email-to-channel forward, or an integration (which one?).
3. **3–5 real FNOL messages, with names, phones and addresses redacted**, covering each type: EMS, mitigation, reconstruction, contents-only, a special assignment, and one initial and one final walk-through. Include a thread with updates if one exists.
4. How each is identified today. Which words or fields mean EMS vs mitigation vs reconstruction vs contents? Initial vs final walk-through? What makes an assignment "special", and are there sub-types?
5. Do later updates (reassignments, final walk-through requests) arrive as thread replies or as new messages? Is there an assignment number that ties them together?
6. Who can approve a Slack app in that workspace? Connecting needs a workspace admin to install it. The user does that later; I won't.

**Scope rules and numbers**
7. Production rates for the crew calculator, per task (for example sq ft extracted per hour, linear feet of baseboard per sub per day), and your rule for crew-chief-to-sub ratio.
8. Your cleaning and treatment methods by loss type: water Cat 1/2/3, fire, smoke (protein, wet, dry), sewage, mold. Use your SOP or manual pages, or approve a starter table I draft.
9. Your "what goes with it" rules: baseboard → full wall paint, flooring → continuous run plus what else, cabinets, contents. A list or SOP pages.
10. The estimator's expected format: an example of a scope your estimator liked (redacted).

**Measurements**
11. Which phone (an iPhone Pro with LiDAR?), and which scan or measure app the team already uses (DocuSketch?). Can it export, and in what format? Is a separate iOS app acceptable later?

**History and review**
12. "Multiple daily monitoring on the same project or a different project": is that a daily list across all jobs (b2), or linking related projects for the same building or claim (b4), or both?
13. What are the "Servpro command project" and "Servpro scope project"? Projects in claude.ai, documents, or people? Can their instructions or files be shared so they can be loaded as company rules?

**Owner decisions (no action from me)**
14. AI stays off. Phases a6, c6, e3 and f3 wait for that decision.
15. Slack credentials: the user adds `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in Vercel when ready.
