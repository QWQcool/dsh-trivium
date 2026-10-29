/** Bounded, single-flight extraction for one live session buffer. No model dependency. */
export function createExtractScheduler({ run, persist, enabled = () => true,
  now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id), onError = () => {},
  idleMs = 60_000, batchSize = 12, cooldownMs = 300_000 } = {}) {
  const states = new Map();
  const stateOf = (buf) => {
    if (!states.has(buf)) states.set(buf, { lastAttempt: -Infinity, lastSuccess: "", timer: null, running: null, disposed: false });
    return states.get(buf);
  };
  const cancel = (st) => { if (st.timer !== null) clearTimer(st.timer); st.timer = null; };
  function schedule(buf, context, reason = "idle") {
    const st = stateOf(buf);
    st.context = context;
    cancel(st);
    if (st.disposed || !enabled() || !buf.turns.length || st.running) return st.running;
    const remaining = Math.max(0, st.lastAttempt + cooldownMs - now());
    if (reason !== "idle" || (buf.turns.length >= batchSize && remaining === 0)) return fire(buf, st, reason === "idle" ? "batch" : reason);
    // A cooldown must wake at its end, even if no new message arrives.
    st.timer = setTimer(() => { st.timer = null; void fire(buf, st, "idle"); }, Math.max(idleMs, remaining));
    st.timer?.unref?.();
    return null;
  }
  async function fire(buf, st, reason) {
    if (st.running || !enabled() || !buf.turns.length || st.disposed) return st.running;
    cancel(st);
    const snapshot = buf.turns.slice();
    const fingerprint = JSON.stringify(snapshot);
    st.lastAttempt = now();
    // Set running before invoking callbacks, including synchronously resolving ones.
    st.running = Promise.resolve().then(async () => {
      let ok = fingerprint === st.lastSuccess;
      if (!ok) ok = (await run(snapshot, st.context, reason)) === true;
      if (ok) {
        st.lastSuccess = fingerprint;
        const consumed = new Set(snapshot);
        buf.turns = buf.turns.filter((turn) => !consumed.has(turn));
      }
      buf.dirty = buf.turns.length > 0;
      await persist(buf, ok ? null : "llm failed");
      return ok;
    }).catch((err) => { onError(err); return false; });
    const ok = await st.running;
    st.running = null;
    // Failures stay pending; retry only on a later event/start, never an unbounded paid loop.
    if (ok && buf.turns.length && !st.disposed) schedule(buf, st.context);
    if (st.disposed) states.delete(buf);
    return ok;
  }
  return {
    schedule,
    dispose(buf) { const st = states.get(buf); if (!st) return; st.disposed = true; cancel(st); if (!st.running) states.delete(buf); },
    disposeAll() { for (const buf of states.keys()) this.dispose(buf); },
  };
}
