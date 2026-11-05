import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { EDGE_LABELS, clip, looksSecret, nowIso } from "./schema.js";
import { sanitizeForWrite } from "./hygiene.js";
import { findMergeTarget, supersedesIn, supersedesOut } from "./store.js";
// B4: every mutation goes through the write port, not through the store directly.
import { memoryWriterFor } from "./memory-writer.js";
import { resolveUntilAt } from "./until.js";
import { buildSource, matchQuote } from "./source-events.js";
import { absoluteDates, allowedDateKeys } from "./date-parse.js";
import { acquireWorkspaceLock } from "./workspace-lock.js";

export const PREFERENCE_CUES =
  /记住|以后都|别再|不要再|从现在起|always do|from now on|never again|remember (?:this|that|to)\b/i;
export const DECISION_CUES =
  /先别动|下周再|采用方案|就用[这那]个|不要改成|postpone|defer until|go with (?:option|plan|方案)/i;
export const ONESHOT_CUES =
  /把这[个份]?文件|改一下.{0,40}文件|只改这|just (?:change|edit|fix) this (?:file|one)|only this file/i;
export const CHITCHAT_CUES =
  /^(哈哈+|呵呵+|嗯+|哦+|好的|谢谢|天气|吃了吗|在吗)[\s!！.。?？]*$/;

/*
 * A decision that *replaces* an earlier one. Without this, "先别动方案 A" and
 * "改用方案 B" sit as two independent decisions, both stay in the short map, and
 * the model can answer with the retired one (A-5: 2/5 on the correction case).
 * Only an explicit replacement word may auto-link; everything else is left alone.
 */
const REPLACEMENT_CUES =
  /更正|改走|改为|改成|改用|换成|换掉|不用了?|别用|不要用|不要了|不再(?:使用|采用|用|走)|替换|取代|放弃|弃用|作废|废弃|deprecat|replace(?:d)?|switch(?:ed)? to/i;

/**
 * How close a bare label ("A" for "方案 A") must sit to the replacement word.
 * Twelve characters covers "不用 A 了，改 B" and "把 A 换成 B" while staying too
 * short to catch a letter that merely appears elsewhere in the sentence.
 */
const BARE_LABEL_CUE_DISTANCE = 12;

/** WorkBuddy-style per-batch write cap. Not a file-size limit. */
export const MAX_WRITE_CHARS = 3000;
export const MAX_LINE_CHARS = 240;
export const EXPLICIT_LINE_CHARS = 2000;
export const MAX_WRITE_ITEMS = 24;

