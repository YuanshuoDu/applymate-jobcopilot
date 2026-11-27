import { isSubagentTaskId, prepareSafeValue, type PreparedLifecycleValue } from "./redaction.js"

export type TaskGraphRetirementOutputIdentity = Readonly<{
  sessionId: string
  turnId: string
  rootTaskId: string
  parentTaskId: string
  stepId: string
  toolCallId: string
}>
type RetirementStatus = "interrupt_requested" | "already_requested"
type RetirementOutput = Readonly<{ taskId: string; status: RetirementStatus; attempt: number }>
type LifecycleCall = Readonly<{
  id: string; toolName: string; sessionId: string; turnId: string; stepId: string; taskId?: string; rootTaskId?: string
}>
type Provenance = TaskGraphRetirementOutputIdentity & RetirementOutput

const provenance = new WeakMap<object, Provenance>()

/** Marks only the bounded output of the verified retirement command receipt. */
export function markTaskGraphRetirementOutput(
  value: unknown,
  identity: TaskGraphRetirementOutputIdentity,
  taskId: string,
  status: RetirementStatus,
  attempt: number,
): value is RetirementOutput {
  try {
    const output = exactOutput(value)
    if (!output || !validIdentity(identity) || !isSubagentTaskId(taskId)
      || !Number.isSafeInteger(attempt) || attempt < 1
      || output.taskId !== taskId || output.status !== status || output.attempt !== attempt) return false
    provenance.set(value as object, { ...identity, taskId, status, attempt })
    return true
  } catch { return false }
}

/** Consumes invocation provenance once; untrusted values stay on generic redaction. */
export function prepareTaskGraphRetirementLifecycleOutput(value: unknown, call: LifecycleCall): PreparedLifecycleValue | null {
  if (!value || typeof value !== "object") return null
  const proof = provenance.get(value)
  if (!proof) return null
  provenance.delete(value)
  try {
    const output = exactOutput(value)
    if (!output || call.toolName !== "agent.retire_superseded_scout" || call.id !== proof.toolCallId
      || call.sessionId !== proof.sessionId || call.turnId !== proof.turnId || call.stepId !== proof.stepId
      || call.taskId !== proof.parentTaskId || call.rootTaskId !== proof.rootTaskId
      || output.taskId !== proof.taskId || output.status !== proof.status || output.attempt !== proof.attempt) return null
    return prepareSafeValue({ taskId: proof.taskId, status: proof.status, attempt: proof.attempt })
  } catch { return null }
}

function validIdentity(value: TaskGraphRetirementOutputIdentity): boolean {
  return Object.values(value).every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 256)
}

function exactOutput(value: unknown): RetirementOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 3 || keys.some(key => key !== "taskId" && key !== "status" && key !== "attempt")) return null
  const task = Object.getOwnPropertyDescriptor(value, "taskId")
  const status = Object.getOwnPropertyDescriptor(value, "status")
  const attempt = Object.getOwnPropertyDescriptor(value, "attempt")
  if (!task?.enumerable || !("value" in task) || !status?.enumerable || !("value" in status)
    || !attempt?.enumerable || !("value" in attempt) || typeof task.value !== "string" || !task.value.trim()
    || (status.value !== "interrupt_requested" && status.value !== "already_requested")
    || typeof attempt.value !== "number" || !Number.isSafeInteger(attempt.value) || attempt.value < 1) return null
  return value as RetirementOutput
}
