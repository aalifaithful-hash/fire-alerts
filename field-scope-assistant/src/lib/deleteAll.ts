import * as repo from "./repo";
import { unlinkAssignmentsFromProject } from "./intake";
import { UserError } from "./service";

/** The exact phrase the confirm button sends; any other request deletes nothing. */
export const DELETE_ALL_CONFIRM = "DELETE ALL PROJECTS";

/**
 * Deletes every project — the projects the PM saw in the confirmation panel, and only those.
 * Each one goes through the same repo.deleteProject() the per-project "Delete project and files"
 * control uses (project row with its visits, rooms, documents, evidence and scans; drafts; batches;
 * stored files). If the list changed since the panel opened, nothing is deleted.
 */
export async function deleteAllProjects(input: { confirm?: unknown; ids?: unknown }): Promise<{ deleted: number; unlinkedAssignments: number }> {
  if (input.confirm !== DELETE_ALL_CONFIRM) throw new UserError("Not confirmed — nothing was deleted.");
  const seen = Array.isArray(input.ids) ? input.ids.map(String) : null;
  if (!seen) throw new UserError("Not confirmed — nothing was deleted.");
  const current = (await repo.listProjects()).map((p) => p.id);
  const same = seen.length === current.length && [...seen].sort().join("|") === [...current].sort().join("|");
  if (!same) throw new UserError(`The project list changed (${current.length} now, ${seen.length} shown) — nothing was deleted. Reload and try again.`);
  let unlinkedAssignments = 0;
  for (const id of current) {
    // FNOL assignments stay in the inbox: unlink them first (back to "new"), then delete the project
    unlinkedAssignments += await unlinkAssignmentsFromProject(id, "Project deleted (Delete All Projects)");
    await repo.deleteProject(id);
  }
  return { deleted: current.length, unlinkedAssignments };
}
