import {
  VISIT_TYPE_LABELS,
  type Category,
  type Equipment,
  type Location,
  type ScopeBullet,
  type ScopeDoc,
  type ScopeItem,
  type ScopeSection,
  type VisitFacts,
  type VisitType,
} from "./schemas";
import { floorLabel, fullLabel, norm, roomHeading, sortLocations } from "./locations";
import { equipmentName, isConfirmedForScope } from "./guards";
import { formatDate, formatTime } from "./time";
import type { Project } from "./types";

export interface RenderInput {
  project: Project;
  visit: {
    type: VisitType;
    visitDate: string;
    appointmentTime: string | null;
    arrivalTime: string | null;
    departureTime: string | null;
    accessOutcome: string | null;
  };
  facts: VisitFacts;
  locations: Location[];
  /** Earlier visits for this project only, oldest first. Used by the final summary. */
  history?: { visitDate: string; type: VisitType; facts: VisitFacts }[];
}

// Initial-mitigation bullet order (spec §8).
const MITIGATION_ORDER: Category[] = [
  "condition",
  "moisture_elevated",
  "reading",
  "extraction",
  "removal",
  "detach_reset",
  "cavity_access",
  "cleaning",
  "antimicrobial",
  "contents",
  "floor_protection",
  "containment",
  "drying",
  "monitoring",
  "note",
];

const STATUS_SUFFIX: Partial<Record<ScopeItem["status"], string>> = {
  completed: "completed",
  scheduled: "scheduled",
  in_progress: "in progress",
  not_performed: "not performed",
};

function itemText(i: ScopeItem, withStatus = true): string {
  let t = i.text.trim().replace(/\.$/, "");
  if (i.quantity && !t.includes(i.quantity)) t += ` (${i.quantity})`;
  const s = STATUS_SUFFIX[i.status];
  if (withStatus && s && !new RegExp(s.split(" ")[0], "i").test(t)) t += ` — ${s}`;
  return t + ".";
}

const EQUIP_STATUS: Record<Equipment["status"], (d: string | null) => string> = {
  planned: () => "planned",
  installed: () => "installed",
  operating: () => "operating",
  pickup_scheduled: (d) => `pickup scheduled${d ? ` ${d}` : ""}`,
  removed: (d) => `removed${d ? ` ${d}` : ""}`,
  unknown: () => "status to be confirmed",
};

export function equipmentText(e: Equipment): string {
  const qty = e.quantity == null ? "Quantity not specified —" : String(e.quantity);
  return `${qty} ${equipmentName(e, e.quantity)} (${EQUIP_STATUS[e.status](e.statusDate)}).`;
}

function byOrder(order: Category[]) {
  return (a: ScopeItem, b: ScopeItem) => {
    const ia = order.indexOf(a.category);
    const ib = order.indexOf(b.category);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  };
}

function scopeItems(f: VisitFacts): ScopeItem[] {
  const ex = f.exclusions ?? [];
  const contentsOut = ex.some((e) => e.target === "contents_all" || (e.target === "service_line" && e.serviceLine === "contents"));
  const roomsOut = new Set(ex.filter((e) => e.target === "room" && e.locationId).map((e) => e.locationId));
  return f.items.filter(
    (i) =>
      isConfirmedForScope(i, f) &&
      // excluded work never prints as scope; the Exclusions section says why
      !(contentsOut && i.category === "contents" && !/access the structure/i.test(i.text)) &&
      !(i.locationId && roomsOut.has(i.locationId)),
  );
}

