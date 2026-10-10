import type { TenantScope } from "@jobcopilot/agent-protocol"

import type { ContextBlock, ContextOwnerFence, ContextRole, ContextLayer, ContextTrust } from "./step-context-builder.js"
import type { StepCheckpoint, StoredAgentInput, InputClaimTransaction } from "./input-claim-store.js"
import type { StepContextRequest, StepSteeringMarkerControl } from "./step-context-builder.js"
import type { HydrationScope } from "./steering-reconciliation-context.js"
import type { ClaimedInputs } from "./input-claim-types.js"
import { activeMarkerInputIds, assertHydratedSteeringInputs, mergeSteeringInputs } from "./steering-marker-hydration.js"
import { buildObservedSteeringMarker } from "./steering-marker-store.js"

export function safeTaskGraphRevision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function ensureTurnInputs(inputs: readonly StoredAgentInput[], request: { readonly sessionId: string; readonly turnId: string; readonly scope: TenantScope }, createError: (inputId: string) => Error): void {
  for (const input of inputs) if (input.sessionId !== request.sessionId || input.targetTurnId !== request.turnId || input.userId !== request.scope.userId || !["steer", "follow_up"].includes(input.delivery)) throw createError(input.id)
}

export function ensureClaimTenant(inputs: readonly StoredAgentInput[], request: { readonly sessionId: string; readonly turnId: string; readonly scope: TenantScope }, createError?: (inputId: string) => Error): void {
  for (const input of inputs) {
    if (input.sessionId !== request.sessionId || input.targetTurnId !== request.turnId || input.userId !== request.scope.userId || input.delivery !== "steer") throw createError?.(input.id) ?? new Error("Input is outside the tenant Turn")
  }
}

type BlockFactory = (layer: ContextLayer, role: ContextRole, trust: ContextTrust, source: string, blockId: string, content: unknown) => ContextBlock
type AttachmentError = (message: string) => Error

export function rootInputTextMatchesGoal(input: StoredAgentInput, rootInputId: string | undefined, goal: unknown): boolean {
  if (input.id !== rootInputId || typeof goal !== "string") return false
  return input.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim() === goal
}

export function mergeRootContextInput(inputs: readonly StoredAgentInput[], root: StoredAgentInput | null): StoredAgentInput[] {
  const byId = new Map(inputs.map(input => [input.id, input]))
  if (root) byId.set(root.id, root)
  return [...byId.values()].sort((left, right) => left.acceptedSequence < right.acceptedSequence ? -1 : left.acceptedSequence > right.acceptedSequence ? 1 : left.id.localeCompare(right.id))
}

export function pendingInputBlocks(input: StoredAgentInput, ownerFence: ContextOwnerFence, scope: TenantScope, createBlock: BlockFactory, attachmentError?: AttachmentError): Promise<ContextBlock[]> {
  return Promise.all(input.content.map(async (part, partIndex) => {
    if (part.type === "attachment_ref") {
      const attachment = await ownerFence.assertAttachmentOwned(part, scope)
      if (attachment.attachmentId !== part.attachmentId) throw attachmentError?.("Attachment resolver returned a different id") ?? new Error("Attachment resolver returned a different id")
      return createBlock("pending_input", "data", "external_untrusted", "user_input", `${input.id}:part:${partIndex}`, {
        inputId: input.id, partIndex, attachmentId: attachment.attachmentId, ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}), ...(attachment.filename ? { filename: attachment.filename } : {}),
      })
    }
    return createBlock("pending_input", "data", "external_untrusted", "user_input", `${input.id}:part:${partIndex}`, { inputId: input.id, partIndex, text: part.text })
  }))
}

export function checkpointWithInputs(checkpoint: StepCheckpoint, inputs: readonly StoredAgentInput[]): StepCheckpoint {
  const ids = [...checkpoint.consumedInputIds]
  const known = new Set(ids)
  let through = checkpoint.inputThroughSequence
  for (const input of [...inputs].sort((left, right) => left.acceptedSequence < right.acceptedSequence ? -1 : left.acceptedSequence > right.acceptedSequence ? 1 : left.id.localeCompare(right.id))) {
    if (!known.has(input.id)) { ids.push(input.id); known.add(input.id) }
    if (input.acceptedSequence > through) through = input.acceptedSequence
  }
  return { inputThroughSequence: through, consumedInputIds: ids }
}

type StepSteeringContext = Readonly<{
  renderInputs: readonly StoredAgentInput[]
  activeInputIds: readonly string[]
  markerInputs: readonly StoredAgentInput[]
}>

export async function loadStepSteeringContext(
  transaction: InputClaimTransaction,
  request: StepContextRequest,
  claimed: ClaimedInputs,
  scope?: HydrationScope,
  fail: (message: string) => Error = message => new Error(message),
): Promise<StepSteeringContext> {
  let unresolvedInputs: readonly StoredAgentInput[] = []
  if (scope) {
    if (scope.sessionId !== request.sessionId || scope.turnId !== request.turnId) throw fail("Steering hydration scope differs from the current Turn")
    const unresolvedLoader = transaction.loadUnresolvedSteeringInputs
    if (!unresolvedLoader) throw fail("Unresolved steering hydration is unavailable")
    unresolvedInputs = await unresolvedLoader({ ...scope, lease: request.lease })
  }
  const activeInputIds = activeMarkerInputIds(request.steeringMarkerState?.active, request.rootInputId, request.steeringMarkerState?.active.length ? {
    sessionId: request.sessionId, turnId: request.turnId, taskId: request.taskId ?? "",
    ...(request.steeringMarkerContext ? { obligationId: request.steeringMarkerContext.obligationId, goalRevision: request.steeringMarkerContext.goalRevision, planRevision: request.steeringMarkerContext.planRevision } : {}),
  } : undefined)
  const markerLoader = transaction.loadActiveSteeringInputs
  if (activeInputIds.length > 0 && !markerLoader) throw fail("Active steering marker hydration is unavailable")
  const markerInputs = activeInputIds.length > 0
    ? [...await markerLoader!({ sessionId: request.sessionId, turnId: request.turnId, inputIds: activeInputIds, lease: request.lease })]
    : []
  assertHydratedSteeringInputs(activeInputIds, markerInputs)
  return { activeInputIds, markerInputs, renderInputs: mergeSteeringInputs(mergeSteeringInputs(claimed.inputs, markerInputs), unresolvedInputs) }
}

export function stepSteeringMarkerControl(
  request: StepContextRequest,
  claimed: ClaimedInputs,
  steering: StepSteeringContext,
  newlyClaimedSteerInputIds: readonly string[],
): StepSteeringMarkerControl {
  const newlyObservedInputIds = request.steeringMarkerContext
    ? newlyClaimedSteerInputIds.filter(inputId => inputId !== request.rootInputId)
    : []
  const newlyObservedMarkers = request.steeringMarkerContext
    ? claimed.inputs.filter(input => newlyObservedInputIds.includes(input.id)).map(markerInput => buildObservedSteeringMarker({
      sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId,
      context: request.steeringMarkerContext!, markerInput,
    }))
    : []
  return { activeInputIds: steering.markerInputs.map(input => input.id), newlyObservedInputIds, newlyObservedMarkers }
}
