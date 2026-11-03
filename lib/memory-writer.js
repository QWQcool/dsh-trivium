/**
 * B4: the memory write port.
 *
 * Extraction used to call `insertNode` / `mergeInto` / `ensureLink` /
 * `updateNode` straight on the workspace database. That is fine while the
 * writer is the process holding the `.tdb`, and wrong the moment one process
 * (a router) owns the store and another (a worker) decides what to write.
 *
 * The port is deliberately narrow: it is exactly the four mutations the
 * extraction pipeline performs, no reads and no store internals. Callers pass a
 * writer (or nothing, which means "the local database in this process"); a
 * future router-backed writer has to implement the same four methods and the
 * pipeline does not change.
 *
 * Throwing is part of the contract: `merge` refuses a node inside a revision
 * chain with REVISION_PROTECTED, and the caller relies on that refusal.
 */

import { ensureLink, insertNode, mergeInto, updateNode } from "./store.js";

/** The four operations a writer must provide. Kept as data for tests/tools. */
export const MEMORY_WRITER_METHODS = Object.freeze(["insert", "merge", "link", "update"]);

/**
 * In-process writer: delegates to the workspace store.
 * @param db - an open workspace database
 */
export function localMemoryWriter(db) {
  if (!db) throw new Error("localMemoryWriter needs an open database");
  return {
    kind: "local",
    insert: (payload) => insertNode(db, payload),
    merge: (id, payload) => mergeInto(db, id, payload),
    link: (from, to, label) => ensureLink(db, from, to, label),
    update: (id, patch) => updateNode(db, id, patch),
  };
}

/** Resolve the writer a caller gave us, defaulting to the local database. */
export function memoryWriterFor(db, writer) {
  if (writer) {
    for (const method of MEMORY_WRITER_METHODS) {
      if (typeof writer[method] !== "function") {
        const err = new Error(`memory writer is missing ${method}()`);
        err.code = "WRITER_INCOMPLETE";
        throw err;
      }
    }
    return writer;
  }
  return localMemoryWriter(db);
}
