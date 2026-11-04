import { z } from "zod";

/**
 * One room, one visit: where the loss is in this room, what is affected, the
 * manual measurements, moisture points and equipment placed — plus the line
 * items the rules engine proposed and the PM's decision on each.
 */

const n = z.number().finite().nonnegative().nullable();

export const Opening = z.object({
  id: z.string(),
  kind: z.enum(["door", "window", "opening"]),
  wall: z.string(), // "N" | "E" | "S" | "W" or a custom segment label
  widthIn: z.number().positive(),
  heightIn: z.number().positive(),
  offsetFt: n.default(null), // from the wall's left end (looking at it from inside); null = centered
});
export type Opening = z.infer<typeof Opening>;

export const WallSegment = z.object({ label: z.string().min(1), lengthFt: z.number().positive() });

export const Measurements = z.object({
  lengthFt: n.default(null), // N and S walls
  widthFt: n.default(null), // E and W walls
  heightFt: n.default(null),
  segments: z.array(WallSegment).nullable().default(null), // odd shapes: overrides N/E/S/W
  openings: z.array(Opening).default([]),
});
export type Measurements = z.infer<typeof Measurements>;

export const WATER_SOURCES = ["clean_supply", "appliance", "dishwasher", "washing_machine", "toilet_overflow", "toilet_with_feces", "sewage", "roof", "groundwater", "flood", "sump_pump", "unknown"] as const;

export const ScanSource = z.object({
  where: z.enum(["in_room", "above", "below", "adjacent", "exterior", "unknown"]).default("unknown"),
  fixture: z.string().nullable().default(null), // e.g. "supply line under sink"
  wall: z.string().nullable().default(null),
  positionFt: n.default(null), // along that wall, from its left end
  surface: z.enum(["floor", "wall", "ceiling"]).nullable().default(null),
  status: z.enum(["repaired", "stopped", "active", "unknown"]).default("unknown"),
  hoursSinceLoss: n.default(null),
  waterSource: z.enum(WATER_SOURCES).nullable().default(null),
});

export const ScanLoss = z.object({
  type: z.enum(["water", "fire", "smoke", "sewage", "mold"]).nullable().default(null),
  category: z.enum(["1", "2", "3"]).nullable().default(null), // only as the PM states it
  waterClass: z.enum(["1", "2", "3", "4"]).nullable().default(null),
  smokeType: z.enum(["dry", "wet", "protein"]).nullable().default(null),
  /** Mold: the licensed assessor's report / remediation protocol. */
  assessmentReport: z.enum(["none", "pending", "received"]).nullable().default(null),
});

export const ScanMaterials = z.object({
  flooring: z
    .object({
      type: z.string().nullable().default(null), // carpet+pad, hardwood, LVP, tile…
      affected: z.boolean().default(false),
      affectedPct: z.number().min(0).max(100).nullable().default(null),
      action: z.enum(["dry_in_place", "remove", "replace"]).nullable().default(null),
      continuousRun: z.string().nullable().default(null), // rooms sharing the same run label have no natural break between them
      breakNote: z.string().nullable().default(null),
    })
    .default({ type: null, affected: false, affectedPct: null, action: null, continuousRun: null, breakNote: null }),
  baseboard: z
    .object({ affected: z.boolean().default(false), walls: z.array(z.string()).default([]), action: z.enum(["detach_reset", "remove"]).nullable().default(null) })
    .default({ affected: false, walls: [], action: null }),
  walls: z
    .object({
      material: z.enum(["drywall", "plaster", "paneling", "tile", "other"]).nullable().default(null),
      affectedWalls: z.array(z.string()).default([]),
      wetHeightIn: n.default(null),
      floodCut: z.union([z.literal("auto"), z.literal("none"), z.number().positive()]).default("auto"),
    })
    .default({ material: null, affectedWalls: [], wetHeightIn: null, floodCut: "auto" }),
  ceiling: z
    .object({
      affected: z.boolean().default(false),
      affectedPct: z.number().min(0).max(100).nullable().default(null),
      action: z.enum(["dry", "seal_paint", "remove"]).nullable().default(null),
    })
    .default({ affected: false, affectedPct: null, action: null }),
  insulation: z.boolean().default(false),
  /** Mold: subfloor under removed flooring — cleaned in place or removed (from the assessor's report). */
  subfloor: z.enum(["clean", "remove"]).nullable().default(null),
  cabinets: z
    .object({ affected: z.boolean().default(false), lf: n.default(null), detach: z.boolean().default(false) })
    .default({ affected: false, lf: null, detach: false }),
  fixtures: z.array(z.string()).default([]),
});

