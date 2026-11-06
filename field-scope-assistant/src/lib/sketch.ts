import { deflateSync } from "node:zlib";
import type { RoomScanData, ScopeLine } from "./scan";

/**
 * Sketch of the affected areas, generated from the manual measurements (no AI).
 * One drawing model (simple primitives) is rendered three ways: SVG (app +
 * Word), vector drawing on the PDF page, and a PNG fallback for Word.
 * Rooms are drawn to scale as rectangles (N at the top); rooms without
 * measurements are dashed boxes labeled "not to scale". Rooms are laid out side
 * by side per floor — their real adjacency is not known from measurements.
 */

export const COLORS = {
  outline: "#222222",
  mitigation: "#2f6fb5",
  reconstruction: "#d9822b",
  source: "#d62828",
  moisture: "#1f8a7a",
  excluded: "#8a8a8a",
  text: "#111111",
  muted: "#666666",
  white: "#ffffff",
};

export type Prim =
  | { t: "rect"; x: number; y: number; w: number; h: number; stroke: string; sw: number; dash?: number[]; fill?: string; opacity?: number }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; sw: number; dash?: number[] }
  | { t: "circle"; cx: number; cy: number; r: number; fill: string; stroke?: string }
  | { t: "text"; x: number; y: number; text: string; size: number; fill: string; anchor?: "start" | "middle" | "end"; bold?: boolean };

export interface SketchModel {
  width: number;
  height: number;
  prims: Prim[];
  rooms: number;
}

export interface SketchRoom {
  locationId: string;
  label: string;
  floor: string | null;
  scan: RoomScanData;
  lines: ScopeLine[];
  excluded: boolean;
}

const W = 1000;
const MARGIN = 30;
const GAP = 46;
const UNMEASURED = { L: 12, W: 10 };

function hatch(x: number, y: number, w: number, h: number, color: string, step = 9): Prim[] {
  const out: Prim[] = [];
  for (let k = -h; k < w; k += step) {
    // segment of the line x - y = k inside the rect
    const x1 = Math.max(0, k);
    const y1 = x1 - k;
    const x2 = Math.min(w, k + h);
    const y2 = x2 - k;
    if (x2 > x1) out.push({ t: "line", x1: x + x1, y1: y + y1, x2: x + x2, y2: y + y2, stroke: color, sw: 1 });
  }
  return out;
}

/** Edge of a rectangular room for wall label N/E/S/W, inset by d (positive = inside). */
function edge(label: string, x: number, y: number, w: number, h: number, d = 0) {
  switch (label) {
    case "N":
      return { x1: x, y1: y + d, x2: x + w, y2: y + d, len: w, horiz: true };
    case "S":
      return { x1: x + w, y1: y + h - d, x2: x, y2: y + h - d, len: w, horiz: true }; // left→right looking from inside
    case "E":
      return { x1: x + w - d, y1: y, x2: x + w - d, y2: y + h, len: h, horiz: false };
    case "W":
      return { x1: x + d, y1: y + h, x2: x + d, y2: y, len: h, horiz: false };
    default:
      return null;
  }
}
const along = (e: NonNullable<ReturnType<typeof edge>>, t: number) => ({ x: e.x1 + (e.x2 - e.x1) * t, y: e.y1 + (e.y2 - e.y1) * t });
const live = (lines: ScopeLine[], id: string) => lines.find((l) => l.id === id && l.status !== "rejected" && l.status !== "excluded");

