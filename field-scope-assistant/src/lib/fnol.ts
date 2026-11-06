import { DEFAULT_RULES, type Rules } from "./defaults";

/**
 * Rules-based FNOL parser (no AI). Reads labeled fields ("Claim #: …") and
 * keyword cues. Every value carries its evidence (the matched text) and a
 * confidence; anything not found stays null — nothing is guessed. The PM
 * reviews and edits the result before saving.
 */

export const SERVICE_LINES = ["ems", "mitigation", "mold", "reconstruction", "contents"] as const;
export type ServiceLine = (typeof SERVICE_LINES)[number];
export const SERVICE_LINE_LABELS: Record<ServiceLine, string> = {
  ems: "EMS (emergency services)",
  mitigation: "Mitigation",
  mold: "Mold remediation",
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
  /** Scheduled visit ("Visit: 11/06/2026 10:00 AM") — date YYYY-MM-DD and time HH:MM when stated. */
  appointment: Found<{ date: string | null; time: string | null }> | null;
  /** Generic fallback: "Key: value" lines whose key isn't a known field (kept for review, saved with the raw text). */
  otherFields: { label: string; value: string }[];
  /** Lines that fed no field. "keywords" = read only for service-line/stage/loss cues; "unused" = not read at all. */
  unparsed: { text: string; use: "keywords" | "unused" }[];
  /** How many fields were filled from the paste (0 → nothing recognized; nothing is saved from it). */
  fieldsFound: number;
  warnings: string[];
}

const LINE = (s: string) => s.replace(/\s+/g, " ").trim();

