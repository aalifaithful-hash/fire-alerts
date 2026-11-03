import { z } from "zod";
import {
  CATEGORIES,
  EQUIPMENT_STATUSES,
  EQUIPMENT_TYPES,
  ITEM_STATUSES,
  SOURCE_STATUSES,
  type Location,
  type VisitFacts,
} from "./schemas";
import { fullLabel, resolveLocation } from "./locations";
import { newId } from "./ids";
import { equipmentName } from "./guards";

/**
 * A correction is a list of targeted operations. Applying ops can only touch
 * what they name — every other room, item and equipment entry is carried over
 * unchanged, which is how "never drop other rooms" is guaranteed.
 *
 * The flat shape (one object with nullable fields) is deliberate: it keeps the
 * structured-output schema simple and every op is validated again here.
 */
export const OP_KINDS = [
  "update_item",
  "remove_item",
  "add_item",
  "update_equipment",
  "remove_equipment",
  "add_equipment",
  "move_location", // "That is the closet, not the bedroom": move a room's items
  "rename_location",
  "set_job_info",
  "set_directive",
  "answer_question",
  "set_visit_field",
] as const;

export const CorrectionOp = z.object({
  op: z.enum(OP_KINDS),
  targetId: z.string().nullable(), // item / equipment / location / question id
  floor: z.string().nullable(),
  unit: z.string().nullable(),
  room: z.string().nullable(),
  category: z.enum(CATEGORIES).nullable(),
  text: z.string().nullable(),
  status: z.enum(ITEM_STATUSES).nullable(),
  quantityText: z.string().nullable(),
  equipmentType: z.enum(EQUIPMENT_TYPES).nullable(),
  equipmentQuantity: z.number().int().nullable(),
  equipmentStatus: z.enum(EQUIPMENT_STATUSES).nullable(),
  statusDate: z.string().nullable(),
  field: z.string().nullable(),
  value: z.string().nullable(),
});
export type CorrectionOp = z.infer<typeof CorrectionOp>;

export function blankOp(op: CorrectionOp["op"], over: Partial<CorrectionOp> = {}): CorrectionOp {
  return {
    op,
    targetId: null,
    floor: null,
    unit: null,
    room: null,
    category: null,
    text: null,
    status: null,
    quantityText: null,
    equipmentType: null,
    equipmentQuantity: null,
    equipmentStatus: null,
    statusDate: null,
    field: null,
    value: null,
    ...over,
  };
}

const JOB_FIELDS = [
  "causeOfLoss",
  "sourceStatus",
  "lossType",
  "category",
  "waterClass",
  "crewRaw",
  "productionDays",
  "equipmentDays",
  "accessRestrictions",
] as const;
export const VISIT_FIELDS = ["appointmentTime", "arrivalTime", "departureTime", "accessOutcome", "visitDate"] as const;

export interface PatchResult {
  facts: VisitFacts;
  locations: Location[]; // full list incl. any newly created
  createdLocations: Location[];
  renamedLocations: Location[];
  visitFieldUpdates: Partial<Record<(typeof VISIT_FIELDS)[number], string | null>>;
  changes: string[];
  rejected: string[];
  clarification: string | null;
}