const NAME_RE =
  /`([^`]{2,64})`|\b([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b|\b([A-Z][A-Za-z0-9]*(?:[_-][A-Z][A-Za-z0-9]*)+)\b|\b([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+)\b|\b([A-Z]{3,}[A-Z0-9_-]{0,})\b/g;

const NAME_STOP = new Set([
  "GET",
  "PUT",
  "POST",
  "JSON",
  "HTTP",
  "HTTPS",
  "HTML",
  "CSS",
  "TODO",
  "NULL",
  "TRUE",
  "FALSE",
  "AND",
  "THE",
  "THIS",
  "THAT",
  "FOR",
  "CTX_FIND",
  "CTX_READ",
  "CTX_REMEMBER",
  "CTX_LINK",
]);

const TOOL_DRIVE_CUES = /只用 ctx_|贴工具原文|按顺序调用/;
const PATH_NOISE_NAME = /^(about|decided|fixed|broke|same_as|in_workspace)-\d+$/i;
const FOLDERISH_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+$/i;

const WRITE_TYPES = new Set(["entity", "preference", "decision", "experience"]);

export function pendingPath(cwd) {
  return join(cwd, ".dsh", "trivium-pending.json");
}

function readPendingState(cwd) {
  try {
    const raw = readFileSync(pendingPath(cwd), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") throw new Error("invalid pending data");
    if (Object.hasOwn(data, "windows") && !Array.isArray(data.windows)) throw new Error("invalid pending windows");
    const windows = Array.isArray(data.windows) ? data.windows : [data];
    if (windows.some((row) => !row || typeof row !== "object" || !Array.isArray(row.turns))) throw new Error("invalid pending window");
    if (Object.hasOwn(data, "acknowledged") && (!Array.isArray(data.acknowledged) || data.acknowledged.some((key) => typeof key !== "string"))) throw new Error("invalid pending acknowledgements");
    const acknowledged = Array.isArray(data.acknowledged) ? data.acknowledged : [];
    return { windows, acknowledged };
  } catch (err) {
    if (err?.code === "ENOENT") return { windows: [], acknowledged: [] };
    throw new Error("pending data unavailable");
  }
}

/** Read legacy single-window data and newer ordered, per-session windows. */
export function loadPendingWindows(cwd) { return readPendingState(cwd).windows; }

export function loadPending(cwd) {
  try { return loadPendingWindows(cwd)[0] || null; } catch { return null; }
}

/**
 * What is waiting to be re-written, as counts.
 *
 * A deferred window is invisible today: the extraction was skipped, the turn
 * looks normal, and nothing tells the user that a fact is sitting on disk. The
 * panel needs the shape without the payload — turn text can be long and is not
 * needed to answer "is anything stuck here".
 *
 * `updatedAt` is the file's own mtime: windows carry no timestamp of their own,
 * and inventing one from the turn text would be worse than saying "the file was
 * last touched at".
 */
export function pendingSummary(cwd) {
  const empty = { windows: [], turns: 0, acknowledged: 0, updatedAt: null };
  if (!cwd) return { ...empty, reason: "no-workspace" };
  let state;
  try {
    state = readPendingState(cwd);
  } catch (err) {
    return { ...empty, reason: "unreadable", error: String(err?.message || err).slice(0, 200) };
  }
  let updatedAt = null;
  try {
    updatedAt = statSync(pendingPath(cwd)).mtime.toISOString();
  } catch {
    updatedAt = null;
  }
  return {
    windows: (state.windows || []).map((row) => ({
      sessionId: String(row.sessionId || ""),
      turns: Array.isArray(row.turns) ? row.turns.length : 0,
      // A short preview only: enough to recognise the window, not a transcript.
      preview: String(row.turns?.[0]?.text || "").replace(/\s+/g, " ").slice(0, 80),
    })),
    turns: (state.windows || []).reduce((sum, row) => sum + (Array.isArray(row.turns) ? row.turns.length : 0), 0),
    acknowledged: Array.isArray(state.acknowledged) ? state.acknowledged.length : 0,
    updatedAt,
  };
}

function writePendingState(cwd, { windows, acknowledged }) {
  const file = pendingPath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  if (!windows.length && !acknowledged.length) {
    try { unlinkSync(file); } catch (err) { if (err?.code !== "ENOENT") throw err; }
    return;
  }
  // Keep the original top-level shape readable by old consumers. Only new
  // code may update a multi-window file without losing the additional entries.
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ cwd, savedAt: nowIso(), ...(windows[0] || { sessionId: "", turns: [] }), windows, acknowledged }, null, 2), "utf8");
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  }
}

const pendingUpdates = new Map();
async function performPendingUpdate(cwd, update) {
  const file = `${pendingPath(cwd)}.lock`;
  const deadline = Date.now() + 2000;
  for (;;) {
    const lock = acquireWorkspaceLock(cwd, { file });
    if (lock.ok) {
      try { writePendingState(cwd, update(readPendingState(cwd))); return; }
      finally { lock.release(); }
    }
    if (lock.reason !== "busy" || Date.now() >= deadline) throw new Error("pending write unavailable");
    await new Promise((done) => setTimeout(done, 20));
  }
}

function updatePendingWindows(cwd, update) {
  const key = pendingPath(cwd);
  const before = pendingUpdates.get(key) || Promise.resolve();
  const next = before.catch(() => {}).then(() => performPendingUpdate(cwd, update));
  pendingUpdates.set(key, next);
  void next.then(() => { if (pendingUpdates.get(key) === next) pendingUpdates.delete(key); }, () => { if (pendingUpdates.get(key) === next) pendingUpdates.delete(key); });
  return next;
}

function acknowledgedKey(sessionId, turn) {
  const locator = turn?.messageId ? `message:${turn.messageId}` : Number.isFinite(turn?.seq) ? `seq:${turn.seq}` : turn?.pendingEventId ? `local:${turn.pendingEventId}` : "";
  if (!locator) return "";
  // A locator can be reused by multiple tool results or corrected events.
  // Include the entire turn so suppressing a stale retry cannot drop changed
  // content with the same locator.
  return createHash("sha256").update(JSON.stringify([sessionId, locator, turn])).digest("hex");
}

/**
 * A recorded host sequence orders events within one session. Unknown or
 * legacy turns are barriers: we cannot place them relative to known events.
 */
function orderRecordedTurns(turns) {
  const result = [];
  let run = [];
  const flush = () => {
    run.sort((a, b) => a.turn.seq - b.turn.seq || a.index - b.index);
    result.push(...run.map((item) => item.turn));
    run = [];
  };
  for (const turn of turns) {
    if (turn?.recorded === true && Number.isSafeInteger(turn.seq) && turn.seq >= 0) run.push({ turn, index: run.length });
    else { flush(); result.push(turn); }
  }
  flush();
  return result;
}

export async function savePending(cwd, payload) {
  const sessionId = String(payload?.sessionId || "");
  if (!Array.isArray(payload?.turns)) throw new Error("invalid pending window");
  await updatePendingWindows(cwd, ({ windows, acknowledged }) => {
    const acknowledgedSet = new Set(acknowledged);
    const turns = payload.turns.filter((turn) => !acknowledgedSet.has(acknowledgedKey(sessionId, turn)));
    const next = { ...payload, sessionId, turns };
    const index = windows.findIndex((row) => String(row.sessionId || "") === sessionId);
    if (index < 0) return { windows: turns.length ? [...windows, { ...next, turns: orderRecordedTurns(turns) }] : windows, acknowledged };
    // Multiple processes may hold snapshots for the same session. Merge the
    // maximum multiplicity of each full turn instead of replacing older data.
    const prior = windows[index];
    const counts = new Map();
    for (const turn of prior.turns) {
      const key = JSON.stringify(turn);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const seen = new Map();
    const merged = prior.turns.slice();
    for (const turn of next.turns) {
      const key = JSON.stringify(turn);
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      if (count > (counts.get(key) || 0)) merged.push(turn);
    }
    return { windows: windows.map((row, i) => i === index ? { ...next, turns: orderRecordedTurns(merged) } : row), acknowledged };
  });
}

/** Atomically consume the completed snapshot and preserve newer buffer turns. */
export async function settlePending(cwd, sessionId, consumed, remaining, error) {
  const id = String(sessionId || "");
  await updatePendingWindows(cwd, ({ windows, acknowledged }) => {
    const acknowledgedSet = new Set(acknowledged);
    const counts = new Map();
    for (const turn of consumed || []) {
      const key = JSON.stringify(turn);
      counts.set(key, (counts.get(key) || 0) + 1);
      const eventKey = acknowledgedKey(id, turn);
      if (eventKey) acknowledgedSet.add(eventKey);
    }
    let index = windows.findIndex((row) => String(row.sessionId || "") === id);
    const row = index < 0 ? { sessionId: id, turns: [] } : windows[index];
    const turns = row.turns.filter((turn) => {
      const key = JSON.stringify(turn), remainingCount = counts.get(key) || 0;
      if (!remainingCount) return true;
      counts.set(key, remainingCount - 1);
      return false;
    });
    // Remaining is a snapshot of the live buffer and may already be on disk.
    const countsOnDisk = new Map(), seen = new Map();
    for (const turn of turns) {
      const key = JSON.stringify(turn);
      countsOnDisk.set(key, (countsOnDisk.get(key) || 0) + 1);
    }
    for (const turn of remaining || []) {
      if (acknowledgedSet.has(acknowledgedKey(id, turn))) continue;
      const key = JSON.stringify(turn), count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      if (count > (countsOnDisk.get(key) || 0)) turns.push(turn);
    }
    const next = { ...row, sessionId: id, turns: orderRecordedTurns(turns), ...(error ? { error } : {}) };
    if (!error) delete next.error;
    const entries = index < 0 ? (turns.length ? [...windows, next] : windows)
      : !turns.length ? windows.filter((_, i) => i !== index)
      : windows.map((old, i) => i === index ? next : old);
    return { windows: entries, acknowledged: [...acknowledgedSet].slice(-4096) };
  });
}

/** Legacy explicit clear-all helper. Production replay uses removePendingWindow. */
export function clearPending(cwd) {
  const lock = acquireWorkspaceLock(cwd, { file: `${pendingPath(cwd)}.lock` });
  if (!lock.ok) throw new Error("pending write unavailable");
  try { writePendingState(cwd, { windows: [], acknowledged: [] }); } finally { lock.release(); }
}

// One implementation only: the same flattener is used when buffering host events.
export { textFromContent } from "./source-events.js";

/*
 * A tool-driving instruction may share a turn with a fact:
 *   "按顺序调用工具，生产端口是 9443。"
 * The whole turn must NOT be dropped for that (R3 F1: the fact was consumed
 * without any rule extraction, model extraction or pending retention).
 *
 * Only a turn whose every sentence is a *pure* operation instruction may be
 * dropped. "Pure" means: after removing the cue phrases and the ctx_* tool
 * names, nothing but a short list of instruction filler remains. Any digit,
 * Latin identifier, name or extra clause keeps the turn in the normal path.
 * Over-calling costs a few tokens; dropping loses the fact.
 */
const OPERATION_RESIDUE = /^[请先接着然后再次一下把帮麻烦你我们它将用对贴出工具原文查看看试的了吧吗呢。.？?！!，,、；;：:…\s]{0,10}$/u;

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？!?\n])|(?<=\. )/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPureToolDriveSentence(sentence) {
  const s = String(sentence || "").trim();
  if (!s) return true;
  if (!TOOL_DRIVE_CUES.test(s)) return false;
  const residue = s
    .replace(/只用/g, "")
    .replace(/贴(?:一下)?工具原文/g, "")
    .replace(/按顺序调用/g, "")
    .replace(/\bctx_[a-z_]+\b/gi, "")
    .trim();
  return OPERATION_RESIDUE.test(residue);
}

function isToolDriveTurn(text) {
  const sentences = splitSentences(text);
  return sentences.length > 0 && sentences.every(isPureToolDriveSentence);
}

/** Names a decision can be recognised by when a newer one talks about it. */
function decisionLabels(payload) {
  const labels = new Set();
  const name = String(payload?.name || "").trim();
  if (name.length >= 2 && name.length <= 24) labels.add(name);
  const plan = planNameOf(payload?.text || "");
  if (plan) labels.add(plan);
  return [...labels];
}

/**
 * A sentence that merely mentions a replacement is not a replacement. These are
 * checked on the *user's* sentence, not on the model's paraphrase: discussion,
 * questions, hypotheses, quoted documents and "keep it as is" must never retire
 * a decision that is still in force.
 */
/*
 * Negations and hedges, evaluated **per clause** (see replacementClauses): an
 * unrelated clause such as "日志格式沿用原样" must not veto the correction next
 * to it. "别用 X / 不要用 X" are deliberately NOT here - they are ordinary
 * instructions to stop using something, and treating them as discussion rejected
 * explicit corrections (re-review P1-3).
 */
const NON_REPLACEMENT_CUES =
  /讨论|商量|评估是否|是否(?:要|该)?(?:替换|换掉|更换|改用)|要不要|能不能|可以吗|假如|假设|如果|万一|若是|别替换|不要替换|不必替换|不用替换|不要换|别换|不换|继续保持|继续沿用|保持原样|保持不动|先不动|不动它|暂不|暂时不|先不|翻译|引用|这句|原文|逐字|据(?:说|闻)|听说|文档(?:里|中)?(?:提过|说过|写着)|[?？]/;

/** Everything inside quotation marks, removed: a quotation is not an instruction. */
function stripQuoted(text) {
  return String(text || "").replace(/[“"「『][^”"」』]{0,200}[”"」』]/g, " ");
}

/**
 * A replacement word inside quotation marks is a quotation, not an instruction:
 * "请把「换掉方案 A」翻译成英文" must not retire anything (review R-02).
 */
function cueInsideQuotes(sentence) {
  const text = String(sentence || "");
  const quoted = /[“"「『]([^”"」』]{0,200})[”"」』]/g;
  for (const match of text.matchAll(quoted)) {
    if (REPLACEMENT_CUES.test(match[1])) return true;
  }
  return false;
}

/** A question never instructs. Checked on the whole sentence, quotes removed. */
function isQuestionSentence(sentence) {
  const text = stripQuoted(sentence).trim();
  if (!text) return false;
  if (/[?？]\s*$/.test(text)) return true;
  return /(?:吗|呢)\s*[。.!！]?$/.test(text);
}

/** Asking to translate/explain/quote something is not doing it. */
const META_REQUEST = /翻译|解释|引用|原文|逐字|什么意思|怎么说/;

/** Reporting what someone else said is not issuing an instruction. */
const REPORTED_SPEECH = /(?:^|[，,。；;])\s*(?:他|她|他们|她们|对方|客户|老板|同事|领导|甲方|乙方|朋友|有人)\s*(?:说|说过|表示|要求|提到|问)/;

/** Waiting for a decision that has not been given. */
const UNAPPROVED = /(?:还没有|尚未|没有|没)(?:批准|同意|确认|签字|拍板)/;

/** Split on every statement separator, including the comma (re-review P1-3). */
function clausesOf(sentence) {
  return String(sentence || "")
    // Full-width comma included: "…改用方案 B，日志格式保持原样" must not be one
    // clause, or the keep-as-is half vetoes the correction (re-review P1-A).
    .split(/[。；;！？!?.,、，\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Plans explicitly said to continue: "方案 A 继续使用" retracts the retirement. */
const KEEP_CUES = /继续使用|继续用|继续沿用|还是用|仍然用|照旧|保持不变|继续保留/;

/**
 * One place that decides whether a user sentence asks for a replacement, and
 * which plans it takes away and which it brings in.
 *
 * The guards run on the whole sentence (a trailing question mark belongs to the
 * sentence), the locality guards run per clause (an unrelated "keep as is" clause
 * must not veto the correction next to it). Getting this wrong in either
 * direction has already cost two reviews: whole-sentence guards let a budget
 * sentence pass, clause-only guards let "…换成方案 B？" through.
 */
function replacementContext(sentence) {
  const raw = String(sentence || "");
  if (!raw.trim()) return { ok: false, skipped: "no-sentence" };
  if (isQuestionSentence(raw)) return { ok: false, skipped: "discussion-or-question" };
  if (META_REQUEST.test(stripQuoted(raw)) && !REPLACEMENT_CUES.test(stripQuoted(raw))) {
    return { ok: false, skipped: "meta-request" };
  }
  /*
   * A question in the middle of the sentence still makes the whole thing a
   * question: "方案 A 换成方案 B 吗，请确认。" asks, it does not instruct
   * (re-review P1-1). Reporting and unapproved plans are not instructions either.
   */
  if (REPORTED_SPEECH.test(stripQuoted(raw))) return { ok: false, skipped: "reported-speech" };
  if (UNAPPROVED.test(stripQuoted(raw))) return { ok: false, skipped: "unapproved" };
  const unquoted = stripQuoted(raw);
  if (!REPLACEMENT_CUES.test(unquoted)) {
    return { ok: false, skipped: cueInsideQuotes(raw) ? "quoted-replacement" : "replacement-not-in-user-sentence" };
  }
  const clauses = clausesOf(raw).filter(
    (clause) => REPLACEMENT_CUES.test(stripQuoted(clause)) && !NON_REPLACEMENT_CUES.test(stripQuoted(clause)),
  );
  if (!clauses.length) return { ok: false, skipped: "discussion-or-question" };
  // A cue clause that ends as a question ("换成方案 B 吗") asks, it does not instruct.
  if (clauses.some((clause) => /[?？]\s*$/.test(clause) || /(?:吗|呢)\s*$/.test(clause))) {
    return { ok: false, skipped: "discussion-or-question" };
  }
  const away = new Set();
  const to = new Set();
  const keep = new Set();
  for (const clause of clauses) {
    const text = stripQuoted(clause);
    for (const match of text.matchAll(AWAY_CUES)) {
      const rest = text.slice(match.index + match[0].length).trim();
      const hit = rest.match(/^(?:方案\s*)?([A-Za-z0-9])/);
      if (hit) away.add(hit[1].toUpperCase());
    }
    for (const match of text.matchAll(SWITCH_CUES)) {
      // "改用方案 B" and "方案 A 换成方案 B" both name the *new* plan after the cue.
      const rest = text.slice(match.index + match[0].length).trim();
      const forward = rest.match(/^(?:方案\s*)?([A-Za-z0-9])/);
      if (forward) to.add(forward[1].toUpperCase());
      // Whatever plan the cue is applied to is the one being replaced.
      const before = text.slice(0, match.index);
      const backward = [...before.matchAll(/(?:方案\s*)?([A-Za-z0-9])(?![A-Za-z0-9])/g)].at(-1);
      if (backward) {
        const token = backward[1].toUpperCase();
        if (!forward || forward[1].toUpperCase() !== token) away.add(token);
      }
    }
  }
  // "别用 A，刚才说错了，A 继续使用": the retraction wins over the instruction.
  for (const clause of clausesOf(raw)) {
    const text = stripQuoted(clause);
    if (!KEEP_CUES.test(text)) continue;
    /*
     * "A 不再继续使用" is the opposite of keeping it: a keep phrase behind a
     * negation must not cancel the retirement (re-review P1-3).
     */
    const keepMatch = KEEP_CUES.exec(text);
    const before = keepMatch ? text.slice(Math.max(0, keepMatch.index - 3), keepMatch.index) : "";
    if (/不再|不|别|未|没/.test(before)) continue;
    for (const match of text.matchAll(/(?:方案\s*)?([A-Za-z0-9])(?![A-Za-z0-9])/g)) keep.add(match[1].toUpperCase());
  }
  for (const token of keep) { away.delete(token); to.delete(token); }
  /*
   * A named plan is optional: "上一个方案不要了" names none, and refusing here
   * would turn a spoken correction into "no replacement wording". Target
   * resolution reports `no-target` when the clause really names nothing.
   */
  return { ok: true, clauses, away, to, keep };
}

/**
 * Retire the decision a replacement replaces.
 *
 * A-6 chained every same-label node; W2 replaces that with the stricter rule the
 * plan asks for: the intent must be backed by a matched *user* sentence, exactly
 * one live decision may answer to the label, and ambiguity is left for review
 * instead of guessing. Two live nodes with one label must both stay current —
 * chaining them would hide a fact that was never replaced.
 */
function cuePositions(sentence) {
  const re = new RegExp(REPLACEMENT_CUES.source, "gi");
  const out = [];
  for (const match of String(sentence || "").matchAll(re)) out.push(match.index);
  return out;
}

/**
 * A user writing "不用 A 了" means the decision labelled 「方案 A」.
 * Accept the bare token only when a replacement word sits within
 * BARE_LABEL_CUE_DISTANCE of it, so an unrelated letter cannot match.
 */
function bareLabelHit(sentence, token, positions) {
  const value = String(token || "").trim();
  if (!value || !positions.length) return false;
  const re = /^[A-Za-z0-9]$/.test(value)
    ? new RegExp(`(^|[^A-Za-z0-9])${value}([^A-Za-z0-9]|$)`, "g")
    : new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  for (const match of String(sentence).matchAll(re)) {
    const at = match.index + (match[1] ? match[1].length : 0);
    if (positions.some((pos) => Math.abs(at - pos) <= BARE_LABEL_CUE_DISTANCE)) return true;
  }
  return false;
}

/** Longest label of a live decision that the sentence actually names. */
function matchedLabel(payload, sentence, positions) {
  for (const label of decisionLabels(payload)) {
    if (sentence.includes(label)) return label;
  }
  for (const label of decisionLabels(payload)) {
    const plan = /^方案\s*(.+)$/.exec(label);
    if (plan && bareLabelHit(sentence, plan[1], positions)) return label;
  }
  return null;
}

/**
 * Does this candidate claim to replace an earlier decision, and does the user's
 * own sentence back that claim?
 *
 * Returns `{replacement:true, sentence, positions}` when it may retire something,
 * `{replacement:false, skipped:<code>}` when the model claims it but the source
 * does not support it (reported, not silently dropped), or `null` when the
 * candidate was never about replacing anything.
 */
export function detectReplacementIntent(cand, sourceTurns = []) {
  if (cand?.type !== "decision") return null;
  const text = `${cand.text || ""} ${cand.quote || ""}`;
  const claimsReplacement = REPLACEMENT_CUES.test(text);
  const quote = String(cand.quote || "").trim();
  if (!quote) return claimsReplacement ? { replacement: false, skipped: "no-quote" } : null;
  // The model writing a quote does not make it evidence: it has to be the user's.
  const hit = matchQuote(quote, sourceTurns, { roles: ["user"] });
  if (!hit) return claimsReplacement ? { replacement: false, skipped: "quote-not-in-source" } : null;
  const sentence = String(hit.turn.text || "");
  /*
   * The wording evidence has to come from the user's sentence, never from the
   * candidate: a model that writes "负责人改为张三" must not thereby authorise
   * retiring "方案 A" from a sentence about who owns the release (re-review P1-1).
   */
  const context = replacementContext(sentence);
  if (!context.ok) return claimsReplacement || context.skipped === "quoted-replacement" ? { replacement: false, skipped: context.skipped, sentence } : null;
  return { replacement: true, sentence, context, clauses: context.clauses, positions: cuePositions(context.clauses.join(" ")) };
}

/** "stop using X" — the plan named *after* the cue is the one being replaced. */
const AWAY_CUES = /不再(?:使用|采用|用|走)|别用|不要用|不用了?|弃用|停用|作废|废弃|放弃|替换|取代/g;
/** "switch to Y" — the plan named *before* the cue is the one being replaced. */
const SWITCH_CUES = /改走|改为|改成|改用|换成|换掉/g;

/**
 * Wording that points at "the one before" instead of naming it. Only usable when
 * exactly one live decision exists, because then there is nothing else it can mean.
 */
const DEICTIC_SUPERSEDE = /^(?:上一个|前一个|之前的?|先前(?:的)?|原先的?|原来的?|旧的?|上一条|之前的那个)\s*(?:方案|决定|决策|计划|安排|那条)?$/;

/**
 * The model's explicit `supersedes` claim, checked before anything is retired.
 *
 * Spoken corrections like "上一个方案不要了" carry neither a replacement word nor
 * a label, so the model is asked which fact it replaces. That claim is still only
 * a proposal: it must be backed by a real user turn, must not come from a
 * discussion, and must name exactly one live decision.
 */
function resolveExplicitSupersede(db, cand, sourceTurns) {
  const named = String(cand.supersedes || "").trim();
  if (!named) return null;
  const quote = String(cand.quote || "").trim();
  if (!quote) return { ok: false, skipped: "no-quote" };
  const hit = matchQuote(quote, sourceTurns, { roles: ["user"] });
  if (!hit) return { ok: false, skipped: "quote-not-in-source" };
  const sentence = String(hit.turn.text || "");
  /*
   * The explicit field is a claim about what is being replaced, not a licence to
   * retire something: the turn has to sound like a replacement too, judged by the
   * same sentence-level guards the heuristic path uses. A candidate that words
   * itself as a replacement ("负责人改为张三") must not authorise its own claim.
   */
  const context = replacementContext(sentence);
  if (!context.ok) {
    return { ok: false, skipped: context.skipped === "discussion-or-question" ? "discussion-or-question" : "no-replacement-wording" };
  }
  const directionWrong = (token) => Boolean(token) && context.to.has(token) && !context.away.has(token);
  // A plan the user put back is not replaced, even when the model names it.
  const retracted = (token) => Boolean(token) && context.keep.has(token);
  const named_by_id = String(named).trim();
  const all = [];
  const liveAll = [];
  for (const rawId of db.allNodeIds()) {
    const id = Number(rawId);
    const payload = db.get(id)?.payload;
    if (!payload || payload.type !== "decision" || payload.status === "archived") continue;
    const labels = decisionLabels(payload);
    const isLive = supersedesIn(db, id).length === 0;
    if (isLive) liveAll.push({ id, label: labels[0] || named_by_id });
    const lower = named_by_id.toLowerCase();
    const byLabel = labels.some((label) => label.toLowerCase() === lower);
    const byId = String(id) === named_by_id;
    const byPartial = labels.some((label) => label.toLowerCase().includes(lower) || lower.includes(label.toLowerCase()));
    if (byLabel || byId || byPartial) {
      all.push({ id, label: labels[0] || named_by_id, live: isLive });
    }
  }
  if (!all.length) {
    /*
     * The model often answers with a deictic phrase instead of a label — the live
     * run of 2026-11-02 wrote "上一个方案" for a decision named 「方案 A」. If the
     * workspace has exactly one live decision, that phrase can only mean it; with
     * zero or several, guessing would hide a fact, so it stays unresolved.
     */
    if (DEICTIC_SUPERSEDE.test(named_by_id) && liveAll.length === 1) {
      // "改用方案 B，上一个方案不要了" must not retire the plan being switched *to*.
      if (directionWrong(tokenOfLabel(liveAll[0].label))) {
        return { ok: false, skipped: "supersedes-wrong-direction", candidates: [liveAll[0].id] };
      }
      if (retracted(tokenOfLabel(liveAll[0].label))) {
        return { ok: false, skipped: "supersedes-retracted", candidates: [liveAll[0].id] };
      }
      return { ok: true, id: liveAll[0].id, label: liveAll[0].label, deictic: true };
    }
    if (DEICTIC_SUPERSEDE.test(named_by_id) && liveAll.length > 1) {
      return { ok: false, skipped: "supersedes-ambiguous", candidates: liveAll.map((row) => row.id) };
    }
    return { ok: false, skipped: "supersedes-not-found", deictic: DEICTIC_SUPERSEDE.test(named_by_id) };
  }
  const live = all.filter((row) => row.live);
  // Naming a decision that was already replaced is a different mistake from
  // naming a stranger: report it as such so the status says what happened.
  if (!live.length) return { ok: false, skipped: "supersedes-not-live", candidates: all.map((row) => row.id) };
  if (live.length > 1) return { ok: false, skipped: "supersedes-ambiguous", candidates: live.map((row) => row.id) };
  // The model may name the plan that is being switched *to*; that is the opposite
  // of replacing it (re-review P1-B).
  if (directionWrong(tokenOfLabel(live[0].label))) {
    return { ok: false, skipped: "supersedes-wrong-direction", candidates: [live[0].id] };
  }
  if (retracted(tokenOfLabel(live[0].label))) {
    return { ok: false, skipped: "supersedes-retracted", candidates: [live[0].id] };
  }
  return { ok: true, id: live[0].id, label: live[0].label };
}

/** "方案 B" -> "B", for comparing against the away/switch sets. */
function tokenOfLabel(label) {
  return (/^方案\s*(.+)$/.exec(String(label || ""))?.[1] || "").trim().toUpperCase();
}

function linkReplacementDecision(db, newId, cand, { intent = null, onSupersede, sink = memoryWriterFor(db) } = {}) {
  if (cand.type !== "decision") return;
  if (supersedesOut(db, newId).length) return;
  const report = (row) => {
    if (typeof onSupersede === "function") onSupersede({ from: Number(newId), ...row });
  };
  if (!intent) return;
  if (!intent.replacement) {
    // The model said "replacement" but the user's sentence does not back it.
    report({ to: null, skipped: intent.skipped || "not-supported", sentence: intent.sentence || "" });
    return;
  }
  if (intent.explicit) {
    const targetId = Number(intent.explicit.id);
    if (targetId === Number(newId)) {
      report({ to: null, skipped: "supersedes-self" });
      return;
    }
    const target = db.get(targetId)?.payload;
    if (!target || target.status === "archived" || supersedesIn(db, targetId).length) {
      report({ to: null, skipped: "supersedes-not-live", candidates: [targetId] });
      return;
    }
    try {
      sink.link(newId, targetId, EDGE_LABELS.supersedes);
    } catch {
      markForReview(sink, newId, "supersede-failed");
      report({ to: null, pending: true, reason: "supersede-failed", candidates: [targetId] });
      return;
    }
    report({ to: targetId, label: intent.explicit.label, via: "model", ...(intent.explicit.deictic ? { deictic: true } : {}) });
    return;
  }
  const { sentence } = intent;
  // Labels are matched inside the clause that asks for the replacement, not in the
  // whole sentence: a second clause about budgets must not name the target.
  const clauseText = (intent.clauses || [sentence]).join("；");
  const positions = intent.positions || cuePositions(clauseText);
  const candidateText = String(cand.text || "");
  const candidateIsReplacement = REPLACEMENT_CUES.test(candidateText);
  const context = intent.context || replacementContext(sentence);
  const away = context.ok ? context.away : new Set();
  const to = context.ok ? context.to : new Set();
  const tokenOf = tokenOfLabel;
  const mentionedIn = (text, label) => {
    const token = tokenOf(label);
    return text.includes(label) || (Boolean(token) && new RegExp(`(^|[^A-Za-z0-9])${token}([^A-Za-z0-9]|$)`).test(text));
  };
  /** Is this candidate about the same subject as the decision it would retire? */
  const mentionsNewPlan = [...to].some((token) => new RegExp(`(^|[^A-Za-z0-9])${token}([^A-Za-z0-9]|$)`).test(candidateText));
  const sameSubject = (payload, label) => {
    const targetName = String(payload?.name || "").trim().toLowerCase().replace(/\s+/g, "");
    const candidateName = String(cand.name || "").trim().toLowerCase().replace(/\s+/g, "");
    if (targetName && candidateName && (candidateName.includes(targetName) || targetName.includes(candidateName))) return true;
    // The candidate that states the new plan *is* the replacement, even when it
    // does not restate the old one ("本次上线使用方案 B") - re-review P1-C.
    return candidateIsReplacement || mentionedIn(candidateText, label) || mentionsNewPlan;
  };
  const targets = [];
  for (const rawId of db.allNodeIds()) {
    const id = Number(rawId);
    if (id === Number(newId)) continue;
    const payload = db.get(id)?.payload;
    if (!payload || payload.type !== "decision" || payload.status === "archived") continue;
    if (supersedesIn(db, id).length) continue;
    const label = matchedLabel(payload, clauseText, positions);
    if (!label) continue;
    const token = tokenOf(label);
    // A plan the user put back ("刚才说错了，方案 A 继续使用") is not replaced.
    if (token && context.ok && context.keep?.has(token)) continue;
    // The plan being switched *to* is never the one being replaced.
    if (token && to.has(token) && !away.has(token)) continue;
    // When the sentence says which plan to stop using, only that plan may be retired.
    if (away.size && (!token || !away.has(token))) continue;
    /*
     * Sharing a sentence with a correction does not make a candidate a
     * correction: a budget fact about 方案 B names the new plan but replaces
     * nothing. Bind by subject (name, cue, or naming the target) instead.
     */
    if (!sameSubject(payload, label)) continue;
    targets.push({ id, label });
  }
  if (!targets.length) {
    report({ to: null, skipped: "no-target", sentence });
    return;
  }
  if (targets.length > 1) {
    // More than one live node answers to that label. Do not chain, do not pick:
    // keep every existing fact current and mark the new one for review.
    markForReview(sink, newId, "ambiguous-supersede");
    report({ to: null, pending: true, reason: "ambiguous-supersede", candidates: targets.map((row) => row.id) });
    return;
  }
  const target = targets[0];
  try {
    sink.link(newId, target.id, EDGE_LABELS.supersedes);
  } catch {
    // A half chain is worse than none: leave both current and ask for review.
    markForReview(sink, newId, "supersede-failed");
    report({ to: null, pending: true, reason: "supersede-failed", candidates: [target.id] });
    return;
  }
  report({ to: target.id, label: target.label });
}

/** Mark a decision as not-yet-confirmed so the short map never offers it. */
function markForReview(sink, id, reason) {
  try {
    sink.update(Number(id), { review: String(reason) });
  } catch {
    // Review marking is advisory; the fact itself is already written.
  }
}

function distillableTurns(turns) {
  return (turns || []).filter((t) => (t.role === "tool" || String(t.text || "").trim()) && (t.role !== "user" || !isToolDriveTurn(t.text)));
}

function isNoiseName(name) {
  const s = String(name || "").trim();
  if (!s) return true;
  if (PATH_NOISE_NAME.test(s) || FOLDERISH_NAME.test(s)) return true;
  if (/^session-[0-9a-f-]+$/i.test(s)) return true;
  if (/^ctx[_-]?(find|read|remember|link)$/i.test(s)) return true;
  return false;
}

function planNameOf(span) {
  const m = String(span || "").match(/方案\s*([A-Za-z0-9甲乙丙丁一二三四五六七八九十])(?![A-Za-z0-9_-])/u);
  return m ? `方案 ${m[1]}` : undefined;
}

function cueSpans(text, re) {
  const parts = String(text || "")
    .split(/(?<=[。！？\n])|(?<=\. )/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const hits = parts.filter((p) => re.test(p));
  return hits.length ? hits : [String(text || "").trim()].filter(Boolean);
}

function cueSpan(text, re) {
  return cueSpans(text, re)[0] || String(text || "").trim();
}

function adjacentLinkName(span, turnText) {
  const parts = String(turnText || "")
    .split(/(?<=[。！？\n])|(?<=\. )/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = parts.indexOf(span);
  if (idx < 0) return undefined;
  for (const neighbor of [parts[idx - 1], parts[idx + 1]]) {
    if (!neighbor || PREFERENCE_CUES.test(neighbor) || DECISION_CUES.test(neighbor)) continue;
    const name = collectNames(neighbor, 1)[0]?.name;
    if (name) return name;
  }
  return undefined;
}

function linkNameOf(span, turnText, uniqueTurn, { inSpanOnly = false } = {}) {
  const inSpan = collectNames(span, 1)[0]?.name;
  if (inSpan) return inSpan;
  if (inSpanOnly) return undefined;
  return (
    adjacentLinkName(span, turnText) ||
    (uniqueTurn ? collectNames(turnText, 1)[0]?.name : undefined)
  );
}

export function firstEntityName(text) {
  return collectNames(text, 1)[0]?.name;
}

function collectNames(text, min = 2) {
  const counts = new Map();
  const s = String(text || "");
  NAME_RE.lastIndex = 0;
  let match;
  while ((match = NAME_RE.exec(s))) {
    const name = (match[1] || match[2] || match[3] || match[4] || match[5] || "").trim();
    if (!name || NAME_STOP.has(name.toUpperCase()) || isNoiseName(name)) continue;
    if (/^E[A-Z]{3,}$/.test(name)) continue;
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    const cur = counts.get(key) || { name, n: 0 };
    cur.n += 1;
    counts.set(key, cur);
  }
  return [...counts.values()].filter((row) => row.n >= min);
}

/**
 * True when one user turn cannot carry a durable fact: short continuation
 * phrasing, no explicit cue, and nothing that looks like a name or code.
 */
// Only complete, content-free utterances qualify. Prefixes, pronouns and
// unrecognised wording are evidence of uncertainty, never proof of emptiness.
const EMPTY_UTTERANCE = /^(?:继续|接着|往下|下一步|开始|动手|推进|好的|好|收到|谢谢|嗯|哦|ok|okay|ack|thanks|thank you|go on|continue|next|carry on)[\s.!！。?？]*$/i;
export function isFillerTurn(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return !value || EMPTY_UTTERANCE.test(value);
}

/*
 * ---- B1: two-level event screening -----------------------------------------
 *
 * This is the program-level half of "fast filter, then semantic judgement". It
 * exists to stop paying a model call for a turn that provably carries no fact;
 * the semantic half stays where it already was (the extraction call itself), so
 * screening never adds a request.
 *
 * The rule for a zero is deliberately the narrowest one that still pays:
 * **the whole utterance must match a complete whitelist entry**. Any prefix, any
 * pronoun, any unrecognised wording, any sentence punctuation beyond a single
 * trailing mark, any CJK character outside the greeting list, and anything over
 * 120 characters scores 1 instead. A false 0 loses a fact silently; a false 1
 * only costs what the plugin already paid before this change.
 */

/*
 * Audit F2, option B (2026-11-04): the shell / slash-command / path / URL / CJK
 * shape rules were removed. "Shaped like a command" never proved "carries no
 * fact", and the zeros they produced could not be recovered.
 */

/**
 * Score one event text: 0 = provably no fact, 1 = maybe, 2 = states a fact.
 *
 * `rule` is returned for auditing: every zero can be traced to one complete
 * whitelist entry, never to a prefix or a heuristic score.
 */
export function screenEventDetail(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return { score: 0, rule: "empty" };
  // A stated preference/decision outranks every "no fact" rule below.
  if (PREFERENCE_CUES.test(value) || DECISION_CUES.test(value)) return { score: 2, rule: "cue" };
  if (value.length > 120) return { score: 1, rule: "long" };
  /*
   * Option B after audit F2 (2026-11-04): the only zeros left are "no content at
   * all" and the two filler lists.
   *
   * The command / path / URL / single-character rules were deleted rather than
   * demoted. They claimed to prove "this text carries no fact" from its shape, and
   * the audit produced a counterexample on the first try ("npm is the package
   * manager for this project"). Since a mixed window is never trimmed any more,
   * keeping them would only buy the savings on command-only windows — measured at
   * 0.0% on a command-heavy corpus — in exchange for a class of silent losses.
   */
  if (!/[\p{L}\p{N}\u4e00-\u9fff]/u.test(value)) return { score: 0, rule: "punctuation" };
  if (EMPTY_UTTERANCE.test(value)) return { score: 0, rule: "filler" };
  if (CHITCHAT_CUES.test(value)) return { score: 0, rule: "chitchat" };
  return { score: 1, rule: "content" };
}

/** The public shape promised by the work order. */
export function screenEvent(text) {
  return screenEventDetail(text).score;
}

/**
 * Screen a whole extraction window.
 *
 * Turns are grouped under their user turn so a reply keeps the message it
 * answers; a group scores the maximum of its user text, and any group holding a
 * tool result is at least 1 (a failing command is evidence even when the
 * instruction itself is content-free). Groups scoring 0 are dropped; groups
 * scoring 2 are moved to the front, and the order inside each score is kept.
 */
export function screenTurns(turns) {
  const groups = [];
  for (const turn of turns || []) {
    const isUser = turn?.role === "user";
    if (isUser || !groups.length) {
      const detail = isUser ? screenEventDetail(turn.text) : { score: 0, rule: "tool-only" };
      groups.push({ turns: [turn], score: detail.score, rule: detail.rule });
      continue;
    }
    groups[groups.length - 1].turns.push(turn);
  }
  for (const group of groups) {
    if (group.turns.some((turn) => turn?.role === "tool") && group.score === 0) {
      group.score = 1;
      group.rule = "tool-evidence";
    }
  }
  const zeros = groups.filter((group) => group.score === 0);
  const kept = groups.filter((group) => group.score > 0).sort((a, b) => b.score - a.score);
  /*
   * Zero groups are dropped **only when the whole window is zero**.
   *
   * Audit F2: in a mixed window the old code deleted the zero groups while
   * extracting the rest, so a fact sitting in a short reply was lost even though
   * the window was processed. Deleting content is only defensible when nothing
   * else would have been sent either.
   */
  const wholeWindowZero = kept.length === 0;
  const dropped = wholeWindowZero ? zeros : [];
  /*
   * In a mixed window the zero groups travel with the rest: scoring 0 only means
   * "unlikely to state a fact", and dropping that turn is how the audit's fact got
   * lost. Ordering still promotes the 2s, because that is a batching hint rather
   * than a filter.
   */
  const ordered = wholeWindowZero ? [] : [...groups].sort((a, b) => b.score - a.score);
  return {
    // Stable sort: among equal scores the original order is preserved, so a 2
    // is promoted without shuffling the rest of the conversation.
    turns: ordered.flatMap((group) => group.turns),
    dropped: dropped.flatMap((group) => group.turns),
    promoted: kept.filter((group) => group.score === 2).length,
    counts: { scored0: zeros.length, scored1: kept.filter((g) => g.score === 1).length, scored2: kept.filter((g) => g.score === 2).length },
    // Bounded, per-window record of what a zero would have discarded, so a
    // screened reply can at least be inspected in the diagnostics card.
    audit: zeros.map((group) => ({
      rule: group.rule,
      score: 0,
      text: String(group.turns[0]?.text || "").replace(/\s+/g, " ").slice(0, 120),
      turns: group.turns.length,
      dropped: wholeWindowZero,
    })),
  };
}

export function shouldExtractBatch(turns) {
  const usable = distillableTurns(turns);
  if (!usable.length) return { call: false, reason: "empty" };
  if (usable.some((t) => t.role === "tool")) return { call: true, reason: "tool-evidence" };
  if (usable.some((t) => !isFillerTurn(t.text))) return { call: true, reason: "window-content" };
  return { call: false, reason: "filler-only" };
}

function turnsText(turns) {
  return (turns || [])
    .map((t) => `${t.role}: ${t.text || ""}`)
    .join("\n");
}

function precedingUserText(usable, toolTurn) {
  const idx = usable.indexOf(toolTurn);
  const end = idx < 0 ? usable.length : idx;
  for (let i = end - 1; i >= 0; i--) {
    if (usable[i].role === "user") return String(usable[i].text || "");
  }
  return "";
}

export function ruleCandidates(turns) {
  const out = [];
  const usable = distillableTurns(turns);

  for (const turn of usable) {
    if (turn.role !== "user") continue;
    const text = String(turn.text || "").trim();
    if (!text || CHITCHAT_CUES.test(text)) continue;
    const prefSpans = PREFERENCE_CUES.test(text) ? cueSpans(text, PREFERENCE_CUES) : [];
    const decisionSpans = DECISION_CUES.test(text) ? cueSpans(text, DECISION_CUES) : [];
    const uniqueTurn = prefSpans.length + decisionSpans.length <= 1;

    for (const span of prefSpans) {
      if (looksSecret(span)) continue;
      if (ONESHOT_CUES.test(span) && !PREFERENCE_CUES.test(span)) continue;
      out.push({
        type: "preference",
        text: clip(span, 240),
        quote: clip(span, 120),
        linkName: linkNameOf(span, text, uniqueTurn, { inSpanOnly: true }),
        linkLabel: EDGE_LABELS.about,
        via: "rule",
      });
    }

    for (const span of decisionSpans) {
      if (looksSecret(span) || ONESHOT_CUES.test(span)) continue;
      const plan = planNameOf(span);
      if (plan) {
        out.push({
          type: "entity",
          name: plan,
          text: plan,
          via: "rule",
        });
      }
      const object = linkNameOf(span, text, uniqueTurn) || plan;
      out.push({
        type: "decision",
        name: object,
        text: clip(span, 240),
        linkName: object,
        linkLabel: EDGE_LABELS.decided,
        quote: clip(span, 120),
        via: "rule",
      });
    }
  }

  for (const row of collectNames(turnsText(usable.filter((t) => t.role === "user")))) {
    out.push({
      type: "entity",
      name: row.name,
      text: row.name,
      via: "rule",
    });
  }

  const byTurn = new Map();
  for (const turn of usable) {
    if (turn.role !== "tool") continue;
    const key = `${turn.turn ?? 0}:${turn.name || ""}`;
    const list = byTurn.get(key) || [];
    list.push(turn);
    byTurn.set(key, list);
  }
  for (const list of byTurn.values()) {
    const failed = list.find((t) => t.ok === false);
    const ok = list.find((t) => t.ok === true);
    if (!failed || !ok) continue;
    const around = usable
      .filter((t) => t.role === "user" && (t.turn === failed.turn || t.turn === ok.turn))
      .map((t) => t.text)
      .join(" ");
    const nearby = precedingUserText(usable, failed);
    const linkName =
      collectNames(`${failed.text || ""} ${ok.text || ""}`, 1)[0]?.name ||
      collectNames(around, 1)[0]?.name ||
      collectNames(nearby, 1)[0]?.name;
    out.push({
      type: "experience",
      name: failed.name || "tool",
      text: `${failed.name || "tool"} failed then succeeded`,
      fail: clip(failed.text, 160),
      fix: clip(ok.text, 160),
      linkName,
      linkLabel: EDGE_LABELS.fixed,
      via: "rule",
    });
  }

  return out;
}

/*
 * Absolute dates the model writes must come from the conversation. A-5 caught
 * "On 2026-04-06 (per conversation context), user corrected: ..." in a session
 * that happened on 2026-10-30. The date is dropped and reported; the fact stays,
 * because dropping the whole fact would be a bigger loss than a missing date.
 */
/* Date parsing lives in one place, with an explicit anchor (lib/date-parse.js). */

/*
 * A date is only allowed when the user's own sentence supports it:
 *   - the same calendar date was written in the window, or
 *   - that sentence has exactly one determinate relative expression and the date
 *     equals what it resolves to from *that turn's* timestamp.
 * The old wide-window allowance ("somewhere between now-7d and now+400d") is
 * gone: it let "明天复盘" authorise 2027-03-01 (F-W02).
 */
function scrubUnsupportedDates(text, { windowText = "", sentence = "", anchorMs = null } = {}) {
  const found = absoluteDates(text);
  if (!found.length) return { text, removed: [], adjusted: [] };
  const allowed = allowedDateKeys({ sentence, anchorMs, windowText });
  const bad = found.filter((row) => !row.key || !allowed.has(row.key));
  if (!bad.length) return { text, removed: [], adjusted: [] };
  let out = String(text);
  for (const row of bad) {
    const raw = row.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Prefix form: "On 2026-04-06, ..." / "2026-04-06 时，..." / "在 2026-04-06，..."
    // The trailing connector belongs to the date: dropping "2026-07-13 起采用方案 B"
    // without also dropping "起" left "起采用方案 B" in a live run (W7).
    out = out.replace(new RegExp(`(?:^|[。！？\\n])\\s*(?:On\\s+|on\\s+|在\\s*)?${raw}\\s*(?:时|当天|当日|起|开始|起算)?\\s*[,，、]?\\s*`, "g"), (m) => (m.startsWith("\n") ? "\n" : ""));
    // Parenthesised / trailing forms, then the bare token.
    out = out.replace(new RegExp(`[（(]\\s*${raw}\\s*[)）]`, "g"), "");
    out = out.replace(new RegExp(`\\s*[,，、]?\\s*${raw}\\s*(?:时|当天|当日)?`, "g"), "");
  }
  // A removed prefix date can also leave a leading connector behind.
  out = out.replace(/\s{2,}/g, " ").replace(/^[\s,，、。;；:：]*(?:起|开始|起算)(?=[^\s])?/, "").replace(/^[\s,，、。;；:：]+/, "").replace(/[\s,，、]+$/g, "").trim();
  return {
    text: out,
    removed: bad.map((row) => row.key || row.raw),
    adjusted: bad.map((row) => ({
      raw: row.raw,
      key: row.key,
      // "not a real date" and "no source supports it" are different defects.
      reason: row.key ? "unsupported-date" : "invalid-date",
    })),
  };
}

export function filterCandidates(candidates, { importFile = false, explicit = false, onSkip, onAdjust, sourceText = "", sourceTurns = [] } = {}) {
  const skip = (reason, raw) => {
    if (typeof onSkip !== "function") return;
    // A secret's own text must not travel into logs or status: report the shape
    // ("type=decision, 40 chars") and nothing else.
    const text = String(raw?.text || raw?.name || "");
    onSkip({
      reason,
      type: String(raw?.type || ""),
      length: text.length,
      preview: reason === "secret" ? "<redacted>" : clip(text, 40),
    });
  };
  const seen = new Set();
  const out = [];
  const caps = importFile || explicit
    ? { entity: 24, preference: 24, decision: 12, experience: 8 }
    : { entity: 8, preference: 8, decision: 6, experience: 4 };
  const used = { entity: 0, preference: 0, decision: 0, experience: 0 };
  for (const raw of candidates || []) {
    if (!raw || !WRITE_TYPES.has(raw.type)) continue;
    let text = String(raw.text || raw.name || "").trim();
    if (!text) continue;
    if (raw.type === "entity" && isNoiseName(raw.name || text)) continue;
    /*
     * The credential gate runs FIRST, before anything can quote this text back.
     * It used to run after the date scrub, and an adjusted.preview built from a
     * secret-looking candidate was then served by /status (review R-05).
     */
    const preGate = sanitizeForWrite(`${text}\n${raw.fail || ""}\n${raw.fix || ""}\n${raw.quote || ""}`);
    if (!preGate.ok && preGate.reason !== "empty") { skip(preGate.reason, raw); continue; }
    /*
     * Anchor the date check on the sentence that supports this candidate: the
     * matched user turn gives both the wording ("明天") and its own timestamp.
     * Another sentence's relative expression cannot authorise this candidate.
     */
    const sourceHit = raw.quote ? matchQuote(String(raw.quote), sourceTurns, { roles: ["user"] }) : null;
    const sentence = sourceHit ? String(sourceHit.turn.text || "") : "";
    const anchorMs = sourceHit?.turn?.at ? Date.parse(sourceHit.turn.at) : null;
    const scrubbed = scrubUnsupportedDates(text, { windowText: sourceText, sentence, anchorMs });
    if (scrubbed.removed.length) {
      // Nothing left once the invented date is gone: refuse rather than store a stub.
      if (scrubbed.text.length < 6) {
        skip(scrubbed.adjusted[0]?.reason || "unsupported-date", { ...raw, text });
        continue;
      }
      text = scrubbed.text;
      if (typeof onAdjust === "function") {
        // The preview is diagnostics, and diagnostics must not become the leak:
        // a value that would be refused today is reported as redacted instead.
        const previewGate = sanitizeForWrite(String(text || ""));
        onAdjust({
          reason: scrubbed.adjusted[0]?.reason || "unsupported-date",
          type: String(raw.type || ""),
          removed: scrubbed.removed,
          details: scrubbed.adjusted,
          preview: previewGate.ok ? clip(text, 40) : "<redacted>",
        });
      }
    }
    const blob = `${text}\n${raw.fail || ""}\n${raw.fix || ""}\n${raw.quote || ""}`;
    const gate = sanitizeForWrite(blob);
    if (!gate.ok && gate.reason !== "empty") { skip(gate.reason, raw); continue; }
    if (raw.type === "preference" && !explicit) {
      const blob = `${raw.text || ""} ${raw.quote || ""}`;
      if (CHITCHAT_CUES.test(String(raw.text || "").trim())) continue;
      if (ONESHOT_CUES.test(blob) && !PREFERENCE_CUES.test(blob)) continue;
      if (!importFile && !PREFERENCE_CUES.test(blob)) continue;
    }
    if ((used[raw.type] || 0) >= (caps[raw.type] || 4)) continue;
    const key = `${raw.type}|${(raw.name || "").toLowerCase()}|${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    used[raw.type] = (used[raw.type] || 0) + 1;
    out.push({
      type: raw.type,
      name: raw.name ? String(raw.name).slice(0, 80) : undefined,
      text: clip(text, explicit ? EXPLICIT_LINE_CHARS : MAX_LINE_CHARS),
      linkName: raw.linkName ? String(raw.linkName).slice(0, 80) : undefined,
      linkLabel: raw.linkLabel || undefined,
      fail: raw.fail ? clip(raw.fail, 200) : undefined,
      fix: raw.fix ? clip(raw.fix, 200) : undefined,
      until: raw.until ? String(raw.until).slice(0, 40) : undefined,
      quote: raw.quote ? clip(raw.quote, 160) : undefined,
      // Which earlier decision this one replaces, as named by the model.
      supersedes: raw.supersedes ? String(raw.supersedes).slice(0, 80) : undefined,
      aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String).slice(0, 8) : undefined,
    });
  }
  return out;
}

