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
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function settingsFileExists() {
  return existsSync(SETTINGS_FILE);
}
