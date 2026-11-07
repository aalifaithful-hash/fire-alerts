// Unauthenticated liveness check for the host (returns no project data).
export function GET() {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
