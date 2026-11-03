import { route } from "@/lib/http";
import { DEFAULT_RULES, RULE_SECTION_LABELS } from "@/lib/defaults";
import { getRulesState } from "@/lib/intake";

export const GET = route(async () => ({ ...(await getRulesState()), defaults: DEFAULT_RULES, labels: RULE_SECTION_LABELS }));
