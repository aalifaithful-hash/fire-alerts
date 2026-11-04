import { rulesAnalyze } from "./rules";
import type { ReportFindings } from "./types";

/**
 * Mold-report analyzers behind one interface. Today only the rules analyzer runs (selectable PDF
 * text, no AI). A future AI analyzer (Anthropic or Gemini) can be added here to read free-form,
 * scanned or photo reports the rules can't — enabled only with the owner's approval and a key.
 * Nothing here loads an AI SDK or reads a key.
 */
export interface ReportInput {
  pages: string[]; // selectable text per page ([] for an image)
  contentType: string;
}

export interface ReportAnalyzer {
  id: "rules" | "ai";
  label: string;
  /** Whether this analyzer can read this input at all. */
  canRead(input: ReportInput): boolean;
  analyze(input: ReportInput): Promise<ReportFindings>;
}

export const rulesReportAnalyzer: ReportAnalyzer = {
  id: "rules",
  label: "Rules (selectable PDF text, no AI)",
  canRead: (i) => i.contentType === "application/pdf" && i.pages.join("").replace(/\s/g, "").length >= 40,
  analyze: async (i) => rulesAnalyze(i.pages),
};

export interface AiReportStatus {
  enabled: false;
  message: string;
}

/** The AI path is not wired up: no key, no SDK setup. Shown wherever the rules can't read a report. */
export function aiReportStatus(): AiReportStatus {
  return {
    enabled: false,
    message: "AI analysis not enabled. It would read scanned, photo or free-form reports the rules can't. It needs your approval and an AI key, and is off.",
  };
}

const ANALYZERS: ReportAnalyzer[] = [rulesReportAnalyzer];

/** Runs the first analyzer that can read the report; an unreadable report comes back with readable=false. */
export async function analyzeReport(input: ReportInput): Promise<ReportFindings> {
  const a = ANALYZERS.find((x) => x.canRead(input));
  if (a) return a.analyze(input);
  return { ...rulesAnalyze([]), readable: false };
}
