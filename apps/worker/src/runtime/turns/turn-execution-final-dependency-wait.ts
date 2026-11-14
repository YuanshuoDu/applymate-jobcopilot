import { createHash } from "node:crypto"
import { TurnEngineError, type TurnEngineStep, type TurnEngineToolCall } from "./turn-engine-types.js"
import type { TurnExecutionIdentity, TurnExecutionOptions } from "./turn-execution-types.js"

const WAIT_TOOL = "wait_subagents"
const WAIT_TIMEOUT_MS = 30_000
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function invalidWaitTargets(): TurnEngineError {
  return new TurnEngineError("invalid_output", "Final dependency wait targets are invalid")
}

function readTaskIds(value: unknown, identity: TurnExecutionIdentity): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalidWaitTargets()
  const keys = Reflect.ownKeys(value), record = value as Record<string, unknown>
  if (keys.length !== 1 || keys[0] !== "taskIds") throw invalidWaitTargets()
  const descriptor = Object.getOwnPropertyDescriptor(value, "taskIds")
  if (!descriptor?.enumerable || !("value" in descriptor) || !Array.isArray(record.taskIds)) throw invalidWaitTargets()
  const ids = record.taskIds as unknown[]
  if (Object.getPrototypeOf(ids) !== Array.prototype || ids.length < 1 || ids.length > 2
    || Reflect.ownKeys(ids).length !== ids.length + 1) throw invalidWaitTargets()
  const result: string[] = []
  for (let index = 0; index < ids.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(ids, String(index))
    if (!item?.enumerable || !("value" in item) || typeof item.value !== "string" || !TASK_ID.test(item.value)
      || item.value === identity.taskId || item.value === identity.rootTaskId) throw invalidWaitTargets()
    result.push(item.value)
  }
  if (new Set(result).size !== result.length) throw invalidWaitTargets()
  return result.sort((left, right) => left.localeCompare(right))
}

export function prepareFinalDependencyWaitCall(
  identity: TurnExecutionIdentity, step: TurnEngineStep, request: unknown,
): TurnEngineToolCall | null {
  if (request === null) return null
  if (identity.kind !== "task") throw invalidWaitTargets()
  const taskIds = readTaskIds(request, identity)
  const key = createHash("sha256").update(JSON.stringify([
    identity.userId, identity.sessionId, identity.turnId, identity.taskId, identity.rootTaskId,
    identity.attemptCount, step.id, taskIds,
  ])).digest("hex")
  const idempotencyKey = `final-dependency-wait:${key}`
  return {
    id: idempotencyKey,
    name: WAIT_TOOL,
    arguments: { idempotencyKey, taskIds, mode: "all", timeoutMs: WAIT_TIMEOUT_MS },
  }
}

export function assertFinalDependencyWaitAvailable(options: TurnExecutionOptions, call: TurnEngineToolCall): void {
  const definitionAvailable = options.tools.some(tool => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false
    const definition = tool as Record<string, unknown>
    return definition.name === WAIT_TOOL && definition.version === "1"
  })
  let argumentsValid = false
  try { argumentsValid = options.validateToolArguments?.(WAIT_TOOL, call.arguments) === true } catch { /* fail closed */ }
  if (!definitionAvailable || !argumentsValid) {
    throw new TurnEngineError("invalid_output", "Authorized durable wait capability is unavailable")
  }
}
