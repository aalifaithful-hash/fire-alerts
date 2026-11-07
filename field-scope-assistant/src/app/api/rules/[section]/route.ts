import { body, route } from "@/lib/http";
import { getRulesState, IntakeError, resetRulesSection, saveRulesSection } from "@/lib/intake";
import type { RulesSection } from "@/lib/defaults";
import { UserError } from "@/lib/service";

type P = { section: string };
export const PUT = route<P>(async (req, { section }) => {
  const { value } = await body<{ value: unknown }>(req);
  try {
    await saveRulesSection(section as RulesSection, value);
  } catch (e) {
    if (e instanceof IntakeError) throw new UserError(e.message);
    throw e;
  }
  return getRulesState();
});
export const DELETE = route<P>(async (_req, { section }) => {
  await resetRulesSection(section as RulesSection);
  return getRulesState();
});
