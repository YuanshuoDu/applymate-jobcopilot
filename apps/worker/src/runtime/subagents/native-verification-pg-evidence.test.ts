import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { canonicalNativeVerificationJson, digestNativeVerificationValue } from "./native-verification-contract.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import type { NativeVerificationOwnedState, NativeVerificationTarget } from "./native-verification-pg-bindings.js"
import {
  buildNativeChildPacketContent, buildNativeRootPacketContent, nativeVerificationRootPacketHistory,
  type NativeVerificationHistoryEntry,
} from "./native-verification-pg-evidence.js"

const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "turn-lease", turnLeaseVersion: 1, parentLeaseOwner: "parent-lease", parentAttemptCount: 1,
}
const objective = { goal: "Prepare a factual answer", successCriteria: ["Use persisted facts"] }

describe("native verification private evidence", () => {
  it("includes actual current owned tool output and denies a missing fact source", async () => {
    const task = { id: "child-1", parentTaskId: "root-1", rootTaskId: "root-1", turnId: "turn-1", role: "analyst", taskType: "research",
      status: "completed", attemptCount: 1, result: { claim: "persisted result" }, failureReason: null, goal: objective.goal,
      successCriteria: objective.successCriteria, expectedOutputSchema: {}, context: {}, outputArtifactIds: [] }
    const node = { key: "child", taskId: task.id, goal: objective.goal, successCriteria: objective.successCriteria, dependsOn: [], depth: 1 }
    const target: NativeVerificationTarget = { node: node as unknown as StoredTaskGraphNode, task, attempt: 1, goal: objective.goal,
      criteria: objective.successCriteria, resultText: canonicalNativeVerificationJson(task.result), resultDigest: digestNativeVerificationValue(task.result) }
    const state = { scope, snapshot: null, tasks: new Map([[task.id, task]]), sourceTasks: new Map(), goal: objective.goal,
      criteria: objective.successCriteria, criteriaValid: true, nativeSourcesValid: true, turnGoalConflict: false, turnInputDigest: "f".repeat(64) } as NativeVerificationOwnedState
    const clientWithFact = { query: vi.fn().mockResolvedValueOnce({ rows: [{ id: "item-1", revision: 1, attempt: 1,
      content: { toolName: "lookup", status: "completed", toolCallId: "call-1", output: { fact: "persisted fact 42" } } }] })
      .mockResolvedValueOnce({ rows: [] }) } as unknown as Pick<pg.PoolClient, "query">
    const content = await buildNativeChildPacketContent(clientWithFact, state, target)
    expect(content?.evidence[0]?.summary).toContain("persisted fact 42")
    expect(content?.target.kind).toBe("child")
    if (content?.target.kind === "child") expect(content.target.resultText).toContain("persisted result")

    const clientWithoutFact = { query: vi.fn().mockResolvedValueOnce({ rows: [{ id: "item-2", revision: 1, attempt: 1,
      content: { toolName: "lookup", status: "completed", toolCallId: "call-2" } }] }) } as unknown as Pick<pg.PoolClient, "query">
    await expect(buildNativeChildPacketContent(clientWithoutFact, state, target)).resolves.toBeNull()
  })

  it("fails closed when child, graph, or legacy source results contain secret-key fields", async () => {
    const secretResult = { nested: { accessToken: "private-token" } }
    const child = { id: "child-secret", parentTaskId: "root-1", rootTaskId: "root-1", turnId: "turn-1", role: "analyst", taskType: "research",
      status: "completed", attemptCount: 1, result: secretResult, failureReason: null, goal: objective.goal,
      successCriteria: objective.successCriteria, expectedOutputSchema: {}, context: {}, outputArtifactIds: [] }
    const childNode = { key: "child", taskId: child.id, goal: objective.goal, successCriteria: objective.successCriteria, dependsOn: [], depth: 1 }
    const childState = { scope, snapshot: null, tasks: new Map([[child.id, child]]), sourceTasks: new Map(), goal: objective.goal,
      criteria: objective.successCriteria, criteriaValid: true, nativeSourcesValid: true, turnGoalConflict: false, turnInputDigest: "f".repeat(64) } as NativeVerificationOwnedState
    const target: NativeVerificationTarget = { node: childNode as unknown as StoredTaskGraphNode, task: child, attempt: 1, goal: objective.goal,
      criteria: objective.successCriteria, resultText: canonicalNativeVerificationJson(secretResult), resultDigest: digestNativeVerificationValue(secretResult) }
    const unusedClient = { query: vi.fn() } as unknown as Pick<pg.PoolClient, "query">
    await expect(buildNativeChildPacketContent(unusedClient, childState, target)).resolves.toBeNull()

    const graphLeaf = { key: "leaf", taskId: "leaf-secret", goal: "Resolve the case", successCriteria: ["Identify cause"], dependsOn: [], depth: 1 }
    const cleanTask = { ...child, id: "leaf-secret", result: { conclusion: "clean" }, goal: graphLeaf.goal, successCriteria: graphLeaf.successCriteria }
    const graphSecret = { ...cleanTask, result: { nested: { apiKey: "private-key" } } }
    const rootState = { scope, snapshot: { nodes: [graphLeaf] }, tasks: new Map([[graphSecret.id, graphSecret]]), sourceTasks: new Map(),
      goal: "Original user goal", criteria: ["Satisfy original user goal"], criteriaValid: true, nativeSourcesValid: true,
      turnGoalConflict: false, turnInputDigest: "a".repeat(64) } as unknown as NativeVerificationOwnedState
    const buildRoot = (state: NativeVerificationOwnedState) => buildNativeRootPacketContent({ state, candidateText: "candidate",
      childBindingSetDigest: "b".repeat(64), history: [] })
    expect(buildRoot(rootState)).toBeNull()

    const legacy = { ...cleanTask, id: "legacy-secret", parentTaskId: "ancestor-1", goal: "Earlier failed research",
      successCriteria: ["Preserve original evidence"], status: "failed", result: JSON.stringify(secretResult), failureReason: "earlier failure" }
    const legacyState = { ...rootState, tasks: new Map([[cleanTask.id, cleanTask]]), sourceTasks: new Map([[legacy.id, legacy]]) }
    expect(buildRoot(legacyState)).toBeNull()
  })

  it("places actual leaf results, failed history and out-of-graph legacy source material in root evidence", () => {
    const leaf = { key: "leaf", taskId: "leaf-1", goal: "Resolve the case", successCriteria: ["Identify cause"], dependsOn: [], depth: 1 }
    const leafTask = { id: "leaf-1", parentTaskId: "root-1", rootTaskId: "root-1", turnId: "turn-1", role: "analyst", taskType: "casework",
      status: "completed", attemptCount: 1, result: { conclusion: "Contradicts candidate" }, failureReason: null, goal: leaf.goal,
      successCriteria: leaf.successCriteria, expectedOutputSchema: {}, context: {}, outputArtifactIds: [] }
    const legacy = { ...leafTask, id: "legacy-1", parentTaskId: "ancestor-1", goal: "Earlier failed research", successCriteria: ["Preserve original evidence"],
      status: "failed", result: { observation: "original failed fact" }, failureReason: "earlier failure" }
    const state = { scope, snapshot: { nodes: [leaf] }, tasks: new Map([[leafTask.id, leafTask]]), sourceTasks: new Map([[legacy.id, legacy]]),
      goal: "Original user goal", criteria: ["Satisfy original user goal"], criteriaValid: true, nativeSourcesValid: true,
      turnGoalConflict: false, turnInputDigest: "a".repeat(64) } as unknown as NativeVerificationOwnedState
    const content = buildNativeRootPacketContent({ state, candidateText: "candidate", childBindingSetDigest: "b".repeat(64), history: [] })
    expect(content).not.toBeNull()
    const summaries = content!.evidence.map(item => item.summary).join("\n")
    expect(summaries).toContain("Contradicts candidate")
    expect(summaries).toContain("Earlier failed research")
    expect(summaries).toContain("earlier failure")
    expect(summaries).toContain("original failed fact")
  })

  it("excludes only the current root judge while retaining same-candidate reviews from another binding", () => {
    const history: NativeVerificationHistoryEntry[] = [
      { controlTaskId: "current", targetTaskId: "root-1", targetKind: "root_goal", candidateDigest: "same", childBindingSetDigest: "binding-now", disposition: "passed", status: "completed", attempt: 1, reportDigest: "r1", criterionSummary: "[]" },
      { controlTaskId: "prior", targetTaskId: "root-1", targetKind: "root_goal", candidateDigest: "same", childBindingSetDigest: "binding-before", disposition: "failed", status: "completed", attempt: 1, reportDigest: "r2", criterionSummary: "negative" },
      { controlTaskId: "other", targetTaskId: "root-1", targetKind: "root_goal", candidateDigest: "other", childBindingSetDigest: "binding-now", disposition: "failed", status: "completed", attempt: 1, reportDigest: "r3", criterionSummary: "negative" },
      { controlTaskId: "child", targetTaskId: "child-1", targetKind: "child", disposition: "passed", status: "completed", attempt: 1, reportDigest: "r4", criterionSummary: "[]" },
    ]
    const selected = nativeVerificationRootPacketHistory(history, history.map(item => ({ controlTaskId: item.controlTaskId,
      targetKind: item.targetKind, candidateDigest: item.candidateDigest, childBindingSetDigest: item.childBindingSetDigest })), "same", "binding-now")
    expect(selected.map(item => item.controlTaskId)).toEqual(["prior", "other", "child"])
  })
})
