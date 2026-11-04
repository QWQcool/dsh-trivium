/**
 * "Is this the same fact?" — without a model, and biased towards *not* merging.
 *
 * Reviewed 2026-11-04 (external audit, F1): the first version merged three pairs
 * that were corrections rather than duplicates:
 *
 *   "重试间隔 1.5 秒" / "5.1 秒"        → the decimal point was turned into a space,
 *                                        so both texts carried the numbers {1,5}
 *   "生产环境用 npm" / "测试环境用 pnpm"  → the names only shared "环境"
 *   "保留十六天" / "六十天"              → CJK numerals were collected as single
 *                                        characters, so both carried {十,六}
 *
 * Merging is the destructive direction: it retires a fact and leaves no revision
 * chain. So the rules here are deliberately narrow, and every one of the three
 * cases above is a regression test in `smoke-p87.mjs`.
 */

const GENERIC_NAME_TOKENS = new Set([
  "环境", "配置", "设置", "系统", "项目", "文件", "时间", "间隔", "流程", "窗口",
  "方式", "方法", "规则", "策略", "方案", "内容", "数据", "情况", "问题", "说明",
  "config", "setting", "settings", "system", "project", "file", "time", "value",
]);

/**
 * Full-width → half-width, lower case, punctuation → space, **decimals intact**.
 *
 * A dot between two digits is part of a number, not punctuation; the first version
 * erased it and "1.5" became "1 5", which made it indistinguishable from "5.1".
 */
export function normalizeFactText(input) {
  return String(input || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    // Keep digits and CJK, keep dots (they may be decimal points), spaces otherwise.
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff.]+/gu, " ")
    // A dot only survives between two digits; "1.5" stays, "end." does not.
    .replace(/(?<!\d)\./g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the text says "this is not / no longer the case".
 *
 * Checked on the **raw** text: normalisation drops the apostrophe, so `don't`
 * became `don t` and stopped matching. Contractions are tested first, then the
 * normalised form.
 */
export function isNegated(input) {
  const raw = String(input || "").toLowerCase();
  const text = ` ${normalizeFactText(raw)} `;
  const rawMarkers = [/\b(don|doesn|isn|aren|won|can|shouldn)'t\b/, /\bnot\b/, /\bnever\b/, /\bno longer\b/];
  if (rawMarkers.some((pattern) => pattern.test(raw))) return true;
  const markers = ["不", "别", "禁止", "没有", "无需", "取消", "永不"];
  return markers.some((word) => text.includes(word));
}

const CJK_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * Read a CJK numeral the way it is actually written: 十五 → 15, 六十 → 60,
 * 六十天 → 60. `十` alone is 10, `十六` is 16.
 */
export function cjkNumber(text) {
  const source = String(text || "");
  const match = source.match(/[零〇一二两三四五六七八九十百]+/);
  if (!match) return null;
  let value = match[0];
  if (!/十|百/.test(value)) {
    // A bare sequence like 一二三 is not a number we can trust; use the last digit.
    return CJK_DIGIT[value[value.length - 1]] ?? null;
  }
  let total = 0;
  let current = 0;
  for (const ch of value) {
    if (ch === "百") { total += (current || 1) * 100; current = 0; }
    else if (ch === "十") { total += (current || 1) * 10; current = 0; }
    else current = CJK_DIGIT[ch] ?? 0;
  }
  return total + current;
}

/**
 * The values a sentence states, as a comparable set.
 *
 * Covers Arabic numbers (decimals preserved), 周X/星期X, and CJK numerals read as a
 * whole number instead of a bag of characters.
 */
export function numberSignature(input) {
  const text = normalizeFactText(input);
  const found = new Set();
  for (const match of text.matchAll(/\d+(?:\.\d+)?/g)) found.add(String(Number(match[0])));
  for (const match of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天零〇七])/g)) {
    const day = match[1] === "天" || match[1] === "日" ? "7" : String(CJK_DIGIT[match[1]] ?? match[1]);
    found.add(`w${day}`);
  }
  for (const word of text.split(" ")) {
    if (!/[\u4e00-\u9fff]/.test(word)) continue;
    for (const chunk of word.match(/[零〇一二两三四五六七八九十百]+/g) || []) {
      const value = cjkNumber(chunk);
      if (value != null) found.add(String(value));
    }
  }
  return found;
}

/** Character bigrams for CJK, trigrams for Latin: no tokens, no similarity. */
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

/**
 * Name family: a **distinctive** shared token, not a generic word.
 *
 * "生产环境" and "测试环境" sharing "环境" says nothing about the subject; sharing
 * "部署窗口" does. Generic words are filtered out before the comparison.
 */
export function sameNameFamily(a, b) {
  const left = normalizeFactText(a);
  const right = normalizeFactText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left))) return true;
  const rightTokens = identityTokens(right);
  return [...identityTokens(left)].some(
    (token) => rightTokens.has(token) && token.length >= 2 && !GENERIC_NAME_TOKENS.has(token),
  );
}

const MIN_TEXT_CHARS = 8;

/**
 * Should `incoming` be folded into `stored`?
 *
 * Order matters: the destructive checks (type, negation, numbers) run first, then
 * length, then similarity. The first version returned on similarity ≥ 0.8 before
 * looking at length, which merged two different four-character bodies.
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
  const score = similarity(inText, stText);

  if (isNegated(inText) !== isNegated(stText)) return { same: false, reason: "negation", score };

  const inNumbers = numberSignature(inText);
  const stNumbers = numberSignature(stText);
  if (inNumbers.size && stNumbers.size) {
    const same = inNumbers.size === stNumbers.size && [...inNumbers].every((value) => stNumbers.has(value));
    if (!same) return { same: false, reason: "value-conflict", score };
  }

  // Two bodies too short to characterise are only the same if they are identical.
  if (
    normalizeFactText(inText).length < MIN_TEXT_CHARS ||
    normalizeFactText(stText).length < MIN_TEXT_CHARS
  ) {
    const identical = normalizeFactText(inText) === normalizeFactText(stText);
    return { same: identical, reason: identical ? "identical" : "too-short", score };
  }

  if (score >= 0.9) return { same: true, reason: "text", score };
  /*
   * Two different bars, because the two cases are not equally supported by the
   * name: the *same* name plus a reordered body is a rewrite of one subject
   * (measured 0.54–0.57), while names that merely share a word ("生产环境依赖" vs
   * "测试环境依赖") can describe different subjects at the same similarity. The
   * second case therefore needs the text alone to be convincing.
   */
  const nameA = normalizeFactText(incoming?.name);
  const nameB = normalizeFactText(stored?.name);
  const identicalName = Boolean(nameA) && nameA === nameB;
  const bar = identicalName ? threshold : 0.8;
  if (sameNameFamily(incoming?.name, stored?.name) && score >= bar) {
    return { same: true, reason: identicalName ? "name+text" : "family+text", score };
  }
  return { same: false, reason: "below-threshold", score };
}
