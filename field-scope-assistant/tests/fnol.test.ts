import { describe, expect, it } from "vitest";
import { addressKey, normalizeDate, outputTypeFor, parseFnol } from "@/lib/fnol";
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