/** Every field label the parser reads (regex fragments, case-insensitive). Also used to normalize layouts. */
const LABELS = {
  serviceType: ["assignment type", "service type", "job type", "type of service", "services? requested", "scope", "service"],
  stage: ["visit type", "visit", "stage", "appointment type", "inspection type", "request"],
  special: ["special instructions", "special assignment", "special handling", "special"],
  program: ["program", "tpa", "national account", "referral source"],
  claim: ["claim", "claim number", "claim no", "claim id"],
  assignment: ["assignment", "job", "file", "work order", "wo", "job number", "file number", "reference", "ref"],
  policy: ["policy", "policy number", "policy no"],
  carrier: ["carrier", "insurance company", "insurance carrier", "insurer", "insurance"],
  insured: ["insured", "insured name", "customer", "customer name", "policyholder", "homeowner", "owner", "contact", "contact name", "tenant"],
  phone: ["phone", "cell", "mobile", "contact phone", "insured phone", "tel"],
  email: ["email", "e-mail"],
  address: ["loss location", "loss address", "property address", "property", "address", "location", "site address", "risk address"],
  unit: ["unit", "apt", "apartment", "suite"],
  lossDate: ["date of loss", "loss date", "dol", "date loss occurred", "loss occurred"],
  lossType: ["type of loss", "loss type", "peril", "cause type"],
  cause: ["cause of loss", "cause", "loss description", "description of loss", "description", "notes", "details"],
  received: ["received", "date received", "assigned", "date assigned", "assignment date", "sent"],
} as const;
const ALL_LABELS = [...new Set(Object.values(LABELS).flat())].sort((a, b) => b.length - a.length);
const LABEL_ALT = ALL_LABELS.join("|");
const SUFFIX = "(?:\\s*(?:#|no\\.?|number))?";
/** A known label at the very start of a line, followed by ":" (or "-", "=") — i.e. a "Label: value" line. */
const LABEL_LINE_RE = new RegExp(`^(?:${LABEL_ALT})${SUFFIX}\\s*[:\\-–=]`, "i");
/** A known label alone on its line (value on the next line). */
const LABEL_ALONE_RE = new RegExp(`^(${LABEL_ALT})${SUFFIX}\\s*:?\\s*$`, "i");
/** A known label + colon anywhere in a line (for splitting several fields that share a line). */
const LABEL_ANYWHERE_RE = new RegExp(`(^|[\\s|•;,])((?:${LABEL_ALT})${SUFFIX}\\s*:)`, "gi");
const CITY_STATE_ZIP_RE = /^[A-Za-z][A-Za-z .'-]*,?\s+[A-Z]{2}\.?\s+\d{5}(?:-\d{4})?\s*$/;

/**
 * Brings the layouts FNOLs are pasted in (Slack bold labels, label on its own
 * line, tab- or pipe-separated tables, several fields on one line, a one-line
 * Slack paste, an address split over two lines) into plain "Label: value" lines.
 * It only re-arranges text; it never adds or invents values.
 */
export function normalizeFnolText(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/：/g, ":").replace(/[\u200b\ufeff]/g, "");
  let lines = t.split("\n").map((raw) => {
    let l = raw.replace(/^\s*[>•·▪◦]+\s*/, "").replace(/^\s*[-–—]\s+/, "");
    // Slack / markdown emphasis around a label: *Claim #:* X, *Claim #*: X, **Claim:** X, _Claim_: X
    l = l.replace(/^(\s*)(\*{1,2}|_{1,2})([^*_\n:]{1,60}?)\s*(:?)\s*\2\s*(:?)/, (m, sp, _mk, lab, c1, c2) => (c1 || c2 ? `${sp}${lab}:` : m));
    // pipe table row: | Label | Value |  (markdown separator rows are dropped)
    if (/^\s*\|/.test(l)) {
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(l)) return "";
      const cells = l.split("|").map((c) => c.trim()).filter(Boolean);
      return pairCells(cells) ?? cells.join(" ");
    }
    if (l.includes("\t")) {
      const cells = l.split("\t").map((c) => c.trim()).filter(Boolean);
      return pairCells(cells) ?? cells.join("  ");
    }
    return l;
  });
  // several "Label:" fields on one line → one per line. Split when they're separated by 2+ spaces,
  // a pipe/bullet/semicolon, or when the line carries 3+ labels (a one-line Slack paste).
  lines = lines.flatMap((l) => {
    const hits = [...l.matchAll(LABEL_ANYWHERE_RE)].filter((m) => m.index! > 0 || m[1] !== "");
    if (!hits.length) return [l];
    const many = hits.length >= 2 && [...l.matchAll(LABEL_ANYWHERE_RE)].length >= 3;
    return l
      .replace(LABEL_ANYWHERE_RE, (m, sep: string, lab: string, off: number) => {
        if (off === 0 && sep === "") return m;
        const before = l.slice(0, off + sep.length);
        const spaced = /(\s{2,}|[|•;]\s*)$/.test(before);
        return spaced || many ? `\n${lab}` : m;
      })
      .split("\n")
      .map((x) => x.replace(/[\s|•;,]+$/, ""));
  });
  // label alone on a line → join with the next non-empty line (unless that line is itself a label)
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const alone = l.match(LABEL_ALONE_RE);
    if (alone) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = lines[j]?.trim();
      if (next && !LABEL_LINE_RE.test(next) && !LABEL_ALONE_RE.test(next)) {
        out.push(`${l.replace(/\s*:?\s*$/, "")}: ${next}`);
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
  }
  // address continued on the next line ("City, ST 12345")
  const addrRe = new RegExp(`^(?:${LABELS.address.join("|")})\\s*[:\\-–=]`, "i");
  for (let i = 0; i < out.length - 1; i++) {
    if (addrRe.test(out[i].trim()) && !/\b\d{5}\b/.test(out[i]) && CITY_STATE_ZIP_RE.test(out[i + 1].trim())) {
      out[i] = `${out[i].trim()}, ${out[i + 1].trim()}`;
      out.splice(i + 1, 1);
    }
  }
  return out.join("\n");
}

