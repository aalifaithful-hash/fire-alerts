// Client-safe. Joins an address and its unit without repeating the unit when the address already has it.
export function hasUnit(address: string, unit: string | null | undefined): boolean {
  if (!unit) return true;
  const u = unit.replace(/^(unit|apt\.?|apartment|suite|#)\s*/i, "").trim();
  if (!u) return true;
  const esc = u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\b(?:unit|apt\\.?|apartment|suite)\\s*|#\\s*)${esc}\\b`, "i").test(address);
}
export function addressWithUnit(address: string, unit: string | null | undefined): string {
  const u = unit?.replace(/^(unit|apt\.?|apartment|suite|#)\s*/i, "").trim();
  return u && !hasUnit(address, u) ? `${address}, Unit ${u}` : address;
}