export function parseModelJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    const list = Array.isArray(parsed?.candidates)
      ? parsed.candidates
      : Array.isArray(parsed)
        ? parsed
        : [];
    return list.map((item) => ({ ...item, via: "model" }));
  } catch {
    return [];
  }
}

/**
 * Does the window plainly state a decision? Used only to decide whether an empty
 * answer deserves one more question, so it is deliberately narrow: a plan label,
 * or an explicit decision verb followed by an action.
 */
const DECISION_SHAPE =
  /方案\s*[A-Za-z0-9一二三四五六七八九十]|(?:决定|确定|采用|改用|改成|敲定|定下来)[^。！？\n]{0,12}(?:走|执行|上线|发布|办|用|吧)|按[^。！？\n]{0,10}走|不再使用|作废|放弃/;

function looksLikeDecision(turns) {
  return (turns || []).some((t) => t.role === "user" && DECISION_SHAPE.test(String(t.text || "").replace(/\s+/g, "")));
}

export function buildExtractPrompt(turns, { strictRetry = false } = {}) {
  const transcript = clip(turnsText(turns), 2400);
  return [
    "Extract durable memory candidates as JSON only.",
    'Shape: {"candidates":[{"type":"preference|entity|decision|experience","name":"","text":"","linkName":"","linkLabel":"about|decided|broke|fixed","fail":"","fix":"","quote":"","supersedes":""}]}',
    "Whitelist: 记住/以后都/别再 → preference; repeated proper names → entity; decision with an object (先别动/下周再/采用方案) → decision; tool fail then success in the same turn → experience.",
    "Do not write chitchat or one-off file edits as preference. Do not store secrets, tool dumps, or whole conversations.",
    "Keep dates in the fact text. Do not infer expiry or emit until/untilAt; expiry is set explicitly through the memory tools or settings.",
    /*
     * Spoken corrections often contain no replacement word and no label
     * ("上一个方案不要了"). The model is the only party that can say which fact is
     * being replaced, so ask it directly; the write path still verifies that the
     * named decision is live and unique before retiring anything.
     */
    'supersedes: the name or label of the earlier decision this one replaces (for example "方案 A"). Leave it empty when nothing is replaced, and never guess.',
    "If nothing matches, return {\"candidates\":[]}.",
    ...(strictRetry
      ? ['A previous attempt on this exact text returned no candidates. Re-read it: if any sentence fixes, changes or retires a decision, return that decision with its quote; if there really is nothing durable, return {"candidates":[]} again.']
      : []),
    "",
    transcript,
  ].join("\n");
}

