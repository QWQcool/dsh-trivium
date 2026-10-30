import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EDGE_LABELS, clip, looksSecret, nowIso } from "./schema.js";
import { sanitizeForWrite } from "./hygiene.js";
import {
  findMergeTarget,
  insertNode,
  mergeInto,
  ensureLink,
  supersedesIn,
  supersedesOut,
} from "./store.js";
import { resolveUntilAt } from "./until.js";

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
const REPLACEMENT_CUES = /更正|改为|改成|改用|不再(?:使用|采用|用)|替换|取代|放弃|作废|deprecat|replace(?:d)?|switch(?:ed)? to/i;

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

export function loadPending(cwd) {
  try {
    const raw = readFileSync(pendingPath(cwd), "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.turns)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function savePending(cwd, payload) {
  const file = pendingPath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        cwd,
        savedAt: nowIso(),
        ...payload,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function clearPending(cwd) {
  try {
    unlinkSync(pendingPath(cwd));
  } catch {
    // missing is fine
  }
}

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text" && block.text) parts.push(String(block.text));
    else if (block.type === "tool-result" && Array.isArray(block.content)) {
      parts.push(textFromContent(block.content));
    } else if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

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
 * Link "A replaces B" when the new decision says so *and* exactly one live
 * decision answers to the label it mentions. Ambiguity is reported, never
 * guessed: a wrong supersede would hide a fact that is still current.
 */
function linkReplacementDecision(db, newId, cand, onSupersede) {
  if (cand.type !== "decision") return;
  const text = `${cand.text || ""} ${cand.quote || ""}`;
  if (!REPLACEMENT_CUES.test(text)) return;
  if (supersedesOut(db, newId).length) return;
  const targets = [];
  for (const rawId of db.allNodeIds()) {
    const id = Number(rawId);
    if (id === Number(newId)) continue;
    const payload = db.get(id)?.payload;
    if (!payload || payload.type !== "decision" || payload.status === "archived") continue;
    if (supersedesIn(db, id).length) continue;
    const label = decisionLabels(payload).find((row) => text.includes(row));
    if (label) targets.push({ id, label });
  }
  if (!targets.length) return;
  /*
   * The rule layer and the model routinely write the same sentence twice, so
   * "one label" can match several live decisions. Chain them oldest → newest →
   * the new decision instead of refusing: every retired node keeps exactly one
   * successor (no fork), and the head still resolves to the new decision.
   */
  const ordered = [...targets].sort((a, b) => a.id - b.id);
  for (let i = 0; i < ordered.length - 1; i += 1) {
    ensureLink(db, ordered[i + 1].id, ordered[i].id, EDGE_LABELS.supersedes);
    if (typeof onSupersede === "function") onSupersede({ from: ordered[i + 1].id, to: ordered[i].id, label: ordered[i].label });
  }
  const last = ordered[ordered.length - 1];
  ensureLink(db, newId, last.id, EDGE_LABELS.supersedes);
  if (typeof onSupersede === "function") onSupersede({ from: Number(newId), to: last.id, label: last.label, chained: ordered.length });
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
const ABSOLUTE_DATE = /((?:19|20)\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})日?/g;

function normalizedDatesIn(text) {
  const out = [];
  for (const match of String(text || "").matchAll(ABSOLUTE_DATE)) {
    out.push({ raw: match[0], key: `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}` });
  }
  return out;
}

/*
 * "下周五" is not an absolute date, but resolving it to one is correct behaviour.
 * Without an allowance the literal check would delete that conversion (A-8 known
 * cost). A date is therefore also accepted when the window contains a relative
 * expression and the date lands in a plausible window around now; anything far
 * outside it is still treated as invented (the A-5 case was six months in the past).
 */
const RELATIVE_TIME = /今天|明天|后天|昨天|前天|本周|这周|下周|下星期|上周|上个?月|下个?月|月底|月初|年底|季度末|\d+\s*(?:天|周|个?月|年)(?:以?后|以?前|内)/;

function withinRelativeWindow(key, now) {
  const target = Date.parse(`${key}T00:00:00Z`);
  if (!Number.isFinite(target)) return false;
  const base = (now instanceof Date ? now : new Date()).getTime();
  const day = 24 * 3600 * 1000;
  return target >= base - 7 * day && target <= base + 400 * day;
}

function scrubUnsupportedDates(text, sourceText, now = new Date()) {
  const found = normalizedDatesIn(text);
  if (!found.length) return { text, removed: [] };
  const known = new Set(normalizedDatesIn(sourceText).map((row) => row.key));
  const relativeAllowed = RELATIVE_TIME.test(String(sourceText || ""));
  const bad = found.filter((row) => !known.has(row.key) && !(relativeAllowed && withinRelativeWindow(row.key, now)));
  if (!bad.length) return { text, removed: [] };
  let out = String(text);
  for (const row of bad) {
    const raw = row.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Prefix form: "On 2026-04-06, ..." / "2026-04-06 时，..." / "在 2026-04-06，..."
    out = out.replace(new RegExp(`(?:^|[。！？\\n])\\s*(?:On\\s+|on\\s+|在\\s*)?${raw}\\s*(?:时|当天)?\\s*[,，、]?\\s*`, "g"), (m) => (m.startsWith("\n") ? "\n" : ""));
    // Parenthesised / trailing forms, then the bare token.
    out = out.replace(new RegExp(`[（(]\\s*${raw}\\s*[)）]`, "g"), "");
    out = out.replace(new RegExp(`\\s*[,，、]?\\s*${raw}\\s*(?:时|当天)?`, "g"), "");
  }
  out = out.replace(/\s{2,}/g, " ").replace(/^[\s,，、。;；:：]+/, "").replace(/[\s,，、]+$/g, "").trim();
  return { text: out, removed: bad.map((row) => row.key) };
}

export function filterCandidates(candidates, { importFile = false, explicit = false, onSkip, onAdjust, sourceText = "", now = new Date() } = {}) {
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
    const scrubbed = scrubUnsupportedDates(text, sourceText, now);
    if (scrubbed.removed.length) {
      // Nothing left once the invented date is gone: refuse rather than store a stub.
      if (scrubbed.text.length < 6) { skip("unsupported-date", { ...raw, text }); continue; }
      text = scrubbed.text;
      if (typeof onAdjust === "function") {
        onAdjust({ reason: "unsupported-date", type: String(raw.type || ""), removed: scrubbed.removed, preview: clip(text, 40) });
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

export function buildExtractPrompt(turns) {
  const transcript = clip(turnsText(turns), 2400);
  return [
    "Extract durable memory candidates as JSON only.",
    'Shape: {"candidates":[{"type":"preference|entity|decision|experience","name":"","text":"","linkName":"","linkLabel":"about|decided|broke|fixed","fail":"","fix":"","quote":""}]}',
    "Whitelist: 记住/以后都/别再 → preference; repeated proper names → entity; decision with an object (先别动/下周再/采用方案) → decision; tool fail then success in the same turn → experience.",
    "Do not write chitchat or one-off file edits as preference. Do not store secrets, tool dumps, or whole conversations.",
    "Keep dates in the fact text. Do not infer expiry or emit until/untilAt; expiry is set explicitly through the memory tools or settings.",
    "If nothing matches, return {\"candidates\":[]}.",
    "",
    transcript,
  ].join("\n");
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

export function applyCandidates(db, candidates, { sessionId, via, onSkip, onSupersede, onAdjust, sourceText = "", now = new Date() } = {}) {  const { kept: list } = capWriteBatch(
    filterCandidates(candidates, {
      importFile: via === "workbuddy-import" || via === "external-import",
      explicit: via === "chip-add",
      onSkip,
      onAdjust,
      sourceText,
      now,
    }),
  );
  const ordered = [
    ...list.filter((c) => c.type === "entity"),
    ...list.filter((c) => c.type !== "entity"),
  ];
  const applied = [];
  for (const cand of ordered) {
    const existing = findMergeTarget(db, cand);
    const payload = {
      type: cand.type,
      name: cand.name,
      text: cand.text,
      uri: `ctx://${cand.type}/${Date.now()}`,
      aliases: cand.aliases,
      fail: cand.fail,
      fix: cand.fix,
      until: cand.until,
      source: {
        // `via` is the legacy channel name; `kind` is the newer stable field the
        // provenance UI reads. Only what this path actually knows is recorded —
        // no message id, author or quote is invented.
        kind: sourceKindOfVia(via || cand.via),
        via: via || cand.via || "extract",
        sessionId: sessionId ? String(sessionId) : "",
        quote: cand.quote,
        capturedAt: nowIso(),
      },
    };
    const untilAt = cand.until ? resolveUntilAt(cand.until) : undefined;
    if (untilAt) payload.untilAt = untilAt;
    let id;
    let action = "insert";
    if (existing != null) {
      id = mergeInto(db, existing, payload);
      action = "merge";
    } else {
      id = insertNode(db, payload);
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
          ensureLink(db, id, target, label);
        } catch {
          // edge is optional
        }
      }
    }
    linkReplacementDecision(db, id, cand, onSupersede);
    applied.push({ id, action, type: cand.type, text: cand.text });
  }
  return applied;
}

export async function distill({ db, turns, sessionId, llmCall, log, now = new Date() }) {
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
  if (callModel) {
    try {
      const raw = await llmCall(buildExtractPrompt(usable));
      // An empty answer means the call produced nothing (a reasoning model can
      // spend the whole maxTokens budget thinking). Treat it as a failure so the
      // caller keeps the window pending; `{"candidates":[]}` is the real no-op.
      if (!String(raw ?? "").trim()) throw new Error("extraction returned no text");
      // Automatic extraction cannot silently turn an event date into expiry,
      // even when the model emits fields outside the requested schema.
      model = parseModelJson(raw).map((candidate) => ({
        ...candidate, until: undefined, untilAt: undefined,
      }));
    } catch (err) {
      llmFailed = true;
      log?.warn?.(`[dsh-trivium] extract prompt failed: ${err.message}`);
    }
  }
  const skipped = [];
  const superseded = [];
  const adjusted = [];
  const applied = applyCandidates(db, [...rules, ...model], {
    sessionId,
    // Raw window text, not the clipped prompt transcript: a date that really
    // appeared must count as supported even if the prompt copy was shortened.
    sourceText: usable.map((t) => String(t.text || "")).join("\n"),
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
    ruleCount: rules.length,
    modelCount: model.length,
    gate: { skipped: typeof llmCall === "function" && !acknowledgementsOnly && !gate.call, reason: gate.reason },
  };
}
