import type { ModelAdapter } from "@jobcopilot/agent-model"
import { redactSensitiveText } from "@jobcopilot/shared"
import { loadWorkerAiConfig, type AiConfig } from "@jobcopilot/shared/llm"
import { Buffer } from "node:buffer"
import { executionOwnerFence } from "../execution-owner.js"
import { createHarnessModelRuntime } from "../harness-model.js"
import { getSubagentRolePolicy } from "./role-policy.js"
import { childContextSnapshot, createChildContextBuilder, type ChildMailboxReader } from "./child-context.js"
import { type ArtifactVersionReference, type StructuredRole } from "./role-results.js"
import { expectedStructuredRole } from "./production-child-policy.js"
import { writerArtifactReferenceFromTaskContext } from "./task-graph-dependency-context.js"
import { TaskGraphWriterReviewFeedbackError } from "./task-graph-writer-review-feedback.js"
import type { TaskGraphWriterReviewFeedbackFrame } from "./task-graph-writer-review-feedback.js"
import type { ArtifactToolRevisionContext } from "../tools/artifact-tools.js"
import { createObservedEvidenceIndex, hydrateObservedEvidence, recordReadToolOutput } from "./child-evidence.js"
import { parseAndBindStructuredResultOutcome } from "./child-structured-result-outcome.js"
import { structuredResultOutputSchema } from "./child-structured-result-outcome.js"
import { parseScheduledPrepareReference, resolveScheduledPrepareResumeEvidence, type ScheduledPrepareReferenceResolver } from "./child-scheduled-prepare-reference.js"
import { createChildPrivateArtifactDispatcher, createPrivateArtifactSafeStore, selectedJobId, type PrivateArtifactToolContext } from "./child-private-artifact.js"
import { createSelectedJobReadRouter, hasSelectedJobReadContext, isSelectedJobReadTool, redactSelectedEvidenceResult, withSelectedJobInputRedaction } from "./selected-job-artifact-context.js"
import { dispatchNativeVerificationTask } from "./native-verification-executor.js"
import type { AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import type { ChildResumeLoader } from "./child-resume.js"
import type { DiscoveryAttemptSidecar } from "./child-discovery-attempt.js"
import type { DiscoveryRecoverySnapshot } from "./task-graph-discovery-recovery-contract.js"
import { SubagentLeaseError, type SubagentExecutionResult, type SubagentLease, type SubagentTaskRecord } from "./types.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { TurnResumeState } from "../turns/turn-engine-types.js"
import { createToolRouterExecutor } from "../turns/turn-engine-helpers.js"
import { runTurnExecutionLoop } from "../turns/turn-execution-loop.js"
import { createUsageAwareModelAdapter, type UsageAwareModelOptions } from "../turns/usage-aware-model.js"
import type { SelectedJobArtifactContextBundle } from "./selected-job-artifact-context.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import type { RuntimeToolDefinition, ToolRouterContext, ToolExecutionResult, ToolCallRequest } from "../tools/types.js"
import { canManageChildrenWithWaitAction, visibleChildDefinitions, isOrdinaryScout, childResultStatus as resultStatus, isDeterministicChildResumeError, acknowledgeDurableWaitAtContinuationStart } from "./child-executor-admission.js"
import type { ChildPublicDefinition, ChildToolRuntime } from "./child-executor-admission.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
export type { ChildPublicDefinition, ChildToolRuntime } from "./child-executor-admission.js"

const MAX_CHILD_FINAL_TEXT_BYTES = 8 * 1024
const CHILD_FINAL_TEXT_TRUNCATION_MARKER = "...[TRUNCATED]"
function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0
  let prefix = ""
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8")
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return prefix
}

function projectChildFinalText(value: string): string {
  const redacted = redactSensitiveText(value)
  if (Buffer.byteLength(redacted, "utf8") <= MAX_CHILD_FINAL_TEXT_BYTES) return redacted
  const markerBytes = Buffer.byteLength(CHILD_FINAL_TEXT_TRUNCATION_MARKER, "utf8")
  return `${utf8Prefix(redacted, MAX_CHILD_FINAL_TEXT_BYTES - markerBytes)}${CHILD_FINAL_TEXT_TRUNCATION_MARKER}`
}

