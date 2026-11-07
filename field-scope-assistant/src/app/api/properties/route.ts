import { route } from "@/lib/http";
import { listProperties } from "@/lib/intake";

export const GET = route(async (req) => ({ properties: await listProperties(req.nextUrl.searchParams.get("q") ?? undefined) }));
