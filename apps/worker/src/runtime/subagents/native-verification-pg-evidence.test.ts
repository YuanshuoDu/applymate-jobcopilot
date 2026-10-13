import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { hashArtifactContent } from "./artifact-adapters.js"
import { NATIVE_VERIFICATION_PACKET_SCHEMA, canonicalNativeVerificationJson, digestNativeVerificationValue, type NativeVerificationPacket } from "./native-verification-contract.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import type { NativeVerificationOwnedState, NativeVerificationTarget } from "./native-verification-pg-bindings.js"
import {
  buildNativeChildPacketContent, buildNativeRootPacketContent, nativeVerificationRootPacketHistory,
  type NativeVerificationHistoryEntry,
} from "./native-verification-pg-evidence.js"
import { nativeVerificationControlContentMatches } from "./native-verification-pg-request.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"

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
    const currentToolResult = { id: "result-1", revision: 1, attempt: 1,
      content: { toolCallId: "call-1", output: { fact: "persisted fact 42" } },
      callItemId: "call-item-1", callRevision: 1, callMatches: 1, resultMatches: 1,
      callContent: { toolCallId: "call-1", toolName: "lookup", status: "completed", input: { query: "private argument sentinel" } } }
    const clientWithFact = { query: vi.fn().mockResolvedValueOnce({ rows: [currentToolResult] })
      .mockResolvedValueOnce({ rows: [] }) } as unknown as Pick<pg.PoolClient, "query">
    const content = await buildNativeChildPacketContent(clientWithFact, state, target)
    expect(content?.evidence[0]?.summary).toContain("persisted fact 42")
    expect(content?.evidence[0]?.summary).toContain('"callItemId":"call-item-1"')
    expect(content?.evidence[0]?.summary).toContain('"toolCallId":"call-1"')
    expect(content?.evidence[0]?.summary).not.toContain("private argument sentinel")
    expect(content?.target.kind).toBe("child")
    if (content?.target.kind === "child") expect(content.target.resultText).toContain("persisted result")
    const evidenceQuery = String(vi.mocked(clientWithFact.query).mock.calls[0]?.[0])
    expect(evidenceQuery).toContain('LEFT JOIN "agent_items" AS call_item')
    expect(evidenceQuery).toContain('call_item."sessionId" = item."sessionId" AND call_item."turnId" = item."turnId"')
    expect(evidenceQuery).toContain('call_item."taskId" = item."taskId" AND call_item."stepId" = item."stepId"')
    expect(evidenceQuery).toContain('call_item."content"->>\'toolCallId\' = item."content"->>\'toolCallId\'')
    expect(evidenceQuery).toContain('COUNT(*) OVER (PARTITION BY item."stepId", item."content"->>\'toolCallId\') AS "resultMatches"')

    const clientWithoutFact = { query: vi.fn().mockResolvedValueOnce({ rows: [{ ...currentToolResult,
      id: "result-missing-output", content: { toolCallId: "call-1" } }] }) } as unknown as Pick<pg.PoolClient, "query">
    await expect(buildNativeChildPacketContent(clientWithoutFact, state, target)).resolves.toBeNull()

    const missingCall = { query: vi.fn().mockResolvedValueOnce({ rows: [{ ...currentToolResult,
      id: "result-unpaired", callMatches: 0, callItemId: null, callContent: null }] }) } as unknown as Pick<pg.PoolClient, "query">
    await expect(buildNativeChildPacketContent(missingCall, state, target)).resolves.toBeNull()
    const mismatchedCall = { query: vi.fn().mockResolvedValueOnce({ rows: [{ ...currentToolResult,
      callContent: { ...currentToolResult.callContent, toolCallId: "other-call" } }] }) } as unknown as Pick<pg.PoolClient, "query">
    await expect(buildNativeChildPacketContent(mismatchedCall, state, target)).resolves.toBeNull()
    const duplicateResult = { query: vi.fn().mockResolvedValueOnce({ rows: [currentToolResult,
      { ...currentToolResult, id: "result-duplicate", resultMatches: 2 }, { ...currentToolResult, resultMatches: 2 }] }) } as unknown as Pick<pg.PoolClient, "query">
    await expect(buildNativeChildPacketContent(duplicateResult, state, target)).resolves.toBeNull()

    const packet = { schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA, controlOperationId: "operation-1", controlTaskId: "control-1",
      goal: content!.goal, criteria: content!.criteria, target: content!.target, evidence: content!.evidence } as NativeVerificationPacket
    const buildVariant = async (callContent: Record<string, unknown>, output: unknown) => {
      const queryMock = { query: vi.fn().mockResolvedValueOnce({ rows: [{ ...currentToolResult,
        content: { toolCallId: "call-1", output }, callContent }] }).mockResolvedValueOnce({ rows: [] }) }
      const client = queryMock as unknown as Pick<pg.PoolClient, "query">
      return buildNativeChildPacketContent(client, state, target)
    }
    for (const [callContent, output] of [
      [{ ...currentToolResult.callContent, toolName: "other-tool" }, currentToolResult.content.output],
      [{ ...currentToolResult.callContent, status: "failed" }, currentToolResult.content.output],
      [{ ...currentToolResult.callContent, input: { query: "different private argument" } }, currentToolResult.content.output],
      [currentToolResult.callContent, { fact: "changed source fact" }],
    ] as const) {
      const changed = await buildVariant(callContent, output)
      expect(changed).not.toBeNull()
      expect(nativeVerificationControlContentMatches(packet, changed!)).toBe(false)
    }
  })

  it("reads the schema-mapped owned artifact version and rejects content that fails its hash", async () => {
    const task = { id: "child-artifact", parentTaskId: "root-1", rootTaskId: "root-1", turnId: "turn-1", role: "analyst", taskType: "research",
      status: "completed", attemptCount: 1, result: { claim: "artifact-backed result" }, failureReason: null, goal: objective.goal,
      successCriteria: objective.successCriteria, expectedOutputSchema: {}, context: {}, outputArtifactIds: [] }
    const node = { key: "child", taskId: task.id, goal: objective.goal, successCriteria: objective.successCriteria, dependsOn: [], depth: 1 }
    const target: NativeVerificationTarget = { node: node as unknown as StoredTaskGraphNode, task, attempt: 1, goal: objective.goal,
      criteria: objective.successCriteria, resultText: canonicalNativeVerificationJson(task.result), resultDigest: digestNativeVerificationValue(task.result) }
    const state = { scope, snapshot: null, tasks: new Map([[task.id, task]]), sourceTasks: new Map(), goal: objective.goal,
      criteria: objective.successCriteria, criteriaValid: true, nativeSourcesValid: true, turnGoalConflict: false, turnInputDigest: "f".repeat(64) } as NativeVerificationOwnedState
    const artifactContent = { body: "Persisted draft content reviewed independently" }
    const artifactHash = hashArtifactContent(artifactContent)
    const artifactRow = { id: "version-1", artifactId: "artifact-1", version: 1, artifactType: "cover_letter",
      contentHash: artifactHash, sourceDigest: `sha256:${"a".repeat(64)}`, content: artifactContent }
    const toolResult = { id: "item-1", revision: 1, attempt: 1, callItemId: "call-item-1", callRevision: 1, callMatches: 1, resultMatches: 1,
      content: { toolCallId: "call-1", output: { artifactId: "artifact-1" } },
      callContent: { toolCallId: "call-1", toolName: "cover_letter.draft", status: "completed" } }
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [toolResult] })
      .mockResolvedValueOnce({ rows: [artifactRow] }) } as unknown as Pick<pg.PoolClient, "query">

    const packet = await buildNativeChildPacketContent(client, state, target)
    const artifactEvidence = packet?.evidence.find(item => item.kind === "artifact_version")
    expect(artifactEvidence?.summary).toContain("Persisted draft content reviewed independently")
    expect(artifactEvidence?.summary).toContain(artifactHash)
    const artifactQuery = vi.mocked(client.query).mock.calls[1]
    expect(String(artifactQuery?.[0])).toContain('FROM "agent_artifact_version" AS version')
    expect(String(artifactQuery?.[0])).not.toContain('FROM "agent_artifact_versions"')
    expect(String(artifactQuery?.[0])).toContain('owner."rootTaskId" = $4 AND owner."parentTaskId" = $4')
    expect(String(artifactQuery?.[0])).toContain('step."attempt" = $6')
    expect(artifactQuery?.[1]).toEqual([task.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId, target.attempt, 9])

    const invalidHashClient = { query: vi.fn().mockResolvedValueOnce({ rows: [toolResult] })
      .mockResolvedValueOnce({ rows: [{ ...artifactRow, contentHash: `sha256:${"0".repeat(64)}` }] }) } as unknown as Pick<pg.PoolClient, "query">
    await expect(buildNativeChildPacketContent(invalidHashClient, state, target)).resolves.toBeNull()
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

  it("projects private TaskGraph bindings out of the native Root-verifier packet without changing storage", () => {
    const node = { key: "analyst", taskId: "analyst-task", goal: "Analyze Scout findings", successCriteria: ["Check every finding"], dependsOn: [], depth: 1 }
    const storedReport = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
      criteria: [{ criterionId: "findings-from-scout", status: "passed", reasonCode: "criteria_met" }],
      evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
      dependencyBindings: [{ nodeKey: "scout-private", taskId: "scout-task-private", attemptCount: 1,
        nodeDigest: "c".repeat(64), resultDigest: "d".repeat(64), evidenceDigest: "e".repeat(64), reportDigest: "f".repeat(64) }],
    }
    const storedResult = { structuredResult: { status: "completed", summary: "Findings checked" }, taskGraphVerificationReport: storedReport }
    const task = { id: node.taskId, parentTaskId: "root-1", rootTaskId: "root-1", turnId: "turn-1", role: "analyst", taskType: "research",
      status: "completed", attemptCount: 1, result: storedResult, failureReason: null, goal: node.goal,
      successCriteria: node.successCriteria, expectedOutputSchema: {}, context: {}, outputArtifactIds: [] }
    const state = { scope, snapshot: { nodes: [node] }, tasks: new Map([[task.id, task]]), sourceTasks: new Map(), goal: "Original user goal",
      criteria: ["Satisfy original user goal"], criteriaValid: true, nativeSourcesValid: true, turnGoalConflict: false,
      turnInputDigest: "a".repeat(64) } as unknown as NativeVerificationOwnedState

    const content = buildNativeRootPacketContent({ state, candidateText: "candidate", childBindingSetDigest: "b".repeat(64), history: [] })
    const graphEvidence = content?.evidence.find(item => item.kind === "graph_history")
    const graphSummary = JSON.parse(graphEvidence?.summary ?? "{}") as Record<string, unknown>
    const persistedResult = graphSummary.persistedResult as Record<string, unknown>
    const publicReport = persistedResult.taskGraphVerificationReport as Record<string, unknown>
    expect(Object.keys(publicReport).sort()).toEqual([
      "criteria", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion",
    ])
    expect(JSON.stringify(content)).not.toContain("scout-task-private")
    expect(JSON.stringify(content)).not.toContain("dependencyBindings")
    for (const digest of ["c", "d", "e", "f"]) expect(JSON.stringify(content)).not.toContain(digest.repeat(64))
    const storedResultDigest = digestNativeVerificationValue(storedResult)
    const publicResultDigest = digestNativeVerificationValue(persistedResult)
    expect(graphSummary.resultDigest).toBe(publicResultDigest)
    expect(publicResultDigest).not.toBe(storedResultDigest)
    expect(JSON.stringify(content)).not.toContain(storedResultDigest)
    expect(task.result).toEqual(storedResult)
    expect(storedReport.dependencyBindings).toHaveLength(1)
  })

  it("strips malformed private TaskGraph report envelopes from native Root evidence", () => {
    const node = { key: "analyst", taskId: "analyst-task", goal: "Analyze Scout findings", successCriteria: ["Check every finding"], dependsOn: [], depth: 1 }
    const storedResult = { summary: "Findings checked", taskGraphVerificationReport: {
      dependencyBindings: [{ nodeKey: "scout-private", taskId: "scout-task-private", nodeDigest: "c".repeat(64) }],
    } }
    const task = { id: node.taskId, parentTaskId: "root-1", rootTaskId: "root-1", turnId: "turn-1", role: "analyst", taskType: "research",
      status: "completed", attemptCount: 1, result: storedResult, failureReason: null, goal: node.goal,
      successCriteria: node.successCriteria, expectedOutputSchema: {}, context: {}, outputArtifactIds: [] }
    const sourceTask = { ...task, id: "legacy-task", status: "failed", goal: "Earlier research", successCriteria: ["Preserve source"], failureReason: "earlier failure" }
    const state = { scope, snapshot: { nodes: [node] }, tasks: new Map([[task.id, task]]), sourceTasks: new Map([[sourceTask.id, sourceTask]]), goal: "Original user goal",
      criteria: ["Satisfy original user goal"], criteriaValid: true, nativeSourcesValid: true, turnGoalConflict: false,
      turnInputDigest: "a".repeat(64) } as unknown as NativeVerificationOwnedState

    const content = buildNativeRootPacketContent({ state, candidateText: "candidate", childBindingSetDigest: "b".repeat(64), history: [] })
    const graphEvidence = content?.evidence.find(item => item.kind === "graph_history")
    const graphSummary = JSON.parse(graphEvidence?.summary ?? "{}") as Record<string, unknown>
    expect(graphSummary.persistedResult).toEqual({ summary: "Findings checked" })
    const sourceEvidence = content?.evidence.find(item => item.kind === "source_history")
    const sourceSummary = JSON.parse(sourceEvidence?.summary ?? "{}") as Record<string, unknown>
    expect(sourceSummary.result).toEqual({ summary: "Findings checked" })
    expect(sourceSummary.resultDigest).toBe(digestNativeVerificationValue(sourceSummary.result))
    expect(JSON.stringify(content)).not.toContain("scout-task-private")
    expect(JSON.stringify(content)).not.toContain("dependencyBindings")
    expect(JSON.stringify(content)).not.toContain("c".repeat(64))
    expect(task.result).toEqual(storedResult)
  })

  it("omits malformed serialized private TaskGraph results from graph and legacy Root history", () => {
    const node = { key: "analyst", taskId: "analyst-task", goal: "Analyze Scout findings", successCriteria: ["Check every finding"], dependsOn: [], depth: 1 }
    const rawResult = String.raw`  {"taskGraph\u0056erificationReport":{"dependency\u0042indings":[{"taskId":"private-source","digest":"${"d".repeat(64)}"}]}`
    const rawDigest = digestNativeVerificationValue(rawResult)
    const task = { id: node.taskId, parentTaskId: "root-1", rootTaskId: "root-1", turnId: "turn-1", role: "analyst", taskType: "research",
      status: "completed", attemptCount: 1, result: rawResult, failureReason: null, goal: node.goal,
      successCriteria: node.successCriteria, expectedOutputSchema: {}, context: {}, outputArtifactIds: [] }
    const sourceTask = { ...task, id: "legacy-task", status: "failed", goal: "Earlier research", successCriteria: ["Preserve source"], failureReason: "earlier failure" }
    const state = { scope, snapshot: { nodes: [node] }, tasks: new Map([[task.id, task]]), sourceTasks: new Map([[sourceTask.id, sourceTask]]), goal: "Original user goal",
      criteria: ["Satisfy original user goal"], criteriaValid: true, nativeSourcesValid: true, turnGoalConflict: false,
      turnInputDigest: "a".repeat(64) } as unknown as NativeVerificationOwnedState

    const content = buildNativeRootPacketContent({ state, candidateText: "candidate", childBindingSetDigest: "b".repeat(64), history: [] })
    const graphSummary = JSON.parse(content?.evidence.find(item => item.kind === "graph_history")?.summary ?? "{}") as Record<string, unknown>
    const sourceSummary = JSON.parse(content?.evidence.find(item => item.kind === "source_history")?.summary ?? "{}") as Record<string, unknown>
    expect(graphSummary.persistedResult).toBeNull()
    expect(graphSummary.resultDigest).toBe(digestNativeVerificationValue(null))
    expect(sourceSummary.result).toBeNull()
    expect(sourceSummary.resultDigest).toBe(digestNativeVerificationValue(null))
    expect(JSON.stringify(content)).not.toContain("taskGraphVerificationReport")
    expect(JSON.stringify(content)).not.toContain("dependencyBindings")
    expect(JSON.stringify(content)).not.toContain("private-source")
    expect(JSON.stringify(content)).not.toContain("d".repeat(64))
    expect(JSON.stringify(content)).not.toContain(rawResult)
    expect(JSON.stringify(content)).not.toContain(rawDigest)
    expect(task.result).toBe(rawResult)
    expect(sourceTask.result).toBe(rawResult)

    const plainTask = { ...task, result: "ordinary graph result" }
    const plainSourceTask = { ...sourceTask, result: "ordinary source result" }
    const plainState = { ...state, tasks: new Map([[plainTask.id, plainTask]]), sourceTasks: new Map([[plainSourceTask.id, plainSourceTask]]) }
    const plainContent = buildNativeRootPacketContent({ state: plainState, candidateText: "candidate", childBindingSetDigest: "b".repeat(64), history: [] })
    expect(JSON.parse(plainContent?.evidence.find(item => item.kind === "graph_history")?.summary ?? "{}").persistedResult).toBe("ordinary graph result")
    expect(JSON.parse(plainContent?.evidence.find(item => item.kind === "source_history")?.summary ?? "{}").result).toBe("ordinary source result")
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