export function buildSketch(rooms: SketchRoom[]): SketchModel {
  const prims: Prim[] = [];
  const dims = rooms.map((r) => {
    const m = r.scan.measurements;
    const measured = !!(m.lengthFt && m.widthFt);
    return { r, measured, L: measured ? m.lengthFt! : UNMEASURED.L, Wd: measured ? m.widthFt! : UNMEASURED.W };
  });
  const maxL = Math.max(1, ...dims.map((d) => d.L));
  const S = Math.min(40, (W - 2 * MARGIN) / maxL); // units per foot (common scale for every room)
  let y = MARGIN + 16;
  let maxX = 0;

  const floors = [...new Set(dims.map((d) => d.r.floor ?? ""))];
  for (const fl of floors) {
    const group = dims.filter((d) => (d.r.floor ?? "") === fl);
    prims.push({ t: "text", x: MARGIN, y, text: fl ? (/^\d+$/.test(fl) ? `FLOOR ${fl}` : fl.toUpperCase()) : "ROOMS", size: 14, fill: COLORS.text, bold: true });
    y += 30;
    let x = MARGIN;
    let rowH = 0;
    for (const d of group) {
      const w = d.L * S;
      const h = d.Wd * S;
      if (x + w > W - MARGIN && x > MARGIN) {
        x = MARGIN;
        y += rowH + GAP;
        rowH = 0;
      }
      drawRoom(prims, d.r, x, y, w, h, d.measured, d.L, d.Wd, S);
      maxX = Math.max(maxX, x + w + 150); // room for labels outside the right wall
      x += w + GAP;
      rowH = Math.max(rowH, h + 26);
    }
    y += rowH + GAP;
  }

  // crop the canvas to the drawing (keeps one small room large on a phone)
  const width = Math.min(W, Math.max(600, maxX + MARGIN));
  prims.push({ t: "text", x: width - MARGIN, y: MARGIN + 4, text: "N ↑", size: 14, fill: COLORS.text, anchor: "end", bold: true });
  // legend
  const ly = y;
  const items: [string, Prim][] = [
    ["Mitigation (affected / removal)", { t: "line", x1: 0, y1: 0, x2: 24, y2: 0, stroke: COLORS.mitigation, sw: 5 }],
    ["Reconstruction (replace / paint)", { t: "line", x1: 0, y1: 0, x2: 24, y2: 0, stroke: COLORS.reconstruction, sw: 3, dash: [4, 3] }],
    ["Source of loss", { t: "circle", cx: 12, cy: 0, r: 6, fill: COLORS.source }],
    ["Moisture point", { t: "circle", cx: 12, cy: 0, r: 5, fill: COLORS.moisture }],
    ["Excluded area", { t: "line", x1: 0, y1: 0, x2: 24, y2: 0, stroke: COLORS.excluded, sw: 5 }],
    ["Not measured (not to scale)", { t: "line", x1: 0, y1: 0, x2: 24, y2: 0, stroke: COLORS.outline, sw: 1.5, dash: [5, 4] }],
  ];
  items.forEach(([label, p], i) => {
    const cx = MARGIN + (i % 2) * ((width - 2 * MARGIN) / 2);
    const cy = ly + Math.floor(i / 2) * 22;
    prims.push(shift(p, cx, cy));
    prims.push({ t: "text", x: cx + 34, y: cy + 4, text: label, size: 12, fill: COLORS.text });
  });
  const height = ly + Math.ceil(items.length / 2) * 22 + 20;
  prims.push({ t: "text", x: MARGIN, y: height - 6, text: "Drawn from manual measurements; rooms are placed side by side, not in their real position.", size: 10, fill: COLORS.muted });
  return { width, height: height + 8, prims, rooms: rooms.length };
}

function shift(p: Prim, dx: number, dy: number): Prim {
  if (p.t === "line") return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy };
  if (p.t === "circle") return { ...p, cx: p.cx + dx, cy: p.cy + dy };
  if (p.t === "rect") return { ...p, x: p.x + dx, y: p.y + dy };
  return { ...p, x: p.x + dx, y: p.y + dy };
}

