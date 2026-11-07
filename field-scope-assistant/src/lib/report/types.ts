/**
 * What a mold assessment report says, as read by an analyzer. Every finding keeps the exact
 * statement it came from (quote + page) so a tech can check it on a phone. Anything the report
 * doesn't state stays null — never guessed.
 */
export interface Finding<T> {
  value: T;
  quote: string;
  page: number;
  /** The report room this statement sits under, when the report is organized by room. */
  room?: string | null;
}

/** One room the report describes (multi-room reports list several). Unstated values are null. */
export interface RoomFinding {
  name: string;
  growth: boolean;
  lengthFt: number | null;
  widthFt: number | null;
  heightFt: number | null;
  areaSF: number | null;
  coverage: { whole: boolean; pct: number | null } | null;
  /** Vague extent wording with no number ("widespread", "extensive"). */
  vague: string | null;
  /** The statements each value came from (for quotes on phone). */
  quotes: { dims: string | null; area: string | null; coverage: string | null };
  /** Surfaces the report lists with growth in this room ([] = not itemized). */
  surfaces?: Surface[];
  /** Which wall, when the report names it by feature ("A/C wall", "rear wall"). */
  wallLabel?: string | null;
  /** Elevated spore counts in this room's air sample. */
  airElevated?: boolean;
}

export type Surface = "wall" | "floor" | "caulking" | "vent" | "ceiling" | "cabinet" | "baseboard" | "air";

/** A drywall removal the report states: a height for named rooms, or a stated SF. */
export interface WallRemoval {
  rooms: string[];
  wallLabel: string;
  heightIn: number | null;
  statedSF: number | null;
  approximate: boolean;
  entireWall: boolean;
}

/** Two parts of the report that disagree — never resolved silently. */
export interface ReportConflict {
  text: string;
  quotes: { quote: string; page: number }[];
}
type F<T> = Finding<T> | null;

export interface ReportFindings {
  analyzer: "rules" | "ai";
  /** What kind of report this reads as. Anything but "mold" is held and never applied. */
  reportType: "mold" | "water" | "other";
  /** Every room the report describes, in order. The single-room fields below mirror rooms[0]. */
  rooms: Finding<RoomFinding>[];
  /** Flooring material named with the growth (e.g. "wood flooring"). */
  flooringType: F<string>;
  /** False when there is no selectable text (photo or scanned report). */
  readable: boolean;
  textChars: number;
  address: F<string>;
  unit: F<string>;
  customer: F<string>;
  assessor: F<string>;
  reportDate: F<string>; // YYYY-MM-DD
  room: F<string>;
  dims: F<{ lengthFt: number; widthFt: number; heightFt: number | null }>;
  affectedAreaSF: F<number>;
  /** Whole floor (pct 100) or part of it (pct when stated). */
  floorCoverage: F<{ whole: boolean; pct: number | null }>;
  containment: F<{
    level: "full" | "limited" | "none" | "unspecified";
    negativeAir: boolean;
    /** Containment areas the report lists, e.g. "(a) a localized area at the Bedroom, (b) the entire Den". */
    areas?: { room: string; extent: "localized" | "entire" | null }[];
    /** Separate containments per area (lettered list / "each containment area"), not one around all rooms. */
    separate?: boolean;
    material?: string | null;
  }>;
  removalExtent: F<string>;
  subfloor: F<"clean" | "remove">;
  wallsGrowth: F<{ growth: boolean; walls: string[]; heightIn: number | null }>;
  baseboardBacksGrowth: F<{ growth: boolean; walls: string[] }>;
  framingGrowth: F<{ growth: boolean; where: "joists" | "studs" | "framing"; action: "clean" | "remove" | null }>;
  clearanceCriteria: F<string>;
  clearanceBy: F<string>;
  moistureSource: F<string>;
  sourceFixed: F<boolean>;
  yearBuilt: F<number>;
  flooringContinuous: F<{ continues: boolean; rooms: string[] }>;
  moldType: F<string>;
  condition: F<string>;
  /** "1 HEPA-filtered air scrubber … for 72 hours at 8 ACH in each containment area – Bedroom, Den, …" */
  airScrubber?: F<{ perContainment: number; hours: number | null; ach: number | null; rooms: string[] }>;
  /** "All AFD devices, dehumidifiers and fans need to be shut down 24 hours … prior to the post remediation clearance inspection." */
  equipmentOff?: F<{ hours: number; devices: string }>;
  wallRemovals?: Finding<WallRemoval>[];
  /** Extra cut beyond affected drywall the plan states (inches). */
  cutBeyondIn?: F<number>;
  /** Flooring treatment options for named rooms ("either removal … or sanding …"). */
  floorTreatment?: F<{ rooms: string[]; options: ("remove" | "sand")[] }>;
  framingCleaning?: F<string>;
  encapsulant?: F<string>;
  surfaceCleaning?: F<{ hepaVacuum: boolean; sanitize: boolean; product: string | null }>;
  specialItems?: Finding<{ room: string; kind: "shower_caulking" | "vent"; hvacIfInaccessible: boolean }>[];
  packout?: F<string>;
  baseboardRemovals?: Finding<{ room: string }>[];
  clearanceConditions?: Finding<string>[];
  /** "The source of water intrusion must be addressed …" — NOT the same as fixed. */
  sourceMustBeAddressed?: F<string>;
  hazardNote?: F<string>;
  otherConcerns?: Finding<string>[];
  conflicts?: ReportConflict[];
  /** Cabinets / countertops / vanity / backsplash the report names, with the action it states (null = not stated). */
  caseworkMentions?: Finding<{ room: string | null; kind: import("../scan").CaseworkKind; action: "clean" | "detach_reset" | "remove_replace" | "remove_dispose" | "sand_refinish" | null; growth: boolean;
    /** The report says only "remove" — how (detach & reset / replace / dispose) is a question for the PM, never picked. */
    removeOnly?: boolean;
    /** What the wording suggests: "to access" → usually detach & reset; damaged → replace or dispose. A hint, never applied. */
    removeHint?: "access" | "damaged" | null }>[];
  /** "cabinets" named without saying which (upper / lower) — never assumed. */
  caseworkUnspecified?: Finding<string>[];
  /** The report refers to lab results but no lab tables are in its text (images or not included). */
  labTablesMissing?: F<string>;
  /** Items the report leaves open; `quote` is set when it says so explicitly (e.g. "to be determined"). */
  unanswered: { key: FindingKey; label: string; quote: string | null }[];
}

