import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { looksHttpUrl } from "./embed.js";

export const SETTINGS_FILE = join(homedir(), ".dsh", "trivium.json");

/** Tests may set DSH_TRIVIUM_SETTINGS to a temp file so we never touch the live home config. */
export function settingsFilePath() {
  const override = String(process.env.DSH_TRIVIUM_SETTINGS || "").trim();
  return override ? resolve(override) : SETTINGS_FILE;
}

function persistSettings(next) {
  const file = settingsFilePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function readUiSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFilePath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function listedWorkspaces() {
  const raw = readUiSettings().workspaces;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const cwd = String(item || "").trim();
    if (!cwd) continue;
    const key = resolve(cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isInsideDir(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep));
}

/** Remember a workspace so uninstall can delete its .tdb. No-op if already listed. */
export function rememberWorkspace(cwd) {
  const key = String(cwd || "").trim();
  if (!key) return listedWorkspaces();
  const resolved = resolve(key);
  if (!process.env.DSH_TRIVIUM_SETTINGS && isInsideDir(tmpdir(), resolved)) {
    return listedWorkspaces();
  }
  const prev = readUiSettings();
  const workspaces = listedWorkspaces();
  if (workspaces.includes(resolved)) return workspaces;
  persistSettings({ ...prev, workspaces: [...workspaces, resolved] });
  return [...workspaces, resolved];
}

export function recallModeOf(opts = {}) {
  const mode = opts.recallMode;
  if (mode === "auto" || mode === "anchor" || mode === "off") return mode;
  if (opts.autoRecall === true && opts.anchorRecall === true) return "off";
  if (opts.anchorRecall === true) return "anchor";
  if (opts.autoRecall === true) return "auto";
  return "off";
}

/** Title-bar Chips tab + pin inject. Missing key = off. */
export function chipsEnabledOf(opts = {}) {
  return opts.chipsEnabled === true;
}

/** Checkpoint canvas. Nested under chips; missing key = off. */
export function sessionLayerEnabledOf(opts = {}) {
  return chipsEnabledOf(opts) && opts.sessionLayerEnabled === true;
}

/** Git JSONL sidecar write. Missing key = off. Import still runs when this is off. */
export function gitSidecarEnabledOf(opts = {}) {
  return opts.gitSidecarEnabled === true;
}

/** Plugin UI language. Missing key = follow the DSH host. */
export function pluginLocaleOf(opts = {}) {
  const v = String(opts.pluginLocale || "").toLowerCase();
  if (v === "zh" || v === "en" || v === "host") return v;
  return "host";
}

/** Settings fold. Missing key = collapsed. */
export function configPanelOpenOf(opts = {}) {
  return opts.configPanelOpen === true;
}

export function sidecarHashOf(cwd) {
  const raw = readUiSettings().sidecarHashByCwd;
  if (!raw || typeof raw !== "object") return "";
  const key = resolve(String(cwd || ""));
  return String(raw[key] || "");
}

export function writeSidecarHash(cwd, hash) {
  const key = resolve(String(cwd || ""));
  if (!process.env.DSH_TRIVIUM_SETTINGS && isInsideDir(tmpdir(), key)) {
    return readUiSettings();
  }
  const prev = readUiSettings();
  const sidecarHashByCwd = {
    ...(prev.sidecarHashByCwd && typeof prev.sidecarHashByCwd === "object" ? prev.sidecarHashByCwd : {}),
  };
  if (!hash) delete sidecarHashByCwd[key];
  else sidecarHashByCwd[key] = String(hash);
  return persistSettings({ ...prev, sidecarHashByCwd });
}

export function applyRecallMode(target, mode) {
  const next = mode === "auto" || mode === "anchor" ? mode : "off";
  target.recallMode = next;
  target.autoRecall = next === "auto";
  target.anchorRecall = next === "anchor";
  return target;
}

export function writeUiSettings(patch) {
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
  if (typeof patch.chipsEnabled === "boolean") next.chipsEnabled = patch.chipsEnabled;
  if (typeof patch.sessionLayerEnabled === "boolean") next.sessionLayerEnabled = patch.sessionLayerEnabled;
  if (typeof patch.gitSidecarEnabled === "boolean") next.gitSidecarEnabled = patch.gitSidecarEnabled;
  if (typeof patch.configPanelOpen === "boolean") next.configPanelOpen = patch.configPanelOpen;
  if (typeof patch.pluginLocale === "string") {
    const loc = String(patch.pluginLocale || "").toLowerCase();
    next.pluginLocale = loc === "zh" || loc === "en" ? loc : "host";
  }
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
  if (Array.isArray(patch.workspaces)) next.workspaces = patch.workspaces;
  else if (Array.isArray(prev.workspaces)) next.workspaces = prev.workspaces;
  if (patch.sidecarHashByCwd && typeof patch.sidecarHashByCwd === "object") {
    next.sidecarHashByCwd = patch.sidecarHashByCwd;
  } else if (prev.sidecarHashByCwd && typeof prev.sidecarHashByCwd === "object") {
    next.sidecarHashByCwd = prev.sidecarHashByCwd;
  }
  return persistSettings(next);
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
  persistSettings({ ...prev, pinsBySession });
  return nextIds;
}

export function settingsFileExists() {
  return existsSync(settingsFilePath());
}
