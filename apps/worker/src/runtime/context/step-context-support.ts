import type { TenantScope } from "@jobcopilot/agent-protocol"

import type { ContextBlock, ContextOwnerFence, ContextRole, ContextLayer, ContextTrust } from "./step-context-builder.js"
import type { StepCheckpoint, StoredAgentInput } from "./input-claim-store.js"

export function ensureClaimTenant(inputs: readonly StoredAgentInput[], request: { readonly sessionId: string; readonly turnId: string; readonly scope: TenantScope }, createError?: (inputId: string) => Error): void {
  for (const input of inputs) {
    if (input.sessionId !== request.sessionId || input.targetTurnId !== request.turnId || input.userId !== request.scope.userId || input.delivery !== "steer") throw createError?.(input.id) ?? new Error("Input is outside the tenant Turn")
  }
}

type BlockFactory = (layer: ContextLayer, role: ContextRole, trust: ContextTrust, source: string, blockId: string, content: unknown) => ContextBlock
type AttachmentError = (message: string) => Error

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
