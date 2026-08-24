/**
 * Write + inject hygiene. Keep dirty tokens out of .tdb and out of the model window.
 * Heuristics follow the same classes as dsh-auto-memory 0.1.27/0.1.28 (mojibake,
 * stutter, raw JSON envelopes, base64 residue, duplicate-line loops), plus secrets.
 */
import { looksSecret } from "./schema.js";

/** GBK round-trip artifacts (same family as dsh-auto-memory / prion-scan). */
const MOJIBAKE_RE =
  /涓婁紶|涓嬭浇|鏉ユ簮|鈥|鈶|鈮|鐨勪|鐨勫|瀹夎|鍙戦|鐢ㄦ埛|鎴戠殑|鏁版嵁|鎸佷箙|璁＄畻|婧愪簬|鏂囦欢|瀹樻柟|娴嬭瘯|鍥剧墖|杩涜涓|鎵撳紑|杈撳嚭|鏌ヨ|鑾峰彇|閰嶇疆|缂撳瓨|瀛樺偍|鍒濆|璇曟嵎|璋冭瘯|瀛︿範|鎬ц兘/;

/** External-tool profile dump, not a durable fact. */
const RAW_JSON_MARK =
  /memoryBlock|"uid"\s*:|"updatedAt"\s*:|"role"\s*:\s*"(?:user|assistant|system)"/i;

const BASE64_LINE = /^[A-Za-z0-9+/]{200,}={0,2}$/;

export const WRITE_GATE_REASON = Object.freeze({
  empty: "empty",
  secret: "secret",
  mojibake: "mojibake",
  stutter: "stutter",
  "duplicate-lines": "duplicate-lines",
  "raw-json": "raw-json",
  base64: "base64",
});

export function writeGateMessage(reason) {
  switch (reason) {
    case "empty":
      return "Refused: empty.";
    case "secret":
      return "Refused: looks like a secret.";
    case "mojibake":
      return "Refused: looks like mojibake / encoding residue.";
    case "stutter":
      return "Refused: looks like stutter degeneration.";
    case "duplicate-lines":
      return "Refused: repeated lines.";
    case "raw-json":
      return "Refused: looks like an external JSON envelope.";
    case "base64":
      return "Refused: looks like base64 residue.";
    default:
      return `Refused: ${reason || "dirty"}`;
  }
}

export function mojibakeDensity(text) {
  const t = String(text || "");
  if (!t) return 0;
  const hits = t.match(new RegExp(MOJIBAKE_RE.source, "g")) || [];
  return (hits.length * 8) / Math.max(1, t.length);
}

export function hasStutter(text) {
  const t = String(text || "");
  if (!t) return false;
  if (/(?:^|[^\w])(\w{2,})(?:[^\w]+\1){3,}(?:[^\w]|$)/.test(t)) return true;
  if (/([\u4e00-\u9fff\u3040-\u30ff])(?:[^\u4e00-\u9fff\u3040-\u30ff]{0,2}\1){4,}/.test(t)) {
    return true;
  }
  return false;
}

function hasDuplicateLines(text) {
  let seq = 0;
  let prev = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      seq = 0;
      prev = "";
      continue;
    }
    if (t === prev) {
      seq += 1;
      if (seq >= 3) return true;
    } else {
      prev = t;
      seq = 1;
    }
  }
  return false;
}

function hasBase64Line(text) {
  return String(text || "")
    .split(/\r?\n/)
    .some((line) => {
      const k = line.trim();
      if (k.length < 200 || !BASE64_LINE.test(k)) return false;
      const alphabet = k.replace(/=+$/, "");
      if (new Set(alphabet).size < 8) return false;
      return /[A-Z]/.test(k) && /[a-z]/.test(k) && /[0-9+/]/.test(k);
    });
}

/**
 * @returns {{ ok: true, clean: string, truncated?: boolean } | { ok: false, reason: string, clean: string }}
 */
export function sanitizeForWrite(text, { maxEntryChars = 8000 } = {}) {
  const raw = String(text || "");
  if (!raw.trim()) return { ok: false, reason: "empty", clean: "" };
  if (looksSecret(raw)) return { ok: false, reason: "secret", clean: "" };
  if (mojibakeDensity(raw) > 0.001) return { ok: false, reason: "mojibake", clean: "" };
  if (hasStutter(raw)) return { ok: false, reason: "stutter", clean: "" };
  if (RAW_JSON_MARK.test(raw)) return { ok: false, reason: "raw-json", clean: "" };
  if (hasBase64Line(raw)) return { ok: false, reason: "base64", clean: "" };
  if (hasDuplicateLines(raw)) return { ok: false, reason: "duplicate-lines", clean: "" };
  if (raw.length > maxEntryChars) {
    return { ok: true, clean: raw.slice(0, maxEntryChars), truncated: true };
  }
  return { ok: true, clean: raw };
}

/** Reason string if this payload should not be injected / found / chipped. Empty if clean. */
export function payloadDirtyReason(payload) {
  const parts = [payload?.name, payload?.text, payload?.fail, payload?.fix, payload?.quote]
    .filter(Boolean)
    .map(String);
  if (!parts.length) return "";
  const gate = sanitizeForWrite(parts.join("\n"));
  if (gate.ok) return "";
  return gate.reason === "empty" ? "" : gate.reason;
}

export function payloadLooksDirty(payload) {
  return Boolean(payloadDirtyReason(payload));
}