/**
 * Same type, same name, same body — regardless of whether the node already sits
 * in a revision chain. Used to make a repeated replacement write idempotent
 * without reopening the substring merge that hid corrections in the first place.
 */
/**
 * Two writes of the same fact.
 *
 * Exact text first. Failing that, the same event (message id, or sequence when a
 * message id is missing) plus the same type and the same name is the same write
 * seen twice: the model paraphrases between passes, so text equality alone misses
 * it. Different events are never folded together here — that stays the job of the
 * explicit replacement path.
 */
function findDuplicateWrite(db, cand, source, { replacement = false } = {}) {
  const exact = findExactDuplicate(db, cand);
  if (exact != null) return exact;
  const messageId = String(source?.messageId || "");
  const seq = source?.seq ?? null;
  if (!messageId && seq == null) return null;
  const type = String(cand?.type || "");
  const name = String(cand?.name || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!type) return null;
  const sessionId = String(source?.sessionId || "");
  const sameEvent = (payload) => {
    const nodeSource = payload.source || {};
    if (messageId) return String(nodeSource.messageId || "") === messageId;
    if (seq == null) return false;
    if (Number(nodeSource.seq) !== Number(seq)) return false;
    /*
     * A sequence number is only unique inside one session. Two sessions both
     * numbering their first message "1" are not the same event, and treating
     * them as one merged a new correction into an old node (review R-03).
     */
    return Boolean(sessionId) && String(nodeSource.sessionId || "") === sessionId;
  };
  for (const rawId of db.allNodeIds()) {
    const id = Number(rawId);
    const payload = db.get(id)?.payload;
    if (!payload || payload.type !== type) continue;
    if (!sameEvent(payload)) continue;
    const sameName = name && String(payload.name || "").trim().toLowerCase().replace(/\s+/g, "") === name;
    if (sameName) return id;
  }
  return null;
}

