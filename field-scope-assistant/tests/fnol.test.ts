import { describe, expect, it } from "vitest";
import { addressKey, normalizeDate, normalizeFnolText, outputTypeFor, parseFnol } from "@/lib/fnol";
import * as S from "./fixtures/fnol-samples";

const lines = (t: string) => parseFnol(t).serviceLines.map((l) => l.value);

describe("FNOL parser (rules-based, no AI)", () => {
  it("EMS: service line, identifiers, address/unit, loss date, received time", () => {
    const p = parseFnol(S.FNOL_EMS);
    expect(lines(S.FNOL_EMS)).toContain("ems");
    expect(p.serviceLines.find((l) => l.value === "ems")!.confidence).toBe("labeled");
    expect(p.claimNumber?.value).toBe("WTR-2026-118842");
    expect(p.assignmentNumber?.value).toBe("26-0417");
    expect(p.carrier?.value).toBe("Sample Mutual Insurance");
    expect(p.insured?.value).toBe("Jane Example");
    expect(p.contactPhone?.value).toBe("(212) 555-0142");
    expect(p.address?.value).toContain("429 E 52nd St");
    expect(p.unit?.value).toBe("5C");
    expect(p.lossDate?.value).toBe("2026-11-02");
    expect(p.lossType?.value).toBe("water");
    expect(p.receivedAt?.value).toBe("2026-11-03T07:42:00");
    expect(p.stage).toMatchObject({ value: "initial_walkthrough", confidence: "keyword" }); // "NEW LOSS"
    expect(p.special).toBeNull();
  });

  it("Mitigation + initial walk-through stated explicitly", () => {
    const p = parseFnol(S.FNOL_MITIGATION_INITIAL);
    expect(lines(S.FNOL_MITIGATION_INITIAL)).toEqual(["mitigation"]);
    expect(p.stage).toMatchObject({ value: "initial_walkthrough", confidence: "labeled" });
    expect(p.claimNumber?.value).toBe("CC-77812-A");
    expect(p.unit?.value).toBe("4B");
    expect(p.lossDate?.value).toBe("2026-10-30");
    expect(p.causeOfLoss?.value).toMatch(/Toilet overflow/);
  });

  it("Reconstruction with program", () => {
    const p = parseFnol(S.FNOL_RECON);
    expect(lines(S.FNOL_RECON)).toContain("reconstruction");
    expect(lines(S.FNOL_RECON)).not.toContain("contents");
    expect(p.program?.value).toBe("Sample Contractor Network");
    expect(p.lossDate?.value).toBe("2026-09-14");
    expect(p.unit?.value).toBe("2");
    expect(p.stage).toMatchObject({ value: "initial_walkthrough", confidence: "assumed" }); // no stage cue → assumed, shown as such
  });

  it("Contents only overrides incidental mentions", () => {
    const p = parseFnol(S.FNOL_CONTENTS_ONLY);
    expect(lines(S.FNOL_CONTENTS_ONLY)).toEqual(["contents"]);
    expect(p.contentsOnly).toBe(true);
    expect(p.lossType?.value).toBe("fire"); // peril; the smoke type is chosen per room
    expect(p.lossDate?.value).toBe("2026-10-28");
    expect(outputTypeFor(["contents"], "initial_walkthrough", true)).toBe("contents_cleaning");
  });

  it("Final walk-through on an existing claim", () => {
    const p = parseFnol(S.FNOL_FINAL);
    expect(p.stage).toMatchObject({ value: "final_walkthrough", confidence: "labeled" });
    expect(p.claimNumber?.value).toBe("WTR-2026-118842");
    expect(lines(S.FNOL_FINAL)).toContain("mitigation");
    expect(outputTypeFor(["mitigation"], "final_walkthrough", false)).toBe("final_walkthrough");
    // matches the same property as the EMS FNOL even though the address is written differently
    expect(addressKey(p.address?.value ?? "429 E 52nd St")).toBe(addressKey(parseFnol(S.FNOL_EMS).address!.value));
  });

  it("Special assignment: flag, reason and multiple service lines", () => {
    const p = parseFnol(S.FNOL_SPECIAL);
    expect(p.special).toMatchObject({ value: true, confidence: "labeled" });
    expect(p.specialReason).toMatch(/board approval/);
    expect(lines(S.FNOL_SPECIAL)).toEqual(["mitigation", "contents"]);
    expect(p.unit?.value).toBe("12A");
  });

  it("Ambiguous text: conflicting stages are flagged, nothing guessed", () => {
    const p = parseFnol(S.FNOL_AMBIGUOUS);
    expect(p.stageConflict).toMatch(/more than one visit stage/);
    expect(p.claimNumber).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/Service line not found/);
  });

  it("dates normalize safely", () => {
    expect(normalizeDate("11/2/26")).toBe("2026-11-02");
    expect(normalizeDate("Nov 3, 2026")).toBe("2026-11-03");
    expect(normalizeDate("yesterday")).toBeNull();
  });
});

