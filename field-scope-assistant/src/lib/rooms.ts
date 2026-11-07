/** Room names recognized in free text (notes, reports). First match wins, so specific names come first. */
export const ROOM_PATTERNS: [RegExp, string][] = [
  [/\bprimary bed(room)?|master bed(room)?\b/i, "Primary bedroom"],
  [/\bbed ?room\s*(\d)\b/i, "Bedroom $1"],
  [/\bbed ?room\b/i, "Bedroom"],
  [/\bden bath(room)?\b/i, "Den bathroom"],
  [/\bprimary bath(room)?|master bath(room)?\b/i, "Primary bathroom"],
  [/\bbath ?room|\bbath\b/i, "Bathroom"],
  [/\bkitchen\b/i, "Kitchen"],
  [/\bliving ?room\b/i, "Living room"],
  [/\bdining ?room\b/i, "Dining room"],
  [/\bhall(way)?\b/i, "Hallway"],
  [/\bfoyer|entry(way)?\b/i, "Foyer"],
  [/\b(?:washer|dryer)(?:\s*\/\s*dryer)?(?:\s+(?:closet|area|room|unit))?\b/i, "Washer/Dryer closet"],
  [/\bcloset\b/i, "Closet"],
  [/\blaundry\b/i, "Laundry"],
  [/\bbasement\b/i, "Basement"],
  [/\bden\b/i, "Den"],
  [/\boffice\b/i, "Office"],
];

export function findRoomName(text: string): string | null {
  for (const [re, name] of ROOM_PATTERNS) {
    const m = text.match(re);
    if (m) return name.replace("$1", m[2] ?? m[1] ?? "").replace(/\s+$/, "");
  }
  return null;
}
