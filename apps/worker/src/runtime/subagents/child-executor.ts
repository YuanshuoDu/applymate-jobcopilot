import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { PolicyRole } from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import { loadWorkerAiConfig, type AiConfig } from "@jobcopilot/shared/llm"
import { Buffer } from "node:buffer"

import { executionOwnerFence } from "../execution-owner.js"
import { createHarnessModelRuntime } from "../harness-model.js"
import { visibleToolPolicy, getSubagentRolePolicy } from "./role-policy.js"
import { childContextSnapshot, createChildContextBuilder, type ChildMailboxReader } from "./child-context.js"
import { ROLE_RESULT_SCHEMA, roleResultOutputSchema, type ArtifactVersionReference, type StructuredRole } from "./role-results.js"
import { writerArtifactReferenceFromTaskContext } from "./task-graph-dependency-context.js"
import { createObservedEvidenceIndex, hydrateObservedEvidence, parseAndBindStructuredResult, recordReadToolOutput } from "./child-evidence.js"
import { createChildPrivateArtifactDispatcher, createPrivateArtifactSafeStore, selectedJobId } from "./child-private-artifact.js"
import { createSelectedJobReadRouter, hasSelectedJobReadContext, isSelectedJobReadTool, redactSelectedEvidenceResult, selectedJobToolAllowed, withSelectedJobInputRedaction } from "./selected-job-artifact-context.js"
import type { AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import type { ChildResumeLoader } from "./child-resume.js"
import { SubagentLeaseError, type SubagentExecutionResult, type SubagentLease, type SubagentTaskRecord } from "./types.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { TurnResumeState } from "../turns/turn-engine-types.js"
import { createToolRouterExecutor } from "../turns/turn-engine-helpers.js"
import { runTurnExecutionLoop } from "../turns/turn-execution-loop.js"
import { createUsageAwareModelAdapter, type UsageAwareModelOptions } from "../turns/usage-aware-model.js"
import type { SelectedJobArtifactContextBundle } from "./selected-job-artifact-context.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import type { RuntimeToolDefinition, ToolRouterContext, ToolExecutionResult, ToolCallRequest } from "../tools/types.js"

/** Public metadata keeps the runtime's readonly tool contracts without exposing execution functions to the model. */
export type ChildPublicDefinition = Omit<RuntimeToolDefinition, "execute">
export type ChildToolRuntime = {
  readonly definitions: readonly ChildPublicDefinition[]
  readonly router: { execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult> }
  readonly selectedJobArtifactContext?: SelectedJobArtifactContextBundle
  readonly serverContext?: unknown
  /** Private scoped tools bypass normal lifecycle persistence; only their ref receipt is persisted. */
  readonly executePrivateTool?: (context: ToolRouterContext, request: ToolCallRequest) => Promise<ToolExecutionResult>
  readonly validateArguments?: (name: string, input: unknown, version?: string) => true | string
}

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

function expectedStructuredRole(value: unknown, leasedRole: string): StructuredRole | undefined {
  if (leasedRole !== "scout" && leasedRole !== "analyst" && leasedRole !== "writer" && leasedRole !== "reviewer" || !value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const marker = value as Record<string, unknown>
    const prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) return undefined
    if (Object.keys(marker).length !== 2 || marker.schemaVersion !== ROLE_RESULT_SCHEMA || marker.role !== leasedRole) return undefined
    return leasedRole
  } catch {
    return undefined
  }
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

function visibleDefinitions(task: SubagentTaskRecord, definitions: readonly ChildPublicDefinition[], selectedJob?: string): ChildPublicDefinition[] {
  const policy = getSubagentRolePolicy(task.role)
  if (!policy) throw new Error("subagent_role_unknown")
  const allowedActions = new Set(Array.isArray(task.allowedActions) ? task.allowedActions.filter((action): action is string => typeof action === "string") : [])
  return definitions.filter(definition => {
    if (!allowedActions.has(definition.name) || (selectedJob && !selectedJobToolAllowed(task.role, definition.name))) return false
    if (definition.name === "tool_results.read") {
      return definition.risk === "read"
        && definition.idempotency === "read_only"
        && definition.capabilities.includes("read")
        && policy.allowedRisks.includes("read")
        && definition.requiredCapabilities.every(capability => policy.capabilities.includes(capability))
    }
    if (definition.domain === "coordination") return false
    return visibleToolPolicy(task.role, definition).visible
  })
}

function resultStatus(status: "completed" | "waiting_for_dependency" | "waiting_for_approval" | "waiting_for_user" | "interrupted" | "failed"): SubagentExecutionResult["status"] {
  if (status === "completed") return "completed"
  if (status === "waiting_for_dependency") return "waiting"
  // SubagentTask has no separate approval state; retain the durable wait.
  if (status === "waiting_for_approval" || status === "waiting_for_user") return "waiting_for_user"
  return "failed"
}

function isDeterministicChildResumeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = error.message
  if (!code.startsWith("child_resume_") || code.includes("owner_mismatch") || code.includes("lease_expired")) return false
  return code.startsWith("child_resume_invalid_")
    || code.endsWith("_lineage")
    || code.endsWith("_limit")
    || code.endsWith("_tool_call_conflict")
    || code.endsWith("_tool_result_conflict")
    || code === "child_resume_usage_overflow"
}
export function createChildExecutor(options: ChildExecutorOptions): (input: { lease: SubagentLease }) => Promise<SubagentExecutionResult> {
  if (!options.treeBudget) throw new TypeError("treeBudget is required for child execution")
  return async ({ lease }) => {
    if (!lease.turnId) return { status: "failed", failureReason: "child_turn_missing" }
    const owner = executionOwnerFence({ kind: "task", lease })
    const selectedJob = selectedJobId(lease)
    const selectedEvidenceTask = Boolean(selectedJob && (lease.role === "scout" || lease.role === "analyst"))
    let reviewerArtifactRef: ArtifactVersionReference | undefined
    if ((lease.role === "writer" || lease.role === "reviewer") && !selectedJob) {
      return { status: "failed", failureReason: "selected_job_context_unavailable", retryDisposition: "terminal" }
    }
    if (lease.role === "reviewer") {
      try { reviewerArtifactRef = writerArtifactReferenceFromTaskContext(lease.context, selectedJob!) }
      catch { return { status: "failed", failureReason: "writer_dependency_unavailable", retryDisposition: "terminal" } }
    }
    const runtime = await options.toolRuntimeFactory({ task: lease, owner, lease })
    const selectedJobPreparation = runtime.selectedJobArtifactContext?.preparation
    if (selectedJob && !hasSelectedJobReadContext(runtime.selectedJobArtifactContext, selectedJob)) return { status: "failed", failureReason: "selected_job_sources_unavailable", retryDisposition: "terminal" }
    const definitions = visibleDefinitions(lease, runtime.definitions, selectedJob)
    const policy = getSubagentRolePolicy(lease.role)
    if (!policy) return { status: "failed", failureReason: "subagent_role_unknown" }
    const observedEvidence = createObservedEvidenceIndex()
    let snapshot = childContextSnapshot(lease, runtime.serverContext)
    let resume: TurnResumeState | undefined
    if (options.resumeLoader && lease.attemptCount > 1) {
      try {
        const restored = await options.resumeLoader(lease)
        if (restored) {
          if (!selectedEvidenceTask) {
            try { hydrateObservedEvidence(observedEvidence, restored.observations) } catch { return { status: "failed", failureReason: "child_resume_evidence_unavailable", retryDisposition: "terminal" } }
            snapshot = { ...snapshot, toolObservations: [...restored.observations] }
          }
          resume = restored.resume
        }
      } catch (error: unknown) {
        if (isDeterministicChildResumeError(error)) return { status: "failed", failureReason: "child_resume_unavailable", retryDisposition: "terminal" }
        return { status: "failed", failureReason: "child_resume_unavailable" }
      }
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
      selectedJobPreparation, taskFence, reviewerArtifactRef, observedEvidence, privateCallIds,
    })
    const executeTool: typeof routedTool = async input => {
      if (selectedJobPreparation && isSelectedJobReadTool(input.call.toolName)) privateCallIds.add(input.call.id)
      const toolResult = await dispatchTool(input)
      if (toolResult.status === "completed" && toolResult.errorCode === null) recordReadToolOutput(observedEvidence, input.call.toolName, toolResult.output)
      return toolResult
    }
    const contextBuilder = createChildContextBuilder(lease, snapshot, options.mailboxReader, lease.role === "writer" || lease.role === "reviewer" ? runtime.selectedJobArtifactContext?.transientSources : undefined)
    const result = await runTurnExecutionLoop({
      identity: owner, scope: { userId: lease.userId }, goal: lease.goal, snapshot,
      contextBuilder, store: safeStore, model, tools: definitions,
      executeTool, actorRole: policy.actorRole, capabilities: policy.capabilities,
      validateToolArguments: runtime.validateArguments, signal: lease.signal, now: options.now, publishReasoningSummary: false,
      budget,
      // A retry is a new durable attempt. Keep IDs deterministic within that
      // attempt while preventing attempt 1 and attempt 2 collisions.
      idFactory: prefix => `${prefix}:attempt:${lease.attemptCount}`,
      resume,
      isOwnershipLost: (error, signal) => signal.aborted || error instanceof SubagentLeaseError,
      signalError: () => new Error("subagent_lease_lost"),
      ...(adapter.profile.nativeTools && adapter.profile.structuredOutput && structuredRole ? { outputSchema: roleResultOutputSchema(structuredRole) } : {}),
    })
    const childResult = {
      status: result.status,
      stepCount: result.stepCount,
      toolCallCount: result.toolCallCount,
      finalItemId: result.finalItemId ?? null,
    }
    if (result.status === "completed" && structuredRole) {
      if (typeof result.finalText !== "string") return { status: "failed", result: { ...childResult, status: "failed" as const }, failureReason: "invalid_structured_result" }
      const structuredResult = parseAndBindStructuredResult(result.finalText, structuredRole, observedEvidence)
      if (!structuredResult) return { status: "failed", result: { ...childResult, status: "failed" as const }, failureReason: "invalid_structured_result" }
      const selectedEvidenceRole = Boolean(selectedJobPreparation && (structuredRole === "scout" || structuredRole === "analyst"))
      const safeStructuredResult = selectedEvidenceRole ? redactSelectedEvidenceResult(structuredResult, runtime.selectedJobArtifactContext!) : structuredResult
      const safeFinalText = selectedEvidenceRole ? JSON.stringify(safeStructuredResult) : result.finalText
      return { status: "completed", mailboxMessageIds: contextBuilder.getMailboxMessageIds(), result: { ...childResult, finalText: projectChildFinalText(safeFinalText), structuredResult: safeStructuredResult }, failureReason: result.errorCode }
    }
    const status = resultStatus(result.status)
    return {
      status,
      ...(status === "completed" ? { mailboxMessageIds: contextBuilder.getMailboxMessageIds() } : {}),
      result: { ...childResult, ...(result.status === "completed" && typeof result.finalText === "string" ? { finalText: projectChildFinalText(result.finalText) } : {}) },
      failureReason: result.errorCode,
    }
  }
}
