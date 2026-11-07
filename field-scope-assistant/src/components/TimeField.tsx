"use client";
import { useEffect, useState } from "react";
import { formatTime12, parseTimeInput } from "@/lib/time";

/**
 * Fast, reliable time entry on a phone (replaces the native segmented picker):
 * type "11", "1100", "11a" or "3:30p"; the result shows as you type and is saved as HH:MM.
 * Quick buttons flip AM/PM. Fires onChange with "HH:MM" or null (cleared) on blur or Enter.
 */
export default function TimeField({ value, onChange, label }: { value: string | null; onChange: (v: string | null) => void; label: string }) {
  const [text, setText] = useState(formatTime12(value));
  useEffect(() => setText(formatTime12(value)), [value]);
  const parsed = parseTimeInput(text);
  const bad = text.trim() !== "" && !parsed;
  const commit = (t: string = text) => {
    const p = parseTimeInput(t);
    if (t.trim() === "") return value !== null && onChange(null);
    if (p && p !== value) onChange(p);
    if (p) setText(formatTime12(p));
  };
  const flip = (ap: "AM" | "PM") => {
    const p = parsed ?? value;
    if (!p) return;
    const [h, m] = p.split(":").map(Number);
    const h2 = ap === "AM" ? h % 12 : (h % 12) + 12;
    const next = `${String(h2).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    setText(formatTime12(next));
    if (next !== value) onChange(next);
  };
  const cur = parsed ?? value;
  return (
    <div className="row" style={{ gap: 4 }}>
      <input
        className="in grow"
        inputMode="text"
        autoComplete="off"
        enterKeyHint="done"
        placeholder="e.g. 11 or 2:30p"
        value={text}
        aria-label={label}
        aria-invalid={bad}
        style={bad ? { borderColor: "var(--fire, #c53030)" } : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <button type="button" className={`btn sm ${cur && Number(cur.slice(0, 2)) < 12 ? "on" : ""}`} onClick={() => flip("AM")} aria-label={`${label} AM`}>
        AM
      </button>
      <button type="button" className={`btn sm ${cur && Number(cur.slice(0, 2)) >= 12 ? "on" : ""}`} onClick={() => flip("PM")} aria-label={`${label} PM`}>
        PM
      </button>
    </div>
  );
}
