import fs from "node:fs";
import path from "node:path";

const PROFILES_DIR =
  process.env.CLOAK_PROFILES_DIR ?? ".cloak-profiles";

function resolveProfileDir(userId: string): string {
  return path.resolve(PROFILES_DIR, userId);
}

/** Ensure the per-user profile directory exists.
 *  Returns the absolute path. Does NOT log the path.
 */
export function ensureProfileDir(userId: string): string {
  const dir = resolveProfileDir(userId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Resolve the path to the storage-state JSON file for a user */
export function storageStatePath(userId: string): string {
  return path.join(resolveProfileDir(userId), "state.json");
}

/** Remove a user's profile directory (for cleanup) */
export function removeProfileDir(userId: string): void {
  const dir = resolveProfileDir(userId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
