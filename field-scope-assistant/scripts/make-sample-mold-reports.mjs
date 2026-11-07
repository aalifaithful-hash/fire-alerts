// Generates the SAMPLE mold assessment reports used as test fixtures (fictional — not real reports).
//   node scripts/make-sample-mold-reports.mjs
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";

const BANNER = "SAMPLE - TEST FIXTURE - FICTIONAL MOLD REPORT - NOT A REAL ASSESSMENT";

const REPORTS = {
  // (a) Test 1. Answers most pending items; deliberately leaves the clearance criteria / who does the
  // post-remediation check, the year built and whether the wood flooring runs into other rooms unanswered.
  "sample-mold-report-308-E-72nd-St-4D.pdf": [
    [
      "Mold Assessment Report",
      "Prepared for: Carol Vinelli",
      "Property: 308 E 72nd St, Unit 4D, New York, NY 10021",
      "Assessment date: 11/02/2026",
      "Assessor: Sample Assessor (SAMPLE NYS Mold Assessor License #SAMPLE-0000)",
      "",
      "1. Findings",
      "Room: Bedroom",
      "Room dimensions: 12 ft x 8 ft, ceiling height 8 ft",
      "Visible mold growth was observed on the underside of the wood flooring across the entire bedroom floor.",
      "Affected area: 96 SF",
      "Mold type: Cladosporium and Penicillium/Aspergillus (spore trap and tape lift samples)",
      "Condition: Condition 3 (actual growth) per IICRC S520",
      "Moisture source: leak at the radiator supply valve below the bedroom window. The leak has been repaired by the building.",
      "Subfloor: the plywood subfloor shows surface growth only; clean and treat the subfloor (do not remove).",
      "Walls: no growth observed on wall surfaces.",
      "Baseboard: growth observed on the back of the baseboard along the north and east walls.",
      "Framing: no growth observed on accessible framing.",
    ],
    [
      "2. Remediation plan",
      "Containment: full containment of the bedroom with HEPA negative air and a decontamination chamber at the bedroom door.",
      "Removal: remove all wood flooring and underlayment in the bedroom, extending 2 ft beyond visible growth where applicable.",
      "Post-remediation verification: to be determined.",
      "",
      "This sample report is for software testing only.",
    ],
  ],
  // (b) A different job: exercises the "Wrong report?" warning on the Test 1 project.
  "sample-mold-report-429-E-52nd-St-5C.pdf": [
    [
      "Mold Assessment Report",
      "Prepared for: Jane Example",
      "Property: 429 E 52nd St, Apt 5C, New York, NY 10022",
      "Assessment date: 10/29/2026",
      "Assessor: Sample Assessor (SAMPLE NYS Mold Assessor License #SAMPLE-0000)",
      "",
      "Room: Bathroom",
      "Room dimensions: 8 ft x 6 ft, ceiling height 8 ft",
      "Visible growth on a portion of the bathroom ceiling and on the drywall behind the vanity.",
      "Affected area: 14 SF",
      "Containment: limited containment at the vanity wall.",
      "Post-remediation verification: by an independent licensed mold assessor; visual inspection, moisture readings at or below dry standard, and air samples comparable to outdoor.",
      "",
      "This sample report is for software testing only.",
    ],
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

for (const [file, pages] of Object.entries(REPORTS)) {
  const doc = await PDFDocument.create();
  doc.setTitle(`SAMPLE mold report (test fixture) — ${file}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    page.drawText(BANNER, { x: 40, y: 760, size: 9, font: bold, color: rgb(0.75, 0.1, 0.1) });
    let y = 730;
    for (const l of lines) {
      for (const part of l ? wrap(l, font, 11, 530) : [""]) {
        if (part) page.drawText(part, { x: 40, y, size: 11, font: /^\d\.|^Mold Assessment Report$/.test(part) ? bold : font });
        y -= 17;
      }
    }
  }
  writeFileSync(new URL(`../tests/fixtures/${file}`, import.meta.url), await doc.save());
  console.log("wrote tests/fixtures/" + file);
}
