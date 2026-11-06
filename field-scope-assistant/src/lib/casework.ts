import type { Rules } from "./defaults";
import { BASE_BOXES, CABINET_BOXES, CASEWORK_ACTION_LABELS, CASEWORK_LABELS, type CaseworkItem, type CaseworkKind, type ScopeLine } from "./scan";

/**
 * Cabinets, countertops and what goes with them (rules only). Every quantity comes from what the PM
 * entered, a company default named in the math (countertop depth, toe kick = base LF), or stays blank
 * with a question — never guessed. Replacement / reset lines are reconstruction (pending unless a
 * reconstruction estimate is requested).
 */

type Draft = Omit<ScopeLine, "status" | "rate" | "total" | "evidence" | "flags" | "source" | "duration"> & { flags?: string[]; evidence?: string[]; duration?: ScopeLine["duration"] };
type Action = NonNullable<CaseworkItem["action"]>;
const OUT: Action[] = ["detach_reset", "remove_replace", "remove_dispose"];
const STONE = /granite|quartz|marble|stone/i;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface CaseworkCtx {
  rules: Rules;
  room: string;
  water: boolean;
  mold: boolean;
  category: "1" | "2" | "3" | null;
  /** Walls with drywall / flood-cut work in this room (paint behind cabinets only where wall work was done for base cabinets). */
  wallsWorked: string[];
  isKitchenOrBath: boolean;
  add: (d: Draft) => void;
  question: (q: string) => void;
  note: (n: string) => void;
  paintWall: (wall: string, why: string) => void;
  /** Values a mold report set on this scan (`casework.<kind>` → "Affected — <action>"), to say where a decision came from. */
  reportValues?: Record<string, string>;
  /** Where an item's decision came from, for questions: the report quote (with page) when the report set it. */
  sourceOf?: (kind: CaseworkKind) => string | null;
}

const isBox = (k: CaseworkKind) => CABINET_BOXES.includes(k);
const isBase = (k: CaseworkKind) => BASE_BOXES.includes(k);
const label = (it: CaseworkItem) => `${CASEWORK_LABELS[it.kind].replace(/ \(.*\)$/, "").toLowerCase()}${it.section ? ` — ${it.section}` : it.extent === "partial" ? " (partial run)" : ""}`;

