import { DEFAULT_RULES, type Rules } from "./defaults";

/**
 * Rules-based FNOL parser (no AI). Reads labeled fields ("Claim #: …") and
 * keyword cues. Every value carries its evidence (the matched text) and a
 * confidence; anything not found stays null — nothing is guessed. The PM
 * reviews and edits the result before saving.
 */

export const SERVICE_LINES = ["ems", "mitigation", "reconstruction", "contents"] as const;
export type ServiceLine = (typeof SERVICE_LINES)[number];
export const SERVICE_LINE_LABELS: Record<ServiceLine, string> = {
  ems: "EMS (emergency services)",
  mitigation: "Mitigation",
  reconstruction: "Reconstruction",
  contents: "Contents cleaning",
};

export const VISIT_STAGES = ["initial_walkthrough", "kickoff", "daily_monitoring", "final_walkthrough", "other"] as const;
export type VisitStage = (typeof VISIT_STAGES)[number];
export const VISIT_STAGE_LABELS: Record<VisitStage, string> = {
  initial_walkthrough: "Initial walk-through",
  kickoff: "Kickoff / start of work",
  daily_monitoring: "Daily monitoring",
  final_walkthrough: "Final walk-through",
  other: "Other visit",
};

export type Confidence = "labeled" | "keyword" | "assumed";
export interface Found<T> {
  value: T;
  confidence: Confidence;
  evidence: string;
}

export interface FnolParse {
  serviceLines: Found<ServiceLine>[];
  contentsOnly: boolean;
  stage: Found<VisitStage> | null;
  stageConflict: string | null;
  special: Found<boolean> | null; // value true when a special-assignment cue is present
  specialReason: string | null;
  program: Found<string> | null;
  claimNumber: Found<string> | null;
  assignmentNumber: Found<string> | null;
  policyNumber: Found<string> | null;
  carrier: Found<string> | null;
  insured: Found<string> | null;
  contactPhone: Found<string> | null;
  email: Found<string> | null;
  address: Found<string> | null;
  unit: Found<string> | null;
  lossDate: Found<string> | null; // YYYY-MM-DD
  lossType: Found<string> | null;
  causeOfLoss: Found<string> | null;
  receivedAt: Found<string> | null; // ISO, when stated in the FNOL
  warnings: string[];
}

const LINE = (s: string) => s.replace(/\s+/g, " ").trim();

/** "Label: value" lookup over lines. Labels are matched case-insensitively at line start (bullets allowed). */
function labeled(text: string, labels: string[], max = 160): Found<string> | null {
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/^[\s>*•\-–—]+/, "");
    for (const lab of labels) {
      const re = new RegExp(`^(?:\\*\\*)?${lab}(?:\\*\\*)?\\s*(?:#|no\\.?|number)?\\s*[:\\-–=]\\s*(.+)$`, "i");
      const m = line.match(re);
      if (m && m[1].trim()) return { value: LINE(m[1]).replace(/\*\*/g, "").slice(0, max), confidence: "labeled", evidence: LINE(raw) };
    }
  }
  return null;
}

function inline(text: string, re: RegExp, group = 1): Found<string> | null {
  const m = text.match(re);
  if (!m || !m[group]) return null;
  return { value: LINE(m[group]), confidence: "keyword", evidence: LINE(m[0]).slice(0, 160) };
}