function findExactDuplicate(db, cand) {
  const type = String(cand?.type || "");
  const name = String(cand?.name || "").trim().toLowerCase();
  const text = String(cand?.text || "").trim().toLowerCase();
  if (!type || !text) return null;
  for (const rawId of db.allNodeIds()) {
    const id = Number(rawId);
    const payload = db.get(id)?.payload;
    if (!payload || payload.type !== type) continue;
    if (String(payload.name || "").trim().toLowerCase() !== name) continue;
    if (String(payload.text || "").trim().toLowerCase() !== text) continue;
    return id;
  }
  return null;
}

function resolveEntityId(db, name) {
  if (!name) return null;
  return findMergeTarget(db, { type: "entity", name, text: name });
}

/** Drop the tail once the WorkBuddy-style char/item budget is spent. */
export function capWriteBatch(candidates, { maxChars = MAX_WRITE_CHARS, maxItems = MAX_WRITE_ITEMS } = {}) {
  const kept = [];
  let used = 0;
  for (const cand of candidates || []) {
    if (kept.length >= maxItems) break;
    const n = String(cand.text || cand.name || "").length;
    if (used + n > maxChars && kept.length) break;
    if (n > maxChars && !kept.length) {
      kept.push({ ...cand, text: clip(cand.text || cand.name || "", MAX_LINE_CHARS) });
      used += Math.min(n, MAX_LINE_CHARS);
      break;
    }
    kept.push(cand);
    used += n;
  }
  return { kept, used, dropped: Math.max(0, (candidates || []).length - kept.length) };
}

