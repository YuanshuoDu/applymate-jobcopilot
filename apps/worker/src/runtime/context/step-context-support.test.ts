import { describe, expect, it, vi } from "vitest"
import type { InputContentPart, TenantScope } from "@jobcopilot/agent-protocol"

import type { ContextBlock, ContextOwnerFence, StepContext } from "./step-context-builder.js"
import type { InputClaimTransaction, StepCheckpoint, StoredAgentInput } from "./input-claim-store.js"
import { checkpointWithInputs, contextForAgenda, hasNewlyAcceptedInput, mergeDurableRootContextInput, mergeRootContextInput, pendingInputBlocks, rootInputTextMatchesGoal } from "./step-context-support.js"

const now = new Date("2026-09-01T00:00:00.000Z")
const scope: TenantScope = { userId: "user-1" }
const input = (id: string, sequence: bigint, content: readonly InputContentPart[]): StoredAgentInput => ({
  id, sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: id, delivery: "steer", status: "consumed", content,
  acceptedSequence: sequence, consumedByStepId: "step-1", consumedAt: now, createdAt: now,
})
const ownerFence: ContextOwnerFence = { assertReferenceOwned: async () => undefined, assertAttachmentOwned: async part => ({ attachmentId: part.attachmentId, filename: "safe.pdf" }) }
const createBlock = (layer: ContextBlock["layer"], role: ContextBlock["role"], trust: ContextBlock["trust"], source: string, id: string, content: unknown): ContextBlock => ({ id, layer, role, trust, source, content: content as ContextBlock["content"] })
const stepContext = (overrides: Partial<StepContext> = {}): StepContext => ({ schemaVersion: "agent-harness.v2", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", inputThroughSequence: 0n, consumedInputIds: [], blocks: [], canonicalJson: "", ...overrides })

describe("step context support", () => {
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

  it("loads and validates the durable root before merging it with claimed context", async () => {
    const root = input("root", 4n, [{ type: "text", text: "reference" }])
    const loadRootInputContext = vi.fn(async () => root)
    const transaction = { loadRootInputContext } as unknown as InputClaimTransaction
    const assertOwner = vi.fn()
    const result = await mergeDurableRootContextInput([], transaction, { sessionId: "session-1", turnId: "turn-1", rootContextInputId: root.id }, assertOwner)
    expect(result).toEqual([root])
    expect(loadRootInputContext).toHaveBeenCalledWith({ sessionId: "session-1", turnId: "turn-1", inputId: root.id, lease: undefined })
    expect(assertOwner).toHaveBeenCalledWith(root)
  })

  it("keeps read-only root context out of later agenda signals without hiding the first-step claim", () => {
    const root = createBlock("pending_input", "data", "external_untrusted", "user_input", "root:part:0", { inputId: "root", text: "reference" })
    const fresh = createBlock("pending_input", "data", "external_untrusted", "user_input", "fresh:part:0", { inputId: "fresh", text: "new steer" })
    const context = stepContext({ blocks: [root, fresh] })
    expect(contextForAgenda(context, 0, "root")).toBe(context)
    expect(contextForAgenda(context, 1, "root").blocks).toEqual([fresh])
    expect(contextForAgenda(stepContext({ consumedInputIds: ["root"], blocks: [root] }), 1, "root").blocks).toEqual([root])
  })

  it("detects only input and marker observations that were not already consumed", () => {
    const marker = { schemaVersion: "agent-harness.steering-marker.v1" as const, kind: "observed" as const, status: "observed" as const, sessionId: "session-1", turnId: "turn-1", taskId: "task-1", stepId: "step-1", inputId: "marker-input", idempotencyKey: "marker-1", obligationId: null, goalRevision: 0, planRevision: null, acceptedSequence: "1" }
    const baseline = stepContext()
    expect(hasNewlyAcceptedInput(baseline, [])).toBe(false)
    expect(hasNewlyAcceptedInput(stepContext({ consumedInputIds: ["new-input"] }), [])).toBe(true)
    expect(hasNewlyAcceptedInput(stepContext({ steeringMarkerControl: { activeInputIds: [], newlyObservedInputIds: ["new-input"], newlyObservedMarkers: [marker] } }), [])).toBe(true)
    expect(hasNewlyAcceptedInput(stepContext({ steeringMarkerControl: { activeInputIds: [], newlyObservedInputIds: ["new-input"], newlyObservedMarkers: [marker] } }), ["new-input", "marker-input"])).toBe(false)
  })

  it("retains the cursor while adding only new checkpoint IDs in sequence order", () => {
    const checkpoint: StepCheckpoint = { inputThroughSequence: 3n, consumedInputIds: ["old"] }
    expect(checkpointWithInputs(checkpoint, [input("new-2", 5n, [{ type: "text", text: "two" }]), input("new-1", 4n, [{ type: "text", text: "one" }]), input("old", 2n, [{ type: "text", text: "old" }])])).toEqual({ inputThroughSequence: 5n, consumedInputIds: ["old", "new-1", "new-2"] })
  })
})
