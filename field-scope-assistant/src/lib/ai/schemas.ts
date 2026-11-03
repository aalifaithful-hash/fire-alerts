import { z } from "zod";
import {
  CATEGORIES,
  CHECKLIST_STATUSES,
  EQUIPMENT_STATUSES,
  EQUIPMENT_TYPES,
  ITEM_STATUSES,
  SOURCE_STATUSES,
} from "../schemas";
import { CorrectionOp } from "../patch";

// Structured-output schemas. Nullable (not optional) everywhere so the JSON schema
// stays simple; every value is validated again server-side.

export const PdfPhoto = z.object({
  index: z.number().int().describe("1-based position of the photo on its page, reading order"),
  caption: z.string().nullable().describe("Caption/description text exactly as printed for THIS photo"),
  captionSource: z.enum(["pdf_text", "ocr", "none"]),
  floor: z.string().nullable(),
  unit: z.string().nullable(),
  room: z.string().nullable(),
  locationBasis: z.enum(["caption", "page_heading", "tag", "visual", "none"]),
  locationConfidence: z.enum(["high", "medium", "low"]),
  materials: z.array(z.string()).describe("Materials visible, e.g. 'drywall', 'hardwood flooring', 'plaster ceiling'"),
  visibleConditions: z.array(z.string()).describe("Only what is visible: staining, standing water, debris, visible growth, equipment in place"),
  captionStatements: z.array(z.string()).describe("Claims made by the caption text itself, kept separate from what is visible"),
  flags: z.array(z.string()).describe("Problems: blurry, caption may belong to another photo, conflicting labels, etc."),
});

export const PdfBatchOutput = z.object({
  pages: z.array(
    z.object({
      page: z.number().int().describe("ORIGINAL page number in the full report"),
      readable: z.boolean(),
      issue: z.string().nullable(),
      photos: z.array(PdfPhoto),
    }),
  ),
});
export type PdfBatchOutput = z.infer<typeof PdfBatchOutput>;

const Loc = {
  locationId: z.string().nullable().describe("Existing room id when the room is already known, else null"),
  floor: z.string().nullable(),
  unit: z.string().nullable(),
  room: z.string().nullable().describe("null = project-wide"),
};

export const AnalysisItem = z.object({
  ...Loc,
  existingItemId: z.string().nullable().describe("Id of the current-record item this continues, else null"),
  category: z.enum(CATEGORIES),
  text: z.string().describe("Concise professional scope bullet. No 'based on the photos'."),
  status: z.enum(ITEM_STATUSES),
  source: z.enum(["pm", "photo", "caption", "prior_visit"]),
  evidenceIds: z.array(z.string()),
  carriedForward: z.boolean(),
  carriedFromVisitId: z.string().nullable(),
  quantity: z.string().nullable().describe("Only a quantity/dimension the PM supplied, verbatim"),
});

export const AnalysisEquipment = z.object({
  ...Loc,
  existingEquipmentId: z.string().nullable(),
  type: z.enum(EQUIPMENT_TYPES),
  label: z.string().nullable(),
  quantity: z.number().int().nullable().describe("Only a count the PM stated; else null"),
  status: z.enum(EQUIPMENT_STATUSES),
  statusDate: z.string().nullable(),
  source: z.enum(["pm", "photo", "caption", "prior_visit"]),
  carriedForward: z.boolean(),
});

export const AnalysisOutput = z.object({
  jobInfo: z.object({
    causeOfLoss: z.string().nullable(),
    sourceStatus: z.enum(SOURCE_STATUSES).nullable(),
    lossType: z.string().nullable(),
    category: z.string().nullable(),
    waterClass: z.string().nullable(),
    productionDays: z.string().nullable(),
    equipmentDays: z.string().nullable(),
    accessRestrictions: z.string().nullable(),
  }),
  dryingOnly: z.boolean(),
  carryForwardConfirmed: z.boolean(),
  items: z.array(AnalysisItem),
  equipment: z.array(AnalysisEquipment),
  questions: z.array(z.object({ text: z.string(), reason: z.string().nullable(), locationId: z.string().nullable() })),
  recommendations: z.array(
    z.object({ ...Loc, category: z.enum(CATEGORIES), text: z.string(), rationale: z.string().nullable() }),
  ),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;

export const CorrectionOutput = z.object({
  intent: z.enum(["apply", "clarify", "show_full"]),
  clarification: z.string().nullable(),
  ops: z.array(CorrectionOp),
});
export type CorrectionOutput = z.infer<typeof CorrectionOutput>;

export const ChecklistOutput = z.object({
  entries: z.array(
    z.object({
      itemId: z.string(),
      status: z.enum(CHECKLIST_STATUSES),
      note: z.string().nullable(),
      evidenceQuote: z.string().nullable().describe("Exact words from the PM's notes that confirm completion"),
    }),
  ),
});

export const ManualRulesOutput = z.object({
  rules: z.array(z.object({ topic: z.string(), rule: z.string() })),
  conflicts: z.array(
    z.object({
      description: z.string(),
      conflictingRuleIds: z.array(z.string()).describe("ids of EXISTING rules from other manuals this conflicts with"),
    }),
  ),
});

/** Reading a photo of a paper checklist (items and what is marked on the page). */
export const ChecklistPhotoOutput = z.object({
  readable: z.boolean(),
  issue: z.string().nullable(),
  title: z.string().nullable(),
  items: z.array(
    z.object({
      label: z.string().describe("Checklist line exactly as printed"),
      mark: z.enum(["checked", "unchecked", "na_marked", "unclear"]).describe("What is visibly marked on the paper — not what you think should be true"),
      handwrittenNote: z.string().nullable(),
      matchedTemplateItemId: z.string().nullable().describe("id of the matching template item, if a template was given"),
    }),
  ),
});
export type ChecklistPhotoOutput = z.infer<typeof ChecklistPhotoOutput>;

/** Damage analysis around a marked cause of loss (suggestions for the PM, never accepted automatically). */
export const CauseOfLossOutput = z.object({
  visibleFindings: z.array(z.object({ text: z.string(), photoIndex: z.number().int().nullable() })),
  suggestedAffected: z.object({
    flooring: z.boolean().nullable(),
    walls: z.array(z.string()).describe("Wall labels N/E/S/W that look affected; empty if unclear"),
    ceiling: z.boolean().nullable(),
    cabinets: z.boolean().nullable(),
    contents: z.boolean().nullable(),
  }),
  migrationPath: z.string().nullable().describe("Likely path of water/smoke from the source, as a hypothesis"),
  questions: z.array(z.string()).describe("Short questions whose answers change the scope; max 5"),
  cannotDetermine: z.array(z.string()).describe("Things photos cannot establish (moisture content, category, hidden damage)"),
});
export type CauseOfLossOutput = z.infer<typeof CauseOfLossOutput>;
