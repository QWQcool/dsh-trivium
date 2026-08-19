/** Cheap, checkable token estimate for injection budgets (CJK ≈ 1, ASCII ≈ 1/4). */

export function estimateTokens(text) {
  const s = String(text || "");
  let tokens = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) tokens += 0.25;
    else if (code <= 0x7ff) tokens += 0.5;
    else tokens += 1;
  }
  return Math.ceil(tokens);
}

export function clipToTokenBudget(text, budget) {
  const raw = String(text || "");
  const cap = Math.max(1, Number(budget) || 400);
  if (estimateTokens(raw) <= cap) return raw;
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(raw.slice(0, mid)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  const cut = Math.max(0, lo - 1);
  return `${raw.slice(0, cut)}…`;
}
