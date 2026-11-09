/**
 * Review marks that more than one module has to agree on.
 *
 * Kept in its own file because `store.js` (map selection), `revisions.js`
 * (proposal state in the ETag) and `supersede-review.js` (the proposal record)
 * all need the values, and having any of them import another would create a
 * cycle.
 */
export const SUPERSEDE_PROPOSED = "supersede-proposed";