/** [Label, Value, Label, Value…] → "Label: Value" lines when every odd cell is a known label. */
function pairCells(cells: string[]): string | null {
  if (cells.length < 2 || cells.length % 2) return null;
  const pairs: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    const lab = cells[i].replace(/\s*:\s*$/, "");
    if (!LABEL_ALONE_RE.test(lab)) return null;
    pairs.push(`${lab}: ${cells[i + 1]}`);
  }
  return pairs.join("\n");
}

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

/** Every street address that appears in a block of text (e.g. a CompanyCam gallery header), one per line. */
export function findStreetAddresses(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const f = streetLine(raw);
    if (f && !out.includes(f.value)) out.push(f.value);
  }
  return out;
}

/** "429 E 52nd St, Apt 5C, New York" → "429 e 52 st" (house number + street only), for comparing addresses. */
export function streetKey(address: string): string | null {
  const k = addressKey(address);
  const m = k.match(/^(\d+[a-z]?)\s+((?:[nsew]\s+)?(?:\d+|[a-z]+)(?:\s+[a-z]+)?)/);
  if (!m) return null;
  return `${m[1]} ${m[2].replace(/\s+(street|st|avenue|ave|road|rd|blvd|boulevard|drive|dr|lane|ln|place|pl|court|ct|way|terrace|ter|parkway|pkwy|concourse)$/, "")}`.trim();
}

const SUFFIXES: Record<string, string> = { street: "st", st: "st", avenue: "ave", ave: "ave", road: "rd", rd: "rd", boulevard: "blvd", blvd: "blvd", drive: "dr", dr: "dr", lane: "ln", ln: "ln", place: "pl", pl: "pl", court: "ct", ct: "ct", way: "way", terrace: "ter", ter: "ter", parkway: "pkwy", pkwy: "pkwy", concourse: "concourse" };

