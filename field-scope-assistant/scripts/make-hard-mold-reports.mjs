// Generates the HARD mold-report test set (fictional SAMPLE reports — not real assessments).
//   node scripts/make-hard-mold-reports.mjs
// Each fixture targets one field situation; the expected behaviour is stated in tests/mold-report-hard.test.ts.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdirSync, writeFileSync } from "node:fs";

const BANNER = "SAMPLE - TEST FIXTURE - FICTIONAL MOLD REPORT - NOT A REAL ASSESSMENT";
const T1 = ["Prepared for: Carol Vinelli", "Property: 308 E 72nd St, Unit 4D, New York, NY 10021"];
const ASSESSOR = "Assessor: Sample Assessor (SAMPLE NYS Mold Assessor License #SAMPLE-0000)";
const PRV_FULL = "Post-remediation verification: by an independent licensed mold assessor; visual inspection, moisture readings at or below dry standard, and air samples comparable to outdoor.";

/** page = string[] (text lines) | { table: string[][] } | { scanned: true } */
export const HARD = {
  // 1 + 6: three rooms with growth, flooring continuous into a fourth; pre-1978 building
  "H01-multi-room-continuous-1925.pdf": [
    ["Mold Assessment Report", ...T1, "Assessment date: 11/05/2026", ASSESSOR, "Year built: 1925", "", "1. Findings by room",
      "Room 1: Bedroom", "Room dimensions: 12 ft x 8 ft, ceiling height 8 ft", "Visible mold growth was observed on the underside of the wood flooring across the entire bedroom floor.", "Affected area: 96 SF"],
    ["Room 2: Hallway", "Room dimensions: 10 ft x 4 ft, ceiling height 8 ft", "Growth observed on approximately 50% of the hallway floor, along the bedroom doorway.", "Affected area: 20 SF",
      "Room 3: Closet", "Room dimensions: 4 ft x 3 ft, ceiling height 8 ft", "Visible growth across the entire closet floor.", "Affected area: 12 SF",
      "Living room: no visible growth observed.", "Room dimensions: 14 ft x 12 ft, ceiling height 8 ft",
      "Flooring: the wood flooring runs continuously from the bedroom into the hallway, closet and living room with no threshold or natural break."],
    ["2. Remediation plan", "Moisture source: leak at the radiator supply valve. The leak has been repaired by the building.",
      "Subfloor: clean and treat the plywood subfloor (do not remove).", "Walls: no growth observed on wall surfaces.", "Baseboard: no growth observed on baseboard backs.", "Framing: no growth observed on accessible framing.",
      "Containment: full containment of the bedroom, hallway and closet with HEPA negative air.", "Removal: remove all wood flooring and underlayment with growth, extending 2 ft beyond visible growth.", PRV_FULL],
  ],
  // 2: report disagrees with what the PM entered (8 x 6 = 48 SF, subfloor kept)
  "H02-conflict-64sf-subfloor-removed.pdf": [
    ["Mold Assessment Report", ...T1, ASSESSOR, "Room: Bedroom", "Room dimensions: 8 ft x 8 ft, ceiling height 8 ft", "Visible mold growth across the entire bedroom floor.", "Affected area: 64 SF",
      "Subfloor: the plywood subfloor is delaminated with growth; remove and replace the subfloor.", "Moisture source: radiator valve leak, repaired.", "Containment: full containment with negative air.", "Removal: remove all wood flooring and the subfloor in the bedroom.", PRV_FULL],
  ],
  // 3: missing and vague — no SF, no measurements, no clearance, no year built, no source-fixed status
  "H03-missing-vague-widespread.pdf": [
    ["Mold Assessment Report", ...T1, ASSESSOR, "Widespread mold growth was observed beneath the wood flooring in the bedroom.", "Containment: full containment recommended.", "Moisture source: plumbing leak from the unit above."],
  ],
  // 4: growth beyond the floor — walls (N, E to 18"), baseboard backs (S), floor joists (clean in place)
  "H04-walls-baseboard-joists.pdf": [
    ["Mold Assessment Report", ...T1, ASSESSOR, "Year built: 1925", "Room: Bedroom", "Room dimensions: 12 ft x 8 ft, ceiling height 8 ft", "Visible mold growth across the entire bedroom floor.", "Affected area: 96 SF",
      "Walls: visible growth on the drywall of the north and east walls, bottom 18 inches.", "Baseboard: growth observed on the back of the baseboard along the south wall.",
      "Framing: surface growth on the floor joists; clean in place by wire-brushing and HEPA vacuuming.", "Moisture source: radiator valve leak, repaired.", "Containment: full containment with negative air.",
      "Removal: remove wood flooring, underlayment and drywall with growth, extending 2 ft beyond visible growth.", PRV_FULL],
  ],
  // 5: the source is NOT fixed
  "H05-source-active.pdf": [
    ["Mold Assessment Report", ...T1, ASSESSOR, "Room: Bedroom", "Room dimensions: 12 ft x 8 ft, ceiling height 8 ft", "Visible mold growth across the entire bedroom floor.", "Affected area: 96 SF",
      "Moisture source: active roof leak above the bedroom window. The leak is ongoing and has not been repaired.", "Containment: full containment with negative air.", PRV_FULL],
  ],
  // 7: partial growth with a percentage, and partial growth with no boundary
  "H07a-partial-30pct.pdf": [
    ["Mold Assessment Report", ...T1, ASSESSOR, "Room: Bedroom", "Room dimensions: 12 ft x 8 ft, ceiling height 8 ft", "Growth observed on approximately 30% of the bedroom floor, near the window.", "Moisture source: radiator valve leak, repaired.", PRV_FULL],
  ],
  "H07b-partial-no-boundary.pdf": [
    ["Mold Assessment Report", ...T1, ASSESSOR, "Room: Bedroom", "Room dimensions: 12 ft x 8 ft, ceiling height 8 ft", "Visible growth on a portion of the bedroom floor.", "Moisture source: radiator valve leak, repaired.", PRV_FULL],
  ],
  // 8: wrong-report variants (and one spelling variant of the RIGHT address that must not warn)
  "H08a-unit-mismatch-4B.pdf": [["Mold Assessment Report", "Prepared for: Carol Vinelli", "Property: 308 E 72nd St, Unit 4B, New York, NY 10021", "Room: Bedroom", "Visible mold growth across the entire bedroom floor."]],
  "H08b-name-mismatch.pdf": [["Mold Assessment Report", "Prepared for: Robert Smith", "Property: 308 E 72nd St, Unit 4D, New York, NY 10021", "Room: Bedroom", "Visible mold growth across the entire bedroom floor."]],
  "H08c-street-west-not-east.pdf": [["Mold Assessment Report", "Prepared for: Carol Vinelli", "Property: 308 W 72nd St, Unit 4D, New York, NY 10023", "Room: Bedroom", "Visible mold growth across the entire bedroom floor."]],
  "H08d-street-avenue-not-street.pdf": [["Mold Assessment Report", "Prepared for: Carol Vinelli", "Property: 308 E 72nd Ave, Unit 4D, New York, NY 10021", "Room: Bedroom", "Visible mold growth across the entire bedroom floor."]],
  "H08e-same-address-spelled-out.pdf": [["Mold Assessment Report", "Prepared for: Vinelli, Carol A.", "Property: 308 East 72nd Street, Apt. 4D, New York, NY 10021", "Room: Bedroom", "Visible mold growth across the entire bedroom floor."]],
  // 9: bad input
  "H09a-scanned-no-text.pdf": [{ scanned: true }, { scanned: true }],
  "H09b-table-form.pdf": [
    ["Mold Assessment Report", ...T1, ASSESSOR, "Findings"],
    { table: [["Room", "Dimensions", "Affected area", "Extent"], ["Bedroom", "12 ft x 8 ft", "96 SF", "Whole floor"], ["Hallway", "10 ft x 4 ft", "20 SF", "Partial (50%)"]] },
    ["Moisture source: radiator valve leak, repaired.", "Containment: full containment with negative air.", PRV_FULL],
  ],
  "H09c-water-damage-report.pdf": [
    ["Water Damage Assessment", ...T1, "Loss type: Category 1 water, Class 2 (S500)", "Affected area: 120 SF of wet wood flooring in the bedroom", "Moisture readings: 28% at the bedroom floor; drying with 3 air movers and 1 dehumidifier.", "No visible mold growth observed."],
  ],
  // 10: a revised report replacing the first (different size, subfloor now removed, clearance now stated)
  "H10-revised-report.pdf": [
    ["Revised Mold Assessment Report", ...T1, "Assessment date: 11/09/2026", ASSESSOR, "Room: Bedroom", "Room dimensions: 12 ft x 10 ft, ceiling height 8 ft", "Visible mold growth across the entire bedroom floor.", "Affected area: 120 SF",
      "Subfloor: growth penetrates the plywood; remove and replace the subfloor.", "Moisture source: radiator valve leak, repaired.", "Containment: full containment with negative air.", "Removal: remove all wood flooring, underlayment and subfloor in the bedroom.", PRV_FULL],
  ],
};