export function caseworkLines(items: CaseworkItem[], contents: "none" | "manipulate" | "clean_onsite" | "packout" | null, c: CaseworkCtx) {
  const R = c.rules.casework;
  const seen = new Map<string, number>();
  const idOf = (k: string) => {
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `cw.${k}${n ? `.${n + 1}` : ""}`;
  };
  const affected = items.filter((i) => i.affected);
  const sumLF = (ks: CaseworkKind[], acts?: Action[]) => {
    const xs = affected.filter((i) => ks.includes(i.kind) && (!acts || (i.action && acts.includes(i.action))));
    if (!xs.length) return { lf: null as number | null, calc: "", missing: [] as string[] };
    const missing = xs.filter((i) => i.lf == null).map(label);
    const lf = missing.length ? null : r1(xs.reduce((a, i) => a + (i.lf ?? 0), 0));
    return { lf, calc: xs.map((i) => `${label(i)} ${i.lf ?? "?"} LF`).join(" + ") + (lf != null && xs.length > 1 ? ` = ${lf} LF` : ""), missing };
  };
  const wetFlag = c.water || c.mold ? [`${c.mold ? "Mold" : "Water"} can be behind or under cabinets — not assumed clean; inspect before deciding.`] : [];

  // ---- the items themselves ----
  const qtyOf = (it: CaseworkItem): { q: number | null; unit: string; calc: string; extra?: string } => {
    if (it.kind === "countertop" || it.kind === "vanity_top") {
      const def = it.kind === "countertop" ? R.countertopDepthIn : R.vanityTopDepthIn;
      const depth = it.depthIn ?? def;
      const src = it.depthIn != null ? `${depth}" depth` : `${depth}" depth (company default — edit if different)`;
      if (it.lf == null) return { q: null, unit: "SF", calc: `length not measured — ${src}` };
      const sf = r1((it.lf * depth) / 12);
      return { q: sf, unit: "SF", calc: `${it.lf} LF × ${src} (${r2(depth / 12)} ft) = ${sf} SF`, extra: `${it.lf} LF / ${sf} SF` };
    }
    if (it.kind === "backsplash") {
      if (it.lf == null || it.depthIn == null) return { q: null, unit: "SF", calc: `${it.lf == null ? "length" : ""}${it.lf == null && it.depthIn == null ? " and " : ""}${it.depthIn == null ? "height" : ""} not measured — no quantity${it.depthIn == null ? ' (no default height: a 4" splash and full-height tile differ too much to guess)' : ""}` };
      const sf = r1((it.lf * it.depthIn) / 12);
      return { q: sf, unit: "SF", calc: `${it.lf} LF × ${it.depthIn}" high (${r2(it.depthIn / 12)} ft) = ${sf} SF` };
    }
    if (it.kind === "doors_drawers" || it.kind === "hardware") return it.count == null ? { q: null, unit: "EA", calc: "not counted — count them" } : { q: it.count, unit: "EA", calc: `${it.count} counted` };
    if (it.kind === "toe_kick" && it.lf == null && R.toeKickEqualsBaseLF) {
      const b = sumLF(BASE_BOXES);
      return b.lf == null ? { q: null, unit: "LF", calc: "base cabinet LF not measured" } : { q: b.lf, unit: "LF", calc: `= base cabinet LF (company default): ${b.calc}` };
    }
    if (it.kind === "interior" && it.lf == null) {
      const b = sumLF(CABINET_BOXES);
      return b.lf == null ? { q: null, unit: "LF", calc: "cabinet LF not measured" } : { q: b.lf, unit: "LF", calc: `= affected cabinet LF: ${b.calc}` };
    }
    return it.lf == null ? { q: null, unit: "LF", calc: "length not measured — measure along the wall (LF)" } : { q: it.lf, unit: "LF", calc: `${it.lf} LF${it.section ? ` (${it.section})` : ""} measured along the wall` };
  };

  const emit = (it: CaseworkItem, action: Action | null, why: string, extraFlags: string[] = []) => {
    const id = idOf(it.kind);
    const { q, unit, calc, extra } = qtyOf(it);
    const name = `${label(it)}${it.material ? ` (${it.material})` : ""}${extra ? ` — ${extra}` : ""}`;
    const flags = [...extraFlags, ...(isBase(it.kind) || it.kind === "toe_kick" || (c.mold && isBox(it.kind)) ? wetFlag : [])];
    if ((it.kind === "countertop" || it.kind === "vanity_top" || it.kind === "backsplash") && !it.material) flags.push("Material not selected — pick it (not guessed).");
    if (R.stoneTopWarning && STONE.test(it.material ?? "") && action === "detach_reset") flags.push("Stone top: detach & reset risks breakage — confirm, or plan remove & replace.");
    if (it.kind === "backsplash" && /tile/i.test(it.material ?? "") && action === "detach_reset") flags.push("Tile backsplash can't usually be reset — plan remove & replace.");
    const base = { ruleId: `casework.${it.kind}`, unit, calc };
    // countertops / vanity tops: detach, reset, remove, dispose and inspect in LF (length handled);
    // clean, refinish and the NEW top in SF (LF × depth) — both shown, never one unit only
    const top = it.kind === "countertop" || it.kind === "vanity_top";
    const lfCalc = it.lf != null ? `${it.lf} LF measured along the wall${q != null ? ` (top area: ${calc})` : ""}` : "length not measured — measure along the wall (LF)";
    const add = (d: Draft) => c.add(top && !/\.(replace|refinish)$/.test(d.id) && d.scopeCategory !== "cleaning" ? { ...d, quantity: it.lf, unit: "LF", calc: lfCalc } : d);
    if (!action) {
      if (c.water || c.mold) {
        add({ ...base, id: `${id}.inspect`, kind: "mitigation", scopeCategory: "cavity_access", activity: "Inspect", item: `behind/under the ${name} — remove the toe kick, open inspection cuts in the back/bottom`, quantity: q, justification: `${c.mold ? "Mold" : "Water"} in the room: cabinets are checked, not assumed clean.`, flags });
        if (c.mold && isBox(it.kind)) add({ ...base, id: `${id}.mold`, kind: "mitigation", scopeCategory: "removal", activity: "Remove & dispose", item: `${name} with growth (if found)`, quantity: q, justification: "Porous cabinet boxes with growth are removed, not cleaned (S520) — accept only if growth is confirmed.", flags });
      }
      c.question(`${c.room}: ${CASEWORK_LABELS[it.kind]} — clean, detach & reset, remove & replace, remove & dispose${isBox(it.kind) || it.kind === "doors_drawers" ? ", or sand & refinish" : ""}?`);
      return;
    }
    const verb = c.mold ? "Clean & treat (HEPA vacuum, damp-wipe, antimicrobial)" : c.water && (c.category === "2" || c.category === "3") ? "Clean & disinfect" : "Clean";
    if (action === "clean") add({ ...base, id, kind: "mitigation", scopeCategory: "cleaning", activity: verb, item: name, quantity: q, justification: why, flags });
    if (action === "detach_reset") {
      add({ ...base, id: `${id}.detach`, kind: "mitigation", scopeCategory: "detach_reset", activity: "Detach", item: name, quantity: q, justification: why, flags });
      add({ ...base, id: `${id}.reset`, kind: "reconstruction", scopeCategory: "detach_reset", activity: it.kind === "upper" ? "Re-hang & reset" : "Reset & reattach", item: name, quantity: q, justification: "Goes back after drying/remediation (same quantity).", flags: [] });
    }
    if (action === "remove_replace") {
      add({ ...base, id: `${id}.remove`, kind: "mitigation", scopeCategory: "removal", activity: "Remove", item: name, quantity: q, justification: why, flags });
      add({ ...base, id: `${id}.replace`, kind: "reconstruction", scopeCategory: "replacement", activity: "Replace", item: name, quantity: q, justification: "Replaces what was removed (same quantity).", flags: [] });
    }
    if (action === "remove_dispose") add({ ...base, id: `${id}.dispose`, kind: "mitigation", scopeCategory: "removal", activity: "Remove & dispose", item: name, quantity: q, justification: why, flags: [...flags, "Not replaced in this scope (PM decision) — add a replacement line if needed."] });
    if (action === "sand_refinish") add({ ...base, id: `${id}.refinish`, kind: "reconstruction", scopeCategory: "finish", activity: "Sand & refinish", item: name, quantity: q, justification: why, flags: [] });
  };

  // ---- what goes with it (decided first: a top on base cabinets that come out follows them) ----
  const baseOut = affected.filter((i) => isBase(i.kind) && i.action && OUT.includes(i.action));
  const isTop = (k: CaseworkKind) => k === "countertop" || k === "vanity_top";
  const underTop = (topKind: CaseworkKind, xs: CaseworkItem[]) => xs.filter((b) => isBase(b.kind) && (topKind === "vanity_top" ? b.kind === "vanity" : b.kind !== "vanity"));
  // the cabinet runs under one top disagree (e.g. sink base disposed, lowers detached & reset): the top's action is a PM question
  const mixedUnder = (topKind: CaseworkKind) =>
    R.countertopGoesWithBase && underTop(topKind, baseOut).length > 0 && new Set(underTop(topKind, affected.filter((i) => i.action)).map((i) => i.action)).size > 1;
  const heldTop = (it: CaseworkItem) => isTop(it.kind) && (!it.action || !OUT.includes(it.action)) && mixedUnder(it.kind);
  const topFollows = (it: CaseworkItem) =>
    !heldTop(it) && R.countertopGoesWithBase && (it.kind === "countertop" || it.kind === "vanity_top") && (!it.action || !OUT.includes(it.action)) && baseOut.some((b) => (it.kind === "vanity_top" ? b.kind === "vanity" : b.kind !== "vanity"));
  const topsOut = () => items.some((i) => (i.kind === "countertop" || i.kind === "vanity_top") && ((i.affected && i.action && OUT.includes(i.action)) || topFollows(i)));
  const backsplashFollows = (it: CaseworkItem) => it.kind === "backsplash" && (!it.affected || !it.action) && topsOut();

  for (const it of affected) if (!topFollows(it) && !heldTop(it) && !backsplashFollows(it)) emit(it, it.action, it.action ? `${CASEWORK_LABELS[it.kind]}: ${CASEWORK_ACTION_LABELS[it.action].toLowerCase()} (${c.reportValues?.[`casework.${it.kind}`] === `Affected — ${CASEWORK_ACTION_LABELS[it.action].toLowerCase()}` ? "as the mold report states" : "PM decision"}).` : "");

  const strongest = (xs: CaseworkItem[]): Action | null => (xs.some((x) => x.action === "remove_replace") ? "remove_replace" : xs.some((x) => x.action === "remove_dispose") ? "remove_dispose" : xs.length ? "detach_reset" : null);

  // countertop on base cabinets that come out — never left floating
  const topKinds: CaseworkKind[] = ["countertop", "vanity_top"];
  for (const topKind of topKinds) {
    const under = baseOut.filter((b) => (topKind === "vanity_top" ? b.kind === "vanity" : b.kind !== "vanity"));
    if (!under.length || !R.countertopGoesWithBase) continue;
    const tops = items.filter((i) => i.kind === topKind);
    if (mixedUnder(topKind)) {
      if (tops.length && tops.every((t) => t.affected && t.action && OUT.includes(t.action))) continue; // the PM already chose
      const runs = underTop(topKind, affected.filter((i) => i.action)).map((b) => {
        const src = c.sourceOf?.(b.kind);
        return `${label(b)}${b.lf != null ? ` ${b.lf} LF` : ""}: ${CASEWORK_ACTION_LABELS[b.action!].toLowerCase()} (${src ?? "PM entry"})`;
      });
      const what = topKind === "vanity_top" ? "vanity top" : "countertop";
      c.question(`${c.room}: ${what} — the cabinet runs under it have different actions (${runs.join("; ")}). Detach & reset, remove & replace, or remove & dispose the ${what}? Not picked — no ${what} line until you choose its action.`);
      continue;
    }
    const act = strongest(under)!;
    const why = `The ${topKind === "vanity_top" ? "vanity top" : "countertop"} sits on base cabinets that are ${act.replace(/_/g, " ")} — it can't stay in place.`;
    if (!tops.length) {
      const b = sumLF(under.map((u) => u.kind));
      const implied: CaseworkItem = { kind: topKind, affected: true, action: act, extent: null, section: null, wall: null, lf: b.lf, depthIn: null, count: null, material: null };
      emit(implied, act, why, ["Length taken from the base cabinets below — measure if the top overhangs or turns a corner."]);
    } else
      for (const t of tops.filter((x) => !x.affected || !x.action || !OUT.includes(x.action))) emit({ ...t, affected: true }, act, why);
  }
  // toe kick under base cabinets that come out
  if (baseOut.length && !items.some((i) => i.kind === "toe_kick")) {
    const act = strongest(baseOut)!;
    if (act !== "remove_dispose") {
      const b = sumLF(baseOut.map((x) => x.kind));
      c.add({ id: "cw.toe_kick.with_base", ruleId: "casework.toeKick", kind: "reconstruction", scopeCategory: act === "remove_replace" ? "replacement" : "detach_reset", activity: act === "remove_replace" ? "Replace" : "Reinstall", item: "toe kick", quantity: b.lf, unit: "LF", calc: b.lf != null ? `= base cabinet LF: ${b.calc}` : "base cabinet LF not measured", justification: "Goes with the base cabinets (same LF)." });
    }
  }
  // base cabinets left in place in a wet / moldy room: toe kick off for drying / inspection
  const baseStaying = affected.filter((i) => isBase(i.kind) && (i.action === "clean" || i.action === "sand_refinish"));
  if ((c.water || c.mold) && baseStaying.length && !items.some((i) => i.kind === "toe_kick")) {
    const b = sumLF(baseStaying.map((x) => x.kind));
    c.add({ id: "cw.toe_kick.drying", ruleId: "casework.toeKick", kind: "mitigation", scopeCategory: "cavity_access", activity: "Remove", item: "toe kick for drying / inspection access", quantity: b.lf, unit: "LF", calc: b.lf != null ? `= base cabinet LF: ${b.calc}` : "base cabinet LF not measured", justification: "Reach the cavity under base cabinets that stay in place." });
    c.add({ id: "cw.toe_kick.drying.reinstall", ruleId: "casework.toeKick", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Reinstall", item: "toe kick (replace if damaged)", quantity: b.lf, unit: "LF", calc: b.lf != null ? `= base cabinet LF: ${b.calc}` : "base cabinet LF not measured", justification: "Goes back on (same LF)." });
  }
  // sink / faucet / disposal
  const topOut = topsOut() || baseOut.length > 0;
  const sinkBases = affected.filter((i) => i.kind === "sink_base" && i.action && OUT.includes(i.action));
  const vanityOut = affected.filter((i) => i.kind === "vanity" && i.action && OUT.includes(i.action));
  if (R.plumbingResetWithSink) {
    const sinks = sinkBases.length + vanityOut.length;
    if (sinks) {
      const what = vanityOut.length && !sinkBases.length ? "lavatory sink & faucet" : "sink, faucet & disposal";
      c.add({ id: "cw.plumbing.disconnect", ruleId: "casework.plumbing", kind: "mitigation", scopeCategory: "detach_reset", activity: "Disconnect", item: what, quantity: sinks, unit: "EA", calc: `1 per sink base / vanity coming out (${sinks})`, justification: "The sink cabinet comes out." });
      c.add({ id: "cw.plumbing.reconnect", ruleId: "casework.plumbing", kind: "reconstruction", scopeCategory: "detach_reset", activity: "Reconnect", item: what, quantity: sinks, unit: "EA", calc: `1 per sink base / vanity (${sinks})`, justification: "Goes with the cabinet / countertop reset." });
    } else if (topOut && c.isKitchenOrBath) c.question(`${c.room}: is there a sink in the countertop that comes off? (sink, faucet & disposal disconnect / reconnect)`);
  }
  // backsplash where it meets a countertop that comes off
  if (topOut && !items.some((i) => i.kind === "backsplash")) c.question(`${c.room}: backsplash where it meets the countertop — affected? It comes off with the countertop (measure LF × height).`);
  for (const bs of items.filter((i) => i.kind === "backsplash" && (!i.affected || !i.action) && topOut))
    emit({ ...bs, affected: true }, "remove_replace", "Backsplash meets a countertop that comes off.");
  // a countertop coming off: check the cabinets below
  if (topOut && !affected.some((i) => isBase(i.kind))) c.question(`${c.room}: the countertop comes off — check the base cabinets below it (add them if affected).`);
  // the wall behind cabinets that come out
  for (const it of affected.filter((i) => isBox(i.kind) && i.action && OUT.includes(i.action))) {
    if (!R.fullWallPaintBehindCabinets) break;
    if (it.kind === "upper" || c.wallsWorked.includes(it.wall ?? "")) {
      if (it.wall) c.paintWall(it.wall, `${label(it)} ${it.action!.replace(/_/g, " ")} — wall behind`);
      else c.question(`${c.room}: which wall are the ${label(it)} on? The wall behind them is sealed/primed & painted in wall SF (not cabinet LF).`);
    } else if (!it.wall) c.note(`${label(it)}: check the wall behind once they're out — add wall work (drywall / paint in wall SF) if needed.`);
  }
  // contents inside cabinets that come out
  const boxesOut = affected.filter((i) => isBox(i.kind) && i.action && OUT.includes(i.action));
  if (boxesOut.length) {
    if (contents == null) c.question(`${c.room}: contents inside the cabinets — move them, clean on site or pack out?`);
    else if (contents !== "none") {
      const what = contents === "manipulate" ? ["Empty & move", "contents of the cabinets (to reach / detach them)"] : contents === "clean_onsite" ? ["Clean on site", "contents of the cabinets"] : ["Pack out", "contents of the cabinets (inventory + photos)"];
      c.add({ id: `contents.cabinets.${contents === "manipulate" ? "manip" : contents === "clean_onsite" ? "clean" : "packout"}`, ruleId: "casework.contents", kind: "contents", scopeCategory: "contents", activity: what[0], item: what[1], quantity: 1, unit: "EA", calc: "1 room's cabinet contents (itemize on inventory)", justification: "The cabinets come out, so their contents are handled first." });
    }
  }
  // what to measure
  for (const it of affected) if ((isBox(it.kind) || it.kind === "countertop" || it.kind === "vanity_top") && it.lf == null) c.question(`${c.room}: measure the ${label(it)} (LF along the wall).`);
}