function drawRoom(P: Prim[], room: SketchRoom, x: number, y: number, w: number, h: number, measured: boolean, L: number, Wd: number, S: number) {
  const { scan, lines } = room;
  const m = scan.materials;
  P.push({
    t: "text",
    x,
    y: y - 8,
    text: measured ? `${room.label} — ${round(L)}′ × ${round(Wd)}′${scan.measurements.heightFt ? ` × ${round(scan.measurements.heightFt)}′h` : ""}` : `${room.label} — not to scale (not measured)`,
    size: 12,
    fill: COLORS.text,
    bold: true,
  });
  P.push({ t: "rect", x, y, w, h, stroke: COLORS.outline, sw: measured ? 2 : 1.5, dash: measured ? undefined : [5, 4] });

  if (room.excluded) {
    P.push(...hatch(x, y, w, h, COLORS.excluded, 7));
    P.push({ t: "text", x: x + w / 2, y: y + h / 2 + 5, text: "EXCLUDED", size: 14, fill: COLORS.excluded, anchor: "middle", bold: true });
    return;
  }

  // affected flooring (partial width from the source side)
  if (m.flooring.affected) {
    const pct = (m.flooring.affectedPct ?? 100) / 100;
    const fw = w * pct;
    const fromRight = scan.source.wall === "E";
    const replace = !!live(lines, "floor.replace");
    P.push(...hatch(fromRight ? x + w - fw : x, y, fw, h, replace ? COLORS.reconstruction : COLORS.mitigation, 10));
    P.push({ t: "text", x: x + 8, y: y + 18, text: `Floor ${Math.round(pct * 100)}%${m.flooring.type ? ` ${m.flooring.type}` : ""}${replace ? " — replace" : ""}`, size: 10, fill: COLORS.text });
  }
  if (m.flooring.continuousRun)
    P.push({ t: "text", x: x + w - 6, y: y + h - 8, text: `Run ${m.flooring.continuousRun}`, size: 10, fill: COLORS.reconstruction, anchor: "end", bold: true });

  // ceiling
  if (m.ceiling.affected) {
    P.push({ t: "rect", x: x + 12, y: y + 12, w: Math.max(4, w - 24), h: Math.max(4, h - 24), stroke: COLORS.mitigation, sw: 1.2, dash: [3, 3] });
    P.push({ t: "text", x: x + w / 2, y: y + 26, text: `Ceiling ${m.ceiling.affectedPct ?? 100}%${m.ceiling.action === "remove" ? " remove" : ""}`, size: 10, fill: COLORS.mitigation, anchor: "middle" });
  }

  // walls: flood cut (mitigation), baseboard, full-wall paint (reconstruction)
  const fc = live(lines, "floodcut");
  const cutIn = fc ? Number(fc.item.match(/(\d+)"/)?.[1] ?? 0) : 0;
  for (const wl of ["N", "E", "S", "W"]) {
    if (fc && m.walls.affectedWalls.includes(wl)) {
      const e = edge(wl, x, y, w, h, 3)!;
      P.push({ t: "line", x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, stroke: COLORS.mitigation, sw: 6 });
      // label at a quarter of the wall so it does not sit on the source marker or the door
      const mid = along(e, 0.25);
      P.push({ t: "text", x: mid.x + (e.horiz ? 0 : wl === "E" ? -8 : 8), y: mid.y + (e.horiz ? (wl === "N" ? 18 : -10) : 4), text: `FC ${cutIn}″`, size: 10, fill: COLORS.mitigation, anchor: e.horiz ? "middle" : wl === "E" ? "end" : "start", bold: true });
    } else if (live(lines, "baseboard") && (m.baseboard.walls.length ? m.baseboard.walls : m.walls.affectedWalls).includes(wl)) {
      const e = edge(wl, x, y, w, h, 4)!;
      P.push({ t: "line", x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, stroke: COLORS.mitigation, sw: 2, dash: [6, 3] });
    }
    const paint = live(lines, "walls.paint");
    if (paint && paint.item.includes(wl === "N" ? "N" : wl) && new RegExp(`\\b${wl}\\b`).test(paint.item)) {
      const e = edge(wl, x, y, w, h, -5)!;
      P.push({ t: "line", x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, stroke: COLORS.reconstruction, sw: 3, dash: [4, 3] });
    }
  }

  // openings
  for (const o of scan.measurements.openings) {
    const e = edge(o.wall, x, y, w, h, 0);
    if (!e) continue;
    const owid = (o.widthIn / 12) * S;
    const start = o.offsetFt != null ? o.offsetFt * S : (e.len - owid) / 2;
    const t0 = Math.max(0, Math.min(1, start / e.len));
    const t1 = Math.max(0, Math.min(1, (start + owid) / e.len));
    const a = along(e, t0);
    const b = along(e, t1);
    if (o.kind === "window") {
      const off = e.horiz ? { x: 0, y: 3 } : { x: 3, y: 0 };
      P.push({ t: "line", x1: a.x - off.x, y1: a.y - off.y, x2: b.x - off.x, y2: b.y - off.y, stroke: COLORS.outline, sw: 1.2 });
      P.push({ t: "line", x1: a.x + off.x, y1: a.y + off.y, x2: b.x + off.x, y2: b.y + off.y, stroke: COLORS.outline, sw: 1.2 });
    } else {
      P.push({ t: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: COLORS.white, sw: 5 });
      const n = e.horiz ? { x: 0, y: 6 } : { x: 6, y: 0 };
      P.push({ t: "line", x1: a.x - n.x, y1: a.y - n.y, x2: a.x + n.x, y2: a.y + n.y, stroke: COLORS.outline, sw: 1.5 });
      P.push({ t: "line", x1: b.x - n.x, y1: b.y - n.y, x2: b.x + n.x, y2: b.y + n.y, stroke: COLORS.outline, sw: 1.5 });
    }
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    P.push({ t: "text", x: mid.x + (e.horiz ? 0 : o.wall === "E" ? -10 : 10), y: mid.y + (e.horiz ? (o.wall === "N" ? -5 : 13) : 4), text: o.kind === "window" ? "Win" : o.kind === "door" ? "Door" : "Open", size: 9, fill: COLORS.muted, anchor: "middle" });
  }

  // source of loss
  const s = scan.source;
  if (s.where === "in_room" || s.wall) {
    const e = s.wall ? edge(s.wall, x, y, w, h, 9) : null;
    const lenFt = s.wall ? (s.wall === "N" || s.wall === "S" ? L : Wd) : 0;
    const p = e ? along(e, s.positionFt != null && lenFt ? Math.min(1, s.positionFt / lenFt) : 0.5) : { x: x + w / 2, y: y + h / 2 };
    P.push({ t: "circle", cx: p.x, cy: p.y, r: 7, fill: COLORS.source });
    P.push({ t: "text", x: p.x + 10, y: p.y - 8, text: s.fixture ? `Source: ${s.fixture}` : "Source", size: 10, fill: COLORS.source, bold: true });
  } else if (s.where !== "unknown") {
    P.push({ t: "text", x: x + w / 2, y: y + 40, text: `Source: from ${s.where}`, size: 11, fill: COLORS.source, anchor: "middle", bold: true });
  }

  // moisture points
  scan.moisturePoints.forEach((mp, i) => {
    let p: { x: number; y: number };
    if (mp.x != null && mp.y != null) p = { x: x + mp.x * w, y: y + mp.y * h };
    else if (mp.wall && edge(mp.wall, x, y, w, h, 16)) {
      const onWall = scan.moisturePoints.filter((q) => q.wall === mp.wall);
      p = along(edge(mp.wall, x, y, w, h, 16)!, (onWall.indexOf(mp) + 1) / (onWall.length + 1));
    } else p = { x: x + w * ((i % 4) + 1) / 5, y: y + h * (0.35 + 0.3 * (Math.floor(i / 4) % 2)) };
    P.push({ t: "circle", cx: p.x, cy: p.y, r: 6, fill: COLORS.moisture });
    P.push({ t: "text", x: p.x, y: p.y + 3.5, text: String(i + 1), size: 8, fill: COLORS.white, anchor: "middle", bold: true });
  });

  // equipment placed by the PM (calculated suggestions are labeled as such)
  const placed = scan.equipmentPlaced.map((e) => `${e.kind === "air_mover" ? "AM" : e.kind === "dehumidifier" ? "DH" : "AS"}×${e.qty} installed`);
  const calc = lines.filter((l) => l.kind === "equipment" && l.status === "accepted").map((l) => `${l.item.includes("scrubber") ? "AS" : /dehumid/i.test(l.item) ? "DH" : "AM"}×${l.quantity} calculated`);
  const eq = placed.length ? placed : calc;
  if (eq.length) P.push({ t: "text", x: x + w - 12, y: y + 32, text: eq.join("  "), size: 10, fill: COLORS.text, anchor: "end", bold: true });
}

const round = (v: number) => Math.round(v * 10) / 10;

// ---------------- SVG ----------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toSvg(m: SketchModel): string {
  const parts = m.prims.map((p) => {
    switch (p.t) {
      case "rect":
        return `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${p.fill ?? "none"}" ${p.opacity != null ? `fill-opacity="${p.opacity}" ` : ""}stroke="${p.stroke}" stroke-width="${p.sw}"${p.dash ? ` stroke-dasharray="${p.dash.join(" ")}"` : ""}/>`;
      case "line":
        return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${p.stroke}" stroke-width="${p.sw}"${p.dash ? ` stroke-dasharray="${p.dash.join(" ")}"` : ""}/>`;
      case "circle":
        return `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="${p.fill}"${p.stroke ? ` stroke="${p.stroke}"` : ""}/>`;
      case "text":
        return `<text x="${p.x}" y="${p.y}" font-size="${p.size}" fill="${p.fill}" text-anchor="${p.anchor ?? "start"}"${p.bold ? ' font-weight="700"' : ""} font-family="Helvetica, Arial, sans-serif">${esc(p.text)}</text>`;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.width} ${m.height}" width="${m.width}" height="${m.height}"><rect width="100%" height="100%" fill="#ffffff"/>${parts.join("")}</svg>`;
}

// ---------------- PNG (fallback for Word; shapes only, no text) ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(new Uint8Array(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
}
const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function toPng(m: SketchModel): Buffer {
  const w = Math.ceil(m.width);
  const h = Math.ceil(m.height);
  const px = Buffer.alloc(w * h * 3, 255);
  const dot = (x: number, y: number, c: number[], r: number) => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const X = Math.round(x + dx);
        const Y = Math.round(y + dy);
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const i = (Y * w + X) * 3;
        px[i] = c[0];
        px[i + 1] = c[1];
        px[i + 2] = c[2];
      }
  };
  const seg = (x1: number, y1: number, x2: number, y2: number, c: number[], sw: number, dash?: number[]) => {
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const r = Math.max(0, Math.floor(sw / 2));
    const period = dash ? dash.reduce((a, b) => a + b, 0) : 0;
    for (let s = 0; s <= len; s += 0.7) {
      if (dash && s % period > dash[0]) continue;
      dot(x1 + ((x2 - x1) * s) / len, y1 + ((y2 - y1) * s) / len, c, r);
    }
  };
  for (const p of m.prims) {
    if (p.t === "line") seg(p.x1, p.y1, p.x2, p.y2, hex(p.stroke), p.sw, p.dash);
    else if (p.t === "rect") {
      const c = hex(p.stroke);
      seg(p.x, p.y, p.x + p.w, p.y, c, p.sw, p.dash);
      seg(p.x + p.w, p.y, p.x + p.w, p.y + p.h, c, p.sw, p.dash);
      seg(p.x + p.w, p.y + p.h, p.x, p.y + p.h, c, p.sw, p.dash);
      seg(p.x, p.y + p.h, p.x, p.y, c, p.sw, p.dash);
    } else if (p.t === "circle") dot(p.cx, p.cy, hex(p.fill), Math.round(p.r));
  }
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", new Uint8Array(ihdr)),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
