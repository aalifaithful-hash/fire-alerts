import type { Location } from "./schemas";

/** Reference to a location as produced by AI or a correction. */
export interface LocationRef {
  locationId?: string | null;
  floor?: string | null;
  unit?: string | null;
  room?: string | null;
}

export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\b(the|apt|apartment|unit|floor|fl)\b\.?/g, " ")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sameLocation(
  a: { floor: string | null; unit: string | null; room: string },
  b: { floor?: string | null; unit?: string | null; room?: string | null },
): boolean {
  return (
    norm(a.room) === norm(b.room) &&
    norm(a.unit) === norm(b.unit) &&
    norm(a.floor) === norm(b.floor)
  );
}

export type ResolveResult =
  | { kind: "existing"; location: Location }
  | { kind: "new"; floor: string | null; unit: string | null; room: string }
  | { kind: "ambiguous"; candidates: Location[] }
  | { kind: "none" };

/**
 * Resolve a reference against a project's locations.
 * - A valid id wins.
 * - Exact floor/unit/room match wins.
 * - A room-only reference (no floor/unit) that matches several rooms is ambiguous —
 *   e.g. "closet" when Unit 19C and Unit 20A both have a closet. We never guess.
 */
export function resolveLocation(ref: LocationRef | null | undefined, locations: Location[]): ResolveResult {
  if (!ref) return { kind: "none" };
  if (ref.locationId) {
    const hit = locations.find((l) => l.id === ref.locationId);
    if (hit) return { kind: "existing", location: hit };
  }
  const room = (ref.room ?? "").trim();
  if (!room) return { kind: "none" };

  const exact = locations.filter((l) => sameLocation(l, ref));
  if (exact.length === 1) return { kind: "existing", location: exact[0] };

  const roomMatches = locations.filter((l) => norm(l.room) === norm(room));
  const partial = roomMatches.filter(
    (l) =>
      (!ref.unit || norm(l.unit) === norm(ref.unit)) &&
      (!ref.floor || norm(l.floor) === norm(ref.floor)),
  );
  if (partial.length === 1) return { kind: "existing", location: partial[0] };
  if (partial.length > 1) return { kind: "ambiguous", candidates: partial };

  return {
    kind: "new",
    floor: ref.floor?.trim() || null,
    unit: ref.unit?.trim() || null,
    room,
  };
}

export function floorLabel(floor: string | null): string {
  if (!floor) return "";
  const f = floor.trim();
  if (/^\d+$/.test(f)) return `${ordinal(Number(f))} Floor`;
  if (/floor|level|basement|cellar|roof|attic|lobby/i.test(f)) return f;
  return `Floor ${f}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function roomHeading(l: Pick<Location, "floor" | "unit" | "room">): string {
  if (l.unit) return `Unit ${l.unit.replace(/^unit\s+/i, "")} — ${l.room}`;
  return l.room;
}

/** Full, unambiguous label: used in questions and the evidence panel. */
export function fullLabel(l: Pick<Location, "floor" | "unit" | "room">): string {
  return [floorLabel(l.floor), l.unit ? `Unit ${l.unit.replace(/^unit\s+/i, "")}` : "", l.room]
    .filter(Boolean)
    .join(" — ");
}

function naturalKey(s: string | null): string {
  return (s ?? "").replace(/\d+/g, (d) => d.padStart(6, "0")).toLowerCase();
}

export function sortLocations(locs: Location[]): Location[] {
  return [...locs].sort(
    (a, b) =>
      naturalKey(a.floor).localeCompare(naturalKey(b.floor)) ||
      naturalKey(a.unit).localeCompare(naturalKey(b.unit)) ||
      a.sort - b.sort ||
      a.room.localeCompare(b.room),
  );
}
