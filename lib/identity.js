/**
 * "Is this the same fact?" — without asking a model, and without trusting wording.
 *
 * Today the merge decision is a substring test on the body (`nText.includes(text)`
 * or the reverse). That catches "发布窗口是周四" → "发布窗口是周四晚上" and misses
 * every paraphrase that reorders the same words ("每周四晚上是发布窗口"). The cost
 * of the miss is a duplicate fact; the cost of a false match is a silently retired
 * fact, which is worse — so every rule here is biased towards *not* merging.
 *
 * Three cheap signals, all local:
 *
 *   1. type must match (a preference never folds into a decision);
 *   2. negation must not flip between the two (`不` / `别` / `禁止` / never, not);
 *   3. similarity is Jaccard over character bigrams, which works for CJK prose and
 *      for Latin text alike, plus a name-family check that tolerates an added or
 *      dropped qualifier ("部署窗口" vs "部署窗口时间").
 *
 * Deliberately absent: embeddings. They would be better, but they cost a network
 * call on the write path and would make duplicate detection depend on a service
 * being up — a merge decision that cannot run offline is a merge decision that
 * silently stops happening.
 */

/** Full-width → half-width, lower case, drop punctuation and collapse spaces. */
export function normalizeFactText(input) {
  return String(input || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    // Keep letters, digits and CJK; everything else is noise for identity.
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
    .trim();
}

const NEGATIONS = ["不", "别", "禁止", "没有", "无需", "取消", "never", "not ", "don't", "do not", "no longer"];

/** Whether the text says "this is not / no longer the case". */
export function isNegated(input) {
  const text = ` ${normalizeFactText(input)} `;
  return NEGATIONS.some((word) => text.includes(word));
}

const CJK_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * The numbers a sentence states, as a comparable set.
 *
 * "部署窗口是周四" and "部署窗口是周五" differ by one character and are ~0.9
 * similar, but they are a correction, not a duplicate: folding them would retire
 * the first fact without saying so. Any pair whose numbers disagree is treated as
 * different, which is why this exists at all.
 */
export function numberSignature(input) {
  const text = normalizeFactText(input);
  const found = new Set();
  for (const match of text.matchAll(/\d+(?:\.\d+)?/g)) found.add(String(Number(match[0])));
  // 周X / 星期X / 月份 / 号, plus bare CJK numerals used as counts.
  for (const match of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天零〇七])/g)) {
    found.add(`w${match[1] === "天" || match[1] === "日" ? 7 : CJK_DIGITS[match[1]] ?? match[1]}`);
  }
  for (const [glyph, value] of Object.entries(CJK_DIGITS)) {
    if (text.includes(glyph)) found.add(String(value));
  }
  return found;
}

/** Character bigrams for CJK, word tokens for anything spaced. */
export function identityTokens(input) {
  const text = normalizeFactText(input);
  if (!text) return new Set();
  const tokens = new Set();
  for (const word of text.split(" ")) {
    if (!word) continue;
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      if (word.length === 1) tokens.add(word);
      for (let i = 0; i + 1 < word.length; i += 1) tokens.add(word.slice(i, i + 2));
    } else if (word.length <= 3) {
      tokens.add(word);
    } else {
      // Long Latin words are compared by prefix pairs, which survives inflection
      // well enough to be useful and badly enough to stay conservative.
      for (let i = 0; i + 3 <= word.length; i += 2) tokens.add(word.slice(i, i + 3));
    }
  }
  return tokens;
}

/** Jaccard similarity over `identityTokens`, 0..1. */
export function similarity(a, b) {
  const left = identityTokens(a);
  const right = identityTokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Name family: one name contains the other, or they share a distinctive token. */
export function sameNameFamily(a, b) {
  const left = normalizeFactText(a);
  const right = normalizeFactText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left))) return true;
  const shared = [...identityTokens(left)].filter((token) => identityTokens(right).has(token));
  return shared.some((token) => token.length >= 2);
}

/**
 * Should `incoming` be folded into `stored`?
 *
 * @returns {{ same: boolean, reason: string, score: number }}
 *   `reason` is part of the contract: the extraction log reports why a write
 *   merged, and "why" is the only thing that makes a wrong merge diagnosable.
 */
export function sameFact(incoming, stored, { threshold = 0.5 } = {}) {
  const inType = String(incoming?.type || "");
  const stType = String(stored?.type || "");
  if (!inType || inType !== stType) return { same: false, reason: "type", score: 0 };
  if (inType === "entity") return { same: false, reason: "entity-uses-name", score: 0 };

  const inText = String(incoming?.text || "");
  const stText = String(stored?.text || "");
  // Negation asymmetry is the one signal that must override similarity: "支持 A"
  // and "不支持 A" are near-identical strings and opposite facts.
  if (isNegated(inText) !== isNegated(stText)) return { same: false, reason: "negation", score: 0 };

  const inNumbers = numberSignature(inText);
  const stNumbers = numberSignature(stText);
  if (inNumbers.size && stNumbers.size) {
    const sameNumbers = inNumbers.size === stNumbers.size && [...inNumbers].every((value) => stNumbers.has(value));
    if (!sameNumbers) return { same: false, reason: "value-conflict", score: similarity(inText, stText) };
  }

  const score = similarity(inText, stText);
  const family = sameNameFamily(incoming?.name, stored?.name);

  if (score >= 0.8) return { same: true, reason: "text", score };
  if (family && score >= threshold) return { same: true, reason: "name+text", score };
  // Two short bodies are too easy to confuse; require the name family as well.
  if (normalizeFactText(inText).length < 6 || normalizeFactText(stText).length < 6) {
    return { same: false, reason: "too-short", score };
  }
  return { same: false, reason: "below-threshold", score };
}