/** Explicit exclusions section — customer preferences are never applied silently. */
function exclusionSection(f: VisitFacts, locations: Location[]): ScopeSection[] {
  const ex = f.exclusions ?? [];
  if (!ex.length) return [];
  const SIG: Record<string, string> = {
    signed: "signed declination on file",
    verbal: "verbal only — signature required",
    not_documented: "not documented — signature required",
  };
  return [
    {
      level: 2,
      heading: "Exclusions",
      bullets: ex.map((e) => {
        const room = e.locationId ? locations.find((l) => l.id === e.locationId) : null;
        const base = e.text || `${e.target.replace(/_/g, " ")} excluded${room ? ` (${fullLabel(room)})` : ""}: ${e.reason}`;
        return { text: `${base.replace(/\.$/, "")}. Customer decision: ${SIG[e.signature] ?? e.signature}.` };
      }),
    },
  ];
}
function scopeEquipment(f: VisitFacts): Equipment[] {
  return f.equipment.filter((e) => isConfirmedForScope(e, f));
}

/**
 * Builds floor → unit/room sections. Every location that has content gets a
 * section; locations are never merged by room name, so two "Closet" rooms in
 * different units stay separate.
 */
function groupSections(
  locations: Location[],
  bulletsFor: (locationId: string | null) => ScopeBullet[],
  opts: { generalHeading?: string } = {},
): ScopeSection[] {
  const out: ScopeSection[] = [];
  const general = bulletsFor(null);
  if (general.length) out.push({ level: 2, heading: opts.generalHeading ?? "General", locationId: null, bullets: general });
  let currentFloor: string | null | undefined = undefined;
  for (const loc of sortLocations(locations)) {
    const bullets = bulletsFor(loc.id);
    if (!bullets.length) continue;
    if (loc.floor && norm(loc.floor) !== norm(currentFloor ?? null)) {
      out.push({ level: 1, heading: floorLabel(loc.floor), bullets: [] });
    }
    currentFloor = loc.floor;
    const heading = !loc.unit && loc.floor ? `${floorLabel(loc.floor)} ${loc.room}` : roomHeading(loc);
    out.push({ level: 2, heading, locationId: loc.id, bullets });
  }
  return out;
}

function unplacedSection(f: VisitFacts): ScopeSection[] {
  const items = scopeItems(f).filter((i) => i.needsLocation && !i.locationId);
  if (!items.length) return [];
  return [
    {
      level: 2,
      heading: "Location to confirm",
      locationId: null,
      bullets: items.map((i) => ({ text: itemText(i), itemId: i.id })),
    },
  ];
}

function itemsAt(f: VisitFacts, locationId: string | null): ScopeItem[] {
  return scopeItems(f).filter((i) => i.locationId === locationId && !(locationId === null && i.needsLocation));
}

// ---------------- header ----------------

function header(input: RenderInput, extra: { label: string; value: string }[] = []) {
  const { project: p, visit: v, facts: f } = input;
  const j = f.jobInfo;
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value && String(value).trim()) rows.push({ label, value: String(value).trim() });
  };
  push("Property", p.address);
  push("Customer", [p.customer, p.contact].filter(Boolean).join(" — "));
  push("PM", p.pm);
  push("JFC/PMA", p.jfcPma);
  push("Visit", `${VISIT_TYPE_LABELS[v.type]} — ${formatDate(v.visitDate)}`);
  push("Appointment", formatTime(v.appointmentTime));
  if (v.arrivalTime || v.departureTime)
    push("On site", [formatTime(v.arrivalTime), formatTime(v.departureTime)].filter(Boolean).join(" – "));
  push("Access", v.accessOutcome);
  push("Loss date", formatDate(p.lossDate));
  push("Loss type", j.lossType ?? p.lossType);
  push("Cause of loss", j.causeOfLoss ?? p.causeOfLoss);
  const src = j.sourceStatus ?? p.sourceStatus;
  if (src) push("Source", src.charAt(0).toUpperCase() + src.slice(1));
  push("Category", j.category ?? p.category);
  push("Class", j.waterClass ?? p.waterClass);
  push("Insurance", [p.payer === "self_pay" ? "Self-pay" : p.carrier || (p.payer === "insurance" ? "Insurance" : null), p.claimNumber ? `Claim ${p.claimNumber}` : null].filter(Boolean).join(" — "));
  rows.push(...extra);
  return rows;
}

