import { describe, expect, it } from "vitest";
import { applyGuards, detectDryingOnly, numbersIn, parseCrew } from "@/lib/guards";
import { resolveLocation } from "@/lib/locations";
import { applyOps, blankOp } from "@/lib/patch";
import { docToText, renderDoc } from "@/lib/render";
import { equip, facts, item, loc, project, visit } from "./helpers";

const EXAMPLE_NOTES =
  "Pipe burst above this apartment. Source repaired. Cat 2. Living room flooring and walls are wet. Kitchen cabinets need to be detached. Bedroom plaster ceiling near the window is wet. Drying only for now. CC+1, three days equipment. One dehumidifier in the living room, one in the kitchen, one in the bedroom.";

describe("crew and number parsing", () => {
  it("CC+4 means one crew chief plus four subcontractors", () => {
    expect(parseCrew("crew CC+4 tomorrow")).toEqual({ raw: "CC+4", crewChiefs: 1, subcontractors: 4 });
  });
  it("understands number words", () => {
    const s = numbersIn("One dehumidifier, twenty-two air movers, 3 days");
    expect(s.has(1) && s.has(22) && s.has(3)).toBe(true);
  });
  it("detects drying-only language", () => {
    expect(detectDryingOnly(EXAMPLE_NOTES)).toBe(true);
    expect(detectDryingOnly("Remove demolition. Drying only.")).toBe(true);
  });
});

describe("two units with a room called closet", () => {
  const c19 = loc("Closet", "19C", "19");
  const c20 = loc("Closet", "20A", "20");
  const locations = [c19, c20];

  it("a bare 'closet' reference is ambiguous, never guessed", () => {
    expect(resolveLocation({ room: "closet" }, locations).kind).toBe("ambiguous");
    const r = resolveLocation({ room: "Closet", unit: "19C" }, locations);
    expect(r.kind === "existing" && r.location.id).toBe(c19.id);
  });

  it("renders both closets separately under their units", () => {
    const f = facts({
      items: [
        item({ locationId: c19.id, category: "moisture_elevated", text: "Wall readings remain elevated" }),
        item({ locationId: c20.id, category: "moisture_dry", text: "Carpet is dry" }),
      ],
      directives: { dryingOnly: false, carryForwardConfirmed: false },
    });
    const text = docToText(renderDoc({ project: project(), visit: visit("daily_monitoring"), facts: f, locations }));
    expect(text).toContain("Unit 19C — Closet");
    expect(text).toContain("Unit 20A — Closet");
    expect(text.indexOf("Wall readings")).toBeLessThan(text.indexOf("Unit 20A"));
  });

  it("a correction naming only 'closet' asks for clarification and changes nothing", () => {
    const f = facts({ items: [item({ locationId: c19.id, category: "moisture_elevated", text: "Wall wet" })] });
    const r = applyOps(f, [blankOp("add_item", { room: "closet", category: "moisture_dry", text: "Closet is dry" })], locations, "p1");
    expect(r.clarification).toMatch(/Which closet\?/);
    expect(r.clarification).toContain("19C");
    expect(r.clarification).toContain("20A");
    expect(r.facts).toBe(f);
  });
});

