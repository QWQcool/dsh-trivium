/**
 * Source events: keep the host's own locators on every buffered turn, and decide
 * what a candidate's quote is allowed to prove.
 *
 * Only fields the host actually emits are recorded (`event.seq`, `event.time`,
 * `message.id`, role, source kind). Nothing here reconstructs a session, invents
 * a message id, or re-reads the original conversation: when a locator is missing
 * the record says `null` and `recorded: false` instead of guessing.
 *
 * Three separate facts, never merged:
 *   - `recorded`  : did we capture a real event locator?
 *   - `quoteMatch`: does the candidate quote match an allowed source turn?
 *   - `hostText`  : can the original still be read from the host? (no host API,
 *                   so this is always "unavailable" today)
 */

/** Roles a buffered turn can have. */
export const SOURCE_ROLES = Object.freeze(["user", "assistant", "tool"]);

/** Quote text kept on a node. Bounded: the plugin does not archive conversations. */
export const SOURCE_QUOTE_MAX = 240;

/** Minimum length before a substring match is trusted as "same wording". */
const MIN_PARTIAL_QUOTE = 8;

function clipText(value, max) {
  const flat = String(value || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Flatten message content blocks to plain text. Shared with extract.js. */
export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text" && block.text) parts.push(String(block.text));
    else if (block.type === "tool-result" && Array.isArray(block.content)) parts.push(textFromContent(block.content));
    else if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function locatorOf(event, data, msg) {
  const seq = Number(event?.seq ?? data?.seq);
  const at = Number(event?.time ?? data?.time);
  const messageId = msg?.id ?? data?.id ?? data?.messageId;
  const hasSeq = Number.isFinite(seq) && seq >= 0;
  const hasId = typeof messageId === "string" && messageId.trim() !== "";
  const hasAt = Number.isFinite(at) && at > 0;
  return {
    seq: hasSeq ? seq : null,
    at: hasAt ? new Date(at).toISOString() : null,
    messageId: hasId ? String(messageId) : null,
    recorded: hasSeq || hasId,
  };
}

/**
 * Shape one host event into a buffered turn, or null when it must not be buffered.
 * Our own injected map arrives as a user message with `source.kind` = plugin:*;
 * treating it as user wording would let the plugin quote itself as evidence.
 */
export function turnFromEvent(event, { name = "" } = {}) {
  if (!event || !event.type) return null;
  if (event.type === "user/message") {
    const data = event.data || {};
    const kind = data.source?.kind;
    if (kind && kind !== "user") return null;
    const text = clipText(textFromContent(data.content), 500);
    if (!text) return null;
    return { role: "user", text, turn: data.turn ?? null, step: null, name: null, ok: null, ...locatorOf(event, data, data) };
  }
  if (event.type === "assistant/message") {
    const data = event.data || {};
    const msg = data.message || data;
    const text = clipText(textFromContent(msg?.content), 400);
    if (!text) return null;
    return { role: "assistant", text, turn: data.turn ?? null, step: data.step ?? null, name: null, ok: null, ...locatorOf(event, data, msg) };
  }
  if (event.type === "tool/result") {
    const data = event.data || {};
    const msg = data.message || data;
    const content0 = Array.isArray(msg?.content) ? msg.content[0] : null;
    const isError =
      Boolean(data.error || msg?.error) ||
      msg?.isError === true ||
      content0?.isError === true ||
      data.ok === false ||
      msg?.ok === false;
    return {
      role: "tool",
      name: name || "tool",
      ok: !isError,
      text: clipText(textFromContent(msg?.content), 200),
      turn: data.turn ?? null,
      step: data.step ?? null,
      ...locatorOf(event, data, msg),
    };
  }
  return null;
}

/** What we know about a turn's locator, without inventing anything. */
export function turnLocator(turn) {
  // `Number(null)` is 0, which would silently turn "no sequence" into sequence 0
  // and make every legacy turn look like the same event.
  const rawSeq = turn?.seq;
  const seq = rawSeq === null || rawSeq === undefined || rawSeq === "" ? null : Number(rawSeq);
  const validSeq = Number.isFinite(seq) && seq >= 0 ? seq : null;
  const messageId = typeof turn?.messageId === "string" && turn.messageId ? turn.messageId : null;
  const at = typeof turn?.at === "string" && turn.at ? turn.at : null;
  return { known: validSeq !== null || Boolean(messageId), seq: validSeq, messageId, at };
}

/** Append a turn once. A replayed event is the same event, not a new one. */
export function appendSourceTurn(list, turn) {
  if (!turn) return false;
  const target = Array.isArray(list) ? list : null;
  if (!target) return false;
  const locator = turnLocator(turn);
  const duplicate = target.some((row) => {
    if (!row) return false;
    const prior = turnLocator(row);
    const sameLocator = locator.messageId && prior.messageId
      ? locator.messageId === prior.messageId
      : locator.seq !== null && prior.seq !== null && locator.seq === prior.seq;
    if (!sameLocator) return false;
    // Host locators can be reused for updated content or different tool
    // results. Deduplicate only the same effective event, never its siblings.
    return ["role", "text", "name", "ok", "turn", "step"].every((key) => (row[key] ?? null) === (turn[key] ?? null));
  });
  if (duplicate) return false;
  target.push(turn);
  return true;
}

/** Find the buffered turn a quote came from. Only the allowed roles are searched. */
export function matchQuote(quote, turns, { roles = ["user"] } = {}) {
  const wanted = clipText(quote, SOURCE_QUOTE_MAX);
  if (!wanted) return null;
  const pool = (turns || []).filter((turn) => turn && roles.includes(turn.role) && String(turn.text || "").trim());
  for (const turn of pool) {
    if (String(turn.text).trim() === wanted) return { turn, quoteMatch: "exact" };
  }
  if (wanted.length >= MIN_PARTIAL_QUOTE) {
    for (const turn of pool) {
      const text = String(turn.text).trim();
      if (text.includes(wanted) || (text.length >= MIN_PARTIAL_QUOTE && wanted.includes(text))) {
        return { turn, quoteMatch: "partial" };
      }
    }
  }
  return null;
}

/**
 * Build the provenance record written onto a node.
 *
 * `quoteMatch: "none"` still keeps the quote for display, but it is not evidence:
 * a model that writes its own quote must not thereby create user confirmation.
 */
export function buildSource({ quote = "", turns = [], sessionId = "", via = "extract", kind = "" } = {}) {
  const keptQuote = clipText(quote, SOURCE_QUOTE_MAX);
  // Prefer user wording; otherwise still label what the quote actually matched
  // (assistant/tool) so the record cannot be mistaken for user confirmation.
  const hit = keptQuote
    ? matchQuote(keptQuote, turns, { roles: ["user"] }) || matchQuote(keptQuote, turns, { roles: ["assistant", "tool"] })
    : null;
  const turn = hit?.turn || null;
  const locator = turnLocator(turn);
  const kindOf = kind || (via === "chip-add" ? "chip" : via === "tool" ? "tool" : via === "manual" ? "manual" : "extract");
  return {
    kind: kindOf,
    via: String(via || "extract"),
    sessionId: String(sessionId || ""),
    messageId: locator.messageId,
    seq: locator.seq,
    at: locator.at,
    role: turn?.role || "unknown",
    quote: keptQuote,
    quoteMatch: hit?.quoteMatch || "none",
    recorded: locator.known,
    // No host API can re-open the original message; say so instead of faking a link.
    hostText: "unavailable",
  };
}

/** Whether a source record may be treated as something the user actually said. */
export function isUserEvidence(source) {
  return Boolean(source) && source.role === "user" && source.quoteMatch !== "none";
}

import { absoluteDates, resolveRelative } from './date-parse.js';

function evidenceDates(value, turn) {
  let text = value;
  const marker = key => `date_${key.replaceAll('-', '_')}`;
  for (const row of absoluteDates(value)) if (row.key) text = text.replace(row.raw, marker(row.key));
  if (turn?.at) for (const row of resolveRelative(value, Date.parse(turn.at))) text = text.replace(row.expr, marker(row.key));
  return text;
}

export function isMemoryReadTool(name) {
  return /^(?:dsh-trivium[.:/])?ctx_(?:find|read)$/i.test(String(name || ''));
}

export function isMemoryWriteTool(name) {
  return /^(?:dsh-trivium[.:/])?ctx_(?:remember|link)$/i.test(String(name || ''));
}

export function independentCandidateTurn(turn) {
  return turn?.role === 'user' || (turn?.role === 'tool' && turn.ok === true && Boolean(turn.name) && turn.name !== 'tool'
    && !isMemoryReadTool(turn.name) && !isMemoryWriteTool(turn.name));
}

/** Attribution is not semantic entailment. Unknown paraphrases stay pending. */
export function candidateEvidence(candidate, turns = []) {
  const flat = value => String(value || "").replace(/\s+/g, " ").trim().replace(/[。.!！]+$/, "");
  const body = flat(candidate.text || candidate.name);
  const quote = flat(candidate.quote);
  const pool = turns.filter(independentCandidateTurn);
  const atoms = value => (value.match(/[a-z_][a-z0-9_./:@-]*|\p{N}+(?:\.\p{N}+)?(?:%|秒|分钟|小时|天|次|条)?/giu) || []).map(s => s.toLowerCase());
  const negative = value => /不|未|无|别|禁止|并非|\b(?:no|not|never|false|disabled|without)\b/i.test(value);
  const content = value => value.replace(/[a-z_][a-z0-9_./:@-]*|\p{N}+(?:\.\p{N}+)?\s*(?:%|秒|分钟|小时|天|次|条)?/giu, '')
    .replace(/记住|以后|从现在起|更正|调整为|改为|改成|可以|作为|有效期|复用|现在|我们定于|定于|使用|采用|固定|的|是|为|用|都|请/g, "").replace(/[^\p{Script=Han}]/gu, "");
  const ordered = (wanted, actual) => {
    let cursor = 0;
    for (const char of actual) if (char === wanted[cursor]) cursor++;
    return cursor === wanted.length;
  };
  const question = /什么|多少|多久|是否|能否|是不是|查找|查询|读一下|假设|假如|如果|也许|可能|[?？]|\b(?:what|which|how|whether|if|perhaps|maybe)\b/i;
  // “允许读取但不允许删除” asserts permissions; “请读取…” requests a read.
  // Keep bare/read-request wording conservative without rejecting every fact
  // that happens to describe read access.
  const isQuestion = value => question.test(value) || /(?:^|请|帮我|麻烦|先|再|现在|需要|想要)\s*读取/u.test(value);
  for (const turn of pool) {
    if ([candidate.linkName, ...(Array.isArray(candidate.aliases) ? candidate.aliases : [])].filter(Boolean).some(value => !String(turn.text || '').includes(String(value)))) continue;
    const whole = flat(turn.text);
    const literalStart = whole.indexOf(body);
    if (body && literalStart >= 0) {
      const prefix = whole.slice(0, literalStart).split(/[。！？?；;，,\n]/u).at(-1) || '';
      const tail = whole.slice(literalStart + body.length).match(/^[^。！？?；;\n]*[。！？?；;]?/u)?.[0] || '';
      if (negative(prefix + body) === negative(body) && (turn.role !== 'user' || !isQuestion(prefix + body + tail))) {
        return { supported: true, quote: quote && whole.includes(quote) ? candidate.quote : body, reason: 'body-in-source', turn };
      }
    }
    const sentences = String(turn.text || '').match(/[^。！？?；;\n]+[。！？?]?/gu) || [];
    for (const sentence of sentences) {
      if (turn.role === 'user' && isQuestion(sentence)) continue;
      const text = flat(sentence), start = text.indexOf(body);
      // A substring inside “不支持导出” cannot support “支持导出”. Keep the
      // surrounding clause's polarity even for a literal body match.
      const prefix = text.slice(0, start).split(/[，,;；]/u).at(-1) || '';
      if (body && start >= 0 && negative(prefix + body) === negative(body)) {
        return { supported: true, quote: quote && whole.includes(quote) ? candidate.quote : body, reason: 'body-in-source', turn };
      }
    }
    if (quote && (!whole.includes(quote) || quote.length < 6)) continue;
    for (const clause of sentences.filter(sentence => turn.role !== 'user' || !isQuestion(sentence)).flatMap(sentence => sentence.split(/[;；，,]/u))) {
      const text = flat(clause);
      if (!text) continue;
      const normalizedBody = evidenceDates(body, turn), normalizedText = evidenceDates(text, turn);
      const values = atoms(normalizedBody), evidence = atoms(normalizedText);
      if (values.some(value => !evidence.includes(value)) || negative(body) !== negative(text)) continue;
      // Do not infer associations between multiple independent numeric values.
      if (evidence.filter(value => /^\p{N}/u.test(value)).length > 1) continue;
      const required = content(normalizedBody);
      // Preserve subject order; a bag of characters would accept reversed
      // owner/subject relations. A narrow continuation can reuse a named subject.
      const continuation = /^(?:然后|再|现在)?(?:把[^。！？?，,]{1,40})?(?:改成|改为|设为|调整为)/u.test(text)
        && candidate.name && whole.includes(candidate.name) && ordered(required, content(evidenceDates(whole, turn)));
      if (required.length < 2 || (!ordered(required, content(normalizedText)) && !continuation)) continue;
      return { supported: true, quote: candidate.quote || text, reason: "quote-and-values-in-source", turn };
    }
  }
  return { supported: false, reason: "source-unverified" };
}
