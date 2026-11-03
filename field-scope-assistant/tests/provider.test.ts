import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@google/genai";
import { z } from "zod";
import { AiError, AiNotConfiguredError, aiAvailable, DEFAULT_MODELS, getProvider, providerConfig, setStructuredImpl } from "@/lib/ai/provider";
import { GeminiProvider, geminiSchema, toGeminiPart } from "@/lib/ai/gemini";
import { toBlock } from "@/lib/ai/anthropic";
import { ai } from "@/lib/ai/features";
import { PdfBatchOutput } from "@/lib/ai/schemas";

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

describe("provider selection (env only, off by default)", () => {
  it("defaults to none — AI off — even if a key happens to be present", () => {
    expect(providerConfig(env({}))).toMatchObject({ provider: "none", configured: false, problem: null });
    expect(providerConfig(env({ ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "y" }))).toMatchObject({ provider: "none", configured: false });
  });
  it("gemini: needs GEMINI_API_KEY; default model, overridable", () => {
    expect(providerConfig(env({ AI_PROVIDER: "gemini" }))).toMatchObject({ provider: "gemini", configured: false, problem: expect.stringMatching(/GEMINI_API_KEY/) });
    expect(providerConfig(env({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" }))).toMatchObject({ configured: true, model: DEFAULT_MODELS.gemini });
    expect(providerConfig(env({ AI_PROVIDER: "Gemini", GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-flash-latest" })).model).toBe("gemini-flash-latest");
  });
  it("anthropic: needs ANTHROPIC_API_KEY; default model, overridable", () => {
    expect(providerConfig(env({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }))).toMatchObject({ configured: true, model: "claude-opus-5-5" });
    expect(providerConfig(env({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-sonnet-5-5" })).model).toBe("claude-sonnet-5-5");
  });
  it("an unknown value is reported, not guessed", () => {
    expect(providerConfig(env({ AI_PROVIDER: "openai" }))).toMatchObject({ provider: "none", configured: false, problem: expect.stringMatching(/not recognized/) });
  });
  it("no-key mode: nothing is available and calls fail with a clear 'not configured'", async () => {
    const saved = { ...process.env };
    delete process.env.AI_PROVIDER;
    try {
      expect(aiAvailable()).toBe(false);
      await expect(getProvider()).rejects.toBeInstanceOf(AiNotConfiguredError);
    } finally {
      process.env = saved;
    }
  });
});

type GenParams = { model: string; contents: { role: string; parts: Record<string, unknown>[] }[]; config: Record<string, any> };
function fakeGemini(reply: (p: GenParams) => unknown) {
  const calls: GenParams[] = [];
  const client = {
    models: {
      generateContent: async (p: GenParams) => {
        calls.push(p);
        return reply(p);
      },
    },
  };
  return { calls, client: client as unknown as ConstructorParameters<typeof GeminiProvider>[1] };
}
const okText = (obj: unknown) => ({ text: JSON.stringify(obj), candidates: [{ finishReason: "STOP" }] });

describe("Gemini provider", () => {
  const S = z.object({ a: z.string(), b: z.number().nullable() });

  it("sends inline PDF/image parts, the system prompt, JSON schema and thinking level; validates the answer", async () => {
    const f = fakeGemini(() => okText({ a: "x", b: null }));
    const g = new GeminiProvider("gemini-3.8-flash", f.client);
    const out = await g.structured({
      schema: S,
      system: "SYS",
      parts: [{ type: "pdf", base64: "UERG" }, { type: "image", base64: "SU1H", mimeType: "image/jpeg" }, { type: "text", text: "hello" }],
      effort: "high",
      maxTokens: 1234,
    });
    expect(out).toEqual({ a: "x", b: null });
    const p = f.calls[0];
    expect(p.model).toBe("gemini-3.8-flash");
    expect(p.contents[0].parts).toEqual([
      { inlineData: { mimeType: "application/pdf", data: "UERG" } },
      { inlineData: { mimeType: "image/jpeg", data: "SU1H" } },
      { text: "hello" },
    ]);
    expect(p.config.systemInstruction).toBe("SYS");
    expect(p.config.responseMimeType).toBe("application/json");
    expect(p.config.maxOutputTokens).toBe(1234);
    expect(p.config.thinkingConfig.thinkingLevel).toBe("HIGH");
    const schema = p.config.responseJsonSchema as Record<string, any>;
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties.a.type).toBe("string");
    expect(JSON.stringify(schema)).not.toContain("additionalProperties");
  });

  it("maps finish reasons and API errors to the app's retryable/non-retryable errors", async () => {
    const run = async (reply: () => unknown) =>
      new GeminiProvider("m", fakeGemini(reply).client).structured({ schema: S, system: "s", parts: [{ type: "text", text: "t" }] }).catch((e) => e);
    const cut = await run(() => ({ text: "{", candidates: [{ finishReason: "MAX_TOKENS" }] }));
    expect(cut).toBeInstanceOf(AiError);
    expect(cut.retryable).toBe(true);
    const blocked = await run(() => ({ text: "", candidates: [{ finishReason: "SAFETY" }] }));
    expect(blocked.retryable).toBe(false);
    const bad = await run(() => okText({ a: 1 }));
    expect(bad.message).toMatch(/did not match/);
    const limited = await run(() => {
      throw new ApiError({ message: "quota", status: 429 });
    });
    expect([limited.retryable, /quota/i.test(limited.message)]).toEqual([true, true]);
    const auth = await run(() => {
      throw new ApiError({ message: "bad key", status: 403 });
    });
    expect(auth.message).toMatch(/GEMINI_API_KEY/);
  });

  it("the real app schemas convert to a Gemini response schema", () => {
    const s = geminiSchema(PdfBatchOutput) as Record<string, any>;
    expect(s.type).toBe("object");
    expect(s.properties.pages.type).toBe("array");
    expect(toGeminiPart({ type: "text", text: "x" })).toEqual({ text: "x" });
  });
});

describe("Claude provider part mapping", () => {
  it("maps neutral parts to Claude blocks", () => {
    expect(toBlock({ type: "pdf", base64: "UERG" })).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" } });
    expect(toBlock({ type: "image", base64: "SU1H", mimeType: "image/png" })).toMatchObject({ type: "image", source: { media_type: "image/png" } });
  });
});

describe("every AI feature runs through the one provider interface", () => {
  afterEach(() => setStructuredImpl(null));
  it("PDF analysis, checklist photo and cause-of-loss send the right parts and schemas", async () => {
    const seen: { system: string; parts: { type: string }[] }[] = [];
    setStructuredImpl((async (req: { system: string; parts: { type: string }[]; schema: z.ZodType }) => {
      seen.push(req);
      return req.schema.parse(
        req.schema === PdfBatchOutput
          ? { pages: [] }
          : req.system.includes("photo of a paper checklist")
            ? { readable: true, issue: null, title: null, items: [] }
            : { visibleFindings: [], suggestedAffected: { flooring: null, walls: [], ceiling: null, cabinets: null, contents: null }, migrationPath: null, questions: [], cannotDetermine: [] },
      );
    }) as never);
    await ai.analyzePdfBatch({ pdfBase64: "UERG", promptText: "pages 1–4" });
    await ai.readChecklistPhoto({ image: { type: "image", base64: "SU1H", mimeType: "image/jpeg" }, templateText: "c1: Photos uploaded" });
    await ai.analyzeCauseOfLoss({ roomText: "Kitchen, source under sink", images: [{ type: "image", base64: "SU1H", mimeType: "image/jpeg" }] });
    expect(seen.map((r) => r.parts.map((p) => p.type))).toEqual([["pdf", "text"], ["image", "text"], ["image", "text"]]);
    expect(Object.keys(ai).sort()).toEqual(
      ["analyzeCauseOfLoss", "analyzePdfBatch", "draftVisitFacts", "extractManualRules", "fillChecklist", "interpretCorrection", "readChecklistPhoto"].sort(),
    );
  });
});