function crewRows(input: RenderInput) {
  const j = input.facts.jobInfo;
  const rows: { label: string; value: string }[] = [];
  if (j.crewRaw) {
    const subs = j.subcontractors;
    rows.push({
      label: "Crew",
      value:
        subs != null
          ? `${j.crewRaw} (${j.crewChiefs ?? 1} crew chief${subs ? ` + ${subs} subcontractor${subs === 1 ? "" : "s"}` : ""})`
          : j.crewRaw,
    });
  } else if (input.project.crewRequirements) rows.push({ label: "Crew", value: input.project.crewRequirements });
  const pd = j.productionDays ?? input.project.productionDays;
  const ed = j.equipmentDays ?? input.project.equipmentDays;
  if (pd) rows.push({ label: "Work days", value: pd });
  if (ed) rows.push({ label: "Equipment days", value: ed });
  const ar = j.accessRestrictions ?? input.project.accessRestrictions;
  if (ar) rows.push({ label: "Access restrictions", value: ar });
  return rows;
}

function openQuestions(f: VisitFacts): string[] {
  return f.questions.filter((q) => q.status === "open").map((q) => q.text);
}

// ---------------- renderers ----------------

function renderMitigation(input: RenderInput, title: string): ScopeDoc {
  const f = input.facts;
  const sections = groupSections(input.locations, (loc) => {
    const items = itemsAt(f, loc)
      .filter((i) => i.status !== "not_performed" && i.category !== "schedule")
      .sort(byOrder(MITIGATION_ORDER));
    const asBullet = (i: ScopeItem): ScopeBullet => ({ text: itemText(i), itemId: i.id });
    const dryingIdx = MITIGATION_ORDER.indexOf("drying");
    const rank = (c: Category) => MITIGATION_ORDER.indexOf(c);
    return [
      // affected conditions, then extraction … containment in spec order
      ...items.filter((i) => rank(i.category) >= 0 && rank(i.category) < dryingIdx).map(asBullet),
      // equipment placement and drying last
      ...items.filter((i) => i.category === "drying").map(asBullet),
      ...scopeEquipment(f).filter((e) => e.locationId === loc).map((e) => ({ text: equipmentText(e), equipmentId: e.id })),
      ...items.filter((i) => rank(i.category) > dryingIdx || rank(i.category) < 0).map(asBullet),
    ];
  });
  const schedule = scopeItems(f).filter((i) => i.category === "schedule");
  if (schedule.length) sections.push({ level: 2, heading: "Schedule", bullets: schedule.map((i) => ({ text: itemText(i, false), itemId: i.id })) });
  return {
    title,
    header: header(input, crewRows(input)),
    sections: [...sections, ...unplacedSection(f)],
    footer: [],
  };
}

const MONITORING_ORDER: Category[] = [
  "drying",
  "monitoring",
  "moisture_elevated",
  "reading",
  "moisture_dry",
  "change",
  "condition",
];

function renderMonitoring(input: RenderInput): ScopeDoc {
  const f = input.facts;
  const sections = groupSections(input.locations, (loc) => {
    const items = itemsAt(f, loc).filter((i) => i.category !== "schedule");
    const equip = scopeEquipment(f).filter((e) => e.locationId === loc);
    const bullets: ScopeBullet[] = [];
    // 1. equipment activity
    bullets.push(...items.filter((i) => i.category === "drying" || i.category === "monitoring").map((i) => ({ text: itemText(i), itemId: i.id })));
    bullets.push(...equip.map((e) => ({ text: equipmentText(e), equipmentId: e.id })));
    // 2. still elevated, 3. now dry, 4. changes
    for (const c of ["moisture_elevated", "reading", "moisture_dry", "change", "condition"] as Category[])
      bullets.push(...items.filter((i) => i.category === c).map((i) => ({ text: itemText(i), itemId: i.id })));
    // 5. remaining work / planned adjustments
    bullets.push(
      ...items
        .filter((i) => !MONITORING_ORDER.includes(i.category))
        .map((i) => ({ text: itemText(i), itemId: i.id })),
    );
    return bullets;
  });
  const schedule = scopeItems(f).filter((i) => i.category === "schedule");
  if (schedule.length) sections.push({ level: 2, heading: "Schedule", bullets: schedule.map((i) => ({ text: itemText(i, false), itemId: i.id })) });
  return { title: "Daily Monitoring Update", header: header(input), sections: [...sections, ...unplacedSection(f)], footer: [] };
}

