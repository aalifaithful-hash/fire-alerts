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

/**
 * Forgiving time entry for phones: "11", "1100", "11:00", "11a", "11 am", "3p", "3:30pm", "15:30", "noon".
 * Returns 24h "HH:MM" or null if it can't tell. Without am/pm, 7–11 → AM and 12–6 → PM
 * (field appointment hours); a 24h hour (13–23, or a leading 0) is taken as written.
 */
export function parseTimeInput(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\./g, "");
  if (!t) return null;
  if (t === "noon") return "12:00";
  if (t === "midnight") return "00:00";
  const m = t.match(/^(\d{1,2})(?:[:h ]?(\d{2}))?\s*(a|am|p|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] != null ? Number(m[2]) : 0;
  if (min > 59 || h > 23) return null;
  const ap = m[3]?.[0];
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "p" ? 12 : 0);
  } else if (!(m[1].length === 2 && m[1].startsWith("0")) && h >= 1 && h <= 6) h += 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "13:05" → "1:05 PM". */
export function formatTime12(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