describe("drying-only instruction prevents demolition", () => {
  const living = loc("Living Room");
  const kitchen = loc("Kitchen");
  const bedroom = loc("Bedroom");
  const locations = [living, kitchen, bedroom];

  it("drops AI-suggested removals and keeps exactly the PM's scope", () => {
    const aiOutput = facts({
      items: [
        item({ locationId: living.id, category: "condition", text: "Flooring and walls are wet" }),
        item({ locationId: living.id, category: "removal", text: "Remove wet drywall 2 ft flood cut", source: "photo", status: "proposed" }),
        item({ locationId: kitchen.id, category: "detach_reset", text: "Detach base cabinets for drying", status: "proposed" }),
        item({ locationId: bedroom.id, category: "condition", text: "Plaster ceiling near the window is wet" }),
        item({ locationId: bedroom.id, category: "antimicrobial", text: "Apply antimicrobial", source: "photo", status: "proposed" }),
      ],
      equipment: [
        equip({ locationId: living.id, type: "dehumidifier", quantity: 1 }),
        equip({ locationId: kitchen.id, type: "dehumidifier", quantity: 1 }),
        equip({ locationId: bedroom.id, type: "dehumidifier", quantity: 1 }),
        equip({ locationId: living.id, type: "air_mover", quantity: 4, source: "pm" }), // invented
      ],
    });
    const { facts: f } = applyGuards(aiOutput, { pmText: EXAMPLE_NOTES, corpusText: "" });
    expect(f.directives.dryingOnly).toBe(true);
    expect(f.jobInfo.crewRaw).toBe("CC+1");
    expect(f.items.some((i) => i.category === "removal")).toBe(false);
    expect(f.items.some((i) => i.category === "antimicrobial")).toBe(false);
    // demolition suggestion withheld entirely, antimicrobial kept only as a recommendation
    expect(f.recommendations.some((r) => r.category === "removal")).toBe(false);
    expect(f.recommendations.some((r) => r.category === "antimicrobial")).toBe(true);
    // the invented "4 air movers" quantity is stripped and flagged
    const am = f.equipment.find((e) => e.type === "air_mover")!;
    expect(am.quantity).toBeNull();
    expect(f.reviewFlags.join(" ")).toMatch(/Quantity not specified: air mover/);

    const text = docToText(renderDoc({ project: project(), visit: visit("initial_mitigation"), facts: f, locations }));
    expect(text).not.toMatch(/remove|demo|flood cut|antimicrobial/i);
    expect(text).toContain("Detach base cabinets");
    expect(text).toMatch(/Living Room[\s\S]*1 dehumidifier \(planned\)/);
    expect(text).toContain("CC+1 (1 crew chief + 1 subcontractor)");
  });

  it("water category from photos alone is removed", () => {
    const { facts: f } = applyGuards(facts({ jobInfo: { ...facts().jobInfo, category: "Category 3" } }), {
      pmText: "Living room wet.",
      corpusText: "",
    });
    expect(f.jobInfo.category).toBeNull();
  });
});

describe("a new visit changing only one room", () => {
  it("updates one room and preserves every other room", () => {
    const hall = loc("Common Hallway", null, "20");
    const c19 = loc("Closet", "19C", "19");
    const bath = loc("Bathroom", "19C", "19");
    const locations = [hall, c19, bath];
    const prior = facts({
      items: [
        item({ id: "h1", locationId: hall.id, category: "moisture_elevated", text: "Elevated moisture at the base of the wall" }),
        item({ id: "c1", locationId: c19.id, category: "moisture_elevated", text: "Wall readings remain elevated" }),
        item({ id: "c2", locationId: c19.id, category: "moisture_dry", text: "Carpet is dry" }),
        item({ id: "b1", locationId: bath.id, category: "moisture_elevated", text: "Subfloor remains elevated" }),
      ],
      equipment: [equip({ id: "e1", locationId: c19.id, type: "air_mover", quantity: 2, status: "operating" })],
    });
    const before = docToText(renderDoc({ project: project(), visit: visit("daily_monitoring"), facts: prior, locations }));
    const r = applyOps(
      prior,
      [
        blankOp("update_item", {
          targetId: "h1",
          category: "moisture_dry",
          text: "Previously affected areas are now dry",
        }),
      ],
      locations,
      "p1",
    );
    expect(r.clarification).toBeNull();
    expect(r.changes).toHaveLength(1);
    const after = docToText(renderDoc({ project: project(), visit: visit("daily_monitoring"), facts: r.facts, locations }));
    expect(after).toContain("20th Floor Common Hallway");
    expect(after).toContain("Previously affected areas are now dry");
    expect(after).not.toContain("Elevated moisture at the base of the wall");
    // all other rooms identical
    for (const line of ["Wall readings remain elevated", "Carpet is dry", "Subfloor remains elevated", "2 air movers (operating)"]) {
      expect(before).toContain(line);
      expect(after).toContain(line);
    }
    // dry room keeps its equipment — dry does not mean removed
    expect(r.facts.equipment[0].status).toBe("operating");
  });

  it("unconfirmed carried-forward conditions are held out of today's scope", () => {
    const k = loc("Kitchen");
    const f = facts({
      items: [item({ locationId: k.id, category: "moisture_elevated", text: "Cabinet toe kick elevated", carriedForward: true, source: "prior_visit" })],
      equipment: [equip({ locationId: k.id, type: "dehumidifier", quantity: 1, status: "operating", carriedForward: true, source: "prior_visit" })],
    });
    const g1 = applyGuards(f, { pmText: "Kitchen readings taken.", corpusText: "1" }).facts;
    const t1 = docToText(renderDoc({ project: project(), visit: visit("daily_monitoring"), facts: g1, locations: [k] }));
    expect(t1).not.toContain("Cabinet toe kick elevated");
    expect(g1.reviewFlags.join(" ")).toMatch(/not confirmed today/);

    const g2 = applyGuards(f, { pmText: "Same as yesterday.", corpusText: "1" }).facts;
    const t2 = docToText(renderDoc({ project: project(), visit: visit("daily_monitoring"), facts: g2, locations: [k] }));
    expect(t2).toContain("Cabinet toe kick elevated");
    expect(t2).toContain("1 dehumidifier (operating)");
  });
});

