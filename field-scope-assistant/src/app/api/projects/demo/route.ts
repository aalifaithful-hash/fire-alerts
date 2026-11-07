import { route } from "@/lib/http";
import { createDemoProject } from "@/lib/service";

export const POST = route(async () => ({ project: await createDemoProject() }));
