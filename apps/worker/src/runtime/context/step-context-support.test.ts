import { describe, expect, it, vi } from "vitest"
import type { InputContentPart, TenantScope } from "@jobcopilot/agent-protocol"

import { StepContextBuilder, type ContextBlock, type ContextOwnerFence, type StepContext } from "./step-context-builder.js"
import type { InputClaimStore, InputClaimTransaction, StepCheckpoint, StoredAgentInput } from "./input-claim-store.js"
import type { HydrationScope } from "./steering-reconciliation-context.js"
import { checkpointWithInputs, contextForAgenda, ensureTurnInputs, hasNewlyAcceptedInput, mergeDurableRootContextInput, mergeRootContextInput, pendingInputBlocks, rootInputTextMatchesGoal, safeTaskGraphRevision } from "./step-context-support.js"


const now = new Date("2026-09-01T00:00:00.000Z")
const scope: TenantScope = { userId: "user-1" }
const input = (id: string, sequence: bigint, content: readonly InputContentPart[]): StoredAgentInput => ({
  id, sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: id, delivery: "steer", status: "consumed", content,
  acceptedSequence: sequence, consumedByStepId: "step-1", consumedAt: now, createdAt: now,
})
const ownerFence: ContextOwnerFence = { assertReferenceOwned: async () => undefined, assertAttachmentOwned: async part => ({ attachmentId: part.attachmentId, filename: "safe.pdf" }) }
const createBlock = (layer: ContextBlock["layer"], role: ContextBlock["role"], trust: ContextBlock["trust"], source: string, id: string, content: unknown): ContextBlock => ({ id, layer, role, trust, source, content: content as ContextBlock["content"] })
const stepContext = (overrides: Partial<StepContext> = {}): StepContext => ({ schemaVersion: "agent-harness.v2", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", inputThroughSequence: 0n, consumedInputIds: [], blocks: [], canonicalJson: "", ...overrides })
const reconciliationScope: HydrationScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", turnLeaseOwner: "worker-1", turnLeaseVersion: 1, parentLeaseOwner: "worker-1", parentAttemptCount: 1, rootInputId: null }

async function buildWithUnresolvedSteering(inputs: readonly StoredAgentInput[], taskId = "root-1", hydration = reconciliationScope) {
  const transaction = {
    getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
    claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }),
    loadUnresolvedSteeringInputs: async () => inputs,
    persistCheckpoint: async () => undefined,
  } as unknown as InputClaimTransaction
  const store: InputClaimStore = { scope, withTransaction: work => work(transaction) }
  const builder = new StepContextBuilder(store, ownerFence, () => now, hydration)
  return builder.build({ scope, sessionId: "session-1", turnId: "turn-1", stepId: "step-current", taskId,
    snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [], taskGraphRevision: 7 } })
}

describe("step context support", () => {
  it("accepts only owner-scoped Turn steer and follow-up rows", () => {
    const request = { sessionId: "session-1", turnId: "turn-1", scope }
    const followUp = { ...input("follow-up", 2n, [{ type: "text", text: "More context" }]), delivery: "follow_up" as const }
    const error = (inputId: string) => new Error(`AgentInput ${inputId} is outside the tenant Turn`)

    expect(() => ensureTurnInputs([input("steer", 1n, []), followUp], request, error)).not.toThrow()
    expect(() => ensureTurnInputs([{ ...followUp, targetTurnId: "other-turn" }], request, error)).toThrow("AgentInput follow-up is outside the tenant Turn")
  })

  it("carries a private reconciliation signal only for consumed unresolved Root steering", async () => {
    const unresolved = input("steer-a", 8n, [{ type: "text", text: "PRIVATE_STEER_SENTINEL" }])
    const context = await buildWithUnresolvedSteering([unresolved])

    expect(context.hasUnresolvedConsumedSteer).toBe(true)
    expect(context.blocks).toContainEqual(expect.objectContaining({ layer: "pending_input", role: "data", trust: "external_untrusted",
      content: { inputId: unresolved.id, partIndex: 0, text: "PRIVATE_STEER_SENTINEL" } }))
    expect(context.canonicalJson).not.toContain("hasUnresolvedConsumedSteer")

    const resolved = await buildWithUnresolvedSteering([])
    const accepted = await buildWithUnresolvedSteering([{ ...unresolved, status: "accepted" }])
    const followUp = await buildWithUnresolvedSteering([{ ...unresolved, delivery: "follow_up" }])
    const child = await buildWithUnresolvedSteering([unresolved], "child-1")
    const foreign = buildWithUnresolvedSteering([{ ...unresolved, targetTurnId: "other-turn" }])

    expect(resolved.hasUnresolvedConsumedSteer).toBeUndefined()
    expect(accepted.hasUnresolvedConsumedSteer).toBeUndefined()
    expect(followUp.hasUnresolvedConsumedSteer).toBeUndefined()
    expect(child.hasUnresolvedConsumedSteer).toBeUndefined()
    await expect(buildWithUnresolvedSteering([{ ...unresolved, userId: "other-user" }])).rejects.toThrow("outside the tenant Turn")
    await expect(foreign).rejects.toThrow("outside the tenant Turn")
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
