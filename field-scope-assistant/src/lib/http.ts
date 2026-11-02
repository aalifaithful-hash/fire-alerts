import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { COOKIE, isAuthedCookie } from "./auth";
import { NotFound } from "./repo";
import { UserError } from "./service";
import { AiError, AiNotConfiguredError } from "./ai/client";

type Ctx<P> = { params: Promise<P> };

/**
 * Wraps a route handler: passcode check, JSON errors, no-store caching.
 * Errors are logged by type/message only — never request bodies or document text.
 */
export function route<P = Record<string, never>>(fn: (req: NextRequest, params: P) => Promise<Response | unknown>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    if (!isAuthedCookie(req.cookies.get(COOKIE)?.value)) return json({ error: "Passcode required" }, 401);
    try {
      const params = (await ctx.params) as P;
      const out = await fn(req, params);
      if (out instanceof Response) return out;
      return json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(e: unknown) {
  if (e instanceof NotFound) return json({ error: e.message }, 404);
  if (e instanceof UserError) return json({ error: e.message }, 400);
  if (e instanceof ZodError) return json({ error: "Invalid input" }, 400);
  if (e instanceof AiNotConfiguredError) return json({ error: e.message, code: "NO_API_KEY" }, 503);
  if (e instanceof AiError) return json({ error: e.message, retryable: e.retryable }, 502);
  console.error("[field-scope] unexpected error:", e instanceof Error ? `${e.name}: ${e.message}` : "unknown");
  return json({ error: "Something went wrong. Please try again." }, 500);
}

export async function body<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new UserError("Invalid request body");
  }
}
