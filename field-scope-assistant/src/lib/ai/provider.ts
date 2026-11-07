import type { z } from "zod";

/**
 * Pluggable AI provider (server-side only).
 *
 * The app talks to AI through ONE provider-neutral interface:
 * - `AiProvider.structured()` — one multimodal request (text, PDF and image
 *   parts) whose answer must match a Zod schema. Both implementations constrain
 *   the response to the JSON schema derived from the Zod schema, then validate
 *   it again with Zod before anything uses it.
 * - `lib/ai/features.ts` builds every AI feature (PDF photo analysis, scope
 *   drafting, corrections, checklists, manual rules, checklist photos,
 *   cause-of-loss analysis) on top of `structured()`, so every feature works
 *   with every provider.
 *
 * Selection is by environment variable only — no code change to switch:
 *   AI_PROVIDER = none (default) | anthropic | gemini
 *   ANTHROPIC_API_KEY (+ optional ANTHROPIC_MODEL), or GEMINI_API_KEY (+ optional GEMINI_MODEL)
 * With AI_PROVIDER unset or "none", AI stays off and the app runs in no-key mode.
 */

export type AiPart =
  | { type: "text"; text: string }
  | { type: "pdf"; base64: string } // a PDF (or a chunk of one); providers read text + page images
  | { type: "image"; base64: string; mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/heic" };

export type Effort = "low" | "medium" | "high";

export interface StructuredRequest<S extends z.ZodType> {
  schema: S;
  system: string;
  parts: AiPart[];
  /** How hard the model should think. Mapped to each provider's own control. */
  effort?: Effort;
  maxTokens?: number;
}

export interface AiProvider {
  name: ProviderName;
  model: string;
  /** Largest raw (pre-base64) inline PDF/image payload this provider accepts in one request. */
  maxInlineBytes: number;
  structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>>;
}

export const PROVIDER_NAMES = ["none", "anthropic", "gemini"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const DEFAULT_MODELS = {
  anthropic: "claude-opus-5-5",
  gemini: "gemini-3.8-flash",
} as const;

export class AiNotConfiguredError extends Error {
  constructor(detail?: string) {
    super(detail ?? "AI is off: set AI_PROVIDER (anthropic or gemini) and that provider's API key on the server, then redeploy.");
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

/** Which provider the environment selects, and whether it can run. */
export function providerConfig(env: NodeJS.ProcessEnv = process.env): {
  provider: ProviderName;
  model: string | null;
  configured: boolean;
  problem: string | null;
} {
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  const provider: ProviderName = (PROVIDER_NAMES as readonly string[]).includes(raw) ? (raw as ProviderName) : "none";
  if (raw && provider === "none" && raw !== "none")
    return { provider: "none", model: null, configured: false, problem: `AI_PROVIDER="${raw}" is not recognized (use anthropic, gemini or none).` };
  if (provider === "none") return { provider, model: null, configured: false, problem: null };
  if (provider === "anthropic") {
    const model = env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODELS.anthropic;
    const hasKey = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    return { provider, model, configured: hasKey, problem: hasKey ? null : "AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set." };
  }
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_MODELS.gemini;
  const hasKey = !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
  return { provider, model, configured: hasKey, problem: hasKey ? null : "AI_PROVIDER=gemini but GEMINI_API_KEY is not set." };
}

// ---------------- registry ----------------

type Impl = <S extends z.ZodType>(req: StructuredRequest<S>) => Promise<z.infer<S>>;
let override: Impl | null = null;
const cache = new Map<string, AiProvider>();

/** The active provider. Throws AiNotConfiguredError when AI is off or the key is missing. */
export async function getProvider(): Promise<AiProvider> {
  const cfg = providerConfig();
  if (cfg.provider === "none" || !cfg.configured || !cfg.model) throw new AiNotConfiguredError(cfg.problem ?? undefined);
  const key = `${cfg.provider}:${cfg.model}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // Loaded lazily so the unused provider's SDK is never initialized.
  const p =
    cfg.provider === "anthropic"
      ? new (await import("./anthropic")).AnthropicProvider(cfg.model)
      : new (await import("./gemini")).GeminiProvider(cfg.model);
  cache.set(key, p);
  return p;
}

/** One structured call through the active provider (or the test double). */
export async function structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
  if (override) return override(req);
  return (await getProvider()).structured(req);
}

export async function maxInlineBytes(): Promise<number> {
  if (override) return 18 * 1024 * 1024;
  return (await getProvider()).maxInlineBytes;
}

/** True when AI calls can run (provider + key configured, or a test double installed). */
export function aiAvailable(): boolean {
  return !!override || providerConfig().configured;
}

/** Tests replace the model call with a deterministic fake. */
export function setStructuredImpl(fake: Impl | null) {
  override = fake;
}

// ---------------- shared helpers for implementations ----------------

/** Parse + validate a model's JSON text against the schema. */
export function parseStructured<S extends z.ZodType>(schema: S, text: string | undefined | null): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(text ?? "");
  } catch {
    throw new AiError("The AI returned malformed output.", true);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new AiError("The AI output did not match the expected structure.", true);
  return parsed.data;
}
