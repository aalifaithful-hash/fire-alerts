export const TZ = "America/New_York";

/** Today's date (YYYY-MM-DD) in America/New_York. */
export function todayNY(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function weekdayNY(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(now);
}

/** "2026-11-02" -> "Mon 11/2/2026". Pure string math — no timezone drift. */
export function formatDate(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(d);
  return `${wd} ${+m[2]}/${+m[3]}/${m[1]}`;
}

/** "14:30" -> "2:30 PM" */
export function formatTime(hm: string | null | undefined): string {
  if (!hm) return "";
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hm;
  const h = +m[1];
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatTimestampNY(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