/** Unlabeled street address: searched line by line so it never spans lines. */
function streetLine(text: string): Found<string> | null {
  const re = /(?:^|[^0-9A-Za-z-])(\d{1,6}[ \t]+(?:[NSEW]\.?[ \t]+)?[A-Za-z0-9.' \t]+?[ \t](?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Pl|Place|Ct|Court|Way|Ter|Terrace|Pkwy|Parkway|Concourse)\b\.?[^\n]*)/i;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(re);
    if (m) return { value: LINE(m[1]), confidence: "keyword", evidence: LINE(raw).slice(0, 160) };
  }
  return null;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First keyword hit (whole-word, case-insensitive) with surrounding evidence. */
function keyword(text: string, words: string[]): { word: string; evidence: string } | null {
  for (const w of words) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(w)}(?=$|[^a-z0-9])`, "i");
    const m = re.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 30);
      return { word: w, evidence: LINE(text.slice(start, m.index + m[0].length + 30)) };
    }
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Normalizes common US date formats to YYYY-MM-DD; returns null if unsure. */
export function normalizeDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = t.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return ymd(y, +m[1], +m[2]);
  }
  m = t.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 4).toLowerCase()] !== undefined) return ymd(+m[3], MONTHS[m[1].slice(0, 4).toLowerCase()], +m[2]);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) return ymd(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  return null;
}
function ymd(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const LOSS_TYPES: [string, RegExp][] = [
  ["sewage", /\b(sewage|sewer back ?up|septic)\b/i],
  ["fire", /\b(fire|burn(ed|t)?|kitchen fire)\b/i],
  ["smoke", /\b(smoke|soot)\b/i],
  ["mold", /\b(mold|mould|microbial)\b/i],
  ["storm", /\b(storm|hurricane|wind|hail)\b/i],
  ["water", /\b(water|leak|pipe|burst|overflow|flood|supply line|dishwasher|washing machine|toilet|sprinkler)\b/i],
];

export function parseFnol(text: string, rules: Rules = DEFAULT_RULES): FnolParse {
  const k = rules.fnolKeywords;
  const warnings: string[] = [];

  // --- service lines (multi) ---
  const lineHits: Found<ServiceLine>[] = [];
  const typeField = labeled(text, ["assignment type", "service type", "job type", "type of service", "services? requested", "scope", "service"]);
  const hay = text;
  const add = (line: ServiceLine, words: string[]) => {
    const fromField = typeField ? keyword(typeField.value, words) : null;
    if (fromField) return lineHits.push({ value: line, confidence: "labeled", evidence: typeField!.evidence });
    const hit = keyword(hay, words);
    if (hit) lineHits.push({ value: line, confidence: "keyword", evidence: hit.evidence });
  };
  add("ems", k.ems);
  add("mitigation", k.mitigation);
  add("reconstruction", k.reconstruction);
  add("contents", k.contents);
  const contentsOnlyHit = keyword(hay, k.contentsOnly);
  let contentsOnly = false;
  if (contentsOnlyHit) {
    contentsOnly = true;
    if (!lineHits.some((h) => h.value === "contents"))
      lineHits.push({ value: "contents", confidence: "keyword", evidence: contentsOnlyHit.evidence });
    // "contents only" overrides incidental mentions of other lines unless they were labeled
    for (let i = lineHits.length - 1; i >= 0; i--) if (lineHits[i].value !== "contents" && lineHits[i].confidence !== "labeled") lineHits.splice(i, 1);
  } else if (lineHits.length === 1 && lineHits[0].value === "contents") contentsOnly = true;
  if (!lineHits.length) warnings.push("Service line not found — choose EMS, mitigation, reconstruction or contents.");

  // --- visit stage ---
  const stageField = labeled(text, ["visit type", "visit", "stage", "appointment type", "inspection type", "request"]);
  const stageWords: [VisitStage, string[]][] = [
    ["final_walkthrough", k.final],
    ["daily_monitoring", k.monitoring],
    ["kickoff", k.kickoff],
    ["initial_walkthrough", k.initial],
  ];
  const stageHits: Found<VisitStage>[] = [];
  for (const [stage, words] of stageWords) {
    const f = stageField ? keyword(stageField.value, words) : null;
    if (f) stageHits.push({ value: stage, confidence: "labeled", evidence: stageField!.evidence });
    else {
      const h = keyword(hay, words);
      if (h) stageHits.push({ value: stage, confidence: "keyword", evidence: h.evidence });
    }
  }
  let stage: Found<VisitStage> | null = stageHits.find((s) => s.confidence === "labeled") ?? stageHits[0] ?? null;
  let stageConflict: string | null = null;
  const distinct = [...new Set(stageHits.map((s) => s.value))];
  if (distinct.length > 1 && !stageHits.some((s) => s.confidence === "labeled")) {
    stageConflict = `Text mentions more than one visit stage (${distinct.join(", ")}) — confirm which one.`;
    warnings.push(stageConflict);
  }
  if (!stage) {
    stage = { value: "initial_walkthrough", confidence: "assumed", evidence: "No stage stated — a new FNOL is assumed to be an initial walk-through." };
  }

  // --- special assignment ---
  const specialField = labeled(text, ["special instructions", "special assignment", "special handling", "special"]);
  const specialHit = keyword(hay, k.special);
  const special: Found<boolean> | null = specialField
    ? { value: true, confidence: "labeled", evidence: specialField.evidence }
    : specialHit
      ? { value: true, confidence: "keyword", evidence: specialHit.evidence }
      : null;
  const specialReason = specialField?.value ?? (specialHit ? specialHit.word : null);

  // --- program / TPA ---
  let program = labeled(text, ["program", "tpa", "national account", "referral source"]);
  if (!program)
    for (const p of rules.programs) {
      const h = p.keywords.length ? keyword(hay, p.keywords) : null;
      if (h) {
        program = { value: p.name, confidence: "keyword", evidence: h.evidence };
        break;
      }
    }

  // --- identifiers & contact (number fields must contain a digit) ---
  const num = (f: Found<string> | null) => (f && /\d/.test(f.value) ? { ...f, value: f.value.split(/\s+/)[0].replace(/[,;.]$/, "") } : null);
  const claimNumber =
    num(labeled(text, ["claim", "claim number", "claim no", "claim id"], 40)) ?? inline(text, /\bclaim\s*(?:#|no\.?|number)\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i);
  const assignmentNumber =
    num(labeled(text, ["assignment", "job", "file", "work order", "wo", "job number", "file number", "reference", "ref"], 40)) ??
    inline(text, /\b(?:job|assignment|file|wo|work order)\s*(?:#|no\.?|number)\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (assignmentNumber && claimNumber && assignmentNumber.value === claimNumber.value) assignmentNumber.confidence = "keyword";
  const policyNumber = num(labeled(text, ["policy", "policy number", "policy no"], 40));
  const carrier = labeled(text, ["carrier", "insurance company", "insurance carrier", "insurer", "insurance"]);
  const insured = labeled(text, ["insured", "insured name", "customer", "customer name", "policyholder", "homeowner", "owner", "contact", "contact name", "tenant"]);
  const phone =
    labeled(text, ["phone", "cell", "mobile", "contact phone", "insured phone", "tel"], 40) ??
    inline(text, /(\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/);
  const contactPhone = phone ? { ...phone, value: (phone.value.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? phone.value).trim() } : null;
  const email = inline(text, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);

  // --- address / unit ---
  let address =
    labeled(text, ["loss location", "loss address", "property address", "property", "address", "location", "site address", "risk address"]) ??
    streetLine(text);
  let unit = labeled(text, ["unit", "apt", "apartment", "suite"], 20);
  if (address) {
    const um = address.value.match(/(?:,?\s*)(?:apt\.?|apartment|unit|suite|ste\.?|#)\s*([0-9A-Z-]{1,8})\b/i);
    if (um && !unit) unit = { value: um[1], confidence: address.confidence, evidence: address.evidence };
  }
  if (!address) warnings.push("Property address not found.");

  // --- dates / loss ---
  const dolRaw = labeled(text, ["date of loss", "loss date", "dol", "date loss occurred", "loss occurred"], 40);
  const lossDateVal = dolRaw ? normalizeDate(dolRaw.value) : null;
  const lossDate = dolRaw && lossDateVal ? { ...dolRaw, value: lossDateVal } : null;
  if (dolRaw && !lossDateVal) warnings.push(`Loss date "${dolRaw.value}" could not be read — enter it.`);

  const typeOfLoss = labeled(text, ["type of loss", "loss type", "peril", "cause type"], 60);
  let lossType: Found<string> | null = null;
  const lossHay = typeOfLoss?.value ?? text;
  for (const [name, re] of LOSS_TYPES)
    if (re.test(lossHay)) {
      lossType = { value: name, confidence: typeOfLoss ? "labeled" : "keyword", evidence: typeOfLoss?.evidence ?? (lossHay.match(re)?.[0] ?? name) };
      break;
    }
  const causeOfLoss = labeled(text, ["cause of loss", "cause", "loss description", "description of loss", "description", "notes", "details"], 400);

  const recRaw = labeled(text, ["received", "date received", "assigned", "date assigned", "assignment date", "sent"], 60);
  let receivedAt: Found<string> | null = null;
  if (recRaw) {
    const d = normalizeDate(recRaw.value);
    const tm = recRaw.value.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (d) {
      let h = tm ? +tm[1] : 0;
      if (tm?.[3]) h = (h % 12) + (/pm/i.test(tm[3]) ? 12 : 0);
      receivedAt = { ...recRaw, value: `${d}T${String(h).padStart(2, "0")}:${tm ? tm[2] : "00"}:00` };
    }
  }

  return {
    serviceLines: dedupeLines(lineHits),
    contentsOnly,
    stage,
    stageConflict,
    special,
    specialReason,
    program,
    claimNumber,
    assignmentNumber,
    policyNumber,
    carrier,
    insured,
    contactPhone,
    email,
    address,
    unit,
    lossDate,
    lossType,
    causeOfLoss,
    receivedAt,
    warnings,
  };
}

function dedupeLines(hits: Found<ServiceLine>[]) {
  const out: Found<ServiceLine>[] = [];
  for (const h of hits) if (!out.some((o) => o.value === h.value)) out.push(h);
  return out.sort((a, b) => SERVICE_LINES.indexOf(a.value) - SERVICE_LINES.indexOf(b.value));
}

/** Normalized key for matching a property across FNOLs. */
export function addressKey(address: string, unit?: string | null): string {
  const a = address
    .toLowerCase()
    .replace(/\b(apt|apartment|unit|suite|ste|#)\s*[0-9a-z-]+\b/g, " ")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\broad\b/g, "rd")
    .replace(/\beast\b/g, "e")
    .replace(/\bwest\b/g, "w")
    .replace(/\bnorth\b/g, "n")
    .replace(/\bsouth\b/g, "s")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6) // number + street; ignore city/state/zip formatting differences
    .join(" ");
  return unit ? `${a}#${unit.toLowerCase()}` : a;
}

/** The output format the app renders for a service line + stage. */
export function outputTypeFor(lines: ServiceLine[], stage: VisitStage, contentsOnly: boolean) {
  if (stage === "final_walkthrough") return "final_walkthrough" as const;
  if (stage === "daily_monitoring") return "daily_monitoring" as const;
  if (stage === "kickoff") return "kickoff" as const;
  if (contentsOnly || (lines.length === 1 && lines[0] === "contents")) return "contents_cleaning" as const;
  if (lines.length && lines.every((l) => l === "reconstruction")) return "reconstruction" as const;
  if (lines.includes("ems") || lines.includes("mitigation")) return "initial_mitigation" as const;
  if (lines.includes("reconstruction")) return "reconstruction" as const;
  return "initial_assessment" as const;
}
