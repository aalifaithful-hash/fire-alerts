import { ApiError, GoogleGenAI, ThinkingLevel, type Part } from "@google/genai";
import { z } from "zod";
import { AiError, parseStructured, type AiPart, type AiProvider, type Effort, type StructuredRequest } from "./provider";

/**
 * Google Gemini implementation (AI_PROVIDER=gemini), via the official
 * Google Gen AI SDK. Same contract as the Claude path: a JSON-schema-constrained
 * response (responseJsonSchema from the Zod schema), validated again with Zod.
 * PDFs and photos are sent inline (Gemini reads PDF text and page images).
 */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini" as const;
  // Inline request limit is ~20 MB total; base64 adds ~33%, so keep raw payloads ≤ 14 MB.
  readonly maxInlineBytes = 14 * 1024 * 1024;
  private client: Pick<GoogleGenAI, "models">;

  constructor(
    readonly model: string,
    client?: Pick<GoogleGenAI, "models">, // injectable for tests
  ) {
    this.client = client ?? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
    try {
      const res = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: req.parts.map(toGeminiPart) }],
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: geminiSchema(req.schema),
          maxOutputTokens: req.maxTokens ?? 32000,
          thinkingConfig: { thinkingLevel: thinkingLevel(req.effort) },
        },
      });
      const cand = res.candidates?.[0];
      const finish = String(cand?.finishReason ?? "");
      if (res.promptFeedback?.blockReason || finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST")
        throw new AiError("The AI declined to process this request.", false);
      if (finish === "MAX_TOKENS") throw new AiError("The AI response was too long and was cut off. Try a smaller batch.", true);
      return parseStructured(req.schema, res.text);
    } catch (e) {
      if (e instanceof AiError) throw e;
      if (e instanceof ApiError) {
        const s = e.status;
        if (s === 400) throw new AiError(`The AI request was rejected: ${e.message.slice(0, 300)}`, false);
        if (s === 401 || s === 403) throw new AiError("The Gemini API key was rejected or lacks access. Check GEMINI_API_KEY.", false);
        if (s === 404) throw new AiError(`Model not found: ${this.model}. Check GEMINI_MODEL.`, false);
        if (s === 429) throw new AiError("Rate limited by the AI service (Gemini quota). Retrying shortly usually works.", true);
        if (s >= 500) throw new AiError("The AI service had a temporary error.", true);
        throw new AiError(`AI service error (${s}).`, true);
      }
      if (e instanceof TypeError || (e instanceof Error && /fetch|network|ECONN|ETIMEDOUT/i.test(e.message)))
        throw new AiError("Could not reach the AI service (network).", true);
      throw e;
    }
  }
}

/** Provider-neutral part → Gemini part. */
export function toGeminiPart(p: AiPart): Part {
  if (p.type === "text") return { text: p.text };
  if (p.type === "pdf") return { inlineData: { mimeType: "application/pdf", data: p.base64 } };
  return { inlineData: { mimeType: p.mimeType, data: p.base64 } };
}

function thinkingLevel(e: Effort | undefined): ThinkingLevel {
  return e === "high" ? ThinkingLevel.HIGH : e === "low" ? ThinkingLevel.LOW : ThinkingLevel.MEDIUM;
}

/** Zod → JSON Schema for responseJsonSchema (drops keys Gemini doesn't use). */
export function geminiSchema(schema: z.ZodType): unknown {
  const js = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "$schema" || k === "additionalProperties") continue;
        o[k] = strip(val);
      }
      return o;
    }
    return v;
  };
  return strip(js);
}
