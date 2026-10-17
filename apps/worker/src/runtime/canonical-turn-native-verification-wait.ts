import { createHash } from "node:crypto"
import type { TaskGraphExecutionScope } from "./subagents/task-graph-command-port.js"
import type { DurableWaitPort, DurableWaitResult } from "./tools/coordination-types.js"

const MAX_WAIT_TARGETS = 8
const DAY_MS = 24 * 60 * 60 * 1_000
const MAX_WAIT_IDENTITY_BYTES = 256

function waitIdentityKey(scope: TaskGraphExecutionScope, targets: readonly string[]): string {
  const legacy = `native-verification:${scope.rootTaskId}:${scope.stepId}:${createHash("sha256").update(targets.join("\0"), "utf8").digest("hex")}`
  if (Buffer.byteLength(legacy, "utf8") <= MAX_WAIT_IDENTITY_BYTES) return legacy
  const canonicalIdentity = JSON.stringify([
    "native-verification-wait", 2, scope.userId, scope.sessionId, scope.turnId,
    scope.rootTaskId, scope.stepId, targets,
  ])
  const digest = createHash("sha256").update(canonicalIdentity, "utf8").digest("hex")
  const overflow = `native-verification:v2:${digest}`
  if (Buffer.byteLength(overflow, "utf8") > MAX_WAIT_IDENTITY_BYTES) throw new Error("native_verification_wait_key_invalid")
  return overflow
}

export async function waitForNativeVerification(input: Readonly<{
  port: DurableWaitPort
  scope: TaskGraphExecutionScope
  targetTaskIds: readonly string[]
  timeoutMs?: number
}>): Promise<DurableWaitResult> {
  const targets = [...new Set(input.targetTaskIds)].sort()
  if (targets.length === 0 || targets.length > MAX_WAIT_TARGETS || targets.includes(input.scope.rootTaskId)
    || targets.some(id => typeof id !== "string" || !id.trim() || id.length > 128)) throw new Error("native_verification_wait_targets_invalid")
  const timeoutMs = input.timeoutMs ?? DAY_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DAY_MS) throw new Error("native_verification_wait_timeout_invalid")
  const result = await input.port.wait({
    userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
    stepId: input.scope.stepId, taskId: input.scope.rootTaskId, rootTaskId: input.scope.rootTaskId,
    targetTaskIds: targets, mode: "all", timeoutMs,
    idempotencyKey: waitIdentityKey(input.scope, targets),
  })
  if (!result || typeof result.waitId !== "string" || !result.waitId.trim() || result.waitId.length > 128
    || !["waiting", "ready", "timed_out", "interrupted", "closed"].includes(result.status)) throw new Error("native_verification_wait_result_invalid")
  return result
}
