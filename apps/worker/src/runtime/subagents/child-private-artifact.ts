import { parseArtifactReference, type ArtifactVersionReference } from "./role-results.js"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { artifactReferenceKey, type ObservedEvidenceIndex } from "./child-evidence.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { TurnEngineToolExecutor } from "../turns/turn-engine-types.js"
import type { RuntimeToolDefinition, SelectedJobArtifactTaskFence, SelectedJobPreparationContext, ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"

type PrivateToolExecutor = (context: ToolRouterContext, request: ToolCallRequest) => Promise<ToolExecutionResult>
type PublicDefinition = Pick<RuntimeToolDefinition, "name" | "version">
type PrivateArtifactSafeStoreOptions = { readonly redactModelText?: boolean }

const PRIVATE_MODEL_TEXT_PLACEHOLDER = "[Private selected-job response withheld]"
const PRIVATE_MODEL_TEXT_KEYS = new Set([
  "text", "body", "response", "final", "finalText", "finalResponse", "finalContent", "commentary", "reasoning", "summary", "narrative", "message", "content", "blocker", "feedback",
])
const SAFE_PRIVATE_STATUS = new Set(["completed", "failed", "passed", "needs_revision", "rejected", "stale"])

export function selectedJobId(task: SubagentTaskRecord): string | undefined {
  const context = record(task.context)
  const selected = record(context.selectedJobPreparation)
  return Object.keys(selected).sort().join(",") === "jobId"
    && typeof selected.jobId === "string" && selected.jobId.trim().length > 0 && selected.jobId.length <= 256
    ? selected.jobId
    : undefined
}

export function validSelectedJobContext(value: SelectedJobPreparationContext | undefined, jobId: string): value is SelectedJobPreparationContext {
  return Boolean(value && value.jobId === jobId && /^sha256:[a-f0-9]{64}$/.test(value.sourceDigest)
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0
    && value.evidenceRefs.every(ref => typeof ref === "string" && ref.trim().length > 0 && ref.length <= 256)
    && new Set(value.evidenceRefs).size === value.evidenceRefs.length)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function privateArtifactReceipt(value: unknown): RepositoryJsonValue {
  try { return { artifactRef: parseArtifactReference(record(value).artifactRef) } } catch { return { privateArtifact: true } }
}

function redactPrivateArtifactData(value: unknown, ids: ReadonlySet<string>, depth = 0): RepositoryJsonValue {
  if (depth > 32) return null
  if (Array.isArray(value)) return value.map(item => redactPrivateArtifactData(item, ids, depth + 1))
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null
  if (!row) return null
  const privateToolCall = typeof row.toolCallId === "string" && ids.has(row.toolCallId)
  const privateDraftInput = row.toolName === "cover_letter.draft" && Object.prototype.hasOwnProperty.call(row, "input")
  if (privateToolCall || privateDraftInput) {
    const result: Record<string, RepositoryJsonValue> = {}
    for (const [key, child] of Object.entries(row)) {
      if (key === "output" && privateToolCall) result[key] = privateArtifactReceipt(child)
      else if (key === "input" && row.toolName === "cover_letter.draft") {
        const input = record(child)
        const safeInput: Record<string, RepositoryJsonValue> = {}
        for (const [inputKey, inputValue] of Object.entries(input)) {
          if (inputKey !== "content") safeInput[inputKey] = redactPrivateArtifactData(inputValue, ids, depth + 1)
        }
        result[key] = safeInput
      } else result[key] = redactPrivateArtifactData(child, ids, depth + 1)
    }
    return result
  }
  const result: Record<string, RepositoryJsonValue> = {}
  for (const [key, child] of Object.entries(row)) result[key] = redactPrivateArtifactData(child, ids, depth + 1)
  return result
}

function redactPrivateModelText(value: unknown, key?: string, depth = 0, privateContext = false): RepositoryJsonValue {
  if (depth > 32) return null
  if (key === "artifactRef") {
    try { return parseArtifactReference(value) as unknown as RepositoryJsonValue } catch { return null }
  }
  const redactContext = privateContext || (key !== undefined && PRIVATE_MODEL_TEXT_KEYS.has(key))
  if (typeof value === "string") {
    if (redactContext) {
      if ((key === "status" || key === "reviewStatus") && SAFE_PRIVATE_STATUS.has(value)) return value
      if (key === "reviewHash" && /^sha256:[a-f0-9]{64}$/.test(value)) return value
      return PRIVATE_MODEL_TEXT_PLACEHOLDER
    }
    return value
  }
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(item => redactPrivateModelText(item, key, depth + 1, redactContext))
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null
  if (!row) return null
  const result: Record<string, RepositoryJsonValue> = {}
  for (const [childKey, child] of Object.entries(row)) {
    result[childKey] = redactPrivateModelText(child, childKey, depth + 1, redactContext)
  }
  return result
}

/** Persist only artifact references and never keep drafted letter content in child turn items/events. */
export function createPrivateArtifactSafeStore(
  store: TurnExecutionStore,
  privateCallIds: ReadonlySet<string>,
  options: PrivateArtifactSafeStoreOptions = {},
): TurnExecutionStore {
  const redactModelText = options.redactModelText === true
  const safe = (value: unknown): RepositoryJsonValue => {
    const artifactSafe = redactPrivateArtifactData(value, privateCallIds)
    return redactModelText ? redactPrivateModelText(artifactSafe) : artifactSafe
  }
  return {
    ...store,
    createItem: input => store.createItem({ ...input, content: safe(input.content) }),
    updateItem: input => store.updateItem({ ...input, content: safe(input.content) }),
    appendEvent: input => store.appendEvent({ ...input, payload: safe(input.payload) }),
    ...(store.appendEvents ? { appendEvents: inputs => store.appendEvents!(inputs.map(input => ({ ...input, payload: safe(input.payload) }))) } : {}),
    ...(redactModelText && store.recordFinalResponse ? {
      recordFinalResponse: input => store.recordFinalResponse!({
        identity: input.identity,
        now: input.now,
        response: PRIVATE_MODEL_TEXT_PLACEHOLDER,
        ...(input.terminal ? { terminal: safe(input.terminal) as NonNullable<typeof input.terminal> } : {}),
      }),
    } : {}),
  }
}

function resultFor(request: ToolCallRequest, errorCode: string, message = errorCode): ToolExecutionResult {
  return { ...request, status: "failed", output: { error: message }, errorCode }
}

function exactReference(value: unknown): ArtifactVersionReference | undefined {
  try { return parseArtifactReference(record(value).artifactRef) } catch { return undefined }
}

function privateContext(input: Parameters<TurnEngineToolExecutor>[0], selectedJobPreparation: SelectedJobPreparationContext | undefined, taskFence: SelectedJobArtifactTaskFence | undefined, lease: SubagentLease): ToolRouterContext {
  return {
    scope: { ...input.scope, userId: lease.userId }, sessionId: lease.sessionId,
    turnId: lease.turnId ?? input.turnId, stepId: input.stepId,
    taskId: lease.id, rootTaskId: lease.rootTaskId, actorRole: input.actorRole,
    remainingTurnSteps: input.remainingTurnSteps, signal: input.signal, capabilities: input.capabilities,
    selectedJobPreparation, taskFence,
  }
}

export function createChildPrivateArtifactDispatcher(options: {
  readonly lease: SubagentLease
  readonly definitions: readonly PublicDefinition[]
  readonly executeRoutedTool: TurnEngineToolExecutor
  readonly executePrivateTool?: PrivateToolExecutor
  readonly selectedJobPreparation?: SelectedJobPreparationContext
  readonly taskFence?: SelectedJobArtifactTaskFence
  readonly reviewerArtifactRef?: ArtifactVersionReference
  readonly observedEvidence: ObservedEvidenceIndex
  readonly privateCallIds: Set<string>
}): TurnEngineToolExecutor {
  return async input => {
    const request = input.call
    const permitted = options.definitions.some(definition => definition.name === request.toolName && definition.version === request.toolVersion)
    if (!permitted) return resultFor(request, "child_action_denied", "tool_not_allowed")

    const privateTool = request.toolName === "artifact.version.read"
      || request.toolName === "cover_letter.draft"
      || request.toolName === "artifact.review"
    if (!privateTool) return options.executeRoutedTool(input)
    options.privateCallIds.add(request.id)
    const fence = options.taskFence
    if (!fence || options.lease.status !== "running" || options.lease.interruptRequestedAt !== null
      || options.lease.leaseOwner !== options.lease.ownerId || !options.lease.turnId
      || fence.taskId !== options.lease.id || fence.userId !== options.lease.userId
      || fence.sessionId !== options.lease.sessionId || fence.turnId !== options.lease.turnId
      || fence.rootTaskId !== options.lease.rootTaskId || fence.parentTaskId !== options.lease.parentTaskId
      || fence.leaseOwner !== options.lease.ownerId || fence.attemptCount !== options.lease.attemptCount) {
      return resultFor(request, "task_fence_denied")
    }
    if (!options.executePrivateTool) return resultFor(request, "private_artifact_tool_unavailable")

    const toolContext = privateContext(input, options.selectedJobPreparation, options.taskFence, options.lease)
    if (request.toolName === "artifact.version.read") {
      const reference = exactReference(request.input)
      if (options.lease.role !== "reviewer" || !reference || !options.reviewerArtifactRef
        || JSON.stringify(reference) !== JSON.stringify(options.reviewerArtifactRef)) {
        return resultFor(request, "private_artifact_read_unavailable")
      }
      try { return await options.executePrivateTool(toolContext, request) }
      catch { return resultFor(request, "private_artifact_read_failed") }
    }
    if (request.toolName === "cover_letter.draft") {
      if (options.lease.role !== "writer" || !options.selectedJobPreparation) return resultFor(request, "private_artifact_draft_unavailable")
      try { return await options.executePrivateTool(toolContext, request) }
      catch { return resultFor(request, "private_artifact_draft_failed") }
    }

    const reference = exactReference(request.input)
    if (options.lease.role !== "reviewer" || !reference || !options.reviewerArtifactRef
      || JSON.stringify(reference) !== JSON.stringify(options.reviewerArtifactRef)
      || !options.observedEvidence.artifactReads.has(artifactReferenceKey(options.reviewerArtifactRef))) {
      return resultFor(request, "review_requires_private_read")
    }
    try { return await options.executePrivateTool(toolContext, request) }
    catch { return resultFor(request, "private_artifact_review_failed") }
  }
}
