/**
 * Compatibility entry point. The AI layer is provider-pluggable — see
 * ./provider.ts (selection + interface), ./anthropic.ts, ./gemini.ts and
 * ./features.ts (every AI feature).
 */
export { AiError, AiNotConfiguredError, aiAvailable, providerConfig, setStructuredImpl, structured } from "./provider";
export type { AiPart, StructuredRequest } from "./provider";
import { providerConfig } from "./provider";

/** AI is on only when AI_PROVIDER names a provider and its key is set. */
export function aiConfigured(): boolean {
  return providerConfig().configured;
}
