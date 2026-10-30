/**
 * Date resolution with an explicit anchor.
 *
 * The only anchor the plugin may use is the *source* turn's own timestamp, in a
 * fixed timezone (Asia/Shanghai, UTC+8, no DST). Replay never re-anchors "明天"
 * to the replay day. Only expressions with a determinate answer are resolved:
 * numbers ("2026-10-31") and the closed set below. Everything else ("以后",
 * "月底前", "尽快") keeps its original wording and is not made precise.
 */

/** Fixed anchor timezone. The host events carry no zone; this one is declared. */
export const ANCHOR_TZ = "Asia/Shanghai";
const ANCHOR_OFFSET_MIN = 8 * 60;

const WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 };

/** Absolute numeric dates, e.g. 2026-10-31 / 2026/10/31 / 2026年10月31日. */
export const ABSOLUTE_DATE = /((?:19|20)\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})日?/g;

const pad = (n) => String(n).padStart(2, "0");

/** Wall-clock parts of an instant in the anchor timezone. */
export function anchorParts(ms) {
  const shifted = new Date(Number(ms) + ANCHOR_OFFSET_MIN * 60 * 1000);
  if (!Number.isFinite(shifted.getTime())) return null;
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: ((shifted.getUTCDay() + 6) % 7) + 1 };
}

function keyOf({ year, month, day }) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Whole days from a calendar date, using UTC arithmetic to avoid DST drift. */
function shiftDays(parts, days) {
  const base = Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86400000;
  const d = new Date(base);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: ((d.getUTCDay() + 6) % 7) + 1 };
}

/** True only for a real calendar date (rejects 2026-02-30, 2026-13-01). */
export function isValidYmd(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Every absolute date written in the text, with a normalised key. */
export function absoluteDates(text) {
  const out = [];
  for (const match of String(text || "").matchAll(ABSOLUTE_DATE)) {
    const [, y, m, d] = match;
    out.push({ raw: match[0], key: isValidYmd(y, m, d) ? keyOf({ year: Number(y), month: Number(m), day: Number(d) }) : null, valid: isValidYmd(y, m, d) });
  }
  return out;
}

/**
 * Resolve the closed set of determinate relative expressions against one anchor.
 *
 * Returns an empty list when the sentence carries no determinate expression, or
 * when it carries more than one: two expressions in one sentence cannot tell us
 * which object the date belongs to, so neither may authorise a candidate date.
 */
export function resolveRelative(sentence, anchorMs) {
  const text = String(sentence || "");
  const parts = anchorParts(anchorMs);
  if (!parts) return [];
  const hits = [];
  const push = (expr, dateParts) => hits.push({ expr, key: keyOf(dateParts) });

  const dayWords = [
    [/今天|今日/, 0],
    [/明天|明日/, 1],
    [/后天/, 2],
    [/昨天|昨日/, -1],
    [/前天/, -2],
  ];
  for (const [re, delta] of dayWords) {
    const m = text.match(re);
    if (m) push(m[0], shiftDays(parts, delta));
  }

  // 下周X / 本周X / 周X — Monday is the first day of the week.
  const weekRe = /(下|本|这)?(?:周|星期)([一二三四五六日天七])/g;
  for (const match of text.matchAll(weekRe)) {
    const scope = match[1] || "";
    const target = WEEKDAYS[match[2]];
    if (!target) continue;
    // Monday is day 1: this week's target is (target - weekday); next week's is
    // that plus a full week, i.e. (7 - weekday + target).
    const delta = scope === "下" ? 7 - parts.weekday + target : target - parts.weekday;
    push(match[0], shiftDays(parts, delta));
  }

  if (hits.length !== 1) return [];
  return hits;
}

/**
 * Dates a candidate may legitimately contain, given the sentence that supports it.
 *
 * Literal dates in the window are always allowed (the user wrote them). A relative
 * expression only authorises the date it resolves to, and only when it sits in the
 * same sentence that supports the candidate and that sentence has exactly one.
 */
export function allowedDateKeys({ sentence = "", anchorMs = null, windowText = "" } = {}) {
  const allowed = new Set();
  for (const row of absoluteDates(windowText)) if (row.key) allowed.add(row.key);
  if (anchorMs !== null && Number.isFinite(Number(anchorMs))) {
    for (const row of resolveRelative(sentence, anchorMs)) allowed.add(row.key);
  }
  return allowed;
}
