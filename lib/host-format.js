/**
 * Host wire-format helpers, kept free of `@deepseek-ai/*` imports so the offline
 * smoke suite can exercise them without a DSH install.
 *
 * Session format v4 (DSH 0.2.0+) replaced the shared `kind: "plugin"` message
 * source with producer-owned kinds: a third-party producer is `plugin:<name>`
 * and the `plugin` field is dropped. Writing the old shape into a v4 log fails
 * the whole turn with "format v4 message requires a producer-owned source kind".
 * 0.1.x only knows the old shape, so lib/index.js picks by host version.
 */

/**
 * Decide whether the host writes session format v4.
 * @param version - `@deepseek-ai/dsh-llm` version, e.g. "0.1.5-rc.1" / "0.2.1-rc.2".
 * @returns true for >= 0.2.0, and for an unreadable version (assume the current
 *   format rather than silently writing a shape the host rejects).
 */
export function detectHostFormatV4(version) {
  const v = String(version || "").trim();
  if (!v) return true;
  const [major, minor] = v.split(".").map((n) => parseInt(n, 10) || 0);
  return major > 0 || minor >= 2;
}

/**
 * Build the `source` for one plugin-authored message.
 * @param hostFormatV4 - result of {@link detectHostFormatV4}.
 * @param extra - additional source fields (form, sections, ...).
 * @returns the source object the installed host accepts.
 */
export function producerSourceFor(hostFormatV4, extra) {
  return hostFormatV4
    ? { kind: "plugin:dsh-trivium", ...extra }
    : { kind: "plugin", plugin: "dsh-trivium", ...extra };
}
