import { describe, expect, it } from "vitest"
import type { InputContentPart, TenantScope } from "@jobcopilot/agent-protocol"

import type { ContextBlock, ContextOwnerFence } from "./step-context-builder.js"
import type { StepCheckpoint, StoredAgentInput } from "./input-claim-store.js"
import { checkpointWithInputs, pendingInputBlocks } from "./step-context-support.js"

const now = new Date("2026-09-01T00:00:00.000Z")
const scope: TenantScope = { userId: "user-1" }
const input = (id: string, sequence: bigint, content: readonly InputContentPart[]): StoredAgentInput => ({
  id, sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: id, delivery: "steer", status: "consumed", content,
  acceptedSequence: sequence, consumedByStepId: "step-1", consumedAt: now, createdAt: now,
})
const ownerFence: ContextOwnerFence = { assertReferenceOwned: async () => undefined, assertAttachmentOwned: async part => ({ attachmentId: part.attachmentId, filename: "safe.pdf" }) }
const createBlock = (layer: ContextBlock["layer"], role: ContextBlock["role"], trust: ContextBlock["trust"], source: string, id: string, content: unknown): ContextBlock => ({ id, layer, role, trust, source, content: content as ContextBlock["content"] })

describe("step context support", () => {
  it("builds bounded pending text and attachment blocks", async () => {
    const blocks = await pendingInputBlocks(input("input-1", 2n, [{ type: "text", text: "Dublin" }, { type: "attachment_ref", attachmentId: "resume-1", mediaType: "application/pdf" }]), ownerFence, scope, createBlock)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.content).toMatchObject({ inputId: "input-1", text: "Dublin" })
    expect(blocks[1]?.content).toMatchObject({ attachmentId: "resume-1", filename: "safe.pdf" })
  })

  it("retains the cursor while adding only new checkpoint IDs in sequence order", () => {
    const checkpoint: StepCheckpoint = { inputThroughSequence: 3n, consumedInputIds: ["old"] }
    expect(checkpointWithInputs(checkpoint, [input("new-2", 5n, [{ type: "text", text: "two" }]), input("new-1", 4n, [{ type: "text", text: "one" }]), input("old", 2n, [{ type: "text", text: "old" }])])).toEqual({ inputThroughSequence: 5n, consumedInputIds: ["old", "new-1", "new-2"] })
  })
})
