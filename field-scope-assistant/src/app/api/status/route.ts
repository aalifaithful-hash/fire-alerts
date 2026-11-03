import { route } from "@/lib/http";
import { aiConfigured, MODEL } from "@/lib/ai/client";
import { passcodeEnabled } from "@/lib/auth";
import { blobEnabled } from "@/lib/storage";
import { connectionString } from "@/lib/db";

export const GET = route(async () => ({
  aiConfigured: aiConfigured(),
  model: MODEL,
  passcodeEnabled: passcodeEnabled(),
  blobUploads: blobEnabled(),
  databaseConfigured: !!connectionString(),
}));
