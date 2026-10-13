import { describe, expect, it, vi } from "vitest"

import { createCanonicalRootToolGuards, interactiveDiscoveryCompletionGate, withInteractiveDiscoveryFinalResponse } from "./interactive-discovery-runtime.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "./subagents/task-graph-final-summary-binding.js"
import { reduceTaskGraphFinalSummary } from "./subagents/task-graph-final-summary.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"

const shortlist = { schemaVersion: 1 as const, status: "completed" as const, items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }], failures: [] }

describe("interactive discovery runtime", () => {
  it("denies tools outside the selected mode before routing or argument validation", async () => {
    const routeTool = vi.fn(async () => ({ id: "call-1", toolName: "jobs.search", toolVersion: "1", status: "completed" as const, errorCode: null }))
    const validateArguments = vi.fn(() => true)
    const guards = createCanonicalRootToolGuards({ interactiveDiscoveryMode: true, selectedJobMode: false, routeTool: routeTool as never, validateArguments })
    const request = { call: { id: "call-1", toolName: "jobs.search", toolVersion: "1", input: {} } } as never
    await expect(guards.executeTool(request)).resolves.toMatchObject({ status: "failed", errorCode: "interactive_discovery_root_tool_disabled" })
    expect(guards.validateToolArguments("jobs.search", {})).toBe("interactive_discovery_root_tool_disabled")
    expect(routeTool).not.toHaveBeenCalled()
    expect(validateArguments).not.toHaveBeenCalled()
  })

  it("blocks completion without an accepted ranked item", async () => {
    const gate = await interactiveDiscoveryCompletionGate({
      pool: {} as never, lease: {} as never, root: { id: "root-1", attemptCount: 1 },
      load: async () => ({ schemaVersion: 1, status: "failed", items: [], failures: ["evidence_unverified"] }),
      accept: vi.fn(), markUnavailable: vi.fn(),
    })
    expect(gate).toMatchObject({ ok: false, blocker: "interactive_discovery_shortlist_required" })
  })

  it("persists only the validated reducer result in final response fields", async () => {
    const writes: unknown[] = []
    const underlying = { recordFinalResponse: vi.fn(async (input: unknown) => { writes.push(input); return { status: "completed" as const, finalItemId: "final-1", events: [] } }) } as unknown as TurnEngineStore
    const guarded = withInteractiveDiscoveryFinalResponse(underlying, () => shortlist)
    await guarded.recordFinalResponse({
      owner: { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      response: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: "model-authored prose" }), now: new Date(), terminal: {
        stepId: "step-1", finalItemId: "final-1", finalContent: { text: "model-authored prose" }, stepCount: 1,
        toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      },
    })
    const saved = writes[0] as { response: string; terminal: { finalContent: { text: string; final: { response: string } }; interactiveDiscoveryShortlist: unknown } }
    expect(saved.response).toBe(JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: JSON.stringify(shortlist) }))
    expect(saved.terminal.finalContent).toEqual({ text: JSON.stringify(shortlist), final: { schemaVersion: "agent-harness.v2.final", response: JSON.stringify(shortlist) } })
    expect(saved.terminal.interactiveDiscoveryShortlist).toEqual(shortlist)
    await expect(withInteractiveDiscoveryFinalResponse(underlying, () => undefined).recordFinalResponse({
      owner: { kind: "turn" } as never, response: "{}", now: new Date(), terminal: {} as never,
    })).rejects.toThrow("interactive_discovery_shortlist_missing")
  })

  it("preserves the verified model candidate when a private TaskGraph summary is bound", async () => {
    const writes: unknown[] = []
    const underlying = { recordFinalResponse: vi.fn(async (input: unknown) => { writes.push(input); return { status: "completed" as const, finalItemId: "final-1", events: [] } }) } as unknown as TurnEngineStore
    const binding = { graphRevision: 1, summary: reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [] }) }
    const response = JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: "original verified candidate" })
    const finalContent = { text: "original verified candidate", final: { schemaVersion: "agent-harness.v2.final", response: "original verified candidate", summary: "Task-reported results: discovered jobs: 1 (complete)." } }
    const terminal = { stepId: "step-1", finalItemId: "final-1", finalContent, stepCount: 1, toolCallCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding }
    const guarded = withInteractiveDiscoveryFinalResponse(underlying, () => shortlist)
    await guarded.recordFinalResponse({
      owner: { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      response, now: new Date(), terminal,
    })
    const saved = writes[0] as { response: string; terminal: typeof terminal & { interactiveDiscoveryShortlist: unknown } }
    expect(saved.response).toBe(response)
    expect(saved.terminal.finalContent).toEqual(finalContent)
    expect(saved.terminal[TASK_GRAPH_FINAL_SUMMARY_BINDING]).toBe(binding)
    expect(saved.terminal.interactiveDiscoveryShortlist).toEqual(shortlist)
    expect(JSON.stringify(saved)).not.toContain("task_graph_final_summary_binding")
  })
})
