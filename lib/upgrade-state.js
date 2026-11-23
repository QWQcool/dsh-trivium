import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export const upgradeDirectory = cwd => join(resolve(cwd), ".dsh-trivium-upgrade");
export const upgradeStatePath = cwd => join(upgradeDirectory(cwd), "state.json");
export const upgradingPhases = new Set(["preparing", "activating", "rolling-back"]);

export function workspaceIdentity(cwd) {
  const path = realpathSync(resolve(cwd));
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function readUpgradeState(cwd) {
  const invalid = () => Object.assign(new Error("The workspace upgrade record is unreadable. Keep both database copies for inspection."), {
    status: 409, code: "WORKSPACE_UPGRADE_UNREADABLE",
  });
  try {
    if (!lstatSync(upgradeDirectory(cwd)).isDirectory() || !lstatSync(upgradeStatePath(cwd)).isFile()) throw invalid();
    const state = JSON.parse(readFileSync(upgradeStatePath(cwd), "utf8"));
    const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    if (state?.version !== 1 || state.workspace !== workspaceIdentity(cwd) ||
        typeof state.attempt !== "string" || !/^[0-9a-f-]{36}$/.test(state.attempt) ||
        !["preparing", "activating", "active", "rolling-back", "rolled-back"].includes(state.phase) ||
        (state.mode !== undefined && !["direct", "migration"].includes(state.mode)) ||
        (state.mode === "direct" && (state.phase === "activating" || (state.source !== undefined && !digest(state.source)))) ||
        (["activating", "active", "rolling-back"].includes(state.phase) && (!digest(state.source) || !digest(state.target))) ||
        (state.phase === "rolling-back" && (!digest(state.rollbackSource) ||
          typeof state.restore !== "string" || !/^restore-[0-9a-f-]{36}$/.test(state.restore)))) throw invalid();
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw invalid();
  }
}

export function assertWorkspaceUpgradeIdle(cwd) {
  if (upgradingPhases.has(readUpgradeState(cwd)?.phase)) {
    throw Object.assign(new Error("Workspace upgrade operation is incomplete. Use dsh-trivium-upgrade status, then resume the operation."), {
      status: 409, code: "WORKSPACE_UPGRADE_IN_PROGRESS",
    });
  }
}