export type FindingKey = Exclude<keyof ReportFindings, "analyzer" | "readable" | "textChars" | "unanswered" | "reportType" | "rooms" | "flooringType">;

/** Plain-language names, in the order the findings panel shows them. */
export const FINDING_LABELS: [FindingKey, string][] = [
  ["address", "Property address"],
  ["unit", "Unit"],
  ["customer", "Prepared for"],
  ["assessor", "Assessor"],
  ["reportDate", "Assessment date"],
  ["room", "Room"],
  ["dims", "Room measurements"],
  ["affectedAreaSF", "Affected area"],
  ["floorCoverage", "Whole floor or part"],
  ["containment", "Containment level"],
  ["removalExtent", "How far removal goes"],
  ["subfloor", "Subfloor cleaned or removed"],
  ["wallsGrowth", "Growth on walls"],
  ["baseboardBacksGrowth", "Growth on baseboard backs"],
  ["framingGrowth", "Growth on framing"],
  ["clearanceCriteria", "Clearance criteria"],
  ["clearanceBy", "Who does the post-remediation check"],
  ["moistureSource", "Moisture source"],
  ["sourceFixed", "Source fixed"],
  ["yearBuilt", "Year built"],
  ["flooringContinuous", "Wood flooring runs into other rooms"],
  ["moldType", "Mold type"],
  ["condition", "Condition / category"],
];

/** Findings that matter for the scope; anything here the report leaves open is listed as still missing. */
export const SCOPE_FINDINGS: FindingKey[] = [
  "dims",
  "affectedAreaSF",
  "floorCoverage",
  "containment",
  "removalExtent",
  "subfloor",
  "wallsGrowth",
  "baseboardBacksGrowth",
  "framingGrowth",
  "clearanceCriteria",
  "clearanceBy",
  "moistureSource",
  "sourceFixed",
  "yearBuilt",
  "flooringContinuous",
];

export function findingText(key: FindingKey, f: ReportFindings): string | null {
  const x = f[key] as Finding<unknown> | null;
  if (!x) return null;
  const v = x.value as never;
  switch (key) {
    case "dims": {
      const d = v as { lengthFt: number; widthFt: number; heightFt: number | null };
      return `${d.lengthFt} × ${d.widthFt} ft${d.heightFt ? `, ${d.heightFt} ft ceiling` : ""} (${Math.round(d.lengthFt * d.widthFt * 10) / 10} SF floor)`;
    }
    case "affectedAreaSF":
      return `${v} SF`;
    case "floorCoverage": {
      const c = v as { whole: boolean; pct: number | null };
      return c.whole ? "Whole floor" : `Part of the floor${c.pct != null ? ` (${c.pct}%)` : ""}`;
    }
    case "containment": {
      const c = v as { level: string; negativeAir: boolean; areas?: { room: string; extent: string | null }[]; separate?: boolean };
      if (c.areas?.length)
        return `${c.separate ? `${c.areas.length} separate containments` : "One containment"}: ${c.areas.map((a) => `${a.room}${a.extent ? ` (${a.extent === "entire" ? "entire room" : "localized"})` : ""}`).join(", ")}${c.negativeAir ? "; negative pressure" : ""}`;
      return `${c.level === "unspecified" ? "Containment (level not stated)" : `${c.level[0].toUpperCase()}${c.level.slice(1)} containment`}${c.negativeAir ? " with negative air" : ""}`;
    }
    case "subfloor":
      return v === "remove" ? "Remove the subfloor" : "Clean and treat the subfloor (stays)";
    case "wallsGrowth":
    case "baseboardBacksGrowth": {
      const g = v as { growth: boolean; walls: string[]; heightIn?: number | null };
      return g.growth ? `Yes${g.walls.length ? ` (${g.walls.join(", ")})` : " (walls not named)"}${g.heightIn ? `, up to ${g.heightIn}"` : ""}` : "No";
    }
    case "framingGrowth": {
      const g = v as { growth: boolean; where: string; action: string | null };
      return g.growth ? `Yes — ${g.where}${g.action === "remove" ? ", remove/replace (structural)" : g.action === "clean" ? ", clean in place" : ", clean or remove not stated"}` : "No";
    }
    case "sourceFixed":
      return v ? "Yes" : "No";
    case "flooringContinuous": {
      const c = v as { continues: boolean; rooms: string[] };
      return c.continues ? `Yes${c.rooms.length ? ` — into ${c.rooms.join(", ")}` : ""}` : "No — stops at a break";
    }
    default:
      return String(v);
  }
}
