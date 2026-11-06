import { body, route } from "@/lib/http";
import { deleteAllProjects } from "@/lib/deleteAll";

// Second, explicit step of "Delete All Projects": only this POST, with the confirmation phrase and the
// exact project ids shown in the in-page panel, deletes anything. No GET handler — loading never deletes.
export const POST = route(async (req) => deleteAllProjects(await body(req)));
