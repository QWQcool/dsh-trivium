import { DIM } from "./schema.js";

const dimensions = new WeakMap();

export function validateDatabaseDimension(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8192) {
    throw Object.assign(new Error("Database dimension must be an integer from 1 to 8192."), {
      code: "DB_DIMENSION_INVALID",
    });
  }
  return value;
}

/** Dimensions are immutable on an open native handle. Never cache by path. */
export function databaseDimension(db) {
  if (dimensions.has(db)) return dimensions.get(db);
  const dim = validateDatabaseDimension(db.dim());
  dimensions.set(db, dim);
  return dim;
}

export function zeroVectorFor(dbOrDim) {
  const dim = typeof dbOrDim === "number" ? validateDatabaseDimension(dbOrDim) : databaseDimension(dbOrDim);
  return new Array(dim).fill(0);
}

/**
 * SDK 0.9.3 has no pre-open inspect API; omitting dim defaults to 1536.
 * On the one documented recoverable mismatch, let a second native read-only
 * open verify the reported width and the rest of the file group. Never infer
 * from localized messages, retry another error, or create a missing store.
 */
export function openExistingDatabaseReadOnly(Engine, path, options = {}) {
  const dim = validateDatabaseDimension(options.dim ?? DIM);
  const open = candidate => new Engine(path, {
    ...options, dim: candidate, autoBuildQuiver: false, accessMode: "readOnly",
  });
  let db;
  let wanted = dim;
  try {
    try {
      db = open(dim);
    } catch (error) {
      const expected = error?.details?.expected;
      if (error?.code !== "TDB_DIMENSION_MISMATCH" || error.details?.got !== dim
          || expected === dim || !Number.isSafeInteger(expected) || expected < 1 || expected > 8192) throw error;
      wanted = expected;
      db = open(expected);
    }
    if (databaseDimension(db) !== wanted) {
      throw Object.assign(new Error("The native handle does not report the verified database dimension."), {
        code: "DB_DIMENSION_INVALID",
      });
    }
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* Preserve the original error. */ }
    throw error;
  }
}