describe("equipment pickup", () => {
  it("stays scheduled until removal is confirmed", () => {
    const k = loc("Kitchen");
    const prev = facts({ equipment: [equip({ locationId: k.id, type: "dehumidifier", quantity: 1, status: "pickup_scheduled", statusDate: "Saturday" })] });
    const aiSaysRemoved = facts({
      equipment: [equip({ locationId: k.id, type: "dehumidifier", quantity: 1, status: "removed", source: "pm" })],
    });
    const g = applyGuards(aiSaysRemoved, { pmText: "Final walk-through today. Kitchen dry.", corpusText: "1", previousFacts: prev }).facts;
    expect(g.equipment[0].status).toBe("pickup_scheduled");
    expect(g.equipment[0].statusDate).toBe("Saturday");

    const g2 = applyGuards(aiSaysRemoved, { pmText: "Equipment was picked up this morning.", corpusText: "1", previousFacts: prev }).facts;
    expect(g2.equipment[0].status).toBe("removed");
  });
});

describe("final walk-through summary", () => {
  it("includes only confirmed completed work and never closes the file", () => {
    const lr = loc("Living Room");
    const history = [
      {
        visitDate: "2026-10-28",
        type: "initial_mitigation" as const,
        facts: facts({
          items: [
            item({ locationId: lr.id, category: "extraction", text: "Extracted standing water from flooring", status: "completed" }),
            item({ locationId: lr.id, category: "antimicrobial", text: "Applied antimicrobial to affected areas", status: "completed" }),
            item({ locationId: lr.id, category: "removal", text: "Remove baseboards", status: "proposed" }), // planned only
            item({ locationId: lr.id, category: "cleaning", text: "HEPA vacuum", status: "completed", source: "photo" }), // not confirmed
          ],
        }),
      },
    ];
    const current = applyGuards(
      facts({
        items: [
          item({ locationId: lr.id, category: "moisture_dry", text: "All affected materials are dry" }),
          item({ locationId: lr.id, category: "detach_reset", text: "Baseboards scheduled for reinstallation tonight", status: "scheduled" }),
        ],
        equipment: [equip({ locationId: lr.id, type: "air_mover", quantity: 3, status: "pickup_scheduled", statusDate: "Saturday" })],
      }),
      { pmText: "3 air movers pickup Saturday", corpusText: "" },
    ).facts;
    history[0].facts = applyGuards(history[0].facts, { pmText: "", corpusText: "" }).facts;
    const text = docToText(renderDoc({ project: project(), visit: visit("final_walkthrough"), facts: current, locations: [lr], history }));
    expect(text).toContain("Extracted standing water from flooring");
    expect(text).toContain("Applied antimicrobial to affected areas");
    expect(text).not.toContain("Remove baseboards");
    expect(text).not.toContain("HEPA vacuum");
    expect(text).toContain("Baseboards scheduled for reinstallation tonight");
    expect(text).not.toMatch(/baseboards reinstalled/i);
    expect(text).toContain("pickup scheduled Saturday");
    expect(text).toContain("Completion forms: not documented.");
    expect(text).toMatch(/File remains open/);
    expect(text).not.toMatch(/file (is )?closed/i);
  });
});

