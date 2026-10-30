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
  supersedes: "supersedes",
});

export const BUSINESS_EDGES = Object.freeze(["about", "decided", "broke", "fixed"]);

/**
 * Revision relations are deliberately NOT in BUSINESS_EDGES: adding them would
 * pull an entire decision history into every recall through neighbor expansion.
 * They are read only through the revision resolver and the history API.
 */
export const REVISION_EDGES = Object.freeze(["supersedes"]);

/** Hard cap on a revision chain walk before the answer is "unresolved". */
export const REVISION_WALK_LIMIT = 32;

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
  supersedes: 0.8,
});

export function weightOf(label) {
  return EDGE_WEIGHTS[label] ?? 1;
}

/*
 * English credential wording. A bare noun is NOT a secret: "token 预算 500" and
 * "the password policy requires 12 characters" are ordinary facts, and blocking
 * them loses information. The word must be followed by an actual value.
 */
export const SECRET_RE = new RegExp([
  String.raw`\bsk-[A-Za-z0-9_-]{8,}`,
  String.raw`\bbearer\s+[A-Za-z0-9._-]{8,}`,
  String.raw`\b(?:api[_-]?key|secret|password|passwd|pwd|token)\b\s*(?:[:=：]|\bis\b|\bare\b|是|为)\s*["'\x60]?[A-Za-z0-9][A-Za-z0-9_\-./+=]{5,}`,
].join("|"), "i");

/*
 * Credential *values* the keyword list above never sees. A-3 showed the model
 * stops redacting on its own once extraction runs with reasoning off, so the
 * gate has to recognise the shapes itself:
 *   - provider prefixes (GitHub, AWS, Google, npm, Slack) and JWT / PEM blocks;
 *   - a Chinese credential word immediately followed by an opaque ASCII value
 *     ("口令 verify-QA-71", "密码：hunter2"), which is how a leak reads in Chinese.
 * Deliberately NOT matched: plain nouns without a value ("密码学很难"), project
 * code names ("发布代号是 BlueHeron"), ports and counts — those are facts.
 */
export const CREDENTIAL_VALUE_RE = new RegExp([
  String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bASIA[0-9A-Z]{16}\b`,
  String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
  String.raw`\bnpm_[A-Za-z0-9]{30,}`,
  String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
  String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  String.raw`(?:密码|口令|密钥|令牌|私钥|凭据)[\s:：=是为]{0,3}[A-Za-z0-9][A-Za-z0-9_\-./+=]{5,}`,
].join("|"), "i");

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
  const value = String(text || "");
  return SECRET_RE.test(value) || CREDENTIAL_VALUE_RE.test(value);
}

export function indexTextFor(payload) {
  const parts = [payload.type, payload.name, ...(Array.isArray(payload.aliases) ? payload.aliases : []), payload.text, payload.uri, payload.fail, payload.fix, payload.until]
    .filter(Boolean)
    .map(String);
  return parts.join(" ");
}
