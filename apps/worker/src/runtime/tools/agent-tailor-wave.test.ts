import { describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "./registry.js"
import { createAgentTailorWaveTool } from "./agent-tailor-wave.js"
import type { ToolExecutionContext } from "./types.js"

const refs = [`otc2_${"a".repeat(64)}`, `otc2_${"b".repeat(64)}`]
const options = { turnLeaseOwner: "worker-1", turnLeaseVersion: 3, parentLeaseOwner: "worker-1",
  parentAttemptCount: () => 2, rootInputId: "root-input" }
const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
  taskId: "root-1", rootTaskId: "root-1", actorRole: "orchestrator", remainingTurnSteps: 3,
  signal: new AbortController().signal, capabilities: ["coordination", "canManageChildren"], reportProgress: vi.fn(), ...overrides,
})
const input = { expectedRevision: 4, candidateRefs: refs }
const MAX_REVISION = 2_147_483_646
const receipt = {
  status: "accepted" as const, revision: 5,
  nodes: [
    { key: "objective-tailor-wave-writer-tailor-1", taskId: "writer-a", status: "queued" as const },
    { key: "objective-tailor-wave-reviewer-tailor-1", taskId: "reviewer-a", status: "waiting" as const },
    { key: "objective-tailor-wave-writer-tailor-2", taskId: "writer-b", status: "queued" as const },
    { key: "objective-tailor-wave-reviewer-tailor-2", taskId: "reviewer-b", status: "waiting" as const },
  ],
  readyTaskIds: ["writer-a", "writer-b"],
}

