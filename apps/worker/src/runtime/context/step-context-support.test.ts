import { describe, expect, it } from "vitest"
import type { InputContentPart, TenantScope } from "@jobcopilot/agent-protocol"

import type { ContextBlock, ContextOwnerFence } from "./step-context-builder.js"
import type { StepCheckpoint, StoredAgentInput } from "./input-claim-store.js"
import { checkpointWithInputs, ensureTurnInputs, mergeRootContextInput, pendingInputBlocks, rootInputTextMatchesGoal, safeTaskGraphRevision } from "./step-context-support.js"

const now = new Date("2026-09-01T00:00:00.000Z")
const scope: TenantScope = { userId: "user-1" }
const input = (id: string, sequence: bigint, content: readonly InputContentPart[]): StoredAgentInput => ({
  id, sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: id, delivery: "steer", status: "consumed", content,
  acceptedSequence: sequence, consumedByStepId: "step-1", consumedAt: now, createdAt: now,
})
const ownerFence: ContextOwnerFence = { assertReferenceOwned: async () => undefined, assertAttachmentOwned: async part => ({ attachmentId: part.attachmentId, filename: "safe.pdf" }) }
const createBlock = (layer: ContextBlock["layer"], role: ContextBlock["role"], trust: ContextBlock["trust"], source: string, id: string, content: unknown): ContextBlock => ({ id, layer, role, trust, source, content: content as ContextBlock["content"] })

describe("step context support", () => {
  it("accepts only owner-scoped Turn steer and follow-up rows", () => {
    const request = { sessionId: "session-1", turnId: "turn-1", scope }
    const followUp = { ...input("follow-up", 2n, [{ type: "text", text: "More context" }]), delivery: "follow_up" as const }
    const error = (inputId: string) => new Error(`AgentInput ${inputId} is outside the tenant Turn`)

    expect(() => ensureTurnInputs([input("steer", 1n, []), followUp], request, error)).not.toThrow()
    expect(() => ensureTurnInputs([{ ...followUp, targetTurnId: "other-turn" }], request, error)).toThrow("AgentInput follow-up is outside the tenant Turn")
  })

  it("accepts only safe nonnegative task graph revisions", () => {
    expect(safeTaskGraphRevision(0)).toBe(0)
    expect(safeTaskGraphRevision(12)).toBe(12)
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "3"]) {
      expect(safeTaskGraphRevision(invalid)).toBeUndefined()
    }
  })

  it("deduplicates only the complete ordered root text joined and trimmed to the exact goal", () => {
    const makeInput = (id: string, texts: readonly string[]) => input(id, 1n, texts.map(text => ({ type: "text" as const, text })))
    expect(rootInputTextMatchesGoal(makeInput("root", ["Find roles", "in Dublin"]), "root", "Find roles\nin Dublin")).toBe(true)
    expect(rootInputTextMatchesGoal(makeInput("root", [" Find roles ", "in Dublin "]), "root", "Find roles \nin Dublin")).toBe(true)
    expect(rootInputTextMatchesGoal(makeInput("root", ["Find roles"]), "root", "Find roles in Dublin")).toBe(false)
    expect(rootInputTextMatchesGoal(makeInput("root", ["Find roles in Dublin"]), "root", "Find roles")).toBe(false)
    expect(rootInputTextMatchesGoal(makeInput("root", ["Find", "roles"]), "root", "Find roles")).toBe(false)
    expect(rootInputTextMatchesGoal(makeInput("root", ["Cafe\u0301 roles"]), "root", "Café roles")).toBe(false)
    expect(rootInputTextMatchesGoal(makeInput("root", ["Find  roles"]), "root", "Find roles")).toBe(false)
    expect(rootInputTextMatchesGoal(makeInput("other", ["Find roles"]), "root", "Find roles")).toBe(false)
    expect(rootInputTextMatchesGoal(makeInput("root", ["Find roles"]), "root", undefined)).toBe(false)
    expect(rootInputTextMatchesGoal(makeInput("root", ["Find roles"]), "root", { text: "Find roles" })).toBe(false)
  })

  it("builds bounded pending text and attachment blocks", async () => {
    const blocks = await pendingInputBlocks(input("input-1", 2n, [{ type: "text", text: "Dublin" }, { type: "attachment_ref", attachmentId: "resume-1", mediaType: "application/pdf" }]), ownerFence, scope, createBlock)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.content).toMatchObject({ inputId: "input-1", text: "Dublin" })
    expect(blocks[1]?.content).toMatchObject({ attachmentId: "resume-1", filename: "safe.pdf" })
  })

  it("deduplicates the read-only root by input ID and renders in sequence order", () => {
    const root = input("root", 4n, [{ type: "text", text: "reference" }])
    const other = input("other", 5n, [{ type: "text", text: "later steering" }])
    expect(mergeRootContextInput([other, root], { ...root, content: [{ type: "text", text: "reloaded reference" }] })).toEqual([{ ...root, content: [{ type: "text", text: "reloaded reference" }] }, other])
    expect(mergeRootContextInput([other], null)).toEqual([other])
  })

  it("retains the cursor while adding only new checkpoint IDs in sequence order", () => {
    const checkpoint: StepCheckpoint = { inputThroughSequence: 3n, consumedInputIds: ["old"] }
    expect(checkpointWithInputs(checkpoint, [input("new-2", 5n, [{ type: "text", text: "two" }]), input("new-1", 4n, [{ type: "text", text: "one" }]), input("old", 2n, [{ type: "text", text: "old" }])])).toEqual({ inputThroughSequence: 5n, consumedInputIds: ["old", "new-1", "new-2"] })
  })
})
