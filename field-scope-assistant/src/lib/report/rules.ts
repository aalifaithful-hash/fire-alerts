import { findStreetAddresses, normalizeDate } from "../fnol";
import { findRoomName } from "../rooms";
import { FINDING_LABELS, SCOPE_FINDINGS, type Finding, type FindingKey, type ReportFindings } from "./types";

/**
 * Rules-based mold-report reader (no AI). Works on selectable PDF text: wrapped lines are joined
 * back into statements, then each finding is read from a labeled line ("Containment: …") or a
 * plain sentence ("growth … across the entire bedroom floor"). Every finding keeps its statement
 * as the quote. Nothing the report doesn't say is filled in.
 */

interface Statement {
  text: string;
  page: number;
}

const LABEL_START = /^[A-Z][A-Za-z /&()'-]{1,40}:\s/;
const HEADING = /^(\d+(\.\d+)*[.)]\s+\S|[A-Z][A-Z /&-]{3,}$)/;

/** Joins wrapped lines into statements (a line continues the previous one unless it starts a label, heading or new sentence). */
export function statements(pages: string[]): Statement[] {
  const out: Statement[] = [];
  pages.forEach((txt, i) => {
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line || /^SAMPLE - TEST FIXTURE/i.test(line)) continue;
      const prev = out[out.length - 1];
      const continues =
        prev && prev.page === i + 1 && !/[.:;!?]$/.test(prev.text) && !LABEL_START.test(line) && !HEADING.test(line) && !HEADING.test(prev.text) && /^[a-z0-9(“"']/.test(line);
      if (continues) prev.text = `${prev.text} ${line}`;
      else out.push({ text: line, page: i + 1 });
    }
  });
  return out;
}

const fnd = <T>(value: T, s: Statement): Finding<T> => ({ value, quote: s.text, page: s.page });
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
const POS = /\b(growth|mold)\b[^.;]{0,40}\b(observed|found|present|visible|noted|identified)\b|\bvisible (mold )?(growth|mold)\b/i;
const WALLS: [RegExp, string][] = [
  [/\bnorth\b/i, "N"],
  [/\beast\b/i, "E"],
  [/\bsouth\b/i, "S"],
  [/\bwest\b/i, "W"],
];
const wallsIn = (t: string) => WALLS.filter(([re]) => re.test(t)).map(([, w]) => w);
const growthFinding = (s: Statement | null): Finding<{ growth: boolean; walls: string[] }> | null => {
  if (!s) return null;
  if (NEG.test(s.text) && !POS.test(s.text.replace(NEG, ""))) return fnd({ growth: false, walls: [] }, s);
  if (POS.test(s.text) || /\bgrowth\b/i.test(s.text)) return fnd({ growth: true, walls: wallsIn(s.text) }, s);
  return null;
};
const OPEN = /\b(to be determined|tbd|not (yet )?(been )?(determined|decided|scheduled|selected)|to follow|n\/a)\b/i;
const num = (x: string) => Number(x.replace(/,/g, ""));