export const ScanContents = z.object({
  present: z.boolean().default(false),
  affected: z.boolean().default(false),
  items: z.string().nullable().default(null),
  handling: z.enum(["none", "manipulate", "clean_onsite", "packout"]).default("none"),
});

export const MoisturePoint = z.object({
  id: z.string(),
  label: z.string(),
  surface: z.enum(["floor", "wall", "ceiling"]),
  wall: z.string().nullable().default(null),
  x: z.number().min(0).max(1).nullable().default(null), // position on the room sketch (0–1), optional
  y: z.number().min(0).max(1).nullable().default(null),
  material: z.string().nullable().default(null),
  reading: z.string().nullable().default(null), // as read — never invented
  dryGoal: z.string().nullable().default(null), // from an unaffected reference reading
});

export const PlacedEquipment = z.object({ kind: z.enum(["air_mover", "dehumidifier", "air_scrubber"]), qty: z.number().int().positive() });

export const LINE_KINDS = ["mitigation", "reconstruction", "contents", "equipment", "monitoring"] as const;
export const LINE_STATUSES = ["suggested", "accepted", "rejected", "excluded"] as const;

export const ScopeLine = z.object({
  id: z.string(), // stable per rule + target, so decisions survive re-analysis
  ruleId: z.string(),
  kind: z.enum(LINE_KINDS),
  scopeCategory: z.string(), // maps to the scope bullet category
  activity: z.string(),
  item: z.string(),
  quantity: z.number().nullable(),
  unit: z.string(),
  rate: z.number().nullable().default(null),
  total: z.number().nullable().default(null),
  calc: z.string(), // the math, shown to the estimator
  justification: z.string(),
  evidence: z.array(z.string()).default([]),
  status: z.enum(LINE_STATUSES),
  flags: z.array(z.string()).default([]),
});
export type ScopeLine = z.infer<typeof ScopeLine>;

export const RoomScanData = z.object({
  source: ScanSource.default(ScanSource.parse({})),
  loss: ScanLoss.default(ScanLoss.parse({})),
  materials: ScanMaterials.default(ScanMaterials.parse({})),
  contents: ScanContents.default(ScanContents.parse({})),
  measurements: Measurements.default(Measurements.parse({})),
  moisturePoints: z.array(MoisturePoint).default([]),
  equipmentPlaced: z.array(PlacedEquipment).default([]),
  lines: z.array(ScopeLine).default([]),
  /** The mold report applied to this room (documents.id), if any. */
  reportDocumentId: z.string().nullable().default(null),
  /** PM decisions keyed by line id (kept even when a line disappears and comes back). */
  decisions: z.record(z.string(), z.enum(["accepted", "rejected"])).default({}),
});
export type RoomScanData = z.infer<typeof RoomScanData>;

export function emptyScan(): RoomScanData {
  return RoomScanData.parse({});
}

// ---------------- visit-level options (stored in visit facts) ----------------

export const EXCLUSION_TARGETS = ["contents_all", "contents_cleaning", "contents_packout", "room", "service_line"] as const;
export const Exclusion = z.object({
  id: z.string(),
  target: z.enum(EXCLUSION_TARGETS),
  locationId: z.string().nullable().default(null),
  serviceLine: z.string().nullable().default(null),
  reason: z.string(),
  decidedBy: z.enum(["customer", "adjuster", "pm", "owner"]),
  date: z.string(), // YYYY-MM-DD
  signature: z.enum(["not_documented", "verbal", "signed"]),
  note: z.string().nullable().default(null),
  text: z.string().default(""), // the explicit wording printed in the scope (from the rules template)
});
export type Exclusion = z.infer<typeof Exclusion>;

export const EXCLUSION_LABELS: Record<(typeof EXCLUSION_TARGETS)[number], string> = {
  contents_all: "All contents work (cleaning and pack-out)",
  contents_cleaning: "Contents cleaning",
  contents_packout: "Contents pack-out",
  room: "An entire room",
  service_line: "A service line",
};