/** Legacy channel name → the stable provenance kind the UI reports. */
function sourceKindOfVia(via) {
  const value = String(via || "");
  if (value === "chip-add") return "chip";
  if (value === "workbuddy-import" || value === "external-import") return "import";
  if (value === "tool") return "tool";
  if (value === "manual") return "manual";
  return "extract";
}

export function applyCandidates(db, candidates, { sessionId, via, onSkip, onSupersede, onAdjust, sourceText = "", sourceTurns = [], now = new Date(), writer } = {}) {
  /*
   * B4: the four mutations below go through the write port. `db` stays for the
   * reads (duplicate detection, merge targets, replacement candidates) — the
   * port is a write boundary, not a database abstraction.
   */
  const sink = memoryWriterFor(db, writer);
  const { kept: list } = capWriteBatch(
    filterCandidates(candidates, {
      importFile: via === "workbuddy-import" || via === "external-import",
      explicit: via === "chip-add",
      onSkip,
      onAdjust,
      sourceText,
      sourceTurns,
    }),
  );
  /*
   * Which candidate owns the retirement must not depend on the order the model
   * happened to list them: a budget fact listed first used to become the chain
   * head and hide the plan (re-review P1-4). Replacements go first, stably.
   */
  const replacementRank = (candidate) =>
    String(candidate.supersedes || "").trim() ? 0 : REPLACEMENT_CUES.test(String(candidate.text || "")) ? 1 : 2;
  const ordered = [
    ...list.filter((c) => c.type === "entity"),
    ...list.filter((c) => c.type !== "entity").sort((a, b) => replacementRank(a) - replacementRank(b)),
  ];
  const applied = [];
  for (const cand of ordered) {
    /*
     * A replacement must not be folded into the node it replaces.
     *
     * store.findMergeTarget merges on body-substring containment, so a model that
     * restates the old decision and appends the correction ("先按 A，随后改 B")
     * overwrote the old body in place: one node, old text gone, and no edge was
     * possible because the new id *was* the old id. When the user's own sentence
     * backs a replacement, insert a new node instead and let the link decide.
     */
    const explicit = resolveExplicitSupersede(db, cand, sourceTurns);
    /*
     * A wrong explicit target is not a reason to do nothing: the model named the
     * plan being switched *to*, while the sentence still says which one it drops.
     * Fall back to the sentence-level path instead of losing the retirement.
     */
    const intent = explicit?.ok
      ? { replacement: true, explicit }
      : explicit?.skipped === "supersedes-wrong-direction"
        ? detectReplacementIntent(cand, sourceTurns) || { replacement: false, skipped: explicit.skipped }
        : explicit
          ? { replacement: false, skipped: explicit.skipped }
          : detectReplacementIntent(cand, sourceTurns);
    /*
     * A replacement refuses the substring merge above, but it must still be
     * idempotent: the same window is routinely processed twice (pending replay,
     * then the turn end), and each pass would insert another copy of the same
     * sentence. An exact type+name+text match is the retry of a write we already
     * made, not a new fact, so it is merged into itself (which changes nothing).
     */
    /*
     * `kind` stays the legacy channel name; the rest is what the host really
     * emitted (sequence, message id, source time, role). A candidate's quote
     * only becomes user evidence when it matches a buffered user turn — the
     * model writing a quote does not create that evidence. Locators we do not
     * have stay null instead of being filled in from the node id or today.
     */
    const source = {
      ...buildSource({
        quote: cand.quote || "",
        turns: sourceTurns,
        sessionId,
        via: via || cand.via || "extract",
      }),
      kind: sourceKindOfVia(via || cand.via),
      capturedAt: nowIso(),
    };
    /*
     * A replacement refuses the substring merge (see above), but it must still
     * be idempotent: the same window is routinely processed twice (pending
     * replay, then the turn end), and each pass would insert another copy. Two
     * passes are not guaranteed to word it identically — the model paraphrases —
     * so the check falls back to "same event, same type, same name" before
     * deciding this is a new fact.
     */
    /*
     * A repeat of a write we already made is folded first, whatever the intent:
     * the second pass of a replacement often finds its target already retired and
     * would otherwise look like an ordinary new fact.
     */
    /*
     * "Claims a replacement" is not the same as "a replacement was accepted": on
     * the second pass the named target is already retired, so the intent comes
     * back unresolved while the candidate still says it replaces something.
     */
    const claimsReplacement = intent?.replacement === true || Boolean(String(cand.supersedes || "").trim());
    const duplicateId = findDuplicateWrite(db, cand, source, { replacement: claimsReplacement });
    const existing = duplicateId != null ? duplicateId : intent?.replacement ? null : findMergeTarget(db, cand);
    const payload = {
      type: cand.type,
      name: cand.name,
      text: cand.text,
      uri: `ctx://${cand.type}/${Date.now()}`,
      aliases: cand.aliases,
      fail: cand.fail,
      fix: cand.fix,
      until: cand.until,
      source,
    };
    const untilAt = cand.until ? resolveUntilAt(cand.until) : undefined;
    if (untilAt) payload.untilAt = untilAt;
    let id;
    let action = "insert";
    if (existing != null) {
      try {
        id = sink.merge(existing, payload);
        action = "merge";
      } catch (err) {
        /*
         * A node inside a revision chain refuses a body change. That refusal is
         * correct, but it must not take the write down with it: the new text is a
         * separate fact, so store it as one (review R-04).
         */
        if (err?.code !== "REVISION_PROTECTED") throw err;
        id = sink.insert(payload);
        action = "insert";
      }
    } else {
      id = sink.insert(payload);
    }
    const linkName = cand.linkName;
    if (linkName && cand.type !== "entity") {
      const target = resolveEntityId(db, linkName);
      if (target != null && target !== id) {
        const label =
          cand.linkLabel ||
          (cand.type === "decision"
            ? EDGE_LABELS.decided
            : cand.type === "experience"
              ? EDGE_LABELS.fixed
              : EDGE_LABELS.about);
        try {
          sink.link(id, target, label);
        } catch {
          // edge is optional
        }
      }
    }
    linkReplacementDecision(db, id, cand, { intent, onSupersede, sink });
    applied.push({ id, action, type: cand.type, text: cand.text });
  }
  return applied;
}

