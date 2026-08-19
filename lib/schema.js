/** Node and edge conventions. Keep this the single source of payload shape. */

export const DIM = 1536;

export const NODE_TYPES = Object.freeze([
  "workspace",
  "entity",
  "preference",
  "decision",
  "experience",
]);

export const EDGE_LABELS = Object.freeze({
  inWorkspace: "in_workspace",
  about: "about",
  decided: "decided",
  broke: "broke",
  fixed: "fixed",
  sameAs: "same_as",
  fromSession: "from_session",
});

export const SECRET_RE =
  /(api[_-]?key|secret|password|token|bearer\s+[a-z0-9]|sk-[a-z0-9])/i;

export function zeroVector() {
  return new Array(DIM).fill(0);
}

export function nowIso() {
  return new Date().toISOString();
}

export function clip(text, max = 200) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function looksSecret(text) {
  return SECRET_RE.test(String(text || ""));
}

export function indexTextFor(payload) {
  const parts = [payload.type, payload.name, payload.text, payload.uri, payload.fail, payload.fix, payload.until]
    .filter(Boolean)
    .map(String);
  return parts.join(" ");
}