export function applyOps(
  input: VisitFacts,
  ops: CorrectionOp[],
  locationsIn: Location[],
  projectId: string,
): PatchResult {
  const facts: VisitFacts = structuredClone(input);
  const locations = [...locationsIn];
  const created: Location[] = [];
  const renamed: Location[] = [];
  const changes: string[] = [];
  const rejected: string[] = [];
  const visitFieldUpdates: PatchResult["visitFieldUpdates"] = {};
  const label = (id: string | null) => {
    const l = locations.find((x) => x.id === id);
    return l ? fullLabel(l) : "Project-wide";
  };

  // Resolve every location reference first. Any ambiguity stops the whole correction:
  // a short clarification is better than editing the wrong room.
  const resolved = new Map<number, string | null>();
  for (const [i, op] of ops.entries()) {
    const needsLoc = ["add_item", "add_equipment", "move_location"].includes(op.op) || (op.room && op.op !== "rename_location");
    if (!needsLoc) continue;
    if (!op.room) {
      resolved.set(i, null);
      continue;
    }
    const r = resolveLocation({ floor: op.floor, unit: op.unit, room: op.room }, locations);
    if (r.kind === "ambiguous") {
      return {
        facts: input,
        locations: locationsIn,
        createdLocations: [],
        renamedLocations: [],
        visitFieldUpdates: {},
        changes: [],
        rejected: [],
        clarification: `Which ${op.room}? ${r.candidates.map((c) => fullLabel(c)).join(" or ")}.`,
      };
    }
    if (r.kind === "existing") resolved.set(i, r.location.id);
    else if (r.kind === "new") {
      const loc: Location = {
        id: newId("loc"),
        projectId,
        floor: r.floor,
        unit: r.unit,
        room: r.room,
        sort: locations.length,
      };
      locations.push(loc);
      created.push(loc);
      resolved.set(i, loc.id);
    } else resolved.set(i, null);
  }

  for (const [i, op] of ops.entries()) {
    switch (op.op) {
      case "update_item": {
        const item = facts.items.find((x) => x.id === op.targetId);
        if (!item) {
          rejected.push(`Item not found: ${op.targetId}`);
          break;
        }
        const before = item.text;
        if (op.text) item.text = op.text;
        if (op.status) item.status = op.status;
        if (op.category) item.category = op.category;
        if (op.quantityText !== null) item.quantity = op.quantityText || null;
        if (resolved.has(i)) item.locationId = resolved.get(i) ?? item.locationId;
        item.source = "pm";
        item.carriedForward = false;
        item.needsLocation = item.locationId ? false : item.needsLocation;
        item.flags = [];
        changes.push(`${label(item.locationId)}: "${before}" → "${item.text}"${op.status ? ` (${op.status})` : ""}`);
        break;
      }
      case "remove_item": {
        const idx = facts.items.findIndex((x) => x.id === op.targetId);
        if (idx < 0) {
          rejected.push(`Item not found: ${op.targetId}`);
          break;
        }
        const [it] = facts.items.splice(idx, 1);
        changes.push(`${label(it.locationId)}: removed "${it.text}"`);
        break;
      }
      case "add_item": {
        if (!op.text || !op.category) {
          rejected.push("Add item missing text or category");
          break;
        }
        const locationId = resolved.get(i) ?? null;
        facts.items.push({
          id: newId("it"),
          locationId,
          needsLocation: false,
          category: op.category,
          text: op.text,
          status: op.status ?? "reported",
          source: "pm",
          evidenceIds: [],
          carriedForward: false,
          carriedFromVisitId: null,
          quantity: op.quantityText || null,
          flags: [],
        });
        changes.push(`${label(locationId)}: added "${op.text}"`);
        break;
      }
      case "update_equipment": {
        const e = facts.equipment.find((x) => x.id === op.targetId);
        if (!e) {
          rejected.push(`Equipment not found: ${op.targetId}`);
          break;
        }
        const was = `${e.quantity ?? "?"} ${equipmentName(e, e.quantity)} (${e.status})`;
        if (op.equipmentQuantity !== null) e.quantity = op.equipmentQuantity;
        if (op.equipmentStatus) e.status = op.equipmentStatus;
        if (op.statusDate !== null) e.statusDate = op.statusDate;
        if (op.equipmentType) e.type = op.equipmentType;
        if (resolved.has(i)) e.locationId = resolved.get(i) ?? e.locationId;
        e.source = "pm";
        e.carriedForward = false;
        e.flags = [];
        changes.push(
          `${label(e.locationId)}: equipment ${was} → ${e.quantity ?? "?"} ${equipmentName(e, e.quantity)} (${e.status}${e.statusDate ? ` ${e.statusDate}` : ""})`,
        );
        break;
      }
      case "remove_equipment": {
        const idx = facts.equipment.findIndex((x) => x.id === op.targetId);
        if (idx < 0) {
          rejected.push(`Equipment not found: ${op.targetId}`);
          break;
        }
        const [e] = facts.equipment.splice(idx, 1);
        changes.push(`${label(e.locationId)}: removed equipment entry ${equipmentName(e)}`);
        break;
      }
      case "add_equipment": {
        if (!op.equipmentType) {
          rejected.push("Add equipment missing type");
          break;
        }
        const locationId = resolved.get(i) ?? null;
        const e = {
          id: newId("eq"),
          locationId,
          type: op.equipmentType,
          label: op.text,
          quantity: op.equipmentQuantity,
          status: op.equipmentStatus ?? "planned",
          statusDate: op.statusDate,
          source: "pm" as const,
          carriedForward: false,
          flags: [],
        };
        facts.equipment.push(e);
        changes.push(`${label(locationId)}: added ${e.quantity ?? "?"} ${equipmentName(e, e.quantity)} (${e.status})`);
        break;
      }
      case "move_location": {
        const from = op.targetId;
        const to = resolved.get(i);
        if (!from || !to || !locations.some((l) => l.id === from)) {
          rejected.push("Move needs a source room and a destination room");
          break;
        }
        let n = 0;
        for (const it of facts.items)
          if (it.locationId === from) {
            it.locationId = to;
            n++;
          }
        for (const e of facts.equipment)
          if (e.locationId === from) {
            e.locationId = to;
            n++;
          }
        changes.push(`Moved ${n} entr${n === 1 ? "y" : "ies"} from ${label(from)} to ${label(to)}`);
        break;
      }
      case "rename_location": {
        const loc = locations.find((l) => l.id === op.targetId);
        if (!loc) {
          rejected.push(`Room not found: ${op.targetId}`);
          break;
        }
        const was = fullLabel(loc);
        const next = { ...loc, floor: op.floor ?? loc.floor, unit: op.unit ?? loc.unit, room: op.room ?? loc.room };
        locations.splice(locations.indexOf(loc), 1, next);
        renamed.push(next);
        changes.push(`Renamed ${was} → ${fullLabel(next)}`);
        break;
      }
      case "set_job_info": {
        const f = op.field as (typeof JOB_FIELDS)[number];
        if (!JOB_FIELDS.includes(f)) {
          rejected.push(`Unknown job field: ${op.field}`);
          break;
        }
        if (f === "sourceStatus") {
          const v = (op.value ?? "").toLowerCase() as (typeof SOURCE_STATUSES)[number];
          if (!SOURCE_STATUSES.includes(v)) {
            rejected.push(`Invalid source status: ${op.value}`);
            break;
          }
          facts.jobInfo.sourceStatus = v;
        } else {
          (facts.jobInfo as Record<string, unknown>)[f] = op.value || null;
        }
        changes.push(`Job info: ${f} = ${op.value ?? "(cleared)"}`);
        break;
      }
      case "set_directive": {
        if (op.field === "dryingOnly") facts.directives.dryingOnly = op.value === "true";
        else if (op.field === "carryForwardConfirmed") facts.directives.carryForwardConfirmed = op.value === "true";
        else {
          rejected.push(`Unknown directive: ${op.field}`);
          break;
        }
        changes.push(`Directive: ${op.field} = ${op.value}`);
        break;
      }
      case "answer_question": {
        const q = facts.questions.find((x) => x.id === op.targetId);
        if (!q) {
          rejected.push(`Question not found: ${op.targetId}`);
          break;
        }
        q.status = "answered";
        q.answer = op.value ?? op.text ?? "";
        changes.push(`Answered: ${q.text}`);
        break;
      }
      case "set_visit_field": {
        const f = op.field as (typeof VISIT_FIELDS)[number];
        if (!VISIT_FIELDS.includes(f)) {
          rejected.push(`Unknown visit field: ${op.field}`);
          break;
        }
        visitFieldUpdates[f] = op.value || null;
        changes.push(`Visit: ${f} = ${op.value ?? "(cleared)"}`);
        break;
      }
    }
  }

  return {
    facts,
    locations,
    createdLocations: created,
    renamedLocations: renamed,
    visitFieldUpdates,
    changes,
    rejected,
    clarification: null,
  };
}
