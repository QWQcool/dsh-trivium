/**
 * Revision relations between decisions.
 *
 * A decision does not get "expired" when a newer one replaces it — it becomes
 * historical. That is a separate axis from `until`, so it gets its own edge
 * label and its own resolver instead of overloading `include_stale`.
 *
 * First version is a linear chain: one direct predecessor and one direct
 * successor per node, confirmed by a human in the management UI.
 */

import { REVISION_EDGES } from "./schema.js";

/** Hard cap on how far a chain walk may travel before refusing. */
export const REVISION_WALK_LIMIT = 32;

/** Reason text shown to the model when it tries to write a revision relation. */
export function refuseModelRevisionLabel(label) {
  const value = String(label || "");
  if (!REVISION_EDGES.includes(value)) return "";
  return `Refused: "${value}" is confirmed by the user in the dsh-trivium management UI, not by a tool call. Ask the user to link the two decisions there.`;
}
