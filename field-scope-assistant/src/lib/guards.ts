import {
  PM_SOURCES,
  type Category,
  type Equipment,
  type ScopeItem,
  type VisitFacts,
} from "./schemas";
import { newId } from "./ids";
import { norm } from "./locations";

/**
 * Deterministic rule enforcement applied after every AI step and every correction.
 * The model is instructed to follow these rules too, but the app never relies on
 * that alone: anything the model returns is re-checked here before it can reach
 * the copy-ready scope.
 */

export const WORK_CATEGORIES: Category[] = [
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
  "repair",
  "replacement",
  "finish",
  "painting",
  "sequencing",
];
const DEMO_CATEGORIES: Category[] = ["removal", "cavity_access"];

export interface GuardContext {
  /** Text the PM supplied for this visit: field notes + corrections + answers. */
  pmText: string;
  /** Everything a number may legitimately come from (pm text, captions, prior facts, project fields). */
  corpusText: string;
  previousFacts?: VisitFacts | null;
  /** All earlier visits of this project (for checking claims attributed to them). */
  priorFacts?: VisitFacts[];
}

// ---------- detectors (exported for tests and prompts) ----------

export function parseCrew(text: string): { raw: string; crewChiefs: number; subcontractors: number } | null {
  const m = text.match(/\bCC\s*\+\s*(\d{1,2})\b/i);
  if (m) return { raw: `CC+${m[1]}`, crewChiefs: 1, subcontractors: Number(m[1]) };
  if (/\bCC only\b/i.test(text)) return { raw: "CC", crewChiefs: 1, subcontractors: 0 };
  return null;
}

export function detectDryingOnly(text: string): boolean {
  return /\b(drying only|dry only|dry-out only|only drying|no demo(lition)?|no removals?|no tear[- ]?out)\b/i.test(text);
}

export function detectCarryForward(text: string): boolean {
  return /\b(same as (yesterday|before|last( visit| time)?|previous( visit)?|prior( visit)?)|no changes?|unchanged|everything else (is )?(the )?same|carry (it )?(forward|over))\b/i.test(
    text,
  );
}

export function detectRemovalLanguage(text: string): boolean {
  return /\b(picked up|pick[- ]?up (is )?(complete|completed|done)|equipment (was )?(removed|pulled)|removed (all )?(the )?equipment|pulled (all )?(the )?equipment|equipment (is )?(off|out|gone))\b/i.test(
    text,
  );
}

export function detectCategoryStatement(text: string): boolean {
  return /\b(cat(egory)?\.?\s*[123]|cat\s*(one|two|three)|category (one|two|three))\b/i.test(text);
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  single: 1, both: 2, couple: 2, pair: 2,
};