describe("correction preserving every other room", () => {
  it("'That is the closet, not the bedroom' moves only that room's entries", () => {
    const bed = loc("Bedroom", "3B");
    const closet = loc("Closet", "3B");
    const kit = loc("Kitchen", "3B");
    const f = facts({
      items: [
        item({ id: "a", locationId: bed.id, category: "moisture_elevated", text: "Back wall is wet" }),
        item({ id: "b", locationId: kit.id, category: "detach_reset", text: "Detach base cabinets" }),
      ],
      equipment: [equip({ id: "e", locationId: bed.id, type: "dehumidifier", quantity: 1 })],
    });
    const r = applyOps(f, [blankOp("move_location", { targetId: bed.id, room: "Closet", unit: "3B" })], [bed, closet, kit], "p1");
    expect(r.facts.items.find((i) => i.id === "a")!.locationId).toBe(closet.id);
    expect(r.facts.equipment[0].locationId).toBe(closet.id);
    expect(r.facts.items.find((i) => i.id === "b")!.locationId).toBe(kit.id);
    expect(r.facts.items).toHaveLength(2);
  });

  it("equipment change applies to the named entry only", () => {
    const a = loc("Room A");
    const b = loc("Room B");
    const f = facts({
      equipment: [
        equip({ id: "x", locationId: a.id, type: "air_mover", quantity: 4 }),
        equip({ id: "y", locationId: b.id, type: "air_mover", quantity: 6 }),
      ],
    });
    const r = applyOps(f, [blankOp("update_equipment", { targetId: "x", equipmentQuantity: 22 })], [a, b], "p1");
    expect(r.facts.equipment.find((e) => e.id === "x")!.quantity).toBe(22);
    expect(r.facts.equipment.find((e) => e.id === "y")!.quantity).toBe(6);
    // the guard accepts 22 because the PM said it
    const g = applyGuards(r.facts, { pmText: "Change equipment to 22 air movers", corpusText: "6" }).facts;
    expect(g.equipment.find((e) => e.id === "x")!.quantity).toBe(22);
  });
});

describe("completion attributed to earlier visits", () => {
  it("is only accepted when an earlier visit actually recorded it as completed", () => {
    const lr = loc("Living Room");
    const prior = facts({
      items: [
        item({ locationId: lr.id, category: "extraction", text: "Extracted water from flooring", status: "completed" }),
        item({ locationId: lr.id, category: "removal", text: "Remove baseboards", status: "proposed" }),
      ],
    });
    const claimed = facts({
      items: [
        item({ locationId: lr.id, category: "extraction", text: "Extracted water from flooring", status: "completed", source: "prior_visit" }),
        item({ locationId: lr.id, category: "removal", text: "Remove baseboards", status: "completed", source: "prior_visit" }),
      ],
    });
    const g = applyGuards(claimed, { pmText: "Final walk-through.", corpusText: "", previousFacts: prior, priorFacts: [prior] }).facts;
    expect(g.items[0].status).toBe("completed");
    expect(g.items[1].status).toBe("unknown");
    expect(g.items[1].flags[0]).toMatch(/No earlier visit/);
  });
});