export async function distill({ db, writer, turns, sessionId, llmCall, log, now = new Date() }) {
  const usable = distillableTurns(turns);
  if (!usable.length) return { applied: [], llmFailed: false };
  const rules = ruleCandidates(usable);
  let model = [];
  let llmFailed = false;
  // Exact acknowledgements contain no durable facts; all other text still reaches the model.
  const acknowledgementsOnly = usable.every((t) => t.role !== "tool" && /^(?:好的|谢谢|收到|嗯|哦|ok|okay|thanks|thank you)[\s!！.。]*$/i.test(String(t.text).trim()));
  /*
   * Content gate (D2 §5.1). Skipping the call also skips paying for it, so the
   * decision has to be conservative and visible: `gate.reason` is reported in
   * the run status, and rules still run and still write their candidates.
   * A skipped window is consumed like a successful one — which is only safe
   * because every utterance must match the complete content-free whitelist.
   */
  const gate = shouldExtractBatch(usable);
  const callModel = typeof llmCall === "function" && !acknowledgementsOnly && gate.call;
  let emptySuspicious = false;
  if (callModel) {
    /*
     * "Nothing worth storing" is the model's judgement, not a fact. A live run
     * (W8, 2026-11-02) answered `{"candidates":[]}` to
     * "这次上线按方案 A 走。" and to "上一个方案不要了，走新的，用方案 B。", the
     * window was consumed, and both decisions were gone. When the window plainly
     * contains a decision and no rule already wrote one, ask once more; the second
     * answer goes through the same gates, and the retry is bounded to one call.
     */
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await llmCall(buildExtractPrompt(usable, { strictRetry: attempt > 0 }));
        // An empty answer means the call produced nothing (a reasoning model can
        // spend the whole maxTokens budget thinking). Treat it as a failure so the
        // caller keeps the window pending; `{"candidates":[]}` is the real no-op.
        if (!String(raw ?? "").trim()) throw new Error("extraction returned no text");
        // Automatic extraction cannot silently turn an event date into expiry,
        // even when the model emits fields outside the requested schema.
        model = parseModelJson(raw).map((candidate) => ({
          ...candidate, until: undefined, untilAt: undefined,
        }));
        llmFailed = false;
        // A retry that produced something is a recovered window, not a loss.
        if (model.length) emptySuspicious = false;
        if (model.length || attempt > 0 || rules.length || !looksLikeDecision(usable)) break;
        emptySuspicious = true;
        log?.warn?.("[dsh-trivium] extraction returned no candidates for a window that states a decision; asking once more");
      } catch (err) {
        llmFailed = true;
        log?.warn?.(`[dsh-trivium] extract prompt failed: ${err.message}`);
        break;
      }
    }
  }
  const skipped = [];
  const superseded = [];
  const adjusted = [];
  const applied = applyCandidates(db, [...rules, ...model], {
    writer,
    sessionId,
    // Raw window text, not the clipped prompt transcript: a date that really
    // appeared must count as supported even if the prompt copy was shortened.
    sourceText: usable.map((t) => String(t.text || "")).join("\n"),
    // Same window, with the host locators each turn carries.
    sourceTurns: usable,
    now,
    onSkip: (row) => skipped.push(row),
    onSupersede: (row) => superseded.push(row),
    onAdjust: (row) => adjusted.push(row),
  });
  return {
    applied,
    skipped,
    superseded,
    adjusted,
    llmFailed,
    // The model said "nothing" for a window that states a decision and still said
    // it after one more question: the window is consumed, so this has to be
    // visible instead of looking like an ordinary empty extraction.
    emptySuspicious,
    ruleCount: rules.length,
    modelCount: model.length,
    gate: { skipped: typeof llmCall === "function" && !acknowledgementsOnly && !gate.call, reason: gate.reason },
  };
}
