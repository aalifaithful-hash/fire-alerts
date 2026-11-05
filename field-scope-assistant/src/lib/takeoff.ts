import type { Measurements, Opening } from "./scan";

/**
 * Quantity takeoff from manual measurements. Every number is returned with the
 * arithmetic that produced it, so the estimator can check it at a glance.
 * Missing measurements produce null quantities — never a guess.
 */

export const r1 = (x: number) => Math.round(x * 10) / 10;
export const ft = (x: number) => `${r1(x)} ft`;

export interface WallInfo {
  label: string;
  lengthFt: number;
  doorsWidthFt: number; // full-height openings along the floor line
  openingsSF: number; // all openings (doors + windows)
  openings: Opening[];
}

export interface Takeoff {
  measured: boolean;
  floorSF: number | null;
  floorCalc: string;
  perimeterLF: number | null;
  perimeterCalc: string;
  heightFt: number | null;
  wallGrossSF: number | null;
  openingsSF: number;
  wallNetSF: number | null;
  wallCalc: string;
  ceilingSF: number | null;
  walls: WallInfo[];
}

export function wallsOf(m: Measurements): { label: string; lengthFt: number }[] {
  if (m.segments?.length) return m.segments;
  if (m.lengthFt && m.widthFt)
    return [
      { label: "N", lengthFt: m.lengthFt },
      { label: "E", lengthFt: m.widthFt },
      { label: "S", lengthFt: m.lengthFt },
      { label: "W", lengthFt: m.widthFt },
    ];
  return [];
}

const sfOf = (o: Opening) => (o.widthIn / 12) * (o.heightIn / 12);

export function takeoff(m: Measurements): Takeoff {
  const walls = wallsOf(m).map((w) => {
    const ops = m.openings.filter((o) => o.wall === w.label);
    return {
      label: w.label,
      lengthFt: w.lengthFt,
      doorsWidthFt: ops.filter((o) => o.kind !== "window").reduce((a, o) => a + o.widthIn / 12, 0),
      openingsSF: ops.reduce((a, o) => a + sfOf(o), 0),
      openings: ops,
    };
  });
  const floorSF = m.lengthFt && m.widthFt ? m.lengthFt * m.widthFt : null;
  const perimeter = walls.length ? walls.reduce((a, w) => a + w.lengthFt, 0) : null;
  const openingsSF = m.openings.reduce((a, o) => a + sfOf(o), 0);
  // Wall lengths entered as segments must close the room when length × width is also given;
  // otherwise wall areas would be built from a partial perimeter — leave them blank and say why.
  const closes = !(m.segments?.length && m.lengthFt && m.widthFt) || Math.abs((perimeter ?? 0) - 2 * (m.lengthFt + m.widthFt)) <= 1;
  const gross = perimeter != null && m.heightFt && closes ? perimeter * m.heightFt : null;
  const net = gross != null ? Math.max(0, gross - openingsSF) : null;
  return {
    measured: floorSF != null || perimeter != null,
    floorSF: floorSF != null ? r1(floorSF) : null,
    floorCalc: floorSF != null ? `${ft(m.lengthFt!)} × ${ft(m.widthFt!)} = ${r1(floorSF)} SF` : "floor not measured",
    perimeterLF: perimeter != null ? r1(perimeter) : null,
    perimeterCalc: walls.length ? `${walls.map((w) => `${w.label} ${r1(w.lengthFt)}`).join(" + ")} = ${r1(perimeter!)} LF` : "walls not measured",
    heightFt: m.heightFt,
    wallGrossSF: gross != null ? r1(gross) : null,
    openingsSF: r1(openingsSF),
    wallNetSF: net != null ? r1(net) : null,
    wallCalc: !closes
      ? `wall lengths entered (${r1(perimeter ?? 0)} LF) don't add up to the room perimeter 2 × (${r1(m.lengthFt!)} + ${r1(m.widthFt!)}) = ${r1(2 * (m.lengthFt! + m.widthFt!))} LF — wall areas not computed`
      : gross != null
        ? `${r1(perimeter!)} LF × ${ft(m.heightFt!)} = ${r1(gross)} SF${openingsSF ? ` − openings ${r1(openingsSF)} SF = ${r1(net!)} SF` : ""}`
        : "wall height or lengths not measured",
    ceilingSF: floorSF != null ? r1(floorSF) : null,
    walls,
  };
}

/** One wall's paintable area (full wall, corner to corner) minus its openings. */
export function wallPaintSF(w: WallInfo, heightFt: number | null): { sf: number | null; calc: string } {
  if (!heightFt) return { sf: null, calc: `${w.label} wall: height not measured` };
  const gross = w.lengthFt * heightFt;
  const net = Math.max(0, gross - w.openingsSF);
  return {
    sf: r1(net),
    calc: `${w.label} wall ${ft(w.lengthFt)} × ${ft(heightFt)} = ${r1(gross)} SF${w.openingsSF ? ` − openings ${r1(w.openingsSF)} SF = ${r1(net)} SF` : ""}`,
  };
}

/** Baseboard along a wall: length minus door widths. */
export function baseboardLF(w: WallInfo): { lf: number; calc: string } {
  const lf = Math.max(0, w.lengthFt - w.doorsWidthFt);
  return { lf: r1(lf), calc: `${w.label} ${ft(w.lengthFt)}${w.doorsWidthFt ? ` − doors ${ft(w.doorsWidthFt)}` : ""} = ${r1(lf)} LF` };
}

/** Flood-cut strip along a wall at a given height, minus door widths. */
export function floodCutSF(w: WallInfo, cutIn: number): { sf: number; lf: number; calc: string } {
  const lf = Math.max(0, w.lengthFt - w.doorsWidthFt);
  const sf = lf * (cutIn / 12);
  return { sf: r1(sf), lf: r1(lf), calc: `${w.label} ${r1(lf)} LF × ${cutIn}" (${r1(cutIn / 12)} ft) = ${r1(sf)} SF` };
}
