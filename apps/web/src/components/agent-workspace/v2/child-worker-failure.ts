export type ChildWorkerFailure = "deadline_exceeded" | "verification_failed" | "verification_unverified"
  | "dependency_unavailable_or_incompatible" | "recovery_unavailable"

export interface TaskWorkerFailureProjection {
  readonly taskId: string
  readonly sessionId: string
  readonly expectedSessionId?: string
  readonly rootTaskId?: string | null
  readonly parentTaskId?: string | null
  readonly role: string
  readonly taskType: string
  readonly status: string
  readonly reason?: string | null
}

export interface ProjectedTaskWorkerFailure {
  readonly detail?: string
  readonly childFailure?: ChildWorkerFailure
}

const FAILURE_TEXT: Readonly<Record<ChildWorkerFailure, Readonly<{ en: string; zh: string }>>> = {
  deadline_exceeded: { en: "The task reached its time limit.", zh: "子任务已达到时间上限。" },
  verification_failed: { en: "The task did not meet its verification checks.", zh: "子任务未通过验证检查。" },
  verification_unverified: { en: "The task result could not be verified.", zh: "无法验证子任务结果。" },
  dependency_unavailable_or_incompatible: { en: "A required dependency was unavailable or incompatible.", zh: "必需的依赖项不可用或不兼容。" },
  recovery_unavailable: { en: "The task's saved state could not be recovered.", zh: "无法恢复子任务的已保存状态。" },
}

/** Accept only exact canonical reasons on failed child tasks. */
export function projectChildWorkerFailure(status: string, reason: unknown): ChildWorkerFailure | undefined {
  if (status !== "failed") return undefined
  switch (reason) {
    case "task_graph_child_deadline_exceeded": return "deadline_exceeded"
    case "task_graph_verification_failed": return "verification_failed"
    case "task_graph_verification_unverified": return "verification_unverified"
    case "task_graph_dependency_scope_mismatch":
    case "writer_dependency_unavailable": return "dependency_unavailable_or_incompatible"
    case "child_resume_unavailable":
    case "child_resume_evidence_unavailable":
    case "child_resume_wait_step_lineage": return "recovery_unavailable"
    default: return undefined
  }
}

/** Keep legacy detail for roots and unscoped records; classify only exact same-session children. */
export function projectTaskWorkerFailure(task: TaskWorkerFailureProjection): ProjectedTaskWorkerFailure {
  const hasNoParent = task.parentTaskId === undefined || task.parentTaskId === null
  const isRoot = hasNoParent && ((task.role === "orchestrator" && task.taskType === "root")
    || (boundedTaskIdentity(task.taskId) && task.taskId === task.rootTaskId))
  const hasLineage = task.rootTaskId !== undefined && task.rootTaskId !== null
    || task.parentTaskId !== undefined && task.parentTaskId !== null
  if (isRoot || !hasLineage) return { detail: task.reason ?? undefined }
  const isScopedChild = boundedTaskIdentity(task.expectedSessionId) && task.sessionId === task.expectedSessionId
    && boundedTaskIdentity(task.taskId) && boundedTaskIdentity(task.rootTaskId) && boundedTaskIdentity(task.parentTaskId)
    && task.taskId !== task.rootTaskId && task.taskId !== task.parentTaskId
  const childFailure = isScopedChild ? projectChildWorkerFailure(task.status, task.reason) : undefined
  return childFailure ? { childFailure } : {}
}

function boundedTaskIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}

/** Render fixed bilingual copy; non-Chinese locales use the English label. */
export function childWorkerFailureText(failure: ChildWorkerFailure, lang: string): string {
  return FAILURE_TEXT[failure][lang === "zh" ? "zh" : "en"]
}
