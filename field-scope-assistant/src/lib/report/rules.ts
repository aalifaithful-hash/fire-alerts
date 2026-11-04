import { findStreetAddresses, normalizeDate } from "../fnol";
import { findRoomName, ROOM_PATTERNS } from "../rooms";
import { FINDING_LABELS, SCOPE_FINDINGS, type Finding, type FindingKey, type ReportFindings, type RoomFinding } from "./types";

/**
 * Rules-based mold-report reader (no AI). Works on selectable PDF text: wrapped lines are joined
 * back into statements, the report is split into room sections when it is organized by room (or a
 * table with one row per room), then each finding is read from a labeled line ("Containment: …")
 * or a plain sentence ("growth … across the entire bedroom floor"). Every finding keeps its
 * statement as the quote. Nothing the report doesn't say is filled in — no default quantities.
 */

interface Statement {
  text: string;
  page: number;
  room: string | null;
}

const LABEL_START = /^[A-Z][A-Za-z0-9 /&()'-]{1,40}:\s/;
const HEADING = /^(\d+(\.\d+)*[.)]\s+\S|[A-Z][A-Z /&-]{3,}$)/;
const ROOM_ALT = ROOM_PATTERNS.map(([re]) => re.source.replace(/^\\b/, "").replace(/\\b$/, "")).join("|");
/** A statement that opens a room section: "Room 2: Hallway", "Hallway:", "Closet — …", or a table row starting with a room. */
const ROOM_START = new RegExp(`^(?:(?:room|area|location)\\s*\\d*\\s*[:\\-–]\\s*(?=(?:the\\s+)?(?:${ROOM_ALT}))|(?=(?:${ROOM_ALT})\\s*(?:\\d\\s*)?(?:[:\\-–—(]|\\s\\d|$)))`, "i");

/** Joins wrapped lines into statements (a line continues the previous one unless it starts a label, heading or new sentence). */
export function statements(pages: string[]): Statement[] {
  const out: Statement[] = [];
  pages.forEach((txt, i) => {
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line || /^SAMPLE - TEST FIXTURE/i.test(line)) continue;
      const prev = out[out.length - 1];
      const continues =
        prev && prev.page === i + 1 && !/[.:;!?]$/.test(prev.text) && !LABEL_START.test(line) && !HEADING.test(line) && !HEADING.test(prev.text) && !ROOM_START.test(line) && /^[a-z0-9(“"']/.test(line);
      if (continues) prev.text = `${prev.text} ${line}`;
      else out.push({ text: line, page: i + 1, room: null });
    }
  });
  // room sections: everything after a room start belongs to that room until the next one,
  // or until a report-wide section (remediation plan, clearance, …) starts
  let cur: string | null = null;
  for (const s of out) {
    if (ROOM_START.test(s.text)) cur = findRoomName(s.text.replace(/^(?:room|area|location)\s*\d*\s*[:\-–]\s*/i, ""));
    else if (HEADING.test(s.text) || /^(containment|removal|remediation|post[- ]remediation|clearance|scope|protocol|recommendations?)\b/i.test(s.text)) cur = null;
    s.room = cur;
  }
  return out;
}

const fnd = <T>(value: T, s: Statement): Finding<T> => ({ value, quote: s.text, page: s.page, room: s.room });
const labeled = (S: Statement[], labels: string) => {
  const re = new RegExp(`^(?:${labels})\\s*[:\\-–]\\s*(.+)$`, "i");
  for (const s of S) {
    const m = s.text.match(re);
    if (m) return { s, value: m[1].trim() };
  }
  return null;
};
const first = (S: Statement[], re: RegExp, not?: RegExp) => S.find((s) => re.test(s.text) && !(not && not.test(s.text))) ?? null;