describe("agent.tailor v2 wave wrapper", () => {
  it("uses the existing tool name with version 2 and a closed one-to-four-ref schema", () => {
    const tool = createAgentTailorWaveTool({ appendObjectiveTailorWave: vi.fn(async () => receipt) }, options)
    const registry = new ToolRegistry([tool])
    expect(tool.name).toBe("agent.tailor")
    expect(tool.version).toBe("2")
    expect(tool.risk).toBe("internal_write")
    expect(tool.requiredCapabilities).toEqual(["coordination", "canManageChildren"])
    expect(registry.validateArguments("agent.tailor", input, "2")).toBe(true)
    expect(registry.validateArguments("agent.tailor", { ...input, jobId: "private-job" }, "2")).not.toBe(true)
    expect(registry.validateArguments("agent.tailor", { ...input, candidateRefs: [refs[0], refs[0]] }, "2")).not.toBe(true)
    expect(registry.validateArguments("agent.tailor", { expectedRevision: 4, candidateRefs: ["otc1_" + "a".repeat(64)] }, "2")).not.toBe(true)
    expect(registry.validateArguments("agent.tailor", { expectedRevision: 4, candidateRefs: [refs[0], refs[1], refs[0], refs[1], refs[0]] }, "2")).not.toBe(true)
    expect(registry.validateArguments("agent.tailor", { expectedRevision: MAX_REVISION - 1, candidateRefs: refs }, "2")).toBe(true)
    expect(registry.validateArguments("agent.tailor", { expectedRevision: MAX_REVISION, candidateRefs: refs }, "2")).not.toBe(true)
  })

  it("delegates the exact current Root scope and projects only the bounded graph receipt", async () => {
    const appendObjectiveTailorWave = vi.fn(async () => ({ ...receipt, jobIds: ["private-job"], privateWitness: "PRIVATE_PROOF",
      nodes: receipt.nodes.map(node => ({ ...node, candidateRef: refs[0] })) }))
    const tool = createAgentTailorWaveTool({ appendObjectiveTailorWave } as never, options)
    await expect(tool.execute(context(), input)).resolves.toEqual(receipt)
    expect(appendObjectiveTailorWave).toHaveBeenCalledWith({
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
        rootTaskId: "root-1", parentTaskId: "root-1", turnLeaseOwner: "worker-1", turnLeaseVersion: 3,
        parentLeaseOwner: "worker-1", parentAttemptCount: 2, rootInputId: "root-input" },
      expectedRevision: 4, candidateRefs: refs,
    })
  })

  const deniedContexts: Array<[string, Partial<ToolExecutionContext>]> = [
    ["non-root task", { taskId: "child-1", actorRole: "subagent" }],
    ["wrong root", { taskId: "other-task" }],
    ["missing role", { actorRole: undefined }],
    ["missing capability", { capabilities: ["coordination"] }],
    ["insufficient continuation", { remainingTurnSteps: 1 }],
  ]
  it.each(deniedContexts)("does not write for %s", async (_label, overrides) => {
    const appendObjectiveTailorWave = vi.fn(async () => receipt)
    const tool = createAgentTailorWaveTool({ appendObjectiveTailorWave } as never, options)
    await expect(tool.execute(context(overrides), input)).rejects.toMatchObject({ name: "ToolExecutionError" })
    expect(appendObjectiveTailorWave).not.toHaveBeenCalled()
  })

  it("rejects malformed direct inputs and accessor-backed values before the command call", async () => {
    const appendObjectiveTailorWave = vi.fn(async () => receipt)
    const tool = createAgentTailorWaveTool({ appendObjectiveTailorWave } as never, options)
    const sparse = new Array(2) as string[]
    sparse[1] = refs[1]!
    const accessor = Object.defineProperty({}, "candidateRefs", { enumerable: true, get: () => { throw new Error("must not read") } })
    const invalid = [
      { expectedRevision: 0, candidateRefs: refs },
      { expectedRevision: 4, candidateRefs: [refs[0], refs[0]] },
      { expectedRevision: 4, candidateRefs: ["arbitrary-ref"] },
      { expectedRevision: 4, candidateRefs: [] },
      { expectedRevision: 4, candidateRefs: sparse },
      { expectedRevision: 4, candidateRefs: refs, sourceDigest: "private" },
      accessor,
    ]
    for (const value of invalid) await expect(tool.execute(context(), value)).rejects.toMatchObject({ code: "objective_tailor_wave_input_invalid" })
    expect(appendObjectiveTailorWave).not.toHaveBeenCalled()
  })

  it("fails closed when the command seam is missing or returns an unbound receipt", async () => {
    const unavailable = createAgentTailorWaveTool(undefined, options)
    await expect(unavailable.execute(context(), input)).rejects.toMatchObject({ code: "objective_tailor_wave_unavailable" })
    const malformed = createAgentTailorWaveTool({ appendObjectiveTailorWave: vi.fn(async () => ({
      ...receipt, nodes: [...receipt.nodes, { key: "foreign", taskId: "foreign-task", status: "queued" }],
    })) } as never, options)
    await expect(malformed.execute(context(), input)).rejects.toMatchObject({ code: "objective_tailor_wave_receipt_invalid" })
  })

  it("rejects receipts with an inexact revision, pair order, or ready set", async () => {
    const invalidReceipts = [
      { ...receipt, revision: input.expectedRevision },
      { ...receipt, revision: input.expectedRevision + 2 },
      { ...receipt, nodes: [receipt.nodes[1], receipt.nodes[0], ...receipt.nodes.slice(2)] },
      { ...receipt, nodes: [receipt.nodes[0], { ...receipt.nodes[1], key: "objective-tailor-wave-reviewer-tailor-3" }, ...receipt.nodes.slice(2)] },
      { ...receipt, readyTaskIds: ["writer-a"] },
      { ...receipt, readyTaskIds: ["writer-a", "reviewer-a"] },
      { ...receipt, readyTaskIds: ["writer-b", "writer-a"] },
    ]
    for (const invalidReceipt of invalidReceipts) {
      const tool = createAgentTailorWaveTool({ appendObjectiveTailorWave: vi.fn(async () => invalidReceipt) } as never, options)
      await expect(tool.execute(context(), input)).rejects.toMatchObject({ code: "objective_tailor_wave_receipt_invalid" })
    }
    const duplicate = { ...receipt, status: "duplicate" as const }
    const replay = createAgentTailorWaveTool({ appendObjectiveTailorWave: vi.fn(async () => duplicate) } as never, options)
    await expect(replay.execute(context(), input)).resolves.toMatchObject({ status: "duplicate", revision: input.expectedRevision + 1 })
  })

  it("projects only a safe command code and revision from failures", async () => {
    const appendObjectiveTailorWave = vi.fn(async () => {
      throw Object.assign(new Error("PRIVATE_JOB_CONTENT"), { code: "objective_tailor_stale", currentRevision: 5 })
    })
    const tool = createAgentTailorWaveTool({ appendObjectiveTailorWave } as never, options)
    await expect(tool.execute(context(), input)).rejects.toMatchObject({
      code: "objective_tailor_stale", safeOutput: { code: "objective_tailor_stale", currentRevision: 5 },
    })
    await expect(tool.execute(context(), input)).rejects.not.toThrow("PRIVATE_JOB_CONTENT")
  })
})
