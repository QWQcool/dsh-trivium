import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EDGE_LABELS, clip, looksSecret, nowIso } from "./schema.js";
import {
  findByType,
  findMergeTarget,
  insertNode,
  mergeInto,
  workspaceId,
} from "./store.js";

export const PREFERENCE_CUES =
  /记住|以后都|别再|不要再|从现在起|always do|from now on|never again|remember (?:this|that|to)\b/i;
export const DECISION_CUES =
  /先别动|下周再|采用方案|就用[这那]个|不要改成|postpone|defer until|go with (?:option|plan|方案)/i;
export const ONESHOT_CUES =
  /把这[个份]?文件|改一下.{0,40}文件|只改这|just (?:change|edit|fix) this (?:file|one)|only this file/i;
export const CHITCHAT_CUES =
  /^(哈哈+|呵呵+|嗯+|哦+|好的|谢谢|天气|吃了吗|在吗)[\s!！.。?？]*$/;

const NAME_RE =
  /`([^`]{2,64})`|「([^」]{2,32})」|\b([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b|\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b|\b([A-Z]{3,}[A-Z0-9_-]{0,})\b/g;

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
]);

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

function cueSpan(text, re) {
  const parts = String(text || "")
    .split(/(?<=[。！？\n])|(?<=\. )/u)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.find((p) => re.test(p)) || String(text || "").trim();
}

function collectNames(text) {
  const counts = new Map();
  const s = String(text || "");
  NAME_RE.lastIndex = 0;
  let match;
  while ((match = NAME_RE.exec(s))) {
    const name = (match[1] || match[2] || match[3] || match[4] || match[5] || "").trim();
    if (!name || NAME_STOP.has(name.toUpperCase())) continue;
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    const cur = counts.get(key) || { name, n: 0 };
    cur.n += 1;
    counts.set(key, cur);
  }
  return [...counts.values()].filter((row) => row.n >= 2);
}

function turnsText(turns) {
  return (turns || [])
    .map((t) => `${t.role}: ${t.text || ""}`)
    .join("\n");
}

export function ruleCandidates(turns) {
  const out = [];
  const transcript = turnsText(turns);

  for (const turn of turns || []) {
    if (turn.role !== "user") continue;
    const text = String(turn.text || "").trim();
    if (!text || CHITCHAT_CUES.test(text)) continue;
    if (looksSecret(text)) continue;

    if (PREFERENCE_CUES.test(text) && !ONESHOT_CUES.test(text)) {
      const span = cueSpan(text, PREFERENCE_CUES);
      out.push({
        type: "preference",
        text: clip(span, 240),
        quote: clip(span, 120),
        via: "rule",
      });
    }

    if (DECISION_CUES.test(text) && !ONESHOT_CUES.test(text)) {
      const span = cueSpan(text, DECISION_CUES);
      const object = collectNames(span)[0]?.name || collectNames(text)[0]?.name || clip(span, 40);
      out.push({
        type: "decision",
        name: object,
        text: clip(span, 240),
        linkName: collectNames(span)[0]?.name || collectNames(text)[0]?.name,
        linkLabel: EDGE_LABELS.decided,
        quote: clip(span, 120),
        via: "rule",
      });
    }
  }

  for (const row of collectNames(transcript)) {
    out.push({
      type: "entity",
      name: row.name,
      text: row.name,
      via: "rule",
    });
  }

  const byTurn = new Map();
  for (const turn of turns || []) {
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
    out.push({
      type: "experience",
      name: failed.name || "tool",
      text: `${failed.name || "tool"} failed then succeeded`,
      fail: clip(failed.text, 160),
      fix: clip(ok.text, 160),
      linkLabel: EDGE_LABELS.fixed,
      via: "rule",
    });
  }

  return out;
}

export function filterCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const raw of candidates || []) {
    if (!raw || !WRITE_TYPES.has(raw.type)) continue;
    const text = String(raw.text || raw.name || "").trim();
    if (!text) continue;
    if (looksSecret(text) || looksSecret(raw.fail) || looksSecret(raw.fix) || looksSecret(raw.quote)) {
      continue;
    }
    if (raw.type === "preference") {
      const blob = `${raw.text || ""} ${raw.quote || ""}`;
      if (CHITCHAT_CUES.test(String(raw.text || "").trim())) continue;
      if (ONESHOT_CUES.test(blob) && !PREFERENCE_CUES.test(blob)) continue;
      if (!PREFERENCE_CUES.test(blob)) continue;
    }
    const key = `${raw.type}|${(raw.name || "").toLowerCase()}|${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: raw.type,
      name: raw.name ? String(raw.name).slice(0, 80) : undefined,
      text: clip(text, 400),
      linkName: raw.linkName ? String(raw.linkName).slice(0, 80) : undefined,
      linkLabel: raw.linkLabel || undefined,
      fail: raw.fail ? clip(raw.fail, 200) : undefined,
      fix: raw.fix ? clip(raw.fix, 200) : undefined,
      until: raw.until ? String(raw.until).slice(0, 40) : undefined,
      quote: raw.quote ? clip(raw.quote, 160) : undefined,
      aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String).slice(0, 8) : undefined,
    });
    if (out.length >= 8) break;
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
  const hit = findMergeTarget(db, { type: "entity", name, text: name });
  if (hit != null) return hit;
  return insertNode(db, {
    type: "entity",
    name,
    text: name,
    uri: `ctx://entity/${Date.now()}`,
    aliases: [],
  });
}

export function applyCandidates(db, candidates, { sessionId } = {}) {
  const applied = [];
  for (const cand of filterCandidates(candidates)) {
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
        via: "extract",
      },
    };
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
          db.link(id, target, label, 1);
          db.flush();
        } catch {
          // edge is optional
        }
      }
    }
    const root = workspaceId(db);
    if (root != null && cand.type !== "workspace") {
      try {
        db.link(id, root, EDGE_LABELS.inWorkspace, 1);
      } catch {
        // already linked
      }
    }
    applied.push({ id, action, type: cand.type, text: cand.text });
  }
  return applied;
}

export async function distill({ db, turns, sessionId, llmCall, log }) {
  const rules = ruleCandidates(turns);
  let model = [];
  let llmFailed = false;
  if (typeof llmCall === "function") {
    try {
      const raw = await llmCall(buildExtractPrompt(turns));
      model = parseModelJson(raw);
    } catch (err) {
      llmFailed = true;
      log?.warn?.(`[dsh-trivium] extract prompt failed: ${err.message}`);
    }
  }
  const applied = applyCandidates(db, [...rules, ...model], { sessionId });
  return { applied, llmFailed, ruleCount: rules.length, modelCount: model.length };
}