/** House number, direction, street name and suffix ("308 East 72nd Street" → 308 / e / 72 / st). */
export function streetParts(address: string): { num: string; dir: string | null; name: string; suffix: string | null } | null {
  const toks = address
    .toLowerCase()
    .replace(/\b(apt|apartment|unit|suite|ste|#)\.?\s*[0-9a-z-]+\b/g, " ")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ");
  const i = toks.findIndex((t) => /^\d+[a-z]?$/.test(t));
  if (i < 0) return null;
  let j = i + 1;
  const DIR: Record<string, string> = { e: "e", east: "e", w: "w", west: "w", n: "n", north: "n", s: "s", south: "s" };
  let dir: string | null = null;
  if (DIR[toks[j]] && toks[j + 1] && !SUFFIXES[toks[j + 1]]) dir = DIR[toks[j++]];
  const name = toks[j];
  if (!name) return null;
  const suffix = SUFFIXES[toks[j + 1]] ?? null;
  return { num: toks[i], dir, name, suffix };
}

/** Same street address? Different number, direction, name or suffix (St vs Ave) is a different place; a missing direction/suffix is tolerated. */
export function sameStreet(a: string, b: string): boolean | null {
  const x = streetParts(a);
  const y = streetParts(b);
  if (!x || !y) return null;
  return x.num === y.num && x.name === y.name && (!x.dir || !y.dir || x.dir === y.dir) && (!x.suffix || !y.suffix || x.suffix === y.suffix);
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

export function parseFnol(rawText: string, rules: Rules = DEFAULT_RULES): FnolParse {
  const text = normalizeFnolText(rawText);
  const k = rules.fnolKeywords;
  const warnings: string[] = [];

  // --- service lines (multi) ---
  const lineHits: Found<ServiceLine>[] = [];
  const typeField = labeled(text, [...LABELS.serviceType]);
  const hay = text;
  const add = (line: ServiceLine, words: string[]) => {
    const fromField = typeField ? keyword(typeField.value, words) : null;
    if (fromField) return lineHits.push({ value: line, confidence: "labeled", evidence: typeField!.evidence });
    const hit = keyword(hay, words);
    if (hit) lineHits.push({ value: line, confidence: "keyword", evidence: hit.evidence });
  };
  add("ems", k.ems);
  add("mitigation", k.mitigation);
  add("mold", k.mold);
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
  const stageField = labeled(text, [...LABELS.stage]);
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
  const specialField = labeled(text, [...LABELS.special]);
  const specialHit = keyword(hay, k.special);
  const special: Found<boolean> | null = specialField
    ? { value: true, confidence: "labeled", evidence: specialField.evidence }
    : specialHit
      ? { value: true, confidence: "keyword", evidence: specialHit.evidence }
      : null;
  const specialReason = specialField?.value ?? (specialHit ? specialHit.word : null);

  // --- program / TPA ---
  let program = labeled(text, [...LABELS.program]);
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
    num(labeled(text, [...LABELS.claim], 40)) ?? inline(text, /\bclaim\s*(?:#|no\.?|number)\s*[:-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i);
  const assignmentNumber =
    num(labeled(text, [...LABELS.assignment], 40)) ??
    inline(text, /\b(?:job|assignment|file|wo|work order)\s*(?:#|no\.?|number)\s*[:-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (assignmentNumber && claimNumber && assignmentNumber.value === claimNumber.value) assignmentNumber.confidence = "keyword";
  const policyNumber = num(labeled(text, [...LABELS.policy], 40));
  const carrier = labeled(text, [...LABELS.carrier]);
  const insured = labeled(text, [...LABELS.insured]);
  const phone =
    labeled(text, [...LABELS.phone], 40) ??
    inline(text, /(\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/);
  const contactPhone = phone ? { ...phone, value: (phone.value.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? phone.value).trim() } : null;
  const email = inline(text, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);

  // --- address / unit ---
  const address =
    labeled(text, [...LABELS.address]) ??
    streetLine(text);
  let unit = labeled(text, [...LABELS.unit], 20);
  if (address) {
    const um = address.value.match(/(?:,?\s*)(?:apt\.?|apartment|unit|suite|ste\.?|#)\s*([0-9A-Z-]{1,8})\b/i);
    if (um && !unit) unit = { value: um[1], confidence: address.confidence, evidence: address.evidence };
  }
  if (!address) warnings.push("Property address not found.");

  // --- dates / loss ---
  const dolRaw = labeled(text, [...LABELS.lossDate], 40);
  const lossDateVal = dolRaw ? normalizeDate(dolRaw.value) : null;
  const lossDate = dolRaw && lossDateVal ? { ...dolRaw, value: lossDateVal } : null;
  if (dolRaw && !lossDateVal) warnings.push(`Loss date "${dolRaw.value}" could not be read — enter it.`);

  const typeOfLoss = labeled(text, [...LABELS.lossType], 60);
  let lossType: Found<string> | null = null;
  const lossHay = typeOfLoss?.value ?? text;
  for (const [name, re] of LOSS_TYPES)
    if (re.test(lossHay)) {
      lossType = { value: name, confidence: typeOfLoss ? "labeled" : "keyword", evidence: typeOfLoss?.evidence ?? (lossHay.match(re)?.[0] ?? name) };
      break;
    }
  // Cause of loss: an explicit cause/description label first; then the cause carried on the loss-type line
  // ("Type of Loss: Water - supply line burst under kitchen sink"); a free "Notes:" / "Details:" line only last.
  let causeOfLoss = labeled(text, ["cause of loss", "cause", "loss description", "description of loss", "description"], 400);
  if (!causeOfLoss && typeOfLoss) {
    const rest = typeOfLoss.value.replace(/^[A-Za-z /&]+?\s*[-–—:,(]\s*/, "").replace(/\)\s*$/, "").trim();
    if (rest && rest !== typeOfLoss.value && rest.split(/\s+/).length >= 2) causeOfLoss = { value: rest, confidence: "keyword", evidence: typeOfLoss.evidence };
  }
  if (!causeOfLoss) causeOfLoss = labeled(text, ["notes", "details"], 400);

  const recRaw = labeled(text, [...LABELS.received], 60);
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

  // scheduled visit: "Visit: 11/06/2026 10:00 AM", "Appointment: 11/6 at 2:30 pm", "Scheduled: …"
  let appointment: FnolParse["appointment"] = null;
  const apRaw = labeled(text, ["visit date", "visit time", "visit", "appointment date", "appointment time", "appointment", "scheduled", "scheduled for", "inspection date"], 80);
  if (apRaw) {
    const d = normalizeDate(apRaw.value);
    const tm = apRaw.value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i) ?? apRaw.value.match(/\b(\d{1,2}):(\d{2})\b/);
    let time: string | null = null;
    if (tm) {
      let h = +tm[1];
      if (tm[3]) h = (h % 12) + (/p/i.test(tm[3]) ? 12 : 0);
      if (h >= 0 && h < 24) time = `${String(h).padStart(2, "0")}:${tm[2] ?? "00"}`;
    }
    if (d || time) appointment = { value: { date: d, time }, confidence: "labeled", evidence: apRaw.evidence };
  }

  // ---------- what was not read (shown highlighted on the review screen) ----------
  const otherFields: FnolParse["otherFields"] = [];
  const unparsed: FnolParse["unparsed"] = [];
  const usedEvidence = new Set(
    [program, claimNumber, assignmentNumber, policyNumber, carrier, insured, contactPhone, email, address, unit, dolRaw, typeOfLoss, causeOfLoss, recRaw, typeField, stageField, specialField]
      .filter((f): f is Found<string> => !!f)
      .map((f) => f.evidence),
  );
  const cue = [...k.ems, ...k.mitigation, ...k.mold, ...k.reconstruction, ...k.contents, ...k.contentsOnly, ...k.special, ...k.initial, ...k.final, ...k.monitoring, ...k.kickoff];
  for (const raw of text.split("\n")) {
    const line = LINE(raw);
    if (!line || /^[-=_*~]{3,}$/.test(line)) continue;
    if (usedEvidence.has(line) || LABEL_LINE_RE.test(line.replace(/^[\s>*•\-–—]+/, ""))) continue;
    if (address && line.includes(address.value)) continue;
    if (contactPhone && line.includes(contactPhone.value) && line.length < 40) continue;
    if (email && line.includes(email.value) && line.length < 60) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9 #/&().'’-]{0,40}?)\s*[:=]\s*(\S.*)$/);
    if (kv && !/^https?$/i.test(kv[1])) {
      otherFields.push({ label: kv[1].trim(), value: kv[2].trim() });
      continue;
    }
    unparsed.push({ text: line, use: keyword(line, cue) || LOSS_TYPES.some(([, re]) => re.test(line)) ? "keywords" : "unused" });
  }
  const fieldsFound = [program, claimNumber, assignmentNumber, policyNumber, carrier, insured, contactPhone, email, address, unit, lossDate, lossType, causeOfLoss, receivedAt].filter(Boolean).length + (lineHits.length ? 1 : 0);
  if (!fieldsFound) warnings.unshift("Nothing in this text matched an FNOL field — check that you pasted the FNOL. Nothing will be saved from it as is.");
  else if (unparsed.some((u) => u.use === "unused")) warnings.push(`${unparsed.filter((u) => u.use === "unused").length} line(s) were not matched to any field — they are highlighted below; copy anything you need into the fields.`);

  return {
    otherFields,
    unparsed,
    fieldsFound,
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
    appointment,
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
  if (lines.includes("mold")) return "mold_remediation" as const;
  if (lines.includes("ems") || lines.includes("mitigation")) return "initial_mitigation" as const;
  if (lines.includes("reconstruction")) return "reconstruction" as const;
  return "initial_assessment" as const;
}
