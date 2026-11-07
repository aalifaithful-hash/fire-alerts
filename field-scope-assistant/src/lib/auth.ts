import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE = "fsa_session";

export function passcodeEnabled() {
  return !!process.env.APP_PASSCODE;
}

function token(): string {
  const secret = process.env.SESSION_SECRET || `fsa:${process.env.APP_PASSCODE ?? ""}`;
  return createHmac("sha256", secret).update("field-scope-assistant:v1").digest("hex");
}

export function checkPasscode(input: string): boolean {
  const want = Buffer.from(process.env.APP_PASSCODE ?? "");
  const got = Buffer.from(input ?? "");
  return want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
}

export function sessionToken() {
  return token();
}

export function isAuthedCookie(value: string | undefined): boolean {
  if (!passcodeEnabled()) return true;
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(token());
  return a.length === b.length && timingSafeEqual(a, b);
}
