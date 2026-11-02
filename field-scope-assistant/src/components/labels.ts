import type { Location } from "@/lib/schemas";

export function locLabel(l: Pick<Location, "floor" | "unit" | "room"> | undefined | null): string {
  if (!l) return "Project-wide";
  const floor = l.floor ? (/^\d+$/.test(l.floor) ? `Floor ${l.floor}` : l.floor) : "";
  return [floor, l.unit ? `Unit ${l.unit}` : "", l.room].filter(Boolean).join(" — ");
}

export const STATUS_LABEL: Record<string, string> = {
  reported: "Reported",
  observed: "Observed in photo",
  proposed: "Proposed",
  approved: "Approved",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  not_performed: "Not performed",
  unknown: "Unknown",
};

export const SOURCE_LABEL: Record<string, string> = {
  pm: "Your notes / correction",
  pm_accepted: "Accepted recommendation",
  manual_edit: "Edited by you",
  photo: "Visible in photo",
  caption: "Caption statement",
  prior_visit: "Carried from prior visit",
};

export const CATEGORY_LABEL: Record<string, string> = {
  condition: "Condition", moisture_elevated: "Still elevated", moisture_dry: "Now dry", reading: "Reading", change: "Change since last visit",
  extraction: "Water extraction", removal: "Material removal", detach_reset: "Detach / reset", cavity_access: "Cavity access",
  cleaning: "Cleaning / HEPA", antimicrobial: "Antimicrobial", contents: "Contents", floor_protection: "Floor protection",
  containment: "Containment", drying: "Equipment / drying", monitoring: "Monitoring", repair: "Repair", replacement: "Replacement",
  finish: "Materials / finishes", painting: "Painting", sequencing: "Trade sequencing", access: "Access / building", forms: "Forms",
  schedule: "Schedule / next step", note: "Note",
};

export const ACCESS_OPTIONS = ["Accessed", "No answer", "Rescheduled", "Access denied", "Partial access"];
