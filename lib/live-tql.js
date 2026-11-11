/** Free-form read TQL on the writer's existing handle; transport owns scheduling. */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);

export const LIVE_TQL_REQUEST_BYTES = 16 * 1024;
export const LIVE_TQL_RESPONSE_BYTES = 512 * 1024;
export const LIVE_TQL_DEFAULT_LIMIT = 200;
export const LIVE_TQL_MAX_LIMIT = 1000;
export const LIVE_TQL_DEFAULT_TIMEOUT_MS = 25;
export const LIVE_TQL_MAX_TIMEOUT_MS = 50;
// Leave room for our response envelope. This limits native JSON encoding, not
// the query's intermediate work or the number of rows it may materialise.
const NATIVE_RESPONSE_BYTES = 500000;
const NATIVE_WORKING_ROWS = 1000;
const MAX_NATIVE_ATTEMPTS = 6;

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function invalid(message) {
  throw fail(400, "LIVE_TQL_INVALID_INPUT", message);
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validate(body) {
  if (!record(body)) invalid("The query body must be an object.");
  for (const key of Reflect.ownKeys(body)) {
    if (!["tql", "params", "limit", "timeoutMs"].includes(key)) invalid("Unknown live TQL request field.");
  }
  if (typeof body.tql !== "string" || !body.tql.trim()) invalid("tql must be a non-empty string.");
  const limit = Object.hasOwn(body, "limit") ? body.limit : LIVE_TQL_DEFAULT_LIMIT;
  const timeoutMs = Object.hasOwn(body, "timeoutMs") ? body.timeoutMs : LIVE_TQL_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIVE_TQL_MAX_LIMIT) {
    invalid(`limit must be an integer from 1 to ${LIVE_TQL_MAX_LIMIT}.`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIVE_TQL_MAX_TIMEOUT_MS) {
    invalid(`timeoutMs must be an integer from 1 to ${LIVE_TQL_MAX_TIMEOUT_MS}.`);
  }
  const params = Object.hasOwn(body, "params") ? body.params : {};
  if (!record(params)) invalid("params must be a JSON object.");
  // The 0.9.0 Prepared binding accepts scalar values only. Checking those
  // directly also rejects non-finite numbers, cycles and non-JSON values.
  for (const key of Reflect.ownKeys(params)) {
    if (typeof key !== "string") invalid("params must use string keys.");
    const value = params[key];
    if (value !== null && !["string", "boolean"].includes(typeof value)
        && !(typeof value === "number" && Number.isFinite(value))) {
      invalid("params values must be null, boolean, string or finite number.");
    }
  }
  let encoded;
  try { encoded = JSON.stringify(body); }
  catch { invalid("The request must contain serializable JSON values."); }
  if (Buffer.byteLength(encoded, "utf8") > LIVE_TQL_REQUEST_BYTES) {
    throw fail(413, "LIVE_TQL_REQUEST_TOO_LARGE", "The live TQL request exceeds 16 KiB.");
  }
  return { tql: body.tql, params, limit, timeoutMs };
}

function nativeFailure(error) {
  if (Number.isInteger(error?.status) && String(error.code || "").startsWith("LIVE_TQL_")) return error;
  const code = error?.code;
  const statuses = {
    TDB_QUERY_PARSE: 400,
    TDB_INVALID_INPUT: 400,
    TDB_READ_ONLY: 403,
    TDB_QUERY_CANCELLED: 408,
    TDB_QUERY_BUDGET: 422,
    TDB_TRAVERSAL_BUDGET_EXCEEDED: 422,
    TDB_PAYLOAD_BUDGET_EXCEEDED: 422,
    TDB_CONSOLE_RESPONSE_TOO_LARGE: 413,
    TDB_DATABASE_CLOSED: 409,
    TDB_SHUTDOWN: 409,
    TDB_CONSOLE_SESSION_CLOSED: 409,
    QueueFull: 429,
  };
  if (Object.hasOwn(statuses, code)) {
    return fail(statuses[code], code, String(error.message || code).slice(0, 500));
  }
  if (code === "TDB_IO" && error?.details?.io_kind === "WouldBlock") {
    return fail(429, "TDB_IO", "The host database is busy; retry the read later.");
  }
  return fail(500, "LIVE_TQL_FAILED", "The native live query could not be completed.");
}

function standardRead(tql) {
  let start = 0;
  while (start < tql.length) {
    if (/\s/.test(tql[start])) { start++; continue; }
    if (tql.startsWith("--", start)) {
      const end = tql.indexOf("\n", start + 2);
      if (end < 0) return false;
      start = end + 1;
      continue;
    }
    break;
  }
  // This is only an eligibility gate, not a parser. Both the original and the
  // candidate must pass the 0.9.0 native parser below. Plan requests stay intact.
  return /^(MATCH|OPTIONAL|FIND|SEARCH|TEXT)\b/i.test(tql.slice(start));
}

function cappedQuery(db, tql, limit, checkCompletion) {
  // Validate the original first: completing an invalid query is never allowed.
  db.prepareTql(tql);
  checkCompletion();
  if (!standardRead(tql)) return { query: tql, optimized: false };
  const candidate = `${tql}\nLIMIT ${limit + 1}`;
  try {
    // 0.9.0 permits one top-level LIMIT and enforces end-of-input. Existing
    // LIMIT/OFFSET rejects this candidate; no clause is located or rewritten.
    db.prepareTql(candidate);
    checkCompletion();
    return { query: candidate, optimized: true };
  } catch (error) {
    if (error?.code !== "TDB_QUERY_PARSE") throw error;
    checkCompletion();
    return { query: tql, optimized: false };
  }
}

/**
 * Preserve native aggregate/sort/paging semantics. For standard reads without
 * paging, a native-validated terminal LIMIT fetches at most one lookahead row.
 * Other valid forms execute unchanged, then receive the same display cap.
 * This is not an independent work cap: explicit LIMIT can override the native
 * default row budget, while full-input operators still need their native work.
 * Bytes/deadlines remain enforced; even the capped lookahead can be too large.
 * The caller owns scheduling: this synchronous call is not timer-preemptible.
 */
export function executeLiveTql(db, body) {
  const { tql, params, limit, timeoutMs } = validate(body);
  let session;
  try {
    if (!db || typeof db.consoleRequest !== "function" || typeof db.prepareTql !== "function") {
      throw fail(409, "LIVE_TQL_UNAVAILABLE", "An already-open host writer is required.");
    }
    const { ConsoleSession } = require("triviumdb");
    const started = performance.now();
    const checkCompletion = () => {
      if (performance.now() - started > timeoutMs) {
        throw fail(408, "LIVE_TQL_TIMEOUT", "The live TQL call did not complete within its deadline.");
      }
    };
    const selected = cappedQuery(db, tql, limit, checkCompletion);
    let query = selected.query;
    let fetchRows = limit + 1;
    let resized = false;
    let raw;
    for (let attempt = 0; attempt < MAX_NATIVE_ATTEMPTS; attempt++) {
      checkCompletion();
      const remainingMs = Math.max(1, Math.floor(timeoutMs - (performance.now() - started)));
      session = new ConsoleSession(JSON.stringify({
        readOnly: true,
        features: ["query"],
        maxRequestBytes: LIVE_TQL_REQUEST_BYTES + 512,
        maxResponseBytes: NATIVE_RESPONSE_BYTES,
        maxOperations: NATIVE_WORKING_ROWS,
        queryTimeoutMs: remainingMs,
      }));
      try {
        raw = db.consoleRequest(session, JSON.stringify({
          version: 1,
          requestId: "live-tql",
          command: { operation: "query", query, parameters: params },
        }));
        break;
      } catch (error) {
        if (error?.code !== "TDB_CONSOLE_RESPONSE_TOO_LARGE" || !selected.optimized
            || fetchRows <= 2 || attempt + 1 === MAX_NATIVE_ATTEMPTS) throw error;
        checkCompletion();
        fetchRows = Math.max(2, Math.ceil(fetchRows / 4));
        const candidate = `${tql}\nLIMIT ${fetchRows}`;
        // Every retry is another native-validated read, never a mutation or a
        // change to the original paging clause. Other native errors propagate.
        db.prepareTql(candidate);
        checkCompletion();
        query = candidate;
        resized = true;
      } finally {
        session.detach();
        session = undefined;
      }
    }
    checkCompletion();
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > NATIVE_RESPONSE_BYTES) {
      throw fail(413, "LIVE_TQL_RESPONSE_TOO_LARGE", "The native live response exceeds its byte budget.");
    }
    const response = JSON.parse(raw);
    const data = response?.data;
    if (response.version !== 1 || response.requestId !== "live-tql" || !Array.isArray(data?.rows)
        || !Array.isArray(data.columns) || data.rowCount !== data.rows.length) {
      throw fail(500, "LIVE_TQL_FAILED", "The native live query returned an invalid response.");
    }
    const visibleLimit = selected.optimized ? Math.min(limit, fetchRows - 1) : limit;
    const rows = data.rows.slice(0, visibleLimit);
    const result = {
      ok: true,
      source: "live",
      kind: "tql",
      rows,
      columns: data.columns,
      rowCount: rows.length,
      truncated: data.rows.length > visibleLimit,
      limit,
      timeoutMs,
    };
    if (resized && result.truncated) result.truncationReason = "response-byte-budget";
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > LIVE_TQL_RESPONSE_BYTES) {
      throw fail(413, "LIVE_TQL_RESPONSE_TOO_LARGE", "The live TQL response exceeds 512 KiB.");
    }
    // This checks completion after encoding/decoding; it does not interrupt a
    // running native operation. Execution cancellation is cooperative in core.
    checkCompletion();
    return result;
  } catch (error) {
    throw nativeFailure(error);
  } finally {
    session?.detach();
  }
}
