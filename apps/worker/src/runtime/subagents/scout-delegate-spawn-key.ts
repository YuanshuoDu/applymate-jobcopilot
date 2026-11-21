import { createHash } from "node:crypto"

/** Stable key for one parent-attempt delegate call; keep the serialized fields byte-compatible. */
export function scoutDelegateSpawnKey(parentTaskId: string, attemptCount: number, toolCallId: string): string {
  return `scout-delegate:${createHash("sha256").update(JSON.stringify([parentTaskId, attemptCount, toolCallId])).digest("hex")}`
}
