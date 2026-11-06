/**
 * Review marks that more than one module has to agree on.
 *
 * Kept in its own file because `store.js` (map selection) and
 * `supersede-review.js` (the proposal record) both need the value, and having
 * either import the other would create a cycle.
 */
export const SUPERSEDE_PROPOSED = "supersede-proposed";
