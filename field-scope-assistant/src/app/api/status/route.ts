import { route } from "@/lib/http";
import { aiConfigured, MODEL } from "@/lib/ai/client";
import { passcodeEnabled } from "@/lib/auth";

export const GET = route(async () => ({ aiConfigured: aiConfigured(), model: MODEL, passcodeEnabled: passcodeEnabled() }));
