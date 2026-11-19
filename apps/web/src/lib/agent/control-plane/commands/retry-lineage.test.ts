import { describe, expect, it, vi } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import type { CommandTransaction } from "./transaction"
import {
  addRetryLineage, bindRetryLineageReceipt, isRetryLineageEligiblePredecessor, parseRetryLineageReceipt,
  RETRY_LINEAGE_SCHEMA_VERSION,
} from "./retry-lineage"

const receipt = {
  schemaVersion: RETRY_LINEAGE_SCHEMA_VERSION, predecessorTurnId: "turn-parent",
  acceptedInputId: "input-current", acceptedSequence: "19",
} as const

describe("private retry lineage", () => {
  it("parses only the exact bounded receipt with a positive PostgreSQL sequence", () => {
    expect(parseRetryLineageReceipt(receipt)).toEqual(receipt)
    for (const invalid of [
      { ...receipt, extra: true }, { ...receipt, predecessorTurnId: " turn-parent" },
      { ...receipt, acceptedInputId: "x".repeat(257) }, { ...receipt, acceptedSequence: "0" },
      { ...receipt, acceptedSequence: "01" }, { ...receipt, acceptedSequence: "9223372036854775808" },
      { ...receipt, schemaVersion: "unsupported" },
    ]) expect(parseRetryLineageReceipt(invalid)).toBeNull()
  })

  it("does not invoke receipt accessors while validating stored metadata", () => {
    let reads = 0
    const accessor = { ...receipt }
    Object.defineProperty(accessor, "acceptedInputId", { enumerable: true, get: () => { reads += 1; return "input-current" } })
    expect(parseRetryLineageReceipt(accessor)).toBeNull()
    expect(reads).toBe(0)
  })

  it("recognizes only user sourced canonical ObjectiveStart predecessors", () => {
    expect(isRetryLineageEligiblePredecessor("user", "canonical_task_graph", { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT })).toBe(true)
    expect(isRetryLineageEligiblePredecessor("automation", "canonical_task_graph", { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT })).toBe(false)
    expect(isRetryLineageEligiblePredecessor("user", "legacy_pipeline_adapter", { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT })).toBe(false)
    expect(isRetryLineageEligiblePredecessor("user", "canonical_task_graph", { intent: { kind: "interactive_discovery_shortlist", version: 1 } })).toBe(false)
    expect(isRetryLineageEligiblePredecessor("user", "canonical_task_graph", { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, selectedJobPreparation: { jobId: "job-1" } })).toBe(false)
    expect(isRetryLineageEligiblePredecessor("user", "canonical_task_graph", { intent: { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, extra: true } })).toBe(false)
  })

  it("adds a validated receipt once without replacing any existing input field", () => {
    const input = { goal: "Find roles", content: [{ type: "text", text: "Find roles" }] }
    expect(addRetryLineage(input, receipt)).toEqual({ ...input, retryLineage: receipt })
    expect(addRetryLineage({ ...input, retryLineage: receipt }, receipt)).toBeNull()
  })

  it("persists the exact predecessor and accepted input under the new user Turn fence", async () => {
    const original = { goal: "Find roles", content: [{ type: "text", text: "Find roles" }] }
    let saved: unknown = original
    const findFirst = vi.fn(async () => ({ input: saved }))
    const updateMany = vi.fn(async (args: { where: Record<string, unknown>; data: { input: unknown } }) => {
      saved = args.data.input
      return { count: 1 }
    })
    const tx = { agentTurn: { findFirst, updateMany } } as unknown as CommandTransaction
    const persisted = await bindRetryLineageReceipt(tx, {
      sessionId: "session_1", userId: "user_1", turnId: "turn-new", predecessorTurnId: "turn-old",
      acceptedInputId: "input-new", acceptedSequence: "23",
    })

    expect(persisted).toEqual({ ...receipt, predecessorTurnId: "turn-old", acceptedInputId: "input-new", acceptedSequence: "23" })
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "turn-new", sessionId: "session_1", userId: "user_1", source: "user" }, select: { input: true },
    })
    expect(updateMany.mock.calls[0]?.[0].where).toEqual({ id: "turn-new", sessionId: "session_1", userId: "user_1", source: "user" })
    expect(saved).toEqual({ ...original, retryLineage: persisted })
  })
})
