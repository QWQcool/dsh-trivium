/** Display `until` is a label; `untilAt` is an absolute instant we can filter on. */

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function resolveUntilAt(until, from = new Date()) {
  const raw = String(until || "").trim();
  if (!raw) return undefined;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/);
  if (iso) {
    const ms = Date.parse(`${iso[1]}T23:59:59.000Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  const fromDate = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(fromDate.getTime())) return undefined;
  if (raw === "下周") {
    return endOfDayUtc(addDays(fromDate, 7)).toISOString();
  }
  if (raw === "周五" || raw === "周末") {
    const want = raw === "周末" ? 6 : 5;
    return endOfDayUtc(nextWeekday(fromDate, want)).toISOString();
  }
  const day = raw.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i);
  if (day) {
    const want = WEEKDAYS[day[1].toLowerCase()];
    return endOfDayUtc(nextWeekday(fromDate, want)).toISOString();
  }
  return undefined;
}

export function isStalePayload(payload, now = new Date()) {
  const at = payload?.untilAt || resolveUntilAt(payload?.until, payload?.createdAt || now);
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms < now.getTime();
}

export function queryMentionsUntil(query, payload) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return false;
  if (/下周|until|周五|周末|过期|到期|postpone|defer|friday|monday|tuesday|wednesday|thursday|saturday|sunday/.test(q)) {
    return true;
  }
  const until = String(payload?.until || "").trim().toLowerCase();
  return until.length >= 2 && q.includes(until);
}

function addDays(date, n) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

function endOfDayUtc(date) {
  const next = new Date(date.getTime());
  next.setUTCHours(23, 59, 59, 0);
  return next;
}

function nextWeekday(from, weekday) {
  const next = new Date(from.getTime());
  const delta = (weekday - next.getUTCDay() + 7) % 7 || 7;
  next.setUTCDate(next.getUTCDate() + delta);
  return next;
}
