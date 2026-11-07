import { body, route } from "@/lib/http";
import { getProperty, listAssignments, updateProperty } from "@/lib/intake";

type P = { prid: string };
export const GET = route<P>(async (_req, { prid }) => ({
  property: await getProperty(prid),
  assignments: (await listAssignments({ propertyId: prid })).map((a) => ({ ...a, rawText: undefined })),
}));
export const PATCH = route<P>(async (req, { prid }) => ({
  property: await updateProperty(prid, await body<{ yearBuilt?: number | null; multiUnit?: boolean; adjacentChecks?: Record<string, string>; notes?: string }>(req)),
}));
