import { findStreetAddresses, normalizeDate } from "../fnol";
import { findRoomName, ROOM_PATTERNS } from "../rooms";
import { FINDING_LABELS, SCOPE_FINDINGS, type Finding, type FindingKey, type ReportConflict, type ReportFindings, type RoomFinding, type Surface, type WallRemoval } from "./types";

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
  // Page headers/footers repeated on most pages (client block, company, "Page 7 of 52") are dropped
  // after page 1 — otherwise they break sentences that run across pages.
  const norm = (l: string) => l.replace(/\s+/g, " ").trim().replace(/\d+/g, "#");
  const seen = new Map<string, number>();
  pages.forEach((txt) => new Set(txt.split(/\r?\n/).map(norm).filter(Boolean)).forEach((l) => seen.set(l, (seen.get(l) ?? 0) + 1)));
  const repeated = (l: string) => pages.length >= 3 && (seen.get(norm(l)) ?? 0) >= Math.max(3, pages.length * 0.5);
  const FUNCTION_END = /\b(the|in|of|and|at|to|a|an|by|for|with|from|on|or|as|that|is|are|be|this|these|which|than)$/i;
  pages.forEach((txt, i) => {
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line || /^SAMPLE - TEST FIXTURE/i.test(line)) continue;
      if (i > 0 && repeated(line)) continue;
      const prev = out[out.length - 1];
      // "Prepared for:" on its own line, value on the next
      if (prev && /^[A-Z][A-Za-z /&()'-]{1,30}:$/.test(prev.text) && !LABEL_START.test(line) && !/^[•\-–]/.test(line)) {
        prev.text = `${prev.text} ${line}`;
        continue;
      }
      const startsLower = /^[a-z(“"']/.test(line) || (/^[0-9]/.test(line) && !LABEL_START.test(prev?.text ?? ""));
      // a long sentence broken mid-way by the page layout ("… in the Primary" / "Bathroom, clean the vent …")
      const midSentence =
        !!prev && !LABEL_START.test(prev.text) && /[A-Za-z0-9,]$/.test(prev.text) && prev.text.split(/\s+/).length >= 8 && /^[A-Z][A-Za-z/]*\b/.test(line) && !/^[A-Z][A-Za-z ]{0,40}:(\s|$)/.test(line);
      const continues =
        prev &&
        prev.page >= i &&
        !/[.:;!?]$/.test(prev.text) &&
        !LABEL_START.test(line) &&
        !HEADING.test(line) &&
        !(HEADING.test(prev.text) && prev.text.split(/\s+/).length <= 6) &&
        !ROOM_START.test(line) &&
        !/^[•\-–]\s/.test(line) &&
        (startsLower || FUNCTION_END.test(prev.text) || midSentence);
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
/** The single sentence of a statement that matches — quotes stay short and exact. */
const sentence = (s: Statement, re: RegExp): Statement => {
  const parts = s.text.split(/(?<=[.!?])\s+(?=[A-Z(•-])/);
  const hit = parts.find((x) => re.test(x));
  return hit ? { ...s, text: hit.trim() } : s;
};
const firstSentence = (S: Statement[], re: RegExp, not?: RegExp): Statement | null => {
  for (const s of S) {
    const x = sentence(s, re);
    if (re.test(x.text) && !(not && not.test(x.text))) return x;
  }
  return null;
};
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12, eighteen: 18, "twenty-four": 24 };
const toNum = (x: string) => WORD_NUM[x.toLowerCase()] ?? Number(x.replace(/,/g, ""));
/** Every room named in a phrase ("the Bedroom, Den, and Kitchen Area" → Bedroom, Den, Kitchen). */
export function findRoomNames(text: string): string[] {
  return [...new Set(text.split(/,|;|\band\b|\/(?![Dd]ryer)/).map((x) => findRoomName(x)).filter((x): x is string => !!x))];
}
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
  const addrL = labeled(S, "property|property address|site|site address|project address|location|address|subject property|conducted at|inspection address|property location");
  const addrText = addrL?.value ?? findStreetAddresses(S.slice(0, 15).map((s) => s.text).join("\n"))[0] ?? null;
  const addrS = addrL?.s ?? (addrText ? S.find((s) => s.text.includes(addrText)) ?? null : null);
  const address = addrText && addrS ? fnd(addrText.replace(/\s*,?\s*(?:apt\.?|apartment|unit|suite|#)\s*[0-9A-Z-]+\b/i, "").replace(/\s+,/g, ","), addrS) : null;
  const unitM = addrText?.match(/(?:apt\.?|apartment|unit|suite|#)\s*([0-9A-Z-]{1,8})\b/i);
  const unit = unitM && addrS ? fnd(unitM[1], addrS) : null;
  const custL = labeled(S, "prepared for|client name|client|customer|owner|occupant|homeowner|tenant|insured");
  const customer = custL ? fnd(custL.value, custL.s) : null;
  const assL = labeled(S, "assessor|inspector|prepared by|assessed by|consultant");
  const assessor = assL ? fnd(assL.value, assL.s) : null;
  const dateL = labeled(S, "assessment date|inspection date|date of assessment|date of inspection|report date|date");
  const d = dateL ? normalizeDate(dateL.value) : null;
  const reportDate = dateL && d ? fnd(d, dateL.s) : null;

  // --- rooms (one section per room; a report not split by room is one section) ---
  // itemized lists: "Mold growth confirmed … in the following areas: • Bedroom Wall by A/C • …"
  const listAfter = (re: RegExp) => {
    const i = S.findIndex((s) => re.test(s.text));
    const items: Statement[] = [];
    if (i >= 0) for (let j = i + 1; j < S.length && /^[•▪◦\-–]\s/.test(S[j].text); j++) items.push({ ...S[j], text: S[j].text.replace(/^[•▪◦\-–]\s*/, "") });
    return items;
  };
  const growthItems = listAfter(/\b(mold growth|visible mold|growth)\b[^.]*\b(confirmed|detected|observed|found|identified)\b[^.]*\b(following|these)\s+(areas|locations)\b/i);
  const airItems = listAfter(/\belevated\b[^.]*\b(spore counts?|mold counts?|levels)\b[^.]*\b(following|these)\s+(areas|locations)\b/i);
  const surfaceOf = (t: string): Surface =>
    /caulk/i.test(t) ? "caulking" : /\bvents?\b/i.test(t) ? "vent" : /\bfloor/i.test(t) ? "floor" : /ceiling/i.test(t) ? "ceiling" : /cabinet/i.test(t) ? "cabinet" : /base ?board|base molding/i.test(t) ? "baseboard" : "wall";
  const itemized = new Map<string, { stmt: Statement; surfaces: Surface[]; wallLabel: string | null; air: boolean; floorQuote: string | null }>();
  for (const it of growthItems) {
    const n = findRoomName(it.text);
    if (!n) continue;
    const e = itemized.get(n) ?? { stmt: it, surfaces: [], wallLabel: null, air: false, floorQuote: null };
    const sf = surfaceOf(it.text);
    if (!e.surfaces.includes(sf)) e.surfaces.push(sf);
    if (sf === "floor") e.floorQuote = it.text;
    if (sf === "wall" && !e.wallLabel) {
      const by = it.text.match(/\b(?:by|behind|under|near)\s+(?:the\s+)?([A-Za-z/]+)/i);
      e.wallLabel = by ? `${by[1]} wall` : /\b(rear|back)\b/i.test(it.text) ? "rear wall" : null;
    }
    itemized.set(n, e);
  }
  for (const it of airItems) {
    const n = findRoomName(it.text);
    if (!n) continue;
    const e = itemized.get(n) ?? { stmt: it, surfaces: [], wallLabel: null, air: false, floorQuote: null };
    e.air = true;
    itemized.set(n, e);
  }

  const names = [...new Set(S.map((s) => s.room).filter((x): x is string => !!x))];
  const rooms: Finding<RoomFinding>[] = [];
  if (!names.length && itemized.size) {
    for (const [n, e] of itemized) {
      const floor = e.surfaces.includes("floor");
      rooms.push(
        fnd(
          {
            name: n,
            growth: e.surfaces.length > 0,
            lengthFt: null,
            widthFt: null,
            heightFt: null,
            areaSF: null,
            // "Flooring by A/C": growth at one spot — part of the floor, boundary not given
            coverage: floor ? { whole: false, pct: null } : null,
            vague: null,
            quotes: { dims: null, area: null, coverage: e.floorQuote },
            surfaces: e.surfaces,
            wallLabel: e.wallLabel,
            airElevated: e.air,
          },
          e.stmt,
        ),
      );
    }
  } else if (names.length) {
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
  const covQuote = r0?.value.quotes.coverage ? (S.find((s) => s.text.includes(r0.value.quotes.coverage!)) ?? null) : null;
  const floorCoverage = r0?.value.coverage && (covQuote || covQ) ? fnd(r0.value.coverage, covQuote ? { ...covQuote, text: r0.value.quotes.coverage! } : covQ!) : null;
  if (dims && r0) dims.page = S.find((s) => s.text === dims.quote)?.page ?? dims.page;

  const ftS = first(S, /\b(wood|hardwood|engineered|laminate|parquet|oak|carpet|vinyl|lvp|tile)\b[^.]{0,20}\bfloor(ing)?\b/i);
  const ftm = ftS?.text.match(/\b(engineered wood|hardwood|wood|laminate|parquet|oak|carpet|vinyl plank|vinyl|lvp|tile)\b/i);
  const flooringType = ftS && ftm ? fnd(`${ftm[1].toLowerCase()} flooring`.replace("oak flooring", "wood flooring"), ftS) : null;

  // --- containment & removal ---
  const contL = labeled(S, "containment|containment level|containment type");
  const contListS = firstSentence(S, /^-?\s*contain\b[^.]*\([a-h]\)/i) ?? firstSentence(S, /\bcontain\b[^.]*\b(localized|entire)\b/i);
  const contS = contListS ?? contL?.s ?? first(S, /\bcontainment\b/i, /\b(in the containment|remediator shall)\b/i) ?? first(S, /\bcontainment\b/i);
  const areas: { room: string; extent: "localized" | "entire" | null }[] = [];
  if (contListS) {
    const segs = contListS.text.split(/\([a-h]\)/i).slice(1);
    for (const seg of segs.length ? segs : [contListS.text]) {
      const room = findRoomName(seg);
      if (!room || areas.some((a) => a.room === room)) continue;
      areas.push({ room, extent: /\b(localized|portion|part of|area of|area at)\b/i.test(seg) ? "localized" : /\b(entire|whole|all of)\b/i.test(seg) || /^\s*the\s+[\w/ ]*\b(closet|room)\b/i.test(seg) ? "entire" : null });
    }
  }
  const separateContainments = areas.length > 1 && (/\([b-h]\)/i.test(contListS?.text ?? "") || S.some((s) => /\beach containment\b/i.test(s.text)));
  const negS = firstSentence(S, /\bnegative (air|pressure)\b/i);
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
          negativeAir: /negative (air|pressure)/i.test(contS.text) || !!negS,
          ...(areas.length ? { areas, separate: separateContainments, material: contS.text.match(/(\d+\s*-?\s*mil[^.]*?)(?:\.|$)/i)?.[1]?.trim() ?? null } : {}),
        },
        contS,
      )
    : null;
  const remL = labeled(S, "removal|removal limits|scope of removal|material removal|remediation scope");
  const remS = remL?.s ?? first(S, /\bremove\b[^.]*\b(beyond|extend|all|entire|up to)\b/i, /\bsubfloor\b/i);
  const remSent = remS ? sentence(remS, /\bremove\b/i) : null;
  const removalExtent = remSent ? fnd(remL?.value ?? remSent.text, remSent) : null;

  // --- subfloor ---
  const subS0 = labeled(S, "subfloor|sub-floor")?.s ?? first(S, /\b(subfloor\w*|sub-floor\w*)\b/i);
  const subS = subS0 ? sentence(subS0, /\b(subfloor\w*|sub-floor\w*)\b/i) : null;
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
    const h = wallS.text.match(/\b(?:bottom|lower|first|up to|to a height of|to)\s*(\d+(?:\.\d+)?)\s*(in(?:ches)?|"|”|ft|feet|')/i) ?? wallS.text.match(/(\d+(?:\.\d+)?)\s*(in(?:ches)?|"|”|ft|feet|')\s*(?:above the floor|from the floor|from the ground|high)/i);
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
  const ci = S.findIndex((s) => /^criteria for clearance/i.test(s.text));
  const critS = ci >= 0 ? S[ci] : null;
  if (critS) {
    const items = critS.text.replace(/^criteria for clearance( testing)?:?\s*/i, "").split(/\s*(?=\b\d\)\s)/).map((x) => x.trim()).filter(Boolean);
    for (let j = ci + 1; j < S.length && /^\d+[.)]\s/.test(S[j].text); j++) items.push(S[j].text);
    if (items.length) clearanceCriteria = fnd(items.join(" "), { ...critS, text: `${critS.text.replace(/:?\s*$/, ":")} ${items.join(" ")}` });
  }
  const bySole = firstSentence(S, /\bonly a\s+((?:NYS|New York State)\s+mold assessor)\b/i);
  if (bySole) clearanceBy = fnd(bySole.text.match(/\bonly a\s+((?:NYS|New York State)\s+mold assessor)\b/i)![1].replace(/^nys/i, "NYS").replace(/mold assessor/i, "Mold Assessor"), bySole);
  if (critS || bySole) {
    /* criteria / assessor stated explicitly */
  } else if (prvS && OPEN.test(prvS.text)) {
    unanswered.push({ key: "clearanceCriteria", label: "Clearance criteria", quote: prvS.text });
    unanswered.push({ key: "clearanceBy", label: "Who does the post-remediation check", quote: prvS.text });
  } else if (prvS) {
    if (/\b(visual|air sampl|spore|moisture|dry standard|tape|swab|surface sampl|comparable|outdoor|pass)\w*/i.test(prvS.text)) clearanceCriteria = fnd(prvS.text.replace(/^[^:]+:\s*/, ""), prvS);
    const by = prvS.text.match(/\bby\s+(?:an?\s+|the\s+)?([^;:.]*?(?:assessor|consultant|inspector|hygienist|company|firm|third[- ]party|laboratory|lab|licensee)\b)/i) ?? prvS.text.match(/\b((?:independent|third[- ]party)[^;:.,]*)/i);
    if (by) clearanceBy = fnd(by[1].trim(), prvS);
  }

  // --- moisture source ---
  const srcL = labeled(S, "moisture source|source of moisture|water source|cause|cause of growth|cause of moisture|cause of loss|source");
  const srcS = srcL?.s ?? first(S, /\b(leak|condensation|humidity|intrusion|plumbing|roof|flood)\b[^.]*\b(source|caused|cause)\b|\bsource\b[^.]*\b(leak|condensation|humidity|intrusion)\b/i);
  const srcSent = srcS ? sentence(srcS, /\b(source|leak|intrusion|condensation)\b/i) : null;
  // "The source of water intrusion must be addressed …" names no source — it is not a finding of what the source is.
  const namesSource = (t: string) => /\b(leak|valve|pipe|plumbing|roof|condensation|humidity|a\/c|hvac|window|appliance|washer|toilet|shower|tub|flood|groundwater|drain|radiator|sprinkler|ice|gutter)\b/i.test(t.replace(/^.*?:\s*/, ""));
  const moistureSource = srcSent && (srcL || namesSource(srcSent.text)) ? fnd((srcL?.value ?? srcSent.text).replace(/\.\s.*$/, "."), srcSent) : null;
  if (!moistureSource && srcSent) unanswered.push({ key: "moistureSource", label: "Moisture source", quote: srcSent.text });
  const FIX_WORDS = /\b(repaired|fixed|corrected|resolved|stopped|active|ongoing|still leaking|unknown|undetermined|not (yet )?(been )?(identified|located|determined))\b/i;
  const PROCEDURE = /\b(to determine|determine (if|whether|any)|whether there|if there were any|are taken|were taken)\b/i;
  const fixS = srcS && FIX_WORDS.test(srcS.text) && !PROCEDURE.test(srcS.text) ? srcS : first(S, /\b(leak|source|moisture)\b[^.]*\b(repaired|fixed|corrected|resolved|stopped|active|ongoing|still leaking)\b/i, PROCEDURE);
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
  const mtS = mtL?.s ?? first(S, /\b(cladosporium|penicillium|aspergillus|stachybotrys|chaetomium|alternaria|trichoderma|ulocladium)\b/i, /\bno\s+(chaetomium|stachybotrys|aspergillus|penicillium|cladosporium)\b|criteria|clearance/i);
  const moldType = mtS ? fnd(mtL?.value ?? mtS.text, mtS) : null;
  const NOT_CURRENT = /\b(normal fungal ecology|return|back to|reduced to|levels|goal|purpose)\b/i;
  const condS = first(S, /\bcondition\s*[123]\b/i, NOT_CURRENT) ?? first(S, /\bcategory\s*[123]\b/i, NOT_CURRENT);
  const cm = condS?.text.match(/\b(condition|category)\s*([123])\b(\s*\([^)]*\))?/i);
  const condition = condS && cm ? fnd(`${cm[1][0].toUpperCase()}${cm[1].slice(1).toLowerCase()} ${cm[2]}${cm[3] ?? ""}`, condS) : null;

  // --- protocol items (plans written as instructions, not room sections) ---
  const conflicts: ReportConflict[] = [];
  const scrS = firstSentence(S, /\bair scrubbers?\b[^.]*\b(\d+)\s*hours?\b/i) ?? firstSentence(S, /\bair scrubbers?\b[^.]*\beach containment\b/i);
  let airScrubber: ReportFindings["airScrubber"] = undefined;
  if (scrS) {
    const t = scrS.text;
    const per = t.match(/\b(?:install|use|place|set)\s+(\d+|one|two)\s+HEPA/i);
    const after = t.split(/each containment area\s*[–—:-]?\s*/i)[1] ?? "";
    airScrubber = fnd(
      { perContainment: per ? toNum(per[1]) : 1, hours: Number(t.match(/(\d+)\s*hours?/i)?.[1] ?? NaN) || null, ach: Number(t.match(/(\d+)\s*ACH/i)?.[1] ?? NaN) || null, rooms: findRoomNames(after) },
      scrS,
    );
    const contRooms = areas.map((a) => a.room);
    if (contRooms.length && airScrubber.value.rooms.length && (contRooms.length !== airScrubber.value.rooms.length || !contRooms.every((r) => airScrubber!.value.rooms.includes(r))))
      conflicts.push({ text: `Containments listed (${contRooms.join(", ")}) and air-scrubber areas (${airScrubber.value.rooms.join(", ")}) don't match`, quotes: [{ quote: contS!.text, page: contS!.page }, { quote: scrS.text, page: scrS.page }] });
  }
  const wallRemovals: Finding<WallRemoval>[] = [];
  for (const st of S) {
    for (const part of st.text.split(/(?<=[.!?])\s+(?=[A-Z(])|\s(?=\([a-h]\)\s)/)) {
      const a = part.match(/\b(?:all\s+)?drywall\s+(\d+|one|two|three|four)\s*(feet|foot|ft|inches|inch|in)\b\s*(?:from|above)\s+the\s+(?:ground|floor)\s+in\s+the\s+(.+?)\s+along\s+the\s+affected\s+wall/i);
      if (a) {
        const rs = findRoomNames(a[3]);
        wallRemovals.push(fnd({ rooms: rs, wallLabel: "affected wall", heightIn: toNum(a[1]) * (/^f/i.test(a[2]) ? 12 : 1), statedSF: null, approximate: false, entireWall: false }, { ...st, text: part.trim() }));
      }
      const b = part.match(/\bremove\s+(approximately|approx\.?|about|roughly|around)?\s*(\d+(?:\.\d+)?)\s*(?:square feet|sq\.?\s*ft|sf)\s+of\s+drywall\s+(?:at|on|from)\s+the\s+(rear|back|front|side)?\s*([\w/]+)\s+wall/i);
      if (b) {
        const room = findRoomName(`${b[4]} wall`) ?? findRoomName(part);
        wallRemovals.push(fnd({ rooms: room ? [room] : [], wallLabel: `${b[3] ? `${b[3].toLowerCase()} ` : ""}wall`, heightIn: null, statedSF: Number(b[2]), approximate: !!b[1], entireWall: /\bentire\b/i.test(part) }, { ...st, text: part.trim() }));
      }
    }
  }
  const beyS = firstSentence(S, /\b(?:cutouts?|cuts?|removal)\s+(\d+|twelve|six)\s*inch(?:es)?\s+beyond\b/i);
  const cutBeyondIn = beyS ? fnd(toNum(beyS.text.match(/\b(\d+|twelve|six)\s*inch/i)![1]), beyS) : undefined;
  const pastS = firstSentence(S, /\bminimum of\s+(\d+|one|two|three)\s*(feet|foot|ft)\s+past\b/i);
  if (cutBeyondIn && pastS) {
    const pastIn = toNum(pastS.text.match(/\bminimum of\s+(\d+|one|two|three)\s*(feet|foot|ft)/i)![1]) * 12;
    if (pastIn !== cutBeyondIn.value) {
      const base = wallRemovals.find((w) => w.value.heightIn)?.value.heightIn ?? null;
      conflicts.push({
        text: `How far past affected drywall to cut: ${cutBeyondIn.value} in (p.${cutBeyondIn.page}) vs at least ${pastIn / 12} ft (p.${pastS.page})${base ? `. If growth reaches the ${base}" cut line: ${base} + ${cutBeyondIn.value} = ${base + cutBeyondIn.value}" by the first rule, ${base} + ${pastIn} = ${base + pastIn}" by the second` : ""} — confirm with the assessor`,
        quotes: [
          { quote: cutBeyondIn.quote, page: cutBeyondIn.page },
          { quote: pastS.text, page: pastS.page },
        ],
      });
    }
  }
  const ftS2 = firstSentence(S, /\beither\s+(?:the\s+)?remov\w*\s+of\s+(?:the\s+)?affected\s+[\w ]*floor\w*\s+or\b[^.]*\bsand/i);
  const floorTreatment = ftS2 ? fnd({ rooms: findRoomNames(ftS2.text.split(/\bproceed\b|\beither\b/i)[0]), options: ["remove", "sand"] as ("remove" | "sand")[] }, ftS2) : undefined;
  const frcS = firstSentence(S, /\b(sand|wire[- ]?brush)\w*\b[^.]*\b(framing|studs|structural components)\b/i);
  const framingCleaning = frcS ? fnd(frcS.text, frcS) : undefined;
  const encS = firstSentence(S, /\bencapsulat\w*\b[^.]*\b(framing|wood|structural)\b/i);
  const encapsulant = encS ? fnd(encS.text, encS) : undefined;
  const hvS = firstSentence(S, /\bHEPA[- ]vacuum\s+all\s+surfaces\b/i);
  const sanS = firstSentence(S, /\b(deep sanitization|small particle cleaning)\b[^.]*\ball surfaces\b/i);
  const prodS = firstSentence(S, /\bantimicrobial\b[^.]*\bsuch as\b/i);
  const product = prodS?.text.match(/\bsuch as\s+([A-Z][\w-]*(?:\s+[A-Z0-9][\w-]*){0,3})/)?.[1] ?? null;
  const surfaceCleaning = hvS || sanS ? fnd({ hepaVacuum: !!hvS, sanitize: !!sanS, product }, (sanS ?? hvS)!) : undefined;
  const specialItems: NonNullable<ReportFindings["specialItems"]> = [];
  const caulkS = firstSentence(S, /\bcaulk\w*\b[^.]*\b(silicone|seal|replace)\b/i);
  if (caulkS) {
    const room = findRoomName(caulkS.text);
    if (room) specialItems.push(fnd({ room, kind: "shower_caulking" as const, hvacIfInaccessible: false }, caulkS));
  }
  const ventS = firstSentence(S, /\bclean\b[^.]*\bvents?\b/i);
  if (ventS) {
    const room = findRoomName(ventS.text);
    if (room) specialItems.push(fnd({ room, kind: "vent" as const, hvacIfInaccessible: /\bHVAC\b/i.test(ventS.text) }, ventS));
  }
  const poS = first(S, /\bpack[- ]?out\b|\bpack out\b/i); // the whole item: pack-out and the porous-discard rule
  const packout = poS ? fnd(poS.text, poS) : undefined;
  const baseboardRemovals: NonNullable<ReportFindings["baseboardRemovals"]> = [];
  for (const st of S) {
    const x = sentence(st, /\b(base moldings?|baseboards?)\b[^.]*\bremoved\b|\bremove\b[^.]*\b(base moldings?|baseboards?)\b/i);
    if (!/\b(base moldings?|baseboards?)\b/i.test(x.text) || !/\bremov/i.test(x.text)) continue;
    const room = findRoomName(x.text);
    if (room && !baseboardRemovals.some((b) => b.value.room === room)) baseboardRemovals.push(fnd({ room }, x));
  }
  const clearanceConditions: Finding<string>[] = [];
  for (const re of [/\bshut down\b[^.]*\b24 hours?\b/i, /\brebuild\b[^.]*\bafter clearance\b/i, /\bpost remediation visual inspection\b[^.]*\bair sample\b/i]) {
    const x = firstSentence(S, re);
    if (x) clearanceConditions.push(fnd(x.text, x));
  }
  const mbaS = firstSentence(S, /\bsource of (?:the\s+)?(?:water intrusion|water|moisture|leak)\b[^.]*\bmust be (addressed|corrected|repaired|fixed|resolved)\b/i);
  const sourceMustBeAddressed = mbaS && !sourceFixed?.value ? fnd(mbaS.text, mbaS) : undefined;
  const hzS = firstSentence(S, /^(?=.*\b(asbestos|lead-based paint)\b)(?=.*\b(responsible|regulations|followed|follow)\b)/i);
  const hazardNote = hzS ? fnd(hzS.text, hzS) : undefined;
  const otherConcerns: Finding<string>[] = [];
  for (const st of S) {
    const x = sentence(st, /\bsuspected mold\b/i);
    if (/\bsuspected mold\b/i.test(x.text) && !otherConcerns.some((o) => o.quote === x.text)) otherConcerns.push(fnd(x.text, x));
  }
  const labMention = firstSentence(S, /\blab(oratory)?\s+(reports?|results?|analysis)\b/i);
  const labTables = S.some((s) => /\b(spores?\s*\/\s*m3|raw count|counts?\s*\/\s*m3|cfu)\b/i.test(s.text));
  const labTablesMissing = labMention && !labTables && !moldType ? fnd("The report refers to lab results, but no lab tables are in its text", labMention) : undefined;
  if (labTablesMissing) unanswered.push({ key: "moldType", label: "Mold type", quote: labTablesMissing.quote });

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
    airScrubber,
    wallRemovals,
    cutBeyondIn,
    floorTreatment,
    framingCleaning,
    encapsulant,
    surfaceCleaning,
    specialItems,
    packout,
    baseboardRemovals,
    clearanceConditions,
    sourceMustBeAddressed,
    hazardNote,
    otherConcerns,
    conflicts,
    labTablesMissing,
  };
  const label = new Map(FINDING_LABELS);
  for (const k of SCOPE_FINDINGS)
    if (out[k] == null && !unanswered.some((u) => u.key === k)) unanswered.push({ key: k as FindingKey, label: label.get(k as FindingKey) ?? k, quote: null });
  return out;
}
