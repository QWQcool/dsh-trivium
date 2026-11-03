/**
 * Stage 1, part B (prototype): one writer, many callers.
 *
 * The concurrency measurement (`evidence-write-provenance/S1/...`) left one
 * finding that decides the design: a losing writer does not lose the fact, it
 * *defers* it, and deferral only works while the same library is opened again.
 * In a Super-agent shape the work-item directory is short-lived, so deferral is
 * loss. The fix is not a better lock — it is a writer that outlives the worker.
 *
 * This module is that writer, as small as it can be while still being real:
 *
 *   - `startRouter({cwd})` opens the workspace database once and serves four
 *     operations (`insert`, `merge`, `link`, `update`) over a local socket;
 *   - `createRouterClient({cwd})` returns an object that satisfies the
 *     `MemoryWriter` port, so `distill({writer})` can use it unchanged;
 *   - requests are applied **in arrival order, one at a time**, on the single
 *     handle the router owns.
 *
 * Deliberately not wired into the plugin yet: the host still runs one process
 * per workspace, so the router has no caller. It is the piece part B needs, and
 * the test (`smoke-p81`) drives it with two real sockets.
 */

import { createHash } from "node:crypto";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the router for a workspace listens. Pipes on Windows, sockets elsewhere. */
export function routerEndpoint(cwd) {
  const digest = createHash("sha1").update(String(cwd || "")).digest("hex").slice(0, 12);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\trivium-router-${digest}`
    : join(tmpdir(), `trivium-router-${digest}.sock`);
}

function encode(row) {
  return `${JSON.stringify(row)}\n`;
}

/**
 * Start the single writer for one workspace.
 *
 * Resolves once the endpoint is accepting connections. `close()` stops accepting
 * and closes the database; requests already queued finish first.
 */
export async function startRouter({ cwd, db, onError = () => {} } = {}) {
  // The store module is needed for the operations either way; a caller-supplied
  // handle only skips the open.
  const store = await import("./store.js");
  const handle = db || (await store.openWorkspaceDb(cwd));
  const endpoint = routerEndpoint(cwd);
  const pending = [];
  let chain = Promise.resolve();
  let closed = false;
  /*
   * Queue depth is the one thing a caller cannot see from a rejection: a router
   * that is merely slow looks exactly like a healthy one from the outside. The
   * counters exist so a benchmark (and, later, a status line) can tell the two
   * apart without adding a request that would itself join the queue.
   */
  const counters = { applied: 0, failed: 0, queued: 0, maxQueued: 0, startedAt: Date.now() };

  const apply = (op, args) => {
    switch (op) {
      case "insert":
        return store.insertNode(handle, args.payload);
      case "merge":
        return store.mergeInto(handle, args.id, args.payload);
      case "link":
        return store.ensureLink(handle, args.from, args.to, args.label);
      case "update":
        return store.updateNode(handle, args.id, args.patch);
      default: {
        const err = new Error(`router does not know op ${op}`);
        err.code = "ROUTER_UNKNOWN_OP";
        throw err;
      }
    }
  };

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          socket.write(encode({ id: null, ok: false, code: "ROUTER_BAD_REQUEST", message: "not JSON" }));
          continue;
        }
        // One request at a time, in arrival order: that is the whole point.
        counters.queued += 1;
        if (counters.queued > counters.maxQueued) counters.maxQueued = counters.queued;
        chain = chain.then(async () => {
          try {
            const value = await apply(String(request.op), request.args || {});
            counters.applied += 1;
            socket.write(encode({ id: request.id, ok: true, value }));
          } catch (err) {
            counters.failed += 1;
            socket.write(
              encode({
                id: request.id,
                ok: false,
                code: err?.code || "ROUTER_ERROR",
                message: String(err?.message || err),
              }),
            );
          } finally {
            counters.queued -= 1;
          }
        });
      }
    });
    socket.on("error", (err) => onError(err));
    pending.push(socket);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    endpoint,
    cwd,
    /** Applied / failed / queued right now / the deepest queue seen. */
    stats() {
      return { ...counters, uptimeMs: Date.now() - counters.startedAt };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of pending) {
        try { socket.end(); } catch { /* already gone */ }
      }
      await new Promise((resolve) => server.close(resolve));
      await chain.catch(() => {});
      try { handle.close?.(); } catch { /* best effort */ }
    },
  };
}

/**
 * A `MemoryWriter` that speaks to the router.
 *
 * It never falls back to the local database: a silent fallback is exactly the
 * failure this part exists to remove — the worker would think it wrote through
 * the router while it wrote its own copy.
 */
export function createRouterClient({ cwd } = {}) {
  const endpoint = routerEndpoint(cwd);
  let socket = null;
  let nextId = 0;
  let buffer = "";
  const waiting = new Map();
  const ready = new Promise((resolve, reject) => {
    socket = connect(endpoint);
    socket.setEncoding("utf8");
    socket.once("connect", resolve);
    socket.once("error", (err) => {
      const failure = new Error(`router unavailable at ${endpoint}: ${err?.message || err}`);
      failure.code = "ROUTER_UNAVAILABLE";
      reject(failure);
      for (const [, row] of waiting) row.reject(failure);
      waiting.clear();
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        const row = waiting.get(reply.id);
        if (!row) continue;
        waiting.delete(reply.id);
        if (reply.ok) row.resolve(reply.value);
        else {
          const err = new Error(reply.message || "router error");
          err.code = reply.code || "ROUTER_ERROR";
          row.reject(err);
        }
      }
    });
  });
  ready.catch(() => {});

  const call = async (op, args) => {
    await ready;
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      socket.write(encode({ id, op, args }));
    });
  };

  const writer = {
    kind: "router",
    insert: (payload) => call("insert", { payload }),
    merge: (id, payload) => call("merge", { id, payload }),
    link: (from, to, label) => call("link", { from, to, label }),
    update: (id, patch) => call("update", { id, patch }),
  };

  return {
    endpoint,
    writer,
    ready,
    async close() {
      try { socket?.end(); } catch { /* already gone */ }
    },
  };
}
