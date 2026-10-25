import type pg from "pg"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import { loadWorkerAiConfig, type AiConfig } from "@jobcopilot/shared/llm"

import { createWorkerUsageAuthorizer } from "../../queue/ai-usage-bridge.js"
import type { SubagentExecutor } from "../../queue/subagent-queue.js"
import { createWorkerToolRuntime } from "../tools/index.js"
import { createArtifactToolStore } from "../tools/artifact-tools.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"
import { durablePolicyDecisionRecorder } from "../turns/canonical-runtime-tool-recovery.js"
import { durableLifecycleSink } from "../canonical-turn-runtime.js"
import { createPgTreeBudgetReservationStore } from "./tree-budget-store.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import { createChildExecutor, type ChildExecutorOptions, type ChildToolRuntime } from "./child-executor.js"
import { loadChildSameAttemptContinuation } from "./child-mailbox-continuation.js"
import { loadChildAttemptResume } from "./child-resume.js"
import { commitDurableSubagentWaitResume, loadDurableSubagentWaitResume } from "./durable-subagent-wait-resume.js"
import { loadSelectedJobArtifactContext, readSelectedJobSourceDigestWithClient, resolveCoverLetterBase } from "./selected-job-artifact-context.js"
import { assertPersistedWriterReviewDependency, createTaskGraphWriterReviewFeedbackFrame, TaskGraphWriterReviewFeedbackError, writerReviewDependencyFromTaskContext, type TaskGraphWriterReviewDependency, type TaskGraphWriterReviewFeedbackFrame } from "./task-graph-writer-review-feedback.js"
import { PgCoordinationStore } from "../mailbox/store.js"
import type { ExecutionOwner, ExecutionOwnerFence } from "../execution-owner.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"
import { createJobDiscoveryClient, type JobDiscoveryClient } from "../tools/job-discovery-client.js"
import type { AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import type { ArtifactToolRevisionContext } from "../tools/artifact-tools.js"
import { childDiscoveryExecutionFence, createChildDiscoveryObservers } from "./child-discovery-observers.js"
import { createProductionChildPolicy } from "./production-child-policy.js"
import { createHarnessModelRuntime } from "../harness-model.js"
import { createScheduledApplicationPrepareRuntime } from "./scheduled-application-prepare-runtime.js"
import { createScheduledPrepareReferenceResolver } from "./child-scheduled-prepare-reference.js"
import { createPrivateSelectedJobToolExecutor, registerProductionChildWaitTool } from "./production-child-tools.js"
import { createScheduledGateChildExecutor, isScheduledGateTask } from "./scheduled-gate-child-runtime.js"
import { SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { createScheduledAuditChildExecutor, isScheduledAuditCandidate } from "./scheduled-audit-child-runtime.js"
export { createProductionChildPolicy } from "./production-child-policy.js"

export type ProductionChildRuntimeOptions = {
  readonly pool: pg.Pool
  readonly authorizeUsage?: ChildExecutorOptions["authorizeUsage"]
  readonly turnStore?: TurnEngineStore
  readonly treeBudget?: TreeBudgetReservationStore
  readonly modelRuntimeFactory?: ChildExecutorOptions["modelRuntimeFactory"]
  readonly toolRuntimeFactory?: ChildExecutorOptions["toolRuntimeFactory"]
  readonly mailboxReader?: ChildExecutorOptions["mailboxReader"]
  readonly resumeLoader?: ChildExecutorOptions["resumeLoader"]
  readonly sameAttemptContinuationLoader?: ChildExecutorOptions["sameAttemptContinuationLoader"]
  readonly jobDiscoveryClient?: JobDiscoveryClient
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
type WriterReviewRevision = Readonly<{
  context: ArtifactToolRevisionContext
  feedback: TaskGraphWriterReviewFeedbackFrame
}>
type ScheduledPrepareRuntimeOptions = Readonly<{
  authorizeUsage: ChildExecutorOptions["authorizeUsage"]
  treeBudget: TreeBudgetReservationStore
  modelRuntimeFactory?: ChildExecutorOptions["modelRuntimeFactory"]
}>
function configWithSnapshot(config: AiConfig, snapshot: unknown): AiConfig {
  const value = record(snapshot)
  return {
    ...config,
    ...(typeof value.provider === "string" ? { provider: value.provider as AiConfig["provider"] } : {}),
    ...(typeof value.model === "string" && value.model.trim() ? { model: value.model } : {}),
  }
}
async function resolveScheduledPrepareModel(task: SubagentTaskRecord, factory: ChildExecutorOptions["modelRuntimeFactory"]): Promise<ModelAdapter> {
  if (factory) return factory({ task })
  const primary = configWithSnapshot(await loadWorkerAiConfig(task.userId), task.modelProfileSnapshot)
  return (await createHarnessModelRuntime({ primary, fallbacks: [], allowEnvironmentFallbacks: false })).adapter
}
function artifactTaskFence(lease: SubagentLease): AgentArtifactTaskFence {
  if (!lease.turnId || lease.status !== "running" || lease.interruptRequestedAt !== null
    || !lease.ownerId.trim() || lease.leaseOwner !== lease.ownerId || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1
    || !(lease.leaseExpiresAt instanceof Date) || lease.leaseExpiresAt.getTime() <= Date.now()) {
    throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
  }
  return {
    taskId: lease.id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    rootTaskId: lease.rootTaskId, parentTaskId: lease.parentTaskId, leaseOwner: lease.ownerId, attemptCount: lease.attemptCount,
  }
}
function selectedJobId(task: SubagentTaskRecord): string | undefined {
  const selection = record(record(task.context).selectedJobPreparation)
  return Object.keys(selection).sort().join(",") === "jobId"
    && typeof selection.jobId === "string" && selection.jobId.trim().length > 0 && selection.jobId.length <= 256
    ? selection.jobId
    : undefined
}
function bindStore(store: TurnEngineStore): TurnExecutionStore {
  return {
    startStep: input => store.startStep({ ...withoutIdentity(input), owner: input.identity }),
    updateStep: input => store.updateStep({ ...withoutIdentity(input), owner: input.identity }),
    createItem: input => store.createItem({ ...withoutIdentity(input), owner: input.identity }),
    updateItem: input => store.updateItem({ ...withoutIdentity(input), owner: input.identity }),
    appendEvent: input => store.appendEvent({ ...withoutIdentity(input), owner: input.identity }),
    appendEvents: store.appendEvents ? (inputs) => store.appendEvents!(inputs.map(input => ({ ...withoutIdentity(input), owner: input.identity }))) : undefined,
  }
}
function withoutIdentity<T extends { identity: ExecutionOwnerFence }>(input: T): Omit<T, "identity"> {
  const { identity: _identity, ...rest } = input
  return rest
}

async function defaultTools(pool: pg.Pool, store: TurnEngineStore, task: SubagentTaskRecord, lease: SubagentLease, owner: ExecutionOwnerFence, discoveryClient?: JobDiscoveryClient, prepareOptions?: ScheduledPrepareRuntimeOptions): Promise<ChildToolRuntime> {
  const executionOwner: ExecutionOwner = { kind: "task", lease }
  const selectedJobRole = task.role === "scout" || task.role === "analyst" || task.role === "writer" || task.role === "reviewer"
  const selectedJob = selectedJobRole ? selectedJobId(lease) : undefined
  let writerReviewDependency: TaskGraphWriterReviewDependency | null = null
  if (task.role === "writer" && selectedJob) {
    try { writerReviewDependency = writerReviewDependencyFromTaskContext(lease.context, selectedJob) }
    catch (error: unknown) {
      if (error instanceof TaskGraphWriterReviewFeedbackError) throw error
      throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
    }
    await assertPersistedWriterReviewDependency(pool, task, lease, writerReviewDependency)
  }
  const selectedJobArtifactContext = selectedJob
    ? await loadSelectedJobArtifactContext(pool, task.userId, selectedJob)
    : undefined
  const selectedJobPreparation = selectedJobArtifactContext?.preparation
  const artifacts = selectedJobPreparation && (task.role === "writer" || task.role === "reviewer")
    ? createArtifactToolStore(pool, readSelectedJobSourceDigestWithClient)
    : undefined
  let writerReviewRevision: WriterReviewRevision | undefined
  if (writerReviewDependency) {
    if (!selectedJobPreparation || !artifacts || selectedJobPreparation.jobId !== selectedJob
      || selectedJobPreparation.sourceDigest !== writerReviewDependency.artifactRef.sourceDigest) {
      throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
    }
    const context: ArtifactToolRevisionContext = {
      ...writerReviewDependency, currentSourceDigest: selectedJobPreparation.sourceDigest,
    }
    const scope = {
      ...selectedJobPreparation, userId: lease.userId, sessionId: lease.sessionId, taskId: lease.id,
      toolCallId: "writer-review-feedback", taskFence: artifactTaskFence(lease),
    }
    const review = await artifacts.readRevisionReview(scope, context)
    if (!review) throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
    writerReviewRevision = {
      context,
      feedback: createTaskGraphWriterReviewFeedbackFrame(review, context, {
        userId: lease.userId, sessionId: lease.sessionId, jobId: selectedJobPreparation.jobId,
      }),
    }
  }
  const coverLetterBase = task.role === "writer" && selectedJobPreparation && artifacts
    ? await resolveCoverLetterBase(artifacts, task.userId, selectedJobPreparation.jobId)
    : undefined
  const serverContext = selectedJobPreparation ? {
    selectedJobPreparation,
    ...(coverLetterBase ? { coverLetterBase } : {}),
  } : undefined
  const toolPolicy = createProductionChildPolicy(task, Boolean(selectedJob || selectedJobPreparation))
  const recordPolicyDecision = durablePolicyDecisionRecorder(store, owner, lease.attemptCount)
  const discoveryFence = childDiscoveryExecutionFence(task, lease, selectedJob, selectedJobPreparation)
  const discoveryObservers = discoveryFence ? await createChildDiscoveryObservers(pool, lease, discoveryFence) : undefined
  const scheduledPrepare = task.role === "prepare" && task.taskType === "scheduled_application_prepare" && prepareOptions
    ? createScheduledApplicationPrepareRuntime({ pool, task, lease, owner, authorize: prepareOptions.authorizeUsage,
      treeBudget: prepareOptions.treeBudget, resolveModel: () => resolveScheduledPrepareModel(task, prepareOptions.modelRuntimeFactory) })
    : undefined
  const runtime = createWorkerToolRuntime(pool, {
    sink: durableLifecycleSink(store, owner),
    resolveOwner: () => executionOwner,
    ...(discoveryObservers ? { onDiscoveryAttemptLifecycleEvent: discoveryObservers.observeLifecycleEvent } : {}),
  }, toolPolicy, undefined, undefined, artifacts ? { store: artifacts } : undefined, undefined,
  discoveryFence ? { client: discoveryClient ?? createJobDiscoveryClient(), fence: discoveryFence } : undefined, scheduledPrepare, recordPolicyDecision)
  registerProductionChildWaitTool({ pool, task, lease, registry: runtime.registry })
  return {
    definitions: runtime.registry.list(), router: runtime.router,
    ...(scheduledPrepare ? { resolveScheduledPrepareReference: createScheduledPrepareReferenceResolver(pool, runtime.durableResults, executionOwner) } : {}),
    ...(discoveryObservers ? {
      discoveryAttemptSidecar: () => discoveryObservers.discoveryAttemptSidecar(),
      discoveryRecoverySidecar: () => discoveryObservers.discoveryRecoverySidecar(),
    } : {}),
    ...(selectedJobArtifactContext ? { selectedJobArtifactContext } : {}),
    ...(serverContext ? { serverContext } : {}),
    ...(writerReviewRevision ? { writerReviewRevision } : {}),
    ...(selectedJobPreparation ? {
      executePrivateTool: createPrivateSelectedJobToolExecutor({
        task, writerReviewRevision: writerReviewRevision?.context, registry: runtime.registry, policy: toolPolicy,
        recordPolicyDecision,
      }),
    } : {}),
    validateArguments: (name, input, version) => runtime.registry.validateArguments(name, input, version),
  }
}

export function childExecutionEnabled(value = process.env.ENABLE_AGENT_CHILD_EXECUTION): boolean { return value === "1" }
function defaultMailboxReader(pool: pg.Pool): ChildExecutorOptions["mailboxReader"] | undefined {
  // Keep lightweight construction fixtures usable; a real pg.Pool exposes
  // both methods and therefore gets the server-owned reader.
  const candidate = pool as unknown as { readonly connect?: unknown; readonly query?: unknown }
  if (typeof candidate.connect !== "function" || typeof candidate.query !== "function") return undefined
  return new PgCoordinationStore(pool)
}
function defaultResumeLoader(pool: pg.Pool): ChildExecutorOptions["resumeLoader"] | undefined {
  const candidate = pool as unknown as { readonly connect?: unknown }
  if (typeof candidate.connect !== "function") return undefined
  return async lease => {
    const wait = await loadDurableSubagentWaitResume(pool, lease)
    return loadChildAttemptResume(pool, lease, new Date(), wait)
  }
}
function defaultSameAttemptContinuationLoader(pool: pg.Pool): ChildExecutorOptions["sameAttemptContinuationLoader"] | undefined {
  const candidate = pool as unknown as { readonly connect?: unknown }
  if (typeof candidate.connect !== "function") return undefined
  return lease => loadChildSameAttemptContinuation(pool, lease)
}
/** Build the production child seam only when the explicit feature flag is on. */
export function createProductionChildExecutor(options: ProductionChildRuntimeOptions): SubagentExecutor {
  let genericExecutor: SubagentExecutor | undefined, gateExecutor: SubagentExecutor | undefined
  return async ({ lease, continuation }) => {
    if (isScheduledAuditCandidate(lease)) return createScheduledAuditChildExecutor({ pool: options.pool })({ lease, ...(continuation ? { continuation } : {}) })
    if (lease.taskType === SCHEDULED_GATE_TASK_TYPE) {
      if (!isScheduledGateTask(lease)) return { status: "failed", failureReason: "scheduled_gate_role_task_type_mismatch", retryDisposition: "terminal" }
      gateExecutor ??= createScheduledGateChildExecutor({ pool: options.pool })
      return gateExecutor({ lease })
    }
    if (lease.role === "application_filler" || lease.taskType === "application_fill_for_review") {
      if (lease.role !== "application_filler" || lease.taskType !== "application_fill_for_review") return { status: "failed", failureReason: "application_fill_role_task_type_mismatch", retryDisposition: "terminal" }
      if (continuation) return { status: "failed", failureReason: "application_fill_continuation_unsupported", retryDisposition: "terminal" }
      return (await import("./application-fill-for-review.js")).executeApplicationFillForReview({ pool: options.pool, lease })
    }
    if (!genericExecutor) {
      const engineStore = options.turnStore ?? createPgTurnEngineStore(options.pool)
      const treeBudget = options.treeBudget ?? createPgTreeBudgetReservationStore(options.pool)
      const authorizeUsage = options.authorizeUsage ?? createWorkerUsageAuthorizer()
      genericExecutor = createChildExecutor({
        store: bindStore(engineStore), treeBudget, authorizeUsage,
        modelRuntimeFactory: options.modelRuntimeFactory,
        toolRuntimeFactory: options.toolRuntimeFactory ?? (({ task, lease: childLease, owner }) => defaultTools(options.pool, engineStore, task, childLease, owner, options.jobDiscoveryClient, {
          authorizeUsage, treeBudget, modelRuntimeFactory: options.modelRuntimeFactory,
        })),
        mailboxReader: options.mailboxReader ?? defaultMailboxReader(options.pool), resumeLoader: options.resumeLoader ?? defaultResumeLoader(options.pool),
        durableWaitResumeCommitter: (lease, wait, nextStepOrdinal) => commitDurableSubagentWaitResume(options.pool, lease, {
          waitId: wait.waitId, stepId: wait.stepId, nextStepOrdinal,
        }),
        sameAttemptContinuationLoader: options.sameAttemptContinuationLoader ?? defaultSameAttemptContinuationLoader(options.pool),
      })
    }
    return genericExecutor({ lease, ...(continuation ? { continuation } : {}) })
  }
}
export function createOptionalProductionChildExecutor(options: ProductionChildRuntimeOptions & { readonly enabled?: boolean }): SubagentExecutor | undefined {
  return (options.enabled ?? childExecutionEnabled()) ? createProductionChildExecutor(options) : undefined
}