function renderAssessment(input: RenderInput): ScopeDoc {
  const f = input.facts;
  const sections = groupSections(input.locations, (loc) =>
    itemsAt(f, loc)
      .filter((i) => i.category !== "schedule")
      .sort(byOrder(MITIGATION_ORDER))
      .map((i) => ({ text: itemText(i), itemId: i.id })),
  );
  const next = scopeItems(f).filter((i) => i.category === "schedule");
  if (next.length) sections.push({ level: 2, heading: "Next steps", bullets: next.map((i) => ({ text: itemText(i, false), itemId: i.id })) });
  const qs = openQuestions(f);
  return {
    title: "Initial Assessment",
    header: header(input, crewRows(input)),
    sections: [...sections, ...unplacedSection(f)],
    footer: qs.length ? ["Open items to confirm:", ...qs.map((q) => `• ${q}`)] : [],
  };
}

function renderKickoff(input: RenderInput): ScopeDoc {
  const doc = renderMitigation(input, "Kickoff / Crew Work Update");
  return doc;
}

const RECON_ORDER: Category[] = ["removal", "repair", "replacement", "detach_reset", "finish", "painting", "note"];

function renderReconstruction(input: RenderInput): ScopeDoc {
  const f = input.facts;
  const sections = groupSections(input.locations, (loc) =>
    itemsAt(f, loc)
      .filter((i) => !["sequencing", "access", "schedule"].includes(i.category))
      .sort(byOrder(RECON_ORDER))
      .map((i) => ({ text: itemText(i), itemId: i.id })),
  );
  const seq = scopeItems(f).filter((i) => i.category === "sequencing");
  const acc = scopeItems(f).filter((i) => i.category === "access");
  if (seq.length) sections.push({ level: 2, heading: "Trade sequencing", bullets: seq.map((i) => ({ text: itemText(i, false), itemId: i.id })) });
  if (acc.length) sections.push({ level: 2, heading: "Access & building requirements", bullets: acc.map((i) => ({ text: itemText(i, false), itemId: i.id })) });
  return { title: "Reconstruction Scope", header: header(input), sections: [...sections, ...unplacedSection(f)], footer: [] };
}

function renderContents(input: RenderInput): ScopeDoc {
  const f = input.facts;
  const sections = groupSections(input.locations, (loc) =>
    itemsAt(f, loc)
      .filter((i) => i.category !== "schedule")
      .sort(byOrder(["condition", "contents", "cleaning", "antimicrobial", "note"]))
      .map((i) => ({ text: itemText(i), itemId: i.id })),
  );
  return { title: "Contents Cleaning Scope", header: header(input, crewRows(input)), sections: [...sections, ...unplacedSection(f)], footer: [] };
}

// ---------------- final walk-through ----------------

const FINAL_GROUPS: { heading: string; cats: Category[] }[] = [
  { heading: "Extraction", cats: ["extraction"] },
  { heading: "Removals", cats: ["removal", "detach_reset", "cavity_access"] },
  { heading: "Cleaning and treatment", cats: ["cleaning", "antimicrobial", "contents", "floor_protection", "containment"] },
  { heading: "Drying and monitoring", cats: ["drying", "monitoring"] },
];

/**
 * Start-to-finish summary using ONLY work confirmed completed (by the PM) across
 * this project's visits. Scheduled work stays "scheduled". Never states the file is closed.
 */
