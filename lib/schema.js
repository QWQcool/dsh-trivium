/** Node and edge conventions. Keep this the single source of payload shape. */

export const DIM = 1536;

export const NODE_TYPES = Object.freeze([
  "workspace",
  "entity",
  "preference",
  "decision",
  "experience",
  "episode",
]);

export const EDGE_LABELS = Object.freeze({
  inWorkspace: "in_workspace",
  about: "about",
  decided: "decided",
  broke: "broke",
  fixed: "fixed",
  sameAs: "same_as",
  fromSession: "from_session",
  continues: "continues",
  forksFrom: "forks_from",
});

export const BUSINESS_EDGES = Object.freeze(["about", "decided", "broke", "fixed"]);

/** Weights written on link(). Engine neighbors / expandLabels can whitelist labels; we still persist weights. */
export const EDGE_WEIGHTS = Object.freeze({
  about: 1,
  decided: 1,
  broke: 0.9,
  fixed: 0.9,
  in_workspace: 0.15,
  same_as: 0.5,
  from_session: 0.1,
  continues: 0.4,
  forks_from: 0.6,
});

export function weightOf(label) {
  return EDGE_WEIGHTS[label] ?? 1;
}

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
