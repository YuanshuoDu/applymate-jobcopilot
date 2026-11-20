import { isSubagentTaskId, prepareSafeValue, type PreparedLifecycleValue } from "./redaction.js"

export type ScoutDelegateOutputIdentity = Readonly<{
  sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string; stepId: string; toolCallId: string
}>
type DelegateStatus = "queued" | "duplicate"
type DelegateOutput = Readonly<{ taskId: string; status: DelegateStatus }>
type LifecycleCall = Readonly<{
  id: string; toolName: string; sessionId: string; turnId: string; stepId: string; taskId?: string; rootTaskId?: string
}>
type Provenance = ScoutDelegateOutputIdentity & DelegateOutput

const provenance = new WeakMap<object, Provenance>()

/** Marks only a closed receipt created after the manager returned the exact direct child. */
export function markScoutDelegateOutput(
  value: unknown, identity: ScoutDelegateOutputIdentity, taskId: string, status: DelegateStatus,
): value is DelegateOutput {
  const output = exactOutput(value)
  if (!output || !validIdentity(identity) || !isSubagentTaskId(taskId) || output.taskId !== taskId || output.status !== status) return false
  provenance.set(value as object, { ...identity, taskId, status })
  return true
}

/** Consumes runtime-only provenance once; unmatched output stays on generic redaction. */
export function prepareScoutDelegateLifecycleOutput(value: unknown, call: LifecycleCall): PreparedLifecycleValue | null {
  if (!value || typeof value !== "object") return null
  const proof = provenance.get(value)
  if (!proof) return null
  provenance.delete(value)
  const output = exactOutput(value)
  if (!output || call.toolName !== "scout.delegate" || call.id !== proof.toolCallId
    || call.sessionId !== proof.sessionId || call.turnId !== proof.turnId || call.stepId !== proof.stepId
    || call.taskId !== proof.parentTaskId || call.rootTaskId !== proof.rootTaskId
    || output.taskId !== proof.taskId || output.status !== proof.status) return null
  return prepareSafeValue({ taskId: proof.taskId, status: proof.status })
}

function validIdentity(value: ScoutDelegateOutputIdentity): boolean {
  return Object.values(value).every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 256)
}

function exactOutput(value: unknown): DelegateOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || keys.some(key => key !== "taskId" && key !== "status")) return null
  const task = Object.getOwnPropertyDescriptor(value, "taskId"), status = Object.getOwnPropertyDescriptor(value, "status")
  if (!task?.enumerable || !("value" in task) || !status?.enumerable || !("value" in status)
    || typeof task.value !== "string" || !task.value.trim() || (status.value !== "queued" && status.value !== "duplicate")) return null
  return value as DelegateOutput
}
