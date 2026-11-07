import { body, route } from "@/lib/http";
import { quickStart, type QuickStartInput } from "@/lib/quickstart";

// One tap: property + assignment + project + visit + first room scan from the PM's notes.
export const POST = route(async (req) => quickStart(await body<QuickStartInput>(req)));
