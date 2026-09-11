/**
 * Atomic text write: write a sibling temp file, then rename over the target.
 *
 * `writeFileSync(file, ...)` truncates in place, so a crash (or a kill) between
 * truncate and write leaves a half-written file. For the settings file that
 * means `readUiSettings()` silently returns `{}` and every switch / chip pin
 * resets. A rename is atomic on the same volume, so readers see either the old
 * file or the new one, never a truncated one.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @param file  absolute target path
 * @param text  UTF-8 payload
 * @param mode  optional POSIX mode (ignored on Windows). Applied to the temp
 *              file, which the rename then promotes to the target.
 * @returns the target path
 */
export function atomicWriteFile(file, text, { mode } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // Drop a stale temp first so `mode` is actually applied on creation.
  try {
    unlinkSync(tmp);
  } catch {
    // nothing stale to remove
  }
  writeFileSync(tmp, text, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  try {
    renameSync(tmp, file);
  } catch {
    // Windows cannot always rename over an existing file; clear and retry.
    try {
      unlinkSync(file);
    } catch {
      // destination may not exist yet
    }
    renameSync(tmp, file);
  }
  return file;
}
