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

/*
 * C2: English month names only.
 *
 * "20 November 2026" and "November 20, 2026" say which number is the day, so they
 * need no locale guess. "11/20/2026" does not — it is the same string in two
 * different countries — so it stays unparsed and is never used to authorise (or
 * to delete) a date. That is the whole rule: unambiguous or nothing.
 */
const MONTH_NUMBER = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_ABBR = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_WORD =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const EN_MONTH_FIRST = new RegExp(
  `\\b(${MONTH_WORD})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*((?:19|20)\\d{2})\\b`,
  "gi",
);
const EN_DAY_FIRST = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_WORD})\\s*,?\\s*((?:19|20)\\d{2})\\b`,
  "gi",
);

function monthNumberOf(word) {
  const bare = String(word || "").toLowerCase().replace(/\.$/, "");
  return MONTH_NUMBER[bare] || MONTH_ABBR[bare] || 0;
}

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
  const source = String(text || "");
  const hits = [];
  for (const match of source.matchAll(ABSOLUTE_DATE)) {
    hits.push({ index: match.index, raw: match[0], year: match[1], month: match[2], day: match[3] });
  }
  for (const match of source.matchAll(EN_MONTH_FIRST)) {
    hits.push({ index: match.index, raw: match[0], year: match[3], month: monthNumberOf(match[1]), day: match[2] });
  }
  for (const match of source.matchAll(EN_DAY_FIRST)) {
    hits.push({ index: match.index, raw: match[0], year: match[3], month: monthNumberOf(match[2]), day: match[1] });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((hit) => {
    const valid = hit.month > 0 && isValidYmd(hit.year, hit.month, hit.day);
    return {
      raw: hit.raw,
      key: valid ? keyOf({ year: Number(hit.year), month: Number(hit.month), day: Number(hit.day) }) : null,
      valid,
    };
  });
}

/**
 * The absolute date a value *starts* with, for explicit `until` fields.
 *
 * Accepts the same numeric forms as `ABSOLUTE_DATE` plus the English month
 * spellings; ignores a trailing time part (`2026-10-31T23:59:59Z`). Returns null
 * for anything ambiguous (`11/20/2026`) or impossible (`2026-13-01`).
 */
export function absoluteDateAtStart(value) {
  const text = String(value || "").trim();
  const numeric = text.match(/^((?:19|20)\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})日?/);
  if (numeric && isValidYmd(numeric[1], numeric[2], numeric[3])) {
    return { year: Number(numeric[1]), month: Number(numeric[2]), day: Number(numeric[3]) };
  }
  const monthFirst = text.match(
    new RegExp(`^(${MONTH_WORD})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*((?:19|20)\\d{2})\\b`, "i"),
  );
  if (monthFirst) {
    const month = monthNumberOf(monthFirst[1]);
    if (month && isValidYmd(monthFirst[3], month, monthFirst[2])) {
      return { year: Number(monthFirst[3]), month, day: Number(monthFirst[2]) };
    }
  }
  const dayFirst = text.match(
    new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_WORD})\\s*,?\\s*((?:19|20)\\d{2})\\b`, "i"),
  );
  if (dayFirst) {
    const month = monthNumberOf(dayFirst[2]);
    if (month && isValidYmd(dayFirst[3], month, dayFirst[1])) {
      return { year: Number(dayFirst[3]), month, day: Number(dayFirst[1]) };
    }
  }
  return null;
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
