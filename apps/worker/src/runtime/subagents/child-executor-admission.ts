import type { RuntimeToolDefinition, ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import type { ArtifactToolRevisionContext } from "../tools/artifact-tools.js"
import type { SelectedJobArtifactContextBundle } from "./selected-job-artifact-context.js"
import type { PrivateArtifactToolContext } from "./child-private-artifact.js"
import type { TaskGraphWriterReviewFeedbackFrame } from "./task-graph-writer-review-feedback.js"
import type { DiscoveryAttemptSidecar } from "./child-discovery-attempt.js"
import type { DiscoveryRecoverySnapshot } from "./task-graph-discovery-recovery-contract.js"
import type { ScheduledPrepareReferenceResolver } from "./child-scheduled-prepare-reference.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import { getSubagentRolePolicy, visibleToolPolicy } from "./role-policy.js"
import { selectedJobToolAllowed } from "./selected-job-artifact-context.js"
import type { SubagentRolePolicy } from "./role-policy.js"
import type { SubagentExecutionResult, SubagentTaskRecord, SubagentLease } from "./types.js"

export type ChildPublicDefinition = Omit<RuntimeToolDefinition, "execute">
export type ChildRolePolicyTask = Pick<SubagentTaskRecord, "role" | "allowedActions">
export type ChildToolRuntime = {
  readonly definitions: readonly ChildPublicDefinition[]
  readonly router: { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> }
  readonly selectedJobArtifactContext?: SelectedJobArtifactContextBundle
  readonly writerReviewRevision?: Readonly<{ context: ArtifactToolRevisionContext; feedback: TaskGraphWriterReviewFeedbackFrame }>
  readonly serverContext?: unknown
  readonly discoveryAttemptSidecar?: () => DiscoveryAttemptSidecar | undefined
  readonly discoveryRecoverySidecar?: () => DiscoveryRecoverySnapshot | undefined
  readonly resolveScheduledPrepareReference?: ScheduledPrepareReferenceResolver
  readonly executePrivateTool?: (context: PrivateArtifactToolContext, request: ToolCallRequest) => Promise<ToolExecutionResult>
  readonly validateArguments?: (name: string, input: unknown, version?: string) => true | string
}

export function canManageChildrenWithWaitAction(policy: Pick<SubagentRolePolicy, "canManageChildren"> | null, actions: unknown): boolean {
  return policy?.canManageChildren === true && Array.isArray(actions) && actions.some(action => action === "wait_subagents")
}

function exactCapabilities(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every(capability => actual.includes(capability))
}

function isExactDurableWaitDefinition(definition: ChildPublicDefinition): boolean {
  return definition.name === "wait_subagents" && definition.version === "1"
    && definition.risk === "internal_write" && definition.domain === "coordination"
    && definition.idempotency === "requires_key" && exactCapabilities(definition.capabilities, ["coordination"])
    && definition.requiredCapabilities.length === 0
}

export function visibleChildDefinitions(
  task: ChildRolePolicyTask,
  definitions: readonly ChildPublicDefinition[],
  selectedJob?: string,
  writerRevision = false,
): ChildPublicDefinition[] {
  const policy = getSubagentRolePolicy(task.role)
  if (!policy) throw new Error("subagent_role_unknown")
  const actions = new Set(Array.isArray(task.allowedActions) ? task.allowedActions.filter((action): action is string => typeof action === "string") : [])
  return definitions.filter(definition => {
    if (!actions.has(definition.name) || (selectedJob && !selectedJobToolAllowed(task.role, definition.name, writerRevision))) return false
    if (definition.name === "wait_subagents") return isExactDurableWaitDefinition(definition) && canManageChildrenWithWaitAction(policy, task.allowedActions)
    if (definition.name === "tool_results.read") {
      return definition.risk === "read" && definition.idempotency === "read_only"
        && definition.capabilities.includes("read") && policy.allowedRisks.includes("read")
        && definition.requiredCapabilities.every(capability => policy.capabilities.includes(capability))
    }
    if (definition.domain === "coordination") return false
    return visibleToolPolicy(task.role, definition).visible
  })
}

export function isOrdinaryScout(lease: { role: string; taskType: string; context?: unknown }, structuredRole: string | undefined, selectedJob: string | undefined, selectedJobPreparation: unknown): boolean {
  const context = lease.context && typeof lease.context === "object" && !Array.isArray(lease.context)
    ? lease.context as Record<string, unknown> : {}
  return lease.role === "scout" && lease.taskType === "job_discovery" && structuredRole === "scout" && !selectedJob && !selectedJobPreparation
    && !["selectedJobPreparation", "coverLetterBase", "writerReviewFeedback"].some(key => Object.hasOwn(context, key))
}

export function childResultStatus(status: "completed" | "waiting_for_dependency" | "waiting_for_approval" | "waiting_for_user" | "interrupted" | "failed"): SubagentExecutionResult["status"] {
  if (status === "completed") return "completed"
  if (status === "waiting_for_dependency") return "waiting"
  if (status === "waiting_for_approval" || status === "waiting_for_user") return "waiting_for_user"
  return "failed"
}

export function isDeterministicChildResumeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = error.message
  if (!code.startsWith("child_resume_") || code.includes("owner_mismatch") || code.includes("lease_expired")) return false
  return code.startsWith("child_resume_invalid_") || code.endsWith("_lineage") || code.endsWith("_limit")
    || code.endsWith("_tool_call_conflict") || code.endsWith("_tool_result_conflict") || code === "child_resume_usage_overflow"
}

export function acknowledgeDurableWaitAtContinuationStart(
  store: TurnExecutionStore, lease: SubagentLease, wait: DurableWaitResume | undefined,
  commit?: (lease: SubagentLease, wait: DurableWaitResume, nextStepOrdinal: number) => Promise<boolean | void>,
): TurnExecutionStore {
  if (!wait) return store
  if (!commit || wait.attempt !== lease.attemptCount || !Number.isSafeInteger(wait.ordinal) || wait.ordinal < 0) {
    throw new Error("child_resume_wait_commit_unavailable")
  }
  return { ...store, startStep: async input => {
    const step = await store.startStep(input)
    if (input.ordinal !== wait.ordinal + 1) return step
    const owner = input.identity
    if (owner.kind !== "task" || owner.userId !== lease.userId || owner.sessionId !== lease.sessionId || owner.turnId !== lease.turnId
      || owner.taskId !== lease.id || owner.rootTaskId !== lease.rootTaskId || owner.ownerId !== lease.ownerId
      || owner.attemptCount !== wait.attempt || input.attempt !== wait.attempt || step.ordinal !== input.ordinal) {
      throw new Error("child_resume_wait_owner_mismatch")
    }
    if (await commit(lease, wait, step.ordinal) === false) throw new Error("child_resume_wait_commit_pending")
    return step
  } }
}