function renderFinal(input: RenderInput): ScopeDoc {
  const f = input.facts;
  const all = [...(input.history ?? []).map((h) => h.facts), f];
  const completedFrom = (facts: VisitFacts) => scopeItems(facts).filter((i) => i.status === "completed");

  // Deduplicate across visits by location + normalized text; latest record wins.
  const completed = new Map<string, ScopeItem>();
  for (const facts of all) for (const i of completedFrom(facts)) completed.set(`${i.locationId}|${norm(i.text)}`, i);
  const doneKeys = new Set(completed.keys());
  const current = scopeItems(f);
  const scheduled = current.filter(
    (i) => (i.status === "scheduled" || i.status === "in_progress") && !doneKeys.has(`${i.locationId}|${norm(i.text)}`),
  );

  // Latest equipment status per location+type (current visit overrides history).
  const equip = new Map<string, Equipment>();
  for (const facts of all) for (const e of scopeEquipment(facts)) equip.set(`${e.locationId}|${e.type}|${e.label ?? ""}`, e);

  const remaining: string[] = [];
  const sections = groupSections(input.locations, (loc) => {
    const bullets: ScopeBullet[] = [];
    const done = [...completed.values()].filter((i) => i.locationId === loc);
    for (const g of FINAL_GROUPS)
      for (const i of done.filter((x) => g.cats.includes(x.category))) bullets.push({ text: itemText(i, false), itemId: i.id });
    // Final condition: current visit observations (e.g. "materials dry").
    for (const i of current.filter((x) => x.locationId === loc && ["moisture_dry", "moisture_elevated", "condition", "reading"].includes(x.category)))
      bullets.push({ text: itemText(i), itemId: i.id });
    for (const e of [...equip.values()].filter((x) => x.locationId === loc)) bullets.push({ text: `Equipment: ${equipmentText(e)}`, equipmentId: e.id });
    for (const i of done.filter((x) => !FINAL_GROUPS.some((g) => g.cats.includes(x.category)) && !["forms", "schedule"].includes(x.category)))
      bullets.push({ text: itemText(i, false), itemId: i.id });
    for (const i of scheduled.filter((x) => x.locationId === loc && x.category !== "forms")) bullets.push({ text: itemText(i), itemId: i.id });
    for (const i of current.filter((x) => x.locationId === loc && ["repair", "replacement", "finish", "painting"].includes(x.category) && x.status !== "completed")) {
      if (!bullets.some((b) => b.itemId === i.id)) bullets.push({ text: `Remaining repair: ${itemText(i)}`, itemId: i.id });
      remaining.push(i.text);
    }
    return bullets;
  });

  const forms = all.flatMap((x) => scopeItems(x).filter((i) => i.category === "forms"));
  const formsDone = forms.filter((i) => i.status === "completed");
  const formsOther = scheduled.filter((i) => i.category === "forms");
  const formBullets: ScopeBullet[] = [
    ...formsDone.map((i) => ({ text: itemText(i, false).replace(/\.$/, "") + " — completed.", itemId: i.id })),
    ...formsOther.map((i) => ({ text: itemText(i), itemId: i.id })),
  ];
  if (!formBullets.length) formBullets.push({ text: "Completion forms: not documented." });
  sections.push({ level: 2, heading: "Completion forms", bullets: formBullets });

  const sched = current.filter((i) => i.category === "schedule");
  if (sched.length) sections.push({ level: 2, heading: "Schedule", bullets: sched.map((i) => ({ text: itemText(i, false), itemId: i.id })) });

  const openEquip = [...equip.values()].filter((e) => e.status !== "removed");
  const footer: string[] = [];
  const pending = [
    ...(openEquip.length ? ["equipment removal"] : []),
    ...(remaining.length ? ["remaining repairs"] : []),
    ...(formsDone.length ? [] : ["completion forms"]),
    ...(scheduled.length ? ["scheduled work"] : []),
  ];
  footer.push(
    pending.length
      ? `File remains open — pending: ${pending.join(", ")}.`
      : "No open items documented. File closeout to be confirmed separately.",
  );
  return { title: "Final Walk-Through — Completed Mitigation Summary", header: header(input), sections: [...sections, ...unplacedSection(f)], footer };
}

// ---------------- checklist ----------------