export type ChildExecutorOptions = {
  readonly store: TurnExecutionStore
  readonly treeBudget: TreeBudgetReservationStore
  readonly authorizeUsage: UsageAwareModelOptions["authorize"]
  readonly modelRuntimeFactory?: (input: { task: SubagentTaskRecord }) => Promise<ModelAdapter> | ModelAdapter
  readonly toolRuntimeFactory: (input: { task: SubagentTaskRecord; lease: SubagentLease; owner: ReturnType<typeof executionOwnerFence> }) => ChildToolRuntime | Promise<ChildToolRuntime>
  /** Reads pending child mailbox messages without acknowledging or consuming them. */
  readonly mailboxReader?: ChildMailboxReader
  /** Restores only server-owned state from prior durable attempts. */
  readonly resumeLoader?: ChildResumeLoader
  /** Acknowledges a delivered durable wait only after the continuation step exists. */
  readonly durableWaitResumeCommitter?: (lease: SubagentLease, wait: DurableWaitResume, nextStepOrdinal: number) => Promise<boolean | void>
  readonly now?: () => Date
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function configWithSnapshot(config: AiConfig, snapshot: unknown): AiConfig {
  const value = record(snapshot)
  const provider = value.provider
  const model = value.model
  return {
    ...config,
    ...(typeof provider === "string" ? { provider: provider as AiConfig["provider"] } : {}),
    ...(typeof model === "string" && model.trim() ? { model } : {}),
  }
}

async function defaultModel(task: SubagentTaskRecord): Promise<ModelAdapter> {
  const config = configWithSnapshot(await loadWorkerAiConfig(task.userId), task.modelProfileSnapshot)
  return (await createHarnessModelRuntime({ primary: config, fallbacks: [], allowEnvironmentFallbacks: false })).adapter
}

export function createChildExecutor(options: ChildExecutorOptions): (input: { lease: SubagentLease }) => Promise<SubagentExecutionResult> {
  if (!options.treeBudget) throw new TypeError("treeBudget is required for child execution")
  return async ({ lease }) => {
    if (!lease.turnId) return { status: "failed", failureReason: "child_turn_missing" }
    const owner = executionOwnerFence({ kind: "task", lease })
    const verifier = await dispatchNativeVerificationTask({ lease, owner, store: options.store, treeBudget: options.treeBudget, authorizeUsage: options.authorizeUsage, resolveModel: () => options.modelRuntimeFactory?.({ task: lease }) ?? defaultModel(lease), now: options.now }); if (verifier) return verifier
    const selectedJob = selectedJobId(lease), selectedEvidenceTask = Boolean(selectedJob && (lease.role === "scout" || lease.role === "analyst"))
    let reviewerArtifactRef: ArtifactVersionReference | undefined
    if ((lease.role === "writer" || lease.role === "reviewer") && !selectedJob) {
      return { status: "failed", failureReason: "selected_job_context_unavailable", retryDisposition: "terminal" }
    }
    if (lease.role === "reviewer") {
      try { reviewerArtifactRef = writerArtifactReferenceFromTaskContext(lease.context, selectedJob!) }
      catch { return { status: "failed", failureReason: "writer_dependency_unavailable", retryDisposition: "terminal" } }
    }
    let runtime: ChildToolRuntime
    try { runtime = await options.toolRuntimeFactory({ task: lease, owner, lease }) }
    catch (error: unknown) {
      if (error instanceof TaskGraphWriterReviewFeedbackError) {
        return { status: "failed", failureReason: error.code, retryDisposition: "terminal" }
      }
      throw error
    }
    const selectedJobPreparation = runtime.selectedJobArtifactContext?.preparation
    if (selectedJob && !hasSelectedJobReadContext(runtime.selectedJobArtifactContext, selectedJob)) return { status: "failed", failureReason: "selected_job_sources_unavailable", retryDisposition: "terminal" }
    if (runtime.writerReviewRevision && lease.role !== "writer") return { status: "failed", failureReason: "writer_review_revision_role_invalid", retryDisposition: "terminal" }
    const definitions = visibleChildDefinitions(lease, runtime.definitions, selectedJob, Boolean(runtime.writerReviewRevision))
    const policy = getSubagentRolePolicy(lease.role)
    if (!policy) return { status: "failed", failureReason: "subagent_role_unknown" }
    let snapshot = childContextSnapshot(lease, runtime.serverContext), resume: TurnResumeState | undefined
    let durableWaitResume: DurableWaitResume | undefined
    const observedEvidence = createObservedEvidenceIndex()
    const durableWaitResumeEligible = canManageChildrenWithWaitAction(policy, lease.allowedActions)
    if (options.resumeLoader && (lease.attemptCount > 1 || durableWaitResumeEligible)) {
      try {
        const restored = await options.resumeLoader(lease)
        if (restored) {
          durableWaitResume = restored.durableWait
          if (!selectedEvidenceTask) {
            try {
              const prepare = await resolveScheduledPrepareResumeEvidence(restored.observations, runtime.resolveScheduledPrepareReference, lease.id, lease.attemptCount)
              const evidence = restored.observations.filter(item => !["scheduled.application.prepare", "wait_subagents"].includes(String(record(item.content).toolName)))
              hydrateObservedEvidence(observedEvidence, evidence, { taskId: lease.id, attemptCount: lease.attemptCount })
              for (const item of prepare) recordReadToolOutput(observedEvidence, "scheduled.application.prepare", item.result, undefined,
                { toolCallId: item.toolCallId, taskId: lease.id, attemptCount: lease.attemptCount, ...(item.reference ? { reference: item.reference } : {}) })
            } catch { return { status: "failed", failureReason: "child_resume_evidence_unavailable", retryDisposition: "terminal" } }
            snapshot = { ...snapshot, toolObservations: [...restored.observations] }
          }
          resume = restored.resume
        }
      } catch (error: unknown) {
        if (isDeterministicChildResumeError(error)) return { status: "failed", failureReason: "child_resume_unavailable", retryDisposition: "terminal" }
        return { status: "failed", failureReason: "child_resume_unavailable" }
      }
    }
    if (durableWaitResume && (!resume || durableWaitResume.attempt !== lease.attemptCount || resume.nextOrdinal !== durableWaitResume.ordinal + 1)) {
      return { status: "failed", failureReason: "child_resume_wait_step_lineage", retryDisposition: "terminal" }
    }
    const budget = await options.treeBudget.readRootLimits?.({
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: lease.rootTaskId,
    })
    const structuredRole = expectedStructuredRole(lease.expectedOutputSchema, lease.role)
    if (selectedJobPreparation && (lease.role === "writer" || lease.role === "reviewer") && !structuredRole) {
      return { status: "failed", failureReason: "selected_job_output_contract_unavailable", retryDisposition: "terminal" }
    }
    const adapter = await (options.modelRuntimeFactory?.({ task: lease }) ?? defaultModel(lease))
    const model = createUsageAwareModelAdapter(adapter, { owner, authorize: options.authorizeUsage, treeBudget: options.treeBudget })
    const router = createSelectedJobReadRouter(runtime.router, runtime.selectedJobArtifactContext)
    const routedTool = createToolRouterExecutor(router)
    const privateCallIds = new Set<string>()
    const safeStore = withSelectedJobInputRedaction(createPrivateArtifactSafeStore(options.store, privateCallIds, { redactModelText: Boolean(selectedJobPreparation) }), Boolean(selectedJobPreparation))
    const taskFence: AgentArtifactTaskFence | undefined = lease.turnId && lease.leaseOwner === lease.ownerId
      && lease.status === "running" && lease.interruptRequestedAt === null && Number.isSafeInteger(lease.attemptCount) && lease.attemptCount > 0
      ? {
          taskId: lease.id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
          rootTaskId: lease.rootTaskId, parentTaskId: lease.parentTaskId, leaseOwner: lease.ownerId,
          attemptCount: lease.attemptCount,
        }
      : undefined
    const dispatchTool = createChildPrivateArtifactDispatcher({
      lease, definitions, executeRoutedTool: routedTool, executePrivateTool: runtime.executePrivateTool,
      selectedJobPreparation, taskFence, reviewerArtifactRef, writerRevisionContext: runtime.writerReviewRevision?.context,
      observedEvidence, privateCallIds,
    })
    const executeTool: typeof routedTool = async input => {
      if (selectedJobPreparation && isSelectedJobReadTool(input.call.toolName)) privateCallIds.add(input.call.id)
      const toolResult = await dispatchTool(input)
      if (toolResult.status === "completed" && toolResult.errorCode === null) {
        let output = toolResult.output, reference: import("./child-scheduled-prepare-reference.js").ScheduledPrepareReference | undefined
        const prepare = input.call.toolName === "scheduled.application.prepare"
        if (prepare && Object.hasOwn(record(output), "$ref")) {
          try {
            const resolved = await runtime.resolveScheduledPrepareReference?.({ output, originalToolCallId: input.call.id, expectedTaskId: lease.id, expectedAttemptCount: lease.attemptCount })
            if (!resolved) return toolResult
            output = resolved.result; reference = resolved.reference
          } catch { return toolResult }
        }
        recordReadToolOutput(observedEvidence, input.call.toolName, output, undefined,
          prepare ? { toolCallId: input.call.id, taskId: lease.id, attemptCount: lease.attemptCount, ...(reference ? { reference } : {}) } : undefined)
      }
      return toolResult
    }
    const contextBuilder = createChildContextBuilder(
      lease, snapshot, options.mailboxReader,
      lease.role === "writer" || lease.role === "reviewer" ? runtime.selectedJobArtifactContext?.transientSources : undefined,
      lease.role === "writer" ? runtime.writerReviewRevision?.feedback : undefined,
    )
    const result = await runTurnExecutionLoop({
      identity: owner, scope: { userId: lease.userId }, goal: lease.goal, snapshot,
      contextBuilder, store: acknowledgeDurableWaitAtContinuationStart(safeStore, lease, durableWaitResume, options.durableWaitResumeCommitter), model, tools: definitions,
      executeTool, actorRole: policy.actorRole, capabilities: policy.capabilities,
      validateToolArguments: runtime.validateArguments, signal: lease.signal, now: options.now, publishReasoningSummary: false,
      budget,
      // A retry is a new durable attempt. Keep IDs deterministic within that
      // attempt while preventing attempt 1 and attempt 2 collisions.
      idFactory: prefix => `${prefix}:attempt:${lease.attemptCount}`,
      resume,
      isOwnershipLost: (error, signal) => signal.aborted || error instanceof SubagentLeaseError,
      signalError: () => new Error("subagent_lease_lost"),
      ...(adapter.profile.nativeTools && adapter.profile.structuredOutput && structuredRole ? { outputSchema: structuredResultOutputSchema(structuredRole) } : {}),
    })
    const childResult = {
      status: result.status,
      stepCount: result.stepCount,
      toolCallCount: result.toolCallCount,
      finalItemId: result.finalItemId ?? null,
    }
    const discoveryAttempt = lease.role === "scout" && lease.taskType === "job_discovery" && !selectedJob
      && (result.status === "completed" || result.status === "failed") ? runtime.discoveryAttemptSidecar?.() : undefined
    const discoveryAttemptField = discoveryAttempt ? { discoveryAttempt } : {}
    const discoveryRecoveryField = (): { discoveryRecovery?: DiscoveryRecoverySnapshot } => {
      if (!isOrdinaryScout(lease, structuredRole, selectedJob, selectedJobPreparation)) return {}
      const recovery = runtime.discoveryRecoverySidecar?.()
      return recovery ? { discoveryRecovery: recovery } : {}
    }
    if (result.status === "completed" && structuredRole) {
      const finalText = result.finalText, outcome = parseAndBindStructuredResultOutcome(finalText, structuredRole, observedEvidence)
      if (outcome.kind === "invalid") return { status: "failed", result: { ...childResult, ...discoveryAttemptField, ...discoveryRecoveryField(), status: "failed" as const, ...((structuredRole === "scout" || structuredRole === "analyst" || structuredRole === "prepare") && outcome.category ? { structuredOutputFailureCategory: outcome.category } : {}) }, failureReason: "invalid_structured_result" }
      if (typeof finalText !== "string") return { status: "failed", result: { ...childResult, ...discoveryAttemptField, ...discoveryRecoveryField(), status: "failed" as const }, failureReason: "invalid_structured_result" }; const structuredResult = outcome.result
      const selectedEvidenceRole = Boolean(selectedJobPreparation && (structuredRole === "scout" || structuredRole === "analyst"))
      const safeStructuredResult = selectedEvidenceRole ? redactSelectedEvidenceResult(structuredResult, runtime.selectedJobArtifactContext!) : structuredResult
      let safeFinalText = projectChildFinalText(selectedJobPreparation ? JSON.stringify(safeStructuredResult) : finalText)
      if (structuredRole === "prepare") {
        try { safeFinalText = JSON.stringify(parseScheduledPrepareReference(JSON.parse(finalText))) } catch { /* Inline Prepare text uses the generic redactor. */ }
      }
      return { status: "completed", mailboxMessageIds: contextBuilder.getMailboxMessageIds(), result: { ...childResult, ...discoveryAttemptField, ...discoveryRecoveryField(), finalText: safeFinalText, structuredResult: safeStructuredResult }, failureReason: result.errorCode }
    }
    const status = resultStatus(result.status)
    return {
      status,
      ...(status === "completed" ? { mailboxMessageIds: contextBuilder.getMailboxMessageIds() } : {}),
      result: { ...childResult, ...discoveryAttemptField, ...(result.status === "failed" ? discoveryRecoveryField() : {}), ...(result.status === "completed" && typeof result.finalText === "string" ? { finalText: projectChildFinalText(result.finalText) } : {}) },
      failureReason: result.errorCode,
    }
  }
}
