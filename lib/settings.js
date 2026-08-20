import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { looksHttpUrl } from "./embed.js";

export const SETTINGS_FILE = join(homedir(), ".dsh", "trivium.json");

export function readUiSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function recallModeOf(opts = {}) {
  const mode = opts.recallMode;
  if (mode === "auto" || mode === "anchor" || mode === "off") return mode;
  if (opts.autoRecall === true && opts.anchorRecall === true) return "off";
  if (opts.anchorRecall === true) return "anchor";
  if (opts.autoRecall === true) return "auto";
  return "off";
}

export function applyRecallMode(target, mode) {
  const next = mode === "auto" || mode === "anchor" ? mode : "off";
  target.recallMode = next;
  target.autoRecall = next === "auto";
  target.anchorRecall = next === "anchor";
  return target;
}

export function writeUiSettings(patch) {
  mkdirSync(join(homedir(), ".dsh"), { recursive: true });
  const prev = readUiSettings();
  const next = { ...prev };
  let mode = recallModeOf(prev);
  if (patch.recallMode === "auto" || patch.recallMode === "anchor" || patch.recallMode === "off") {
    mode = patch.recallMode;
  } else if (patch.autoRecall === true && patch.anchorRecall === true) {
    mode = "off";
  } else if (patch.anchorRecall === true) {
    mode = "anchor";
  } else if (patch.autoRecall === true) {
    mode = "auto";
  } else {
    if (patch.autoRecall === false && mode === "auto") mode = "off";
    if (patch.anchorRecall === false && mode === "anchor") mode = "off";
  }
  applyRecallMode(next, mode);
  if (typeof patch.extractEnabled === "boolean") next.extractEnabled = patch.extractEnabled;
  if (typeof patch.embeddingEnabled === "boolean") next.embeddingEnabled = patch.embeddingEnabled;
  if (typeof patch.embeddingUrl === "string") {
    const url = patch.embeddingUrl.trim();
    next.embeddingUrl = !url || looksHttpUrl(url) ? url : prev.embeddingUrl || "";
  }
  if (typeof patch.embeddingModel === "string") next.embeddingModel = patch.embeddingModel.trim();
  if (typeof patch.embeddingApiKey === "string" && patch.embeddingApiKey.trim()) {
    next.embeddingApiKey = patch.embeddingApiKey.trim();
  }
  if (patch.pinsBySession && typeof patch.pinsBySession === "object") {
    next.pinsBySession = patch.pinsBySession;
  } else if (prev.pinsBySession && typeof prev.pinsBySession === "object") {
    next.pinsBySession = prev.pinsBySession;
  }
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function pinsOf(sessionId) {
  const raw = readUiSettings().pinsBySession;
  if (!raw || typeof raw !== "object") return [];
  const ids = raw[String(sessionId || "")];
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map(Number).filter((id) => Number.isFinite(id)))];
}

export function writePins(sessionId, ids) {
  const key = String(sessionId || "");
  const prev = readUiSettings();
  const pinsBySession = { ...(prev.pinsBySession && typeof prev.pinsBySession === "object" ? prev.pinsBySession : {}) };
  const nextIds = [...new Set((ids || []).map(Number).filter((id) => Number.isFinite(id)))];
  if (!key) return nextIds;
  if (!nextIds.length) delete pinsBySession[key];
  else pinsBySession[key] = nextIds;
  mkdirSync(join(homedir(), ".dsh"), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...prev, pinsBySession }, null, 2), "utf8");
  return nextIds;
}

export function settingsFileExists() {
  return existsSync(SETTINGS_FILE);
}