const NEG = /\b(no|not|none)\b[^.;]{0,25}\b(growth|mold|observed|found|visible)\b|\b(not observed|none observed|not found|no visible)\b/i;
const POS = /\b(growth|mold)\b[^.;]{0,40}\b(observed|found|present|visible|noted|identified)\b|\bvisible (mold )?(growth|mold)\b|\b(growth|mold)\s+(across|on|throughout|beneath|under|along)\b/i;
const WALLS: [RegExp, string][] = [
  [/\bnorth\b/i, "N"],
  [/\beast\b/i, "E"],
  [/\bsouth\b/i, "S"],
  [/\bwest\b/i, "W"],
];
const wallsIn = (t: string) => WALLS.filter(([re]) => re.test(t)).map(([, w]) => w);
const negOnly = (t: string) => NEG.test(t) && !POS.test(t.replace(NEG, ""));
const growthFinding = (s: Statement | null): Finding<{ growth: boolean; walls: string[] }> | null => {
  if (!s) return null;
  if (negOnly(s.text)) return fnd({ growth: false, walls: [] }, s);
  if (POS.test(s.text) || /\bgrowth\b/i.test(s.text)) return fnd({ growth: true, walls: wallsIn(s.text) }, s);
  return null;
};
const OPEN = /\b(to be determined|tbd|not (yet )?(been )?(determined|decided|scheduled|selected)|to follow|n\/a)\b/i;
const VAGUE = /\b(widespread|extensive|significant|heavy|moderate|scattered|various areas|numerous|throughout the (unit|apartment|home|house))\b/i;
const num = (x: string) => Number(x.replace(/,/g, ""));
const DIMS = /(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)/i;
const HEIGHT = /(?:ceiling height|ceiling|height)\D{0,12}(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)|(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)\s*(?:high|ceiling)/i;
const AREA_LABELED = /(affected area|area of (visible )?(mold )?growth|total affected( area)?|growth area|impacted area|area affected)\D{0,30}([\d,]+(\.\d+)?)\s*(sf|sq\.?\s*ft|square feet|ft2|ft²)\b/i;
const AREA_OF_GROWTH = /([\d,]+(\.\d+)?)\s*(sf|sq\.?\s*ft|square feet)\s+of\s+(visible\s+)?(mold|growth|microbial)/i;
const SF = /([\d,]+(?:\.\d+)?)\s*(?:sf|sq\.?\s*ft|square feet|ft2|ft²)\b/i;

function coverageOf(s: Statement, tableRow: boolean): { whole: boolean; pct: number | null } | null {
  const t = s.text;
  const pct = t.match(/(\d{1,3}(?:\.\d+)?)\s*%(?:\s*of\s+the\s+[\w ]*floor)?/i);
  if (pct && (tableRow || /floor/i.test(t))) return { whole: +pct[1] >= 100, pct: Math.min(100, +pct[1]) };
  if (/\b(entire|whole|full|all of the|throughout the|across the (entire|whole|full)|wall[- ]to[- ]wall)\b[^.]{0,40}\bfloor/i.test(t) || /\bfloor\w*\b[^.]{0,30}\b(entire|throughout)\b/i.test(t)) return { whole: true, pct: 100 };
  if (tableRow && /\b(whole|entire|full)\b/i.test(t)) return { whole: true, pct: 100 };
  if (/\b(portion|part|partial|section|corner|localized|isolated|patch(es)?)\b[^.]{0,40}\bfloor|\bfloor\w*\b[^.]{0,30}\b(near|along|at the|in front of)\b/i.test(t) || (tableRow && /\b(partial|part)\b/i.test(t))) return { whole: false, pct: null };
  return null;
}

/** Reads one room section (statements under that room, or the whole report when it isn't split by room). */
function readRoom(name: string, S: Statement[], anchor: Statement): Finding<RoomFinding> {
  const row = S.find((s) => ROOM_START.test(s.text) && (DIMS.test(s.text) || SF.test(s.text))) ?? null; // table form
  const dimS = S.find((s) => DIMS.test(s.text)) ?? null;
  const dm = dimS?.text.match(DIMS) ?? null;
  const hS = S.find((s) => HEIGHT.test(s.text)) ?? null;
  const hm = hS?.text.match(HEIGHT) ?? null;
  const areaS = S.find((s) => AREA_LABELED.test(s.text)) ?? S.find((s) => AREA_OF_GROWTH.test(s.text)) ?? (row && SF.test(row.text.replace(DIMS, "")) ? row : null);
  const am = areaS ? (areaS === row ? row.text.replace(DIMS, "") : areaS.text).match(SF) : null;
  let coverage: RoomFinding["coverage"] = null;
  let covS: Statement | null = null;
  for (const s of S) {
    const isRow = s === row;
    if (!isRow && !(/\bfloor/i.test(s.text) && (POS.test(s.text) || /\b(growth|mold)\b/i.test(s.text)))) continue;
    if (/^subfloor\b/i.test(s.text)) continue;
    coverage = coverageOf(isRow ? { ...s, text: s.text.replace(DIMS, "").replace(SF, "") } : s, isRow);
    if (coverage) {
      covS = s;
      break;
    }
  }
  const vagueS = S.find((s) => VAGUE.test(s.text) && /\b(growth|mold)\b/i.test(s.text));
  const sectionText = S.map((s) => s.text).join(" ");
  const growth = !negOnly(sectionText) || POS.test(sectionText.replace(NEG, ""));
  return fnd(
    {
      name,
      growth,
      lengthFt: dm ? num(dm[1]) : null,
      widthFt: dm ? num(dm[2]) : null,
      heightFt: hm ? num(hm[1] ?? hm[2]) : null,
      areaSF: am ? num(am[1]) : null,
      coverage,
      vague: !am && vagueS ? vagueS.text : null,
      quotes: { dims: dimS?.text ?? null, area: areaS?.text ?? null, coverage: covS?.text ?? null },
    },
    anchor,
  );
}