function wrap(text, font, size, max) {
  const out = [];
  let line = "";
  for (const w of text.split(" ")) {
    const t = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > max && line) {
      out.push(line);
      line = w;
    } else line = t;
  }
  out.push(line);
  return out;
}

export async function buildPdf(pages, opts = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const pg of pages) {
    const page = doc.addPage([612, 792]);
    if (pg.scanned) {
      // a "scan": only drawn shapes, no selectable text at all
      page.drawRectangle({ x: 30, y: 30, width: 552, height: 732, color: rgb(0.96, 0.95, 0.9) });
      for (let i = 0; i < 30; i++) page.drawRectangle({ x: 50, y: 720 - i * 22, width: 300 + ((i * 37) % 200), height: 8, color: rgb(0.35, 0.35, 0.35) });
      continue;
    }
    page.drawText(BANNER, { x: 40, y: 760, size: 9, font: bold, color: rgb(0.75, 0.1, 0.1) });
    let y = 730;
    if (pg.table) {
      const xs = [40, 160, 300, 420];
      for (const row of pg.table) {
        row.forEach((cell, i) => page.drawText(cell, { x: xs[i], y, size: 11, font: row === pg.table[0] ? bold : font }));
        y -= 20;
      }
      continue;
    }
    for (const l of pg) {
      for (const part of l ? wrap(l, font, 11, 530) : [""]) {
        if (part) page.drawText(part, { x: 40, y, size: 11, font: /^\d\.|Report$|^Water Damage Assessment$/.test(part) ? bold : font });
        y -= 17;
      }
    }
  }
  if (opts.padBytes) doc.attach(opts.padBytes, "survey-photos.bin", { mimeType: "application/octet-stream", description: "padding to make the file large (test)" });
  return doc.save();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL("../tests/fixtures/hard/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const [file, pages] of Object.entries(HARD)) {
    writeFileSync(new URL(file, dir), await buildPdf(pages));
    console.log("wrote tests/fixtures/hard/" + file);
  }
}
