import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EDGE_LABELS, clip, looksSecret, nowIso } from "./schema.js";
import { sanitizeForWrite } from "./hygiene.js";
import {
  findMergeTarget,
  insertNode,
  mergeInto,
  ensureLink,
} from "./store.js";
import { parseUntilFromText, resolveUntilAt } from "./until.js";

export const PREFERENCE_CUES =
  /记住|以后都|别再|不要再|从现在起|always do|from now on|never again|remember (?:this|that|to)\b/i;
export const DECISION_CUES =
  /先别动|下周再|采用方案|就用[这那]个|不要改成|postpone|defer until|go with (?:option|plan|方案)/i;
export const ONESHOT_CUES =
  /把这[个份]?文件|改一下.{0,40}文件|只改这|just (?:change|edit|fix) this (?:file|one)|only this file/i;
export const CHITCHAT_CUES =
  /^(哈哈+|呵呵+|嗯+|哦+|好的|谢谢|天气|吃了吗|在吗)[\s!！.。?？]*$/;

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

export function savePending(cwd, payload) {
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

function untilOf(text) {
  return parseUntilFromText(text);
}

function isToolDriveTurn(text) {
  return TOOL_DRIVE_CUES.test(String(text || ""));
}

function distillableTurns(turns) {
  return (turns || []).filter((t) => t.role !== "user" || !isToolDriveTurn(t.text));
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
  const m = String(span || "").match(/方案\s*([A-Za-z0-9甲乙丙丁一二三四五六七八九十])/u);
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
        until: untilOf(span),
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

export function filterCandidates(candidates, { importFile = false, explicit = false } = {}) {
  const seen = new Set();
  const out = [];
  const caps = importFile || explicit
    ? { entity: 24, preference: 24, decision: 12, experience: 8 }
    : { entity: 8, preference: 8, decision: 6, experience: 4 };
  const used = { entity: 0, preference: 0, decision: 0, experience: 0 };
  for (const raw of candidates || []) {
    if (!raw || !WRITE_TYPES.has(raw.type)) continue;
    const text = String(raw.text || raw.name || "").trim();
    if (!text) continue;
    if (raw.type === "entity" && isNoiseName(raw.name || text)) continue;
    const blob = `${text}\n${raw.fail || ""}\n${raw.fix || ""}\n${raw.quote || ""}`;
    const gate = sanitizeForWrite(blob);
    if (!gate.ok && gate.reason !== "empty") continue;
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
    'Shape: {"candidates":[{"type":"preference|entity|decision|experience","name":"","text":"","linkName":"","linkLabel":"about|decided|broke|fixed","fail":"","fix":"","until":"","quote":""}]}',
    "Whitelist: 记住/以后都/别再 → preference; repeated proper names → entity; decision with an object (先别动/下周再/采用方案) → decision; tool fail then success in the same turn → experience.",
    "Do not write chitchat or one-off file edits as preference. Do not store secrets, tool dumps, or whole conversations.",
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

export function applyCandidates(db, candidates, { sessionId, via } = {}) {
  const { kept: list } = capWriteBatch(
    filterCandidates(candidates, {
      importFile: via === "workbuddy-import" || via === "external-import",
      explicit: via === "chip-add",
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
        sessionId: sessionId ? String(sessionId) : "",
        quote: cand.quote,
        via: via || cand.via || "extract",
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
    applied.push({ id, action, type: cand.type, text: cand.text });
  }
  return applied;
}

export async function distill({ db, turns, sessionId, llmCall, log }) {
  const usable = distillableTurns(turns);
  if (!usable.length) return { applied: [], llmFailed: false };
  const rules = ruleCandidates(usable);
  let model = [];
  let llmFailed = false;
  if (typeof llmCall === "function") {
    try {
      const raw = await llmCall(buildExtractPrompt(usable));
      model = parseModelJson(raw);
    } catch (err) {
      llmFailed = true;
      log?.warn?.(`[dsh-trivium] extract prompt failed: ${err.message}`);
    }
  }
  const applied = applyCandidates(db, [...rules, ...model], { sessionId });
  return { applied, llmFailed, ruleCount: rules.length, modelCount: model.length };
}