/** All numeric values that appear in a text, including number words ("one dehumidifier"). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/\d+(\.\d+)?/g)) out.add(Number(m[0]));
  for (const m of lower.matchAll(/\b(twenty|thirty|forty|fifty)[- ](one|two|three|four|five|six|seven|eight|nine)\b/g))
    out.add(NUMBER_WORDS[m[1]] + NUMBER_WORDS[m[2]]);
  for (const m of lower.matchAll(/\b([a-z]+)\b/g)) if (m[1] in NUMBER_WORDS) out.add(NUMBER_WORDS[m[1]]);
  // "a dehumidifier" / "an air mover" = 1
  if (/\b(a|an)\s+(dehu|dehumidifier|air ?mover|fan|scrubber|hepa|heater|nam|negative air)/.test(lower)) out.add(1);
  return out;
}

/** Numbers that look like measurements/readings/quantities inside an item's text. */
function quantityNumbersInItem(text: string): number[] {
  // ignore dates (11/2), times (9:30), crew codes (CC+4), unit/floor codes (19C, 20th)
  const cleaned = text
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\bCC\s*\+\s*\d+\b/gi, " ")
    .replace(/\b\d+[a-z]\b/gi, " ")
    .replace(/\b\d+(st|nd|rd|th)\b/gi, " ")
    .replace(/\b(unit|apt|floor|room|suite|#)\s*\d+\b/gi, " ");
  return [...cleaned.matchAll(/\d+(\.\d+)?/g)].map((m) => Number(m[0]));
}

const EQUIPMENT_WORD: Record<string, string> = {
  air_mover: "air mover",
  dehumidifier: "dehumidifier",
  air_scrubber: "air scrubber",
  negative_air_machine: "negative air machine",
  heater: "heater",
  drying_mat: "drying mat",
  other: "equipment",
};
export function equipmentName(e: Pick<Equipment, "type" | "label">, qty?: number | null): string {
  const base = e.label?.trim() || EQUIPMENT_WORD[e.type];
  if (qty != null && qty !== 1 && !base.endsWith("s")) return base + "s";
  return base;
}

// ---------- guard ----------

export function applyGuards(input: VisitFacts, ctx: GuardContext): { facts: VisitFacts; notes: string[] } {
  const facts: VisitFacts = structuredClone(input);
  const notes: string[] = [];
  const pm = ctx.pmText ?? "";
  const corpusNumbers = numbersIn(`${ctx.corpusText}\n${pm}`);

  // Directives derived from the PM's own words always win.
  if (detectDryingOnly(pm)) facts.directives.dryingOnly = true;
  if (detectCarryForward(pm)) facts.directives.carryForwardConfirmed = true;

  // Crew: "CC+4" = one crew chief + four subcontractors. Deterministic parse.
  const crew = parseCrew(pm);
  if (crew) {
    facts.jobInfo.crewRaw = crew.raw;
    facts.jobInfo.crewChiefs = crew.crewChiefs;
    facts.jobInfo.subcontractors = crew.subcontractors;
  } else if (facts.jobInfo.crewChiefs != null || facts.jobInfo.subcontractors != null) {
    const n = [facts.jobInfo.crewChiefs, facts.jobInfo.subcontractors].filter((x): x is number => x != null);
    if (!n.every((x) => corpusNumbers.has(x))) {
      facts.jobInfo.crewChiefs = null;
      facts.jobInfo.subcontractors = null;
      facts.jobInfo.crewRaw = null;
      notes.push("Crew count removed: not stated in your notes.");
    }
  }

  // Water category cannot come from photos. Require an explicit statement.
  if (facts.jobInfo.category && !detectCategoryStatement(ctx.corpusText + "\n" + pm)) {
    notes.push(`Water category "${facts.jobInfo.category}" removed: not confirmed in your notes.`);
    facts.jobInfo.category = null;
  }

  // Work items must originate from the PM. Anything the AI inferred becomes a recommendation.
  const kept: ScopeItem[] = [];
  for (const item of facts.items) {
    const fromPm = PM_SOURCES.includes(item.source) || item.source === "prior_visit";
    if (WORK_CATEGORIES.includes(item.category) && !fromPm && item.status !== "observed") {
      facts.recommendations.push({
        id: newId("rec"),
        locationId: item.locationId,
        category: item.category,
        text: item.text,
        rationale: "Suggested from photo/caption evidence — not confirmed by you.",
        status: "pending",
      });
      notes.push(`Moved to recommendations (not confirmed): ${item.text}`);
      continue;
    }
    kept.push(item);
  }
  facts.items = kept;

  // Completion can only be confirmed by the PM — now, or in an earlier visit's record.
  const priorCompleted = new Set(
    (ctx.priorFacts ?? (ctx.previousFacts ? [ctx.previousFacts] : []))
      .flatMap((f) => f.items)
      .filter((i) => i.status === "completed")
      .map((i) => norm(i.text)),
  );
  for (const item of facts.items) {
    if (item.status !== "completed" || PM_SOURCES.includes(item.source)) continue;
    if (item.source === "prior_visit") {
      if (priorCompleted.has(norm(item.text))) continue;
      item.status = "unknown";
      addFlag(item.flags, "No earlier visit records this as completed — confirm.");
      continue;
    }
    item.status = item.source === "caption" ? "reported" : "unknown";
    addFlag(item.flags, "Completion not confirmed by you — caption/photo only.");
  }

  // Drying only: no demolition/removal/cavity access unless the PM explicitly listed it.
  if (facts.directives.dryingOnly) {
    const before = facts.items.length;
    facts.items = facts.items.filter((i) => !(DEMO_CATEGORIES.includes(i.category) && !PM_SOURCES.includes(i.source)));
    if (facts.items.length !== before) notes.push("Removed demolition items: drying-only instruction.");
    for (const i of facts.items)
      if (DEMO_CATEGORIES.includes(i.category))
        addFlag(i.flags, "Conflicts with the drying-only instruction — confirm or remove.");
    const recBefore = facts.recommendations.length;
    facts.recommendations = facts.recommendations.filter(
      (r) => !(DEMO_CATEGORIES.includes(r.category) && r.status === "pending"),
    );
    if (facts.recommendations.length !== recBefore)
      notes.push("Withheld demolition recommendations: drying-only instruction.");
  }

  // Numbers in bullets must exist somewhere in the record.
  for (const item of facts.items) {
    if (item.source === "prior_visit") continue;
    const bad = quantityNumbersInItem(item.text).filter((n) => !corpusNumbers.has(n));
    if (item.quantity) bad.push(...quantityNumbersInItem(item.quantity).filter((n) => !corpusNumbers.has(n)));
    if (bad.length) addFlag(item.flags, `Number not found in your notes: ${[...new Set(bad)].join(", ")} — verify.`);
  }

  // Equipment: no invented counts, no pickup without confirmation.
  const prevEquip = ctx.previousFacts?.equipment ?? [];
  const prevNumbers = new Set(prevEquip.map((e) => e.quantity).filter((q): q is number => q != null));
  for (const e of facts.equipment) {
    if (e.quantity != null) {
      const supported =
        e.source === "photo"
          ? false
          : corpusNumbers.has(e.quantity) || (e.source === "prior_visit" && prevNumbers.has(e.quantity));
      if (!supported) {
        addFlag(
          e.flags,
          e.source === "photo"
            ? `${e.quantity} visible in photos — confirm the count.`
            : `Quantity ${e.quantity} not found in your notes — removed.`,
        );
        e.quantity = null;
      }
    }
    if (e.status === "removed") {
      const confirmed = PM_SOURCES.includes(e.source) && detectRemovalLanguage(pm);
      const priorRemoved =
        e.source === "prior_visit" && prevEquip.some((p) => p.type === e.type && p.locationId === e.locationId && p.status === "removed");
      if (!confirmed && !priorRemoved) {
        const prev = prevEquip.find((p) => p.type === e.type && p.locationId === e.locationId);
        e.status = prev?.status === "pickup_scheduled" ? "pickup_scheduled" : "unknown";
        e.statusDate = e.status === "pickup_scheduled" ? (prev?.statusDate ?? e.statusDate) : e.statusDate;
        addFlag(e.flags, "Removal not confirmed — kept as previously recorded.");
      }
    }
  }

  // Review flags (rebuilt every time so they always describe the current facts).
  const flags: string[] = [];
  for (const e of facts.equipment)
    if (e.quantity == null && e.status !== "removed")
      flags.push(`Quantity not specified: ${equipmentName(e)}${e.locationId ? "" : " (location not set)"}.`);
  if (!facts.directives.carryForwardConfirmed) {
    const carried = facts.items.filter((i) => i.carriedForward).length + facts.equipment.filter((e) => e.carriedForward).length;
    if (carried)
      flags.push(
        `${carried} prior condition(s) not confirmed today — held out of the scope until you confirm (e.g. "same as yesterday").`,
      );
  }
  const unplaced = facts.items.filter((i) => i.needsLocation).length;
  if (unplaced) flags.push(`${unplaced} item(s) need a room assignment.`);
  facts.reviewFlags = [...flags, ...notes];

  return { facts, notes };
}

function addFlag(list: string[], flag: string) {
  if (!list.includes(flag)) list.push(flag);
}

/** Visible in the copy-ready scope? Unconfirmed carry-forwards are held back. */
export function isConfirmedForScope(x: { carriedForward: boolean }, facts: VisitFacts): boolean {
  return !x.carriedForward || facts.directives.carryForwardConfirmed;
}
