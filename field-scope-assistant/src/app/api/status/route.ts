import { route } from "@/lib/http";
import { providerConfig } from "@/lib/ai/provider";
import { passcodeEnabled } from "@/lib/auth";
import { blobEnabled } from "@/lib/storage";
import { connectionString } from "@/lib/db";

export const GET = route(async () => ({
  aiConfigured: providerConfig().configured,
  aiProvider: providerConfig().provider,
  model: providerConfig().model,
  aiProblem: providerConfig().problem,
  passcodeEnabled: passcodeEnabled(),
  blobUploads: blobEnabled(),
  databaseConfigured: !!connectionString(),
}));
