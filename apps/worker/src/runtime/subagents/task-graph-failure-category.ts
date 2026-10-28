import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "./task-graph-child-deadline.js"

export type TaskGraphExecutionFailureCategory =
  | "execution_setup_unavailable"
  | "resume_state_unavailable"
  | "structured_output_invalid"
  | "execution_deadline_exceeded"

function plainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/** Classifies only fixed ordinary-child literals; it never returns the stored reason. */
export function classifyCurrentTaskGraphExecutionFailure(
  value: unknown,
  eligibility: Readonly<{ hasVerifiedReport: boolean; isNative: boolean }>,
): TaskGraphExecutionFailureCategory | undefined {
  if (!plainRecord(value) || !plainRecord(eligibility)) return undefined
  const status = ownDataValue(value, "status")
  const reason = ownDataValue(value, "failureReason")
  const hasVerifiedReport = ownDataValue(eligibility, "hasVerifiedReport")
  const isNative = ownDataValue(eligibility, "isNative")
  if (status !== "failed" || typeof reason !== "string"
    || typeof hasVerifiedReport !== "boolean" || typeof isNative !== "boolean"
    || hasVerifiedReport || isNative) return undefined

  switch (reason) {
    case "child_turn_missing":
    case "subagent_role_unknown":
    case "selected_job_context_unavailable":
    case "writer_dependency_unavailable":
    case "selected_job_sources_unavailable":
    case "selected_job_output_contract_unavailable":
      return "execution_setup_unavailable"
    case "child_resume_evidence_unavailable":
    case "child_resume_unavailable":
      return "resume_state_unavailable"
    case "invalid_structured_result":
      return "structured_output_invalid"
    case TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON:
      return "execution_deadline_exceeded"
    default:
      return undefined
  }
}
