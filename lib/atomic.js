/**
 * Atomic text write: write a sibling temp file, then rename over the target.
 *
 * `writeFileSync(file, ...)` truncates in place, so a crash (or a kill) between
 * truncate and write leaves a half-written file. For the settings file that
 * means `readUiSettings()` silently returns `{}` and every switch / chip pin
 * resets. A rename is atomic on the same volume, so readers see either the old
 * file or the new one, never a truncated one.
 */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (error) {
    // A failed replacement must leave the last good destination intact.
    try {
      unlinkSync(tmp);
    } catch {
      // Report the original write or rename failure.
    }
    throw error;
  }
  return file;
}
