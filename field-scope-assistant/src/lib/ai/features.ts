import { AnalysisOutput, CauseOfLossOutput, ChecklistOutput, ChecklistPhotoOutput, CorrectionOutput, ManualRulesOutput, PdfBatchOutput } from "./schemas";
import {
  CAUSE_OF_LOSS_SYSTEM,
  CHECKLIST_PHOTO_SYSTEM,
  CHECKLIST_SYSTEM,
  CORRECTION_SYSTEM,
  MANUAL_SYSTEM,
  PDF_SYSTEM,
  visitSystem,
} from "./prompts";
import { structured, type AiPart } from "./provider";
import type { VisitType } from "../schemas";
import type { z } from "zod";

/**
 * Every place the app uses AI, as one provider-agnostic interface. Each
 * feature is built once on `structured()`, so Claude and Gemini support all of
 * them identically; outputs are schema-validated and are suggestions for the
 * PM (deterministic guards run afterwards in the service layer).
 */
export interface AiFeatures {
  /** CompanyCam PDF batch: photos + captions + room labels per page. */
  analyzePdfBatch(input: { pdfBase64: string; promptText: string }): Promise<PdfBatchOutput>;
  /** Draft a visit's structured scope facts from notes, photo evidence and history. */
  draftVisitFacts(input: { visitType: VisitType; contextText: string }): Promise<AnalysisOutput>;
  /** Plain-language correction → targeted operations (or a clarifying question). */
  interpretCorrection(input: { contextText: string }): Promise<CorrectionOutput>;
  /** Fill a checklist template from what the record says. */
  fillChecklist(input: { contextText: string }): Promise<ChecklistOutputT>;
  /** Pull reusable company rules (and conflicts) from a manual. */
  extractManualRules(input: { promptText: string }): Promise<ManualRulesOutputT>;
  /** Read a photo of a paper checklist. */
  readChecklistPhoto(input: { image: Extract<AiPart, { type: "image" }>; templateText: string | null }): Promise<ChecklistPhotoOutput>;
  /** Analyze damage around a marked cause of loss (room record + photos). */
  analyzeCauseOfLoss(input: { roomText: string; images: Extract<AiPart, { type: "image" }>[] }): Promise<CauseOfLossOutput>;
}

type ChecklistOutputT = z.infer<typeof ChecklistOutput>;
type ManualRulesOutputT = z.infer<typeof ManualRulesOutput>;

export const ai: AiFeatures = {
  analyzePdfBatch: ({ pdfBase64, promptText }) =>
    structured({ schema: PdfBatchOutput, system: PDF_SYSTEM, parts: [{ type: "pdf", base64: pdfBase64 }, { type: "text", text: promptText }], effort: "medium", maxTokens: 32000 }),
  draftVisitFacts: ({ visitType, contextText }) =>
    structured({ schema: AnalysisOutput, system: visitSystem(visitType), parts: [{ type: "text", text: contextText }], effort: "high", maxTokens: 48000 }),
  interpretCorrection: ({ contextText }) =>
    structured({ schema: CorrectionOutput, system: CORRECTION_SYSTEM, parts: [{ type: "text", text: contextText }], effort: "medium", maxTokens: 16000 }),
  fillChecklist: ({ contextText }) =>
    structured({ schema: ChecklistOutput, system: CHECKLIST_SYSTEM, parts: [{ type: "text", text: contextText }], effort: "medium", maxTokens: 8000 }),
  extractManualRules: ({ promptText }) =>
    structured({ schema: ManualRulesOutput, system: MANUAL_SYSTEM, parts: [{ type: "text", text: promptText }], effort: "medium", maxTokens: 32000 }),
  readChecklistPhoto: ({ image, templateText }) =>
    structured({
      schema: ChecklistPhotoOutput,
      system: CHECKLIST_PHOTO_SYSTEM,
      parts: [image, { type: "text", text: templateText ? `<checklist_template>\n${templateText}\n</checklist_template>` : "No template given." }],
      effort: "medium",
      maxTokens: 8000,
    }),
  analyzeCauseOfLoss: ({ roomText, images }) =>
    structured({ schema: CauseOfLossOutput, system: CAUSE_OF_LOSS_SYSTEM, parts: [...images, { type: "text", text: `<room_record>\n${roomText}\n</room_record>` }], effort: "high", maxTokens: 12000 }),
};
