import { NextResponse, type NextRequest } from "next/server";
import { checkPasscode, COOKIE, sessionToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { passcode } = (await req.json().catch(() => ({}))) as { passcode?: string };
  if (!checkPasscode(passcode ?? "")) return NextResponse.json({ error: "Wrong passcode" }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, sessionToken(), {
    httpOnly: true,
    sameSite: "strict",
    secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE);
  return res;
}
