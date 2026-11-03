import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { AiError, parseStructured, type AiPart, type AiProvider, type StructuredRequest } from "./provider";

/** Anthropic Claude implementation (AI_PROVIDER=anthropic). */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;
  // 32 MB request limit; base64 adds ~33%.
  readonly maxInlineBytes = 18 * 1024 * 1024;
  private client = new Anthropic({ maxRetries: 2, timeout: 10 * 60 * 1000 });

  constructor(readonly model: string) {}

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
    try {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: req.maxTokens ?? 32000,
        // Refusal fallback: if the model declines, the API reruns on its recommended fallback.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        output_config: { effort: req.effort ?? "medium", format: zodOutputFormat(req.schema) },
        messages: [{ role: "user", content: req.parts.map(toBlock) }],
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") throw new AiError("The AI declined to process this request.", false);
      if (msg.stop_reason === "max_tokens") throw new AiError("The AI response was too long and was cut off. Try a smaller batch.", true);
      return parseStructured(req.schema, msg.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
    } catch (e) {
      if (e instanceof AiError) throw e;
      if (e instanceof Anthropic.AuthenticationError) throw new AiError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.", false);
      if (e instanceof Anthropic.PermissionDeniedError) throw new AiError("The API key does not have access to this model.", false);
      if (e instanceof Anthropic.NotFoundError) throw new AiError(`Model not found: ${this.model}. Check ANTHROPIC_MODEL.`, false);
      if (e instanceof Anthropic.BadRequestError) throw new AiError(`The AI request was rejected: ${e.message.slice(0, 300)}`, false);
      if (e instanceof Anthropic.RateLimitError) throw new AiError("Rate limited by the AI service. Retrying shortly usually works.", true);
      if (e instanceof Anthropic.InternalServerError) throw new AiError("The AI service had a temporary error.", true);
      if (e instanceof Anthropic.APIConnectionError) throw new AiError("Could not reach the AI service (network).", true);
      if (e instanceof Anthropic.APIError) throw new AiError(`AI service error (${e.status ?? "unknown"}).`, true);
      throw e;
    }
  }
}

type Block = Anthropic.Beta.Messages.BetaContentBlockParam;

/** Provider-neutral part → Claude content block. */
export function toBlock(p: AiPart): Block {
  if (p.type === "text") return { type: "text", text: p.text };
  if (p.type === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.base64 } };
  const media = p.mimeType === "image/heic" ? "image/jpeg" : p.mimeType; // Claude takes jpeg/png/gif/webp
  return { type: "image", source: { type: "base64", media_type: media, data: p.base64 } };
}
