import type { WaitKind } from "./types"

export function waitItemId(kind: WaitKind, waitId: string): string {
  return `agent-wait:${kind}:${waitId}`
}
