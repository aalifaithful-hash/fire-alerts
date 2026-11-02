import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

export function aiConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the server.");
  }
}

export class AiError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

export type ContentBlock = Anthropic.Beta.Messages.BetaContentBlockParam;

export interface StructuredRequest<S extends z.ZodType> {
  schema: S;
  system: string;
  content: ContentBlock[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

type Impl = <S extends z.ZodType>(req: StructuredRequest<S>) => Promise<z.infer<S>>;

let client: Anthropic | null = null;
function getClient() {
  if (!aiConfigured()) throw new AiNotConfiguredError();
  client ??= new Anthropic({ maxRetries: 2, timeout: 10 * 60 * 1000 });
  return client;
}

/**
 * One structured call. The response is constrained to the JSON schema derived from
 * the Zod schema and then validated again with Zod before anything uses it.
 */
const realImpl: Impl = async (req) => {
  const anthropic = getClient();
  try {
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: req.maxTokens ?? 32000,
      // Refusal fallback: if the model declines, the API reruns on its recommended fallback.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      output_config: { effort: req.effort ?? "medium", format: zodOutputFormat(req.schema) },
      messages: [{ role: "user", content: req.content }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new AiError("The AI declined to process this request.", false);
    if (msg.stop_reason === "max_tokens") throw new AiError("The AI response was too long and was cut off. Try a smaller batch.", true);
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiError("The AI returned malformed output.", true);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) throw new AiError("The AI output did not match the expected structure.", true);
    return parsed.data;
  } catch (e) {
    if (e instanceof AiError || e instanceof AiNotConfiguredError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new AiError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.", false);
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError("The API key does not have access to this model.", false);
    if (e instanceof Anthropic.NotFoundError) throw new AiError(`Model not found: ${MODEL}. Check ANTHROPIC_MODEL.`, false);
    if (e instanceof Anthropic.BadRequestError) throw new AiError(`The AI request was rejected: ${e.message.slice(0, 300)}`, false);
    if (e instanceof Anthropic.RateLimitError) throw new AiError("Rate limited by the AI service. Retrying shortly usually works.", true);
    if (e instanceof Anthropic.InternalServerError) throw new AiError("The AI service had a temporary error.", true);
    if (e instanceof Anthropic.APIConnectionError) throw new AiError("Could not reach the AI service (network).", true);
    if (e instanceof Anthropic.APIError) throw new AiError(`AI service error (${e.status ?? "unknown"}).`, true);
    throw e;
  }
};

let impl: Impl = realImpl;

export function structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
  return impl(req);
}

/** Tests replace the model call with a deterministic fake. */
export function setStructuredImpl(fake: Impl | null) {
  impl = fake ?? realImpl;
}