const CHECK_LABEL: Record<string, string> = {
  applicable: "Applicable",
  completed: "Completed",
  pending: "Pending",
  not_applicable: "Not applicable",
  not_documented: "Not documented",
};

function renderChecklist(input: RenderInput, baseType: VisitType): ScopeDoc {
  const f = input.facts;
  const sections: ScopeSection[] = [];
  const entries = f.checklist?.entries ?? [];
  for (const status of ["completed", "pending", "applicable", "not_documented", "not_applicable"]) {
    const list = entries.filter((e) => e.status === status);
    if (list.length)
      sections.push({
        level: 2,
        heading: CHECK_LABEL[status],
        bullets: list.map((e) => ({ text: e.note ? `${e.label} — ${e.note}` : e.label })),
      });
  }
  if (!entries.length) sections.push({ level: 2, heading: "Checklist", bullets: [{ text: "Generate checklist information to fill this section." }] });

  // Findings, equipment status and remaining services by room.
  const findings = groupSections(input.locations, (loc) => [
    ...itemsAt(f, loc)
      .filter((i) => i.category !== "schedule")
      .sort(byOrder(MITIGATION_ORDER))
      .map((i) => ({ text: itemText(i), itemId: i.id })),
    ...scopeEquipment(f).filter((e) => e.locationId === loc).map((e) => ({ text: equipmentText(e), equipmentId: e.id })),
  ]);
  if (findings.length) sections.push({ level: 1, heading: "Findings and equipment", bullets: [] }, ...findings);
  const next = scopeItems(f).filter((i) => i.category === "schedule");
  if (next.length) sections.push({ level: 2, heading: "Next steps", bullets: next.map((i) => ({ text: itemText(i, false), itemId: i.id })) });
  return {
    title: `Checklist Information — ${VISIT_TYPE_LABELS[baseType]}`,
    header: header(input, crewRows(input)),
    sections,
    footer: [],
  };
}

export function renderDoc(input: RenderInput, checklistFor?: VisitType): ScopeDoc {
  const doc = renderDocInner(input, checklistFor);
  const ex = exclusionSection(input.facts, input.locations);
  return ex.length ? { ...doc, sections: [...doc.sections, ...ex] } : doc;
}

function renderDocInner(input: RenderInput, checklistFor?: VisitType): ScopeDoc {
  switch (input.visit.type) {
    case "initial_assessment":
      return renderAssessment(input);
    case "initial_mitigation":
      return renderMitigation(input, "Initial Mitigation Scope");
    case "kickoff":
      return renderKickoff(input);
    case "daily_monitoring":
      return renderMonitoring(input);
    case "final_walkthrough":
      return renderFinal(input);
    case "reconstruction":
      return renderReconstruction(input);
    case "contents_cleaning":
      return renderContents(input);
    case "checklist":
      return renderChecklist(input, checklistFor ?? "checklist");
  }
}

// ---------------- text output ----------------

export function docToText(doc: ScopeDoc): string {
  const lines: string[] = [doc.title.toUpperCase(), ""];
  for (const h of doc.header) lines.push(`${h.label}: ${h.value}`);
  for (const s of doc.sections) {
    lines.push("");
    lines.push(s.level === 1 ? s.heading.toUpperCase() : s.heading);
    for (const b of s.bullets) lines.push(`• ${b.text}`);
  }
  if (doc.footer.length) lines.push("", ...doc.footer);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Slack mrkdwn: *bold* headings, bullet characters, no tables. */
export function docToSlack(doc: ScopeDoc): string {
  const lines: string[] = [`*${doc.title}*`];
  for (const h of doc.header) lines.push(`*${h.label}:* ${h.value}`);
  for (const s of doc.sections) {
    lines.push("");
    lines.push(s.level === 1 ? `*${s.heading.toUpperCase()}*` : `*${s.heading}*`);
    for (const b of s.bullets) lines.push(`• ${b.text}`);
  }
  if (doc.footer.length) lines.push("", ...doc.footer.map((x) => `_${x.replace(/^• /, "")}_`));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export { fullLabel };