// Same fixture content, laid out the ways FNOLs are commonly pasted. These re-arrange the
// fictional fixtures only; they are not real-world samples (none were supplied).
describe("FNOL paste layouts (normalizeFnolText)", () => {
  const ems = S.FNOL_EMS;
  const layouts: Record<string, string> = {
    "Slack bold label *Claim #:* X": ems.replace(/^([^:\n]+):/gm, "*$1:*"),
    "Slack bold label *Claim #*: X": ems.replace(/^([^:\n]+):/gm, "*$1*:"),
    "markdown **Claim #:** X": ems.replace(/^([^:\n]+):/gm, "**$1:**"),
    "label on its own line": ems.replace(/^([^:\n]+):\s*/gm, "$1\n"),
    "label: on its own line": ems.replace(/^([^:\n]+):\s*/gm, "$1:\n"),
    "tab-separated table (copied from a portal)": ems.replace(/^([^:\n]+):\s*/gm, "$1\t"),
    "pipe table": "| Field | Value |\n|---|---|\n" + ems.replace(/^([^:\n]+):\s*/gm, "| $1 | ").replace(/$/gm, " |"),
    "Windows line endings": ems.replace(/\n/g, "\r\n"),
    "whole message on one line": ems.replace(/\n/g, " "),
    "non-breaking spaces": ems.replace(/: /g, ": "),
    "full-width colon": ems.replace(/: /g, "： "),
    "bulleted lines": ems.replace(/^/gm, "• "),
    "address split over two lines": ems.replace("Loss Address: 429 E 52nd St, Apt 5C, New York, NY 10022", "Loss Address:\n429 E 52nd St, Apt 5C\nNew York, NY 10022"),
  };
  for (const [name, text] of Object.entries(layouts))
    it(`reads every field: ${name}`, () => {
      const p = parseFnol(text);
      expect(p.serviceLines.map((l) => l.value)).toContain("ems");
      expect(p.claimNumber?.value).toBe("WTR-2026-118842");
      expect(p.assignmentNumber?.value).toBe("26-0417");
      expect(p.carrier?.value).toBe("Sample Mutual Insurance");
      expect(p.insured?.value).toBe("Jane Example");
      expect(p.contactPhone?.value).toBe("(212) 555-0142");
      expect(p.address?.value).toBe("429 E 52nd St, Apt 5C, New York, NY 10022");
      expect(p.unit?.value).toBe("5C");
      expect(p.lossDate?.value).toBe("2026-11-02");
      expect(p.lossType?.value).toBe("water");
      expect(p.causeOfLoss?.value).toBe("supply line burst under kitchen sink");
      expect(p.receivedAt?.value).toBe("2026-11-03T07:42:00");
    });

  it("two fields sharing a line are kept apart (Customer … Cell …)", () => {
    const p = parseFnol(S.FNOL_MITIGATION_INITIAL);
    expect(p.insured?.value).toBe("Mark Sample");
    expect(p.contactPhone?.value).toBe("917-555-0199");
  });

  it("free text with a colon is not split into fake fields", () => {
    const p = parseFnol(S.FNOL_FINAL);
    expect(p.insured).toBeNull();
    expect(p.address?.value).toMatch(/^429 E 52nd St/);
  });

  it("normalizing never invents text: every value word comes from the paste", () => {
    for (const t of Object.values(S)) {
      const words = new Set(t.toLowerCase().split(/[^a-z0-9]+/));
      for (const w of normalizeFnolText(t).toLowerCase().split(/[^a-z0-9]+/)) if (w) expect(words.has(w), w).toBe(true);
    }
  });
});