export function rulesAnalyze(pages: string[]): ReportFindings {
  const S = statements(pages);
  const textChars = pages.join("").replace(/\s/g, "").length;
  const unanswered: ReportFindings["unanswered"] = [];

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

  // --- room & measurements ---
  const roomL = labeled(S, "room|rooms|affected room|area|location of growth|work area");
  const growthS = first(S, POS);
  const roomName = roomL ? findRoomName(roomL.value) ?? roomL.value : growthS ? findRoomName(growthS.text) : null;
  const room = roomName ? fnd(roomName, roomL?.s ?? growthS!) : null;
  const dimS = first(S, /(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)/i);
  let dims: ReportFindings["dims"] = null;
  if (dimS) {
    const m = dimS.text.match(/(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)/i)!;
    const h = dimS.text.match(/(?:ceiling height|ceiling|height)\D{0,12}(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)|(\d+(?:\.\d+)?)\s*(?:ft|feet|'|′)\s*(?:high|ceiling)/i) ?? first(S, /ceiling height\D{0,12}\d/i)?.text.match(/(\d+(?:\.\d+)?)\s*(?:ft|feet)/i);
    dims = fnd({ lengthFt: num(m[1]), widthFt: num(m[2]), heightFt: h ? num(h[1] ?? h[2]) : null }, dimS);
  }
  const areaS =
    first(S, /(affected area|area of (visible )?(mold )?growth|total affected( area)?|growth area|impacted area|area affected)\D{0,30}[\d,]+(\.\d+)?\s*(sf|sq\.?\s*ft|square feet|ft2|ft²)\b/i) ??
    first(S, /[\d,]+(\.\d+)?\s*(sf|sq\.?\s*ft|square feet)\s+of\s+(visible\s+)?(mold|growth|microbial)/i);
  const areaM = areaS?.text.match(/([\d,]+(?:\.\d+)?)\s*(?:sf|sq\.?\s*ft|square feet|ft2|ft²)\b/i);
  const affectedAreaSF = areaS && areaM ? fnd(num(areaM[1]), areaS) : null;

  // --- floor coverage ---
  const floorS = S.filter((s) => /\bfloor/i.test(s.text) && (POS.test(s.text) || /\b(growth|mold)\b/i.test(s.text)) && !/subfloor/i.test(s.text.replace(/\bfloor(ing)?\b.*$/i, "")));
  let floorCoverage: ReportFindings["floorCoverage"] = null;
  for (const s of floorS) {
    const pct = s.text.match(/(\d{1,3})\s*%\s*of\s+the\s+[\w ]*floor/i);
    if (pct) {
      floorCoverage = fnd({ whole: +pct[1] >= 100, pct: Math.min(100, +pct[1]) }, s);
      break;
    }
    if (/\b(entire|whole|full|all of the|throughout the|across the (entire|whole|full)|wall[- ]to[- ]wall)\b[^.]{0,40}\bfloor/i.test(s.text) || /\bfloor\w*\b[^.]{0,30}\b(entire|throughout)\b/i.test(s.text)) {
      floorCoverage = fnd({ whole: true, pct: 100 }, s);
      break;
    }
    if (/\b(portion|part|section|corner|localized|isolated|patch(es)?)\b[^.]{0,40}\bfloor|\bfloor\w*\b[^.]{0,30}\b(near|along|at the|in front of)\b/i.test(s.text)) {
      floorCoverage = fnd({ whole: false, pct: null }, s);
      break;
    }
  }

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
  const wallsGrowth = growthFinding(wallS);
  const bbS = labeled(S, "baseboard|baseboards|trim")?.s ?? first(S, /\bbaseboards?\b/i);
  const baseboardBacksGrowth = growthFinding(bbS);
  const frS = labeled(S, "framing|joists|studs|structural framing")?.s ?? first(S, /\b(framing|joists?|studs|sill plate)\b/i);
  const fg = growthFinding(frS);
  const framingGrowth = fg ? { ...fg, value: fg.value.growth } : null;

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
  const fixS = srcS && /\b(repaired|fixed|corrected|resolved|stopped|active|ongoing|still leaking)\b/i.test(srcS.text) ? srcS : first(S, /\b(leak|source)\b[^.]*\b(repaired|fixed|corrected|resolved|stopped|active|ongoing)\b/i);
  let sourceFixed: ReportFindings["sourceFixed"] = null;
  if (fixS) {
    if (/\b(not (yet )?(been )?(repaired|fixed|corrected|resolved))\b|\b(active|ongoing|still leaking|remains? (active|wet))\b/i.test(fixS.text)) sourceFixed = fnd(false, fixS);
    else if (/\b(repaired|fixed|corrected|resolved|stopped)\b/i.test(fixS.text)) sourceFixed = fnd(true, fixS);
  }

  // --- building & flooring run ---
  const ybS = first(S, /\b(year built|built in|constructed in|construction (year|date)|built circa|built c\.)\D{0,10}(1[789]\d\d|20[0-4]\d)\b/i);
  const yearBuilt = ybS ? fnd(Number(ybS.text.match(/\b(1[789]\d\d|20[0-4]\d)\b/)![1]), ybS) : null;
  const runS = first(S, /\b(flooring|floor|wood)\b[^.]{0,50}\b(continues|extends|runs|continuous)\b[^.]{0,30}\b(into|to|through)\b/i) ?? first(S, /\b(flooring|floor)\b[^.]{0,50}\b(does not (continue|extend|run)|stops at|threshold|transition|natural break)\b/i);
  let flooringContinuous: ReportFindings["flooringContinuous"] = null;
  if (runS) {
    if (/\b(does not (continue|extend|run)|stops at|natural break)\b/i.test(runS.text)) flooringContinuous = fnd({ continues: false, rooms: [] }, runS);
    else {
      const into = runS.text.match(/\b(?:into|to|through)\s+(?:the\s+)?([^.]+)/i)?.[1] ?? "";
      const rooms = into.split(/,|\band\b/).map((x) => findRoomName(x)).filter((x): x is string => !!x);
      flooringContinuous = fnd({ continues: true, rooms }, runS);
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
