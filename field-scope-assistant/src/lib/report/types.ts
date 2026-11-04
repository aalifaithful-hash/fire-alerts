/**
 * What a mold assessment report says, as read by an analyzer. Every finding keeps the exact
 * statement it came from (quote + page) so a tech can check it on a phone. Anything the report
 * doesn't state stays null — never guessed.
 */
export interface Finding<T> {
  value: T;
  quote: string;
  page: number;
}
type F<T> = Finding<T> | null;

export interface ReportFindings {
  analyzer: "rules" | "ai";
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
  containment: F<{ level: "full" | "limited" | "none" | "unspecified"; negativeAir: boolean }>;
  removalExtent: F<string>;
  subfloor: F<"clean" | "remove">;
  wallsGrowth: F<{ growth: boolean; walls: string[] }>;
  baseboardBacksGrowth: F<{ growth: boolean; walls: string[] }>;
  framingGrowth: F<boolean>;
  clearanceCriteria: F<string>;
  clearanceBy: F<string>;
  moistureSource: F<string>;
  sourceFixed: F<boolean>;
  yearBuilt: F<number>;
  flooringContinuous: F<{ continues: boolean; rooms: string[] }>;
  moldType: F<string>;
  condition: F<string>;
  /** Items the report leaves open; `quote` is set when it says so explicitly (e.g. "to be determined"). */
  unanswered: { key: FindingKey; label: string; quote: string | null }[];
}

export type FindingKey = Exclude<keyof ReportFindings, "analyzer" | "readable" | "textChars" | "unanswered">;

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
      const c = v as { level: string; negativeAir: boolean };
      return `${c.level === "unspecified" ? "Containment (level not stated)" : `${c.level[0].toUpperCase()}${c.level.slice(1)} containment`}${c.negativeAir ? " with negative air" : ""}`;
    }
    case "subfloor":
      return v === "remove" ? "Remove the subfloor" : "Clean and treat the subfloor (stays)";
    case "wallsGrowth":
    case "baseboardBacksGrowth": {
      const g = v as { growth: boolean; walls: string[] };
      return g.growth ? `Yes${g.walls.length ? ` (${g.walls.join(", ")})` : ""}` : "No";
    }
    case "framingGrowth":
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