export function rulesAnalyze(pages: string[]): ReportFindings {
  const S = statements(pages);
  const textChars = pages.join("").replace(/\s/g, "").length;
  const unanswered: ReportFindings["unanswered"] = [];

  // --- what kind of report this is (a water-damage report is not a mold report) ---
  const moldSignals = S.filter((s) => (/\b(mold|mould|fungal|microbial|S520|spore)\b/i.test(s.text) || POS.test(s.text)) && !negOnly(s.text)).length;
  const waterSignals = S.filter((s) => /\b(water damage|moisture (map|readings?)|wet|drying|dehumidif|S500|extraction|water loss|category [123] water|class [1-4])\b/i.test(s.text)).length;
  const reportType: ReportFindings["reportType"] = moldSignals > 0 ? "mold" : waterSignals > 0 ? "water" : "other";

  // --- who / where ---
  const addrL = labeled(S, "property|property address|site|site address|project address|location|address|subject property");
  const addrText = addrL?.value ?? findStreetAddresses(S.slice(0, 15).map((s) => s.text).join("\n"))[0] ?? null;
  const addrS = addrL?.s ?? (addrText ? S.find((s) => s.text.includes(addrText)) ?? null : null);
  const address = addrText && addrS ? fnd(addrText.replace(/\s*,?\s*(?:apt\.?|apartment|unit|suite|#)\s*[0-9A-Z-]+\b/i, "").replace(/\s+,/g, ","), addrS) : null;
  const unitM = addrText?.match(/(?:apt\.?|apartment|unit|suite|#)\s*([0-9A-Z-]{1,8})\b/i);
  const unit = unitM && addrS ? fnd(unitM[1], addrS) : null;
  const custL = labeled(S, "prepared for|client|customer|owner|occupant|homeowner|tenant|insured");
  const customer = custL ? fnd(custL.value, custL.s) : null;
  const assL = labeled(S, "assessor|inspector|prepared by|assessed by|consultant");
  const assessor = assL ? fnd(assL.value, assL.s) : null;
  const dateL = labeled(S, "assessment date|inspection date|date of assessment|date of inspection|report date|date");
  const d = dateL ? normalizeDate(dateL.value) : null;
  const reportDate = dateL && d ? fnd(d, dateL.s) : null;

  // --- rooms (one section per room; a report not split by room is one section) ---
  const names = [...new Set(S.map((s) => s.room).filter((x): x is string => !!x))];
  const rooms: Finding<RoomFinding>[] = [];
  if (names.length) {
    for (const n of names) {
      const sec = S.filter((s) => s.room === n);
      rooms.push(readRoom(n, sec, sec[0]));
    }
  } else if (reportType === "mold") {
    const growthS = first(S, POS) ?? first(S, VAGUE);
    const roomL = labeled(S, "room|rooms|affected room|area|location of growth|work area");
    const n = roomL ? (findRoomName(roomL.value) ?? roomL.value) : growthS ? findRoomName(growthS.text) : null;
    const rf = readRoom(n ?? "", S, roomL?.s ?? growthS ?? S[0]);
    if (n || rf.value.lengthFt != null || rf.value.areaSF != null || rf.value.coverage) rooms.push(n ? rf : { ...rf, value: { ...rf.value, name: "" } });
  }
  const r0 = rooms[0] ?? null;
  const room = r0 && r0.value.name ? { ...r0, value: r0.value.name } : null;
  const dims = r0 && r0.value.lengthFt != null && r0.value.widthFt != null ? { ...r0, value: { lengthFt: r0.value.lengthFt, widthFt: r0.value.widthFt, heightFt: r0.value.heightFt }, quote: S.find((s) => s.room === r0.room && DIMS.test(s.text))?.text ?? r0.quote } : null;
  const roomQuote = (r: Finding<RoomFinding>, re: RegExp) => S.find((s) => (names.length ? s.room === r.value.name : true) && re.test(s.text)) ?? null;
  const areaQ = r0 ? roomQuote(r0, AREA_LABELED) ?? roomQuote(r0, AREA_OF_GROWTH) ?? roomQuote(r0, SF) : null;
  const affectedAreaSF = r0 && r0.value.areaSF != null && areaQ ? fnd(r0.value.areaSF, areaQ) : null;
  const covQ = r0?.value.coverage ? (S.find((s) => (names.length ? s.room === r0.value.name : true) && coverageOf(s, false)) ?? roomQuote(r0, /./)) : null;
  const floorCoverage = r0?.value.coverage && covQ ? fnd(r0.value.coverage, covQ) : null;
  if (dims && r0) dims.page = S.find((s) => s.text === dims.quote)?.page ?? dims.page;

  const ftS = first(S, /\b(wood|hardwood|engineered|laminate|parquet|oak|carpet|vinyl|lvp|tile)\b[^.]{0,20}\bfloor(ing)?\b/i);
  const ftm = ftS?.text.match(/\b(engineered wood|hardwood|wood|laminate|parquet|oak|carpet|vinyl plank|vinyl|lvp|tile)\b/i);
  const flooringType = ftS && ftm ? fnd(`${ftm[1].toLowerCase()} flooring`.replace("oak flooring", "wood flooring"), ftS) : null;

  // --- containment & removal ---
  const contL = labeled(S, "containment|containment level|containment type");
  const contS = contL?.s ?? first(S, /\bcontainment\b/i);
  const containment = contS
    ? fnd(
        {
          level: /\bno containment\b|containment\s*[:-]\s*(none|not required)/i.test(contS.text)
            ? ("none" as const)
            : /\b(full|complete|full[- ]room)\b/i.test(contS.text)
              ? ("full" as const)
              : /\b(limited|mini|local|source)\b/i.test(contS.text)
                ? ("limited" as const)
                : ("unspecified" as const),
          negativeAir: /negative (air|pressure)/i.test(contS.text),
        },
        contS,
      )
    : null;
  const remL = labeled(S, "removal|removal limits|scope of removal|material removal|remediation scope");
  const remS = remL?.s ?? first(S, /\bremove\b[^.]*\b(beyond|extend|all|entire|up to)\b/i, /\bsubfloor\b/i);
  const removalExtent = remS ? fnd(remL?.value ?? remS.text, remS) : null;

  // --- subfloor ---
  const subS = labeled(S, "subfloor|sub-floor")?.s ?? first(S, /\b(subfloor|sub-floor)\b/i);
  let subfloor: ReportFindings["subfloor"] = null;
  if (subS) {
    const t = subS.text.replace(/\b(do not|don't|not to be|no need to|without)\s+(be\s+)?(remov|replac)\w*/gi, "");
    if (/\b(remove|replace|cut out|discard|tear out)\b/i.test(t)) subfloor = fnd("remove", subS);
    else if (/\b(clean|treat|sand|hepa|wire[- ]brush|encapsulat|scrub)/i.test(subS.text)) subfloor = fnd("clean", subS);
  }

  // --- other growth ---
  const wallS = labeled(S, "walls|wall surfaces|drywall|wall")?.s ?? first(S, /\b(wall surfaces?|drywall|sheetrock|gypsum)\b/i, /baseboard/i);
  const wg = growthFinding(wallS);
  let wallsGrowth: ReportFindings["wallsGrowth"] = null;
  if (wg && wallS) {
    const h = wallS.text.match(/\b(?:bottom|lower|first|up to|to a height of|to)\s*(\d+(?:\.\d+)?)\s*(in(?:ches)?|"|”|ft|feet|')/i) ?? wallS.text.match(/(\d+(?:\.\d+)?)\s*(in(?:ches)?|"|”|ft|feet|')\s*(?:above the floor|from the floor|high)/i);
    const heightIn = h ? (/(ft|feet|')/i.test(h[2]) ? num(h[1]) * 12 : num(h[1])) : null;
    wallsGrowth = { ...wg, value: { ...wg.value, heightIn: wg.value.growth ? heightIn : null } };
  }
  const bbS = labeled(S, "baseboard|baseboards|trim")?.s ?? first(S, /\bbaseboards?\b/i);
  const baseboardBacksGrowth = growthFinding(bbS);
  const frS = labeled(S, "framing|joists|floor joists|studs|wall studs|structural framing")?.s ?? first(S, /\b(framing|joists?|studs|sill plate)\b/i);
  const fg = growthFinding(frS);
  let framingGrowth: ReportFindings["framingGrowth"] = null;
  if (fg && frS) {
    const t = frS.text.replace(/\b(do not|don't|not to be|no need to)\s+(be\s+)?(remov|replac)\w*/gi, "");
    const where = /\b(joists?|floor framing|sill)\b/i.test(frS.text) ? ("joists" as const) : /\b(studs?|wall framing|plates?)\b/i.test(frS.text) ? ("studs" as const) : ("framing" as const);
    const action = !fg.value.growth ? null : /\b(remove|replace|sister|rot|rotted|decay|structural damage|compromised)\b/i.test(t) ? ("remove" as const) : /\b(clean|sand|wire[- ]brush|hepa|treat|encapsulat)/i.test(frS.text) ? ("clean" as const) : null;
    framingGrowth = { ...fg, value: { growth: fg.value.growth, where, action } };
  }

  // --- clearance ---
  const prvS = labeled(S, "post-remediation verification|post remediation verification|post-remediation assessment|clearance|clearance testing|clearance criteria|prv")?.s ?? first(S, /\b(post[- ]remediation (verification|assessment|testing)|clearance)\b/i);
  let clearanceCriteria: ReportFindings["clearanceCriteria"] = null;
  let clearanceBy: ReportFindings["clearanceBy"] = null;
  if (prvS && OPEN.test(prvS.text)) {
    unanswered.push({ key: "clearanceCriteria", label: "Clearance criteria", quote: prvS.text });
    unanswered.push({ key: "clearanceBy", label: "Who does the post-remediation check", quote: prvS.text });
  } else if (prvS) {
    if (/\b(visual|air sampl|spore|moisture|dry standard|tape|swab|surface sampl|comparable|outdoor|pass)\w*/i.test(prvS.text)) clearanceCriteria = fnd(prvS.text.replace(/^[^:]+:\s*/, ""), prvS);
    const by = prvS.text.match(/\bby\s+(?:an?\s+|the\s+)?([^;:.]*?(?:assessor|consultant|inspector|hygienist|company|firm|third[- ]party|laboratory|lab)\b)/i) ?? prvS.text.match(/\b((?:independent|third[- ]party)[^;:.,]*)/i);
    if (by) clearanceBy = fnd(by[1].trim(), prvS);
  }

  // --- moisture source ---
  const srcL = labeled(S, "moisture source|source of moisture|water source|cause|cause of growth|cause of moisture|cause of loss|source");
  const srcS = srcL?.s ?? first(S, /\b(leak|condensation|humidity|intrusion|plumbing|roof|flood)\b[^.]*\b(source|caused|cause)\b|\bsource\b[^.]*\b(leak|condensation|humidity|intrusion)\b/i);
  const moistureSource = srcS ? fnd((srcL?.value ?? srcS.text).replace(/\.\s.*$/, "."), srcS) : null;
  const FIX_WORDS = /\b(repaired|fixed|corrected|resolved|stopped|active|ongoing|still leaking|unknown|undetermined|not (yet )?(been )?(identified|located|determined))\b/i;
  const fixS = srcS && FIX_WORDS.test(srcS.text) ? srcS : first(S, /\b(leak|source|moisture)\b[^.]*\b(repaired|fixed|corrected|resolved|stopped|active|ongoing|still leaking)\b/i);
  let sourceFixed: ReportFindings["sourceFixed"] = null;
  if (fixS) {
    if (/\b(not (yet )?(been )?(repaired|fixed|corrected|resolved|stopped))\b|\b(active|ongoing|still leaking|remains? (active|wet))\b/i.test(fixS.text)) sourceFixed = fnd(false, fixS);
    else if (/\b(unknown|undetermined|not (yet )?(been )?(identified|located|determined))\b/i.test(fixS.text)) sourceFixed = null;
    else if (/\b(repaired|fixed|corrected|resolved|stopped)\b/i.test(fixS.text)) sourceFixed = fnd(true, fixS);
  }

  // --- building & flooring run ---
  const ybS = first(S, /\b(year built|built in|constructed in|construction (year|date)|built circa|built c\.)\D{0,10}(1[789]\d\d|20[0-4]\d)\b/i);
  const yearBuilt = ybS ? fnd(Number(ybS.text.match(/\b(1[789]\d\d|20[0-4]\d)\b/)![1]), ybS) : null;
  const runS =
    first(S, /\b(flooring|floor|wood)\b[^.]{0,60}\b(continues|extends|runs|continuous|continuously)\b[^.]{0,40}\b(into|to|through)\b/i) ??
    first(S, /\b(flooring|floor)\b[^.]{0,60}\b(does not (continue|extend|run)|stops at|ends at|threshold|transition|natural break)\b/i);
  let flooringContinuous: ReportFindings["flooringContinuous"] = null;
  if (runS) {
    const t = runS.text.replace(/\b(no|without)\s+(a\s+|any\s+)?(natural break|threshold|transition)s?(\s+(or|and)\s+(a\s+)?(natural break|threshold|transition)s?)?/gi, "");
    if (/\b(does not (continue|extend|run)|stops at|ends at|natural break|threshold|transition)\b/i.test(t)) flooringContinuous = fnd({ continues: false, rooms: [] }, runS);
    else {
      const from = runS.text.match(/\bfrom\s+(?:the\s+)?([a-z ]+?)\s+(?:into|to|through)\b/i)?.[1] ?? "";
      const into = runS.text.match(/\b(?:into|to|through)\s+(?:the\s+)?([^.]+)/i)?.[1] ?? "";
      const roomsIn = [from, ...into.split(/,|\band\b/)].map((x) => findRoomName(x)).filter((x): x is string => !!x);
      flooringContinuous = fnd({ continues: true, rooms: [...new Set(roomsIn)] }, runS);
    }
  }

  // --- mold type & condition ---
  const mtL = labeled(S, "mold type|mold types|species|genus|genera|organisms?|identified|mold identified");
  const mtS = mtL?.s ?? first(S, /\b(cladosporium|penicillium|aspergillus|stachybotrys|chaetomium|alternaria|trichoderma|ulocladium)\b/i);
  const moldType = mtS ? fnd(mtL?.value ?? mtS.text, mtS) : null;
  const condS = first(S, /\bcondition\s*[123]\b/i) ?? first(S, /\bcategory\s*[123]\b/i);
  const cm = condS?.text.match(/\b(condition|category)\s*([123])\b(\s*\([^)]*\))?/i);
  const condition = condS && cm ? fnd(`${cm[1][0].toUpperCase()}${cm[1].slice(1).toLowerCase()} ${cm[2]}${cm[3] ?? ""}`, condS) : null;

  const out: ReportFindings = {
    analyzer: "rules",
    readable: textChars >= 40,
    textChars,
    reportType,
    rooms,
    flooringType,
    address,
    unit,
    customer,
    assessor,
    reportDate,
    room,
    dims,
    affectedAreaSF,
    floorCoverage,
    containment,
    removalExtent,
    subfloor,
    wallsGrowth,
    baseboardBacksGrowth,
    framingGrowth,
    clearanceCriteria,
    clearanceBy,
    moistureSource,
    sourceFixed,
    yearBuilt,
    flooringContinuous,
    moldType,
    condition,
    unanswered,
  };
  const label = new Map(FINDING_LABELS);
  for (const k of SCOPE_FINDINGS)
    if (out[k] == null && !unanswered.some((u) => u.key === k)) unanswered.push({ key: k as FindingKey, label: label.get(k as FindingKey) ?? k, quote: null });
  return out;
}
