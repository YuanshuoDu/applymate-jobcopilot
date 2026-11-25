import { validateTaskGraphVerificationItems as validateSharedTaskGraphVerificationItems } from "@jobcopilot/shared/task-graph-tool-receipt-verification"

export { taskGraphEvidenceDigest } from "@jobcopilot/shared/task-graph-verification-digest"
export { canonicalTaskGraphReadObservations } from "@jobcopilot/shared/task-graph-read-observations"

export type TaskGraphVerificationScope = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  parentTaskId: string
  taskId: string
  attemptCount: number
}>
type Row = Record<string, unknown>

export function validateTaskGraphVerificationItems(values: readonly unknown[], scope: TaskGraphVerificationScope): Row[] {
  return validateSharedTaskGraphVerificationItems(values, scope)
}
