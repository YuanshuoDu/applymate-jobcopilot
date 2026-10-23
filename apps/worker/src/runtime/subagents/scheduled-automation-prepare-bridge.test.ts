import { describe, expect, it, vi } from "vitest"
import type { DurableWaitPort, DurableWaitInvocation } from "../tools/coordination-types.js"
import type { TaskGraphCommandPort, TaskGraphReadScope, TaskGraphScheduledPrepareReceipt } from "./task-graph-command-port.js"
import type { ScheduledPipelinePrepareContinuationInput } from "./scheduled-pipeline-completion.js"
import { ROLE_RESULT_SCHEMA, type PrepareResult } from "./role-results.js"
import { buildScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import { buildScheduledPrepareTaskGraphProof, SCHEDULED_PREPARE_COMPLETION_SCHEMA, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, scheduledPrepareResultDigest } from "./scheduled-prepare-task-graph-verification.js"
import { scheduledPrepareChoiceWaitId } from "../turns/turn-question-contract.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { createScheduledAutomationPrepareContinuation, projectScheduledAnalyzePrefix } from "./scheduled-automation-prepare-bridge.js"
import type { TaskGraphCurrentState } from "./task-graph-command-port.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID } from "./scheduled-gate-contract.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "worker-1", turnLeaseVersion: 5 }
const analyst = { taskId: "analyst-task", attemptCount: 1, status: "completed" as const, verification: "passed" as const,
  resultDigest: `sha256:${"a".repeat(64)}`, dependsOnTaskIds: ["scout-task"], jobIds: ["job-1"] }
const attestation = { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1" as const, owner,
  snapshotDigest: `sha256:${"b".repeat(64)}`, graphRevision: 7,
  scout: { taskId: "scout-task", attemptCount: 1, status: "completed" as const, verification: "passed" as const,
    resultDigest: `sha256:${"c".repeat(64)}`, candidateJobIds: ["job-1"], discoveryReceipt: {
      status: "complete" as const, taskId: "scout-task", attemptCount: 1, completedCalls: 1, candidateCount: 1,
      providerFailures: 0 as const, materializationFailures: 0 as const, hasMore: false as const, receiptDigest: "d".repeat(64),
    } }, analyst, evidenceDigest: `sha256:${"e".repeat(64)}` }
const proof = { status: "analyze_checkpointed" as const, continuationKey: `scheduled-taskgraph:sha256:${"f".repeat(64)}`,
  checkpointDigest: "1".repeat(64), claimTokenDigest: `sha256:${"2".repeat(64)}`, executionId: "execution-1", executionAttemptCount: 3 }
const executionOwner = { kind: "turn" as const, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
  taskId: owner.rootTaskId, rootTaskId: owner.rootTaskId, ownerId: owner.turnLeaseOwnerId, leaseVersion: owner.turnLeaseVersion,
  leaseExpiresAt: new Date("2026-10-21T00:00:00.000Z") }
const base: ScheduledPipelinePrepareContinuationInput = { owner, executionOwner, attestation, proof,
  candidateText: "Final response", finalStepId: "step-original", finalStepOrdinal: 9, signal: new AbortController().signal }
const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
  { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
] }
const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
  { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
] }

function ports(options: { revision?: number; nodes?: readonly unknown[]; receiptNodes?: readonly unknown[]; waitStatus?: string; waitMatchedTaskIds?: readonly string[];
  receiptStatus?: "accepted" | "duplicate" | "waiting_for_choice"; choice?: TaskGraphScheduledPrepareReceipt["choice"] } = {}) {
  const readCurrent = vi.fn(async (_scope: TaskGraphReadScope) => ({ revision: options.revision ?? 7, nodes: options.nodes ?? [
    { key: "analysis", templateId: "analyst", taskId: "analyst-task", status: "completed", failureReason: null },
  ] }))
  const appendScheduledPrepare = vi.fn(async () => ({ status: options.receiptStatus ?? "accepted", revision: options.receiptStatus === "waiting_for_choice" ? 7 : 8,
    nodes: (options.receiptNodes ?? (options.receiptStatus === "waiting_for_choice" ? [] : [{ key: "prepare", taskId: "prepare-task", status: "queued" }])) as never,
    readyTaskIds: options.receiptStatus === "waiting_for_choice" ? [] : ["prepare-task"],
    choice: options.choice ?? { required: false as const } }))
  const commandPort = { readCurrent, appendScheduledPrepare } as unknown as TaskGraphCommandPort
  const wait = vi.fn(async (_invocation: DurableWaitInvocation) => ({ waitId: "wait-1", status: (options.waitStatus ?? "waiting") as "waiting",
    deadlineAt: "2026-10-22T00:00:00.000Z", matchedTaskIds: options.waitMatchedTaskIds ?? [] }))
  return { commandPort, waitPort: { wait } as unknown as DurableWaitPort, readCurrent, appendScheduledPrepare, wait }
}

function prepareFacts() {
  const binding = { owner: { ...owner, executionId: "execution-1", executionAttemptCount: 3 }, continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
    snapshotDigest: `sha256:${"b".repeat(64)}`, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 7, prepareScheduleRevision: 8 }
  const receipt = buildScheduledTaskGraphContinuationReceipt({ ...binding, continuationKey: scheduledTaskGraphStableContinuationKey(binding) })!
  const result: PrepareResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "prepare-task", attemptCount: 1,
    snapshotDigest: receipt.snapshotDigest, checkpointDigest: receipt.checkpointDigest, jobs: [{ jobId: "job-1", status: "prepared" }], materials: [
      { jobId: "job-1", kind: "resume", artifactRef: { artifactId: "artifact-1", version: 1, contentHash: `sha256:${"e".repeat(64)}`, sourceDigest: `sha256:${"f".repeat(64)}` } },
    ] }
  return { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, receipt, result, completion: {
    schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 9, nodes: [
      { taskId: "scout-task", attemptCount: 1, role: "scout", taskType: TASK_GRAPH_TEMPLATES.scout.taskType, status: "completed", verification: "passed", dependsOnTaskIds: [] },
      { taskId: "analyst-task", attemptCount: 1, role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType, status: "completed", verification: "passed", dependsOnTaskIds: ["scout-task"] },
      { taskId: "prepare-task", attemptCount: 1, role: "prepare", taskType: TASK_GRAPH_TEMPLATES.prepare.taskType, status: "completed", verification: "passed", dependsOnTaskIds: ["analyst-task"],
        tool: "scheduled.application.prepare@1", resultDigest: scheduledPrepareResultDigest(result) },
    ] as const,
  } }
}

const expectedChoiceWaitId = scheduledPrepareChoiceWaitId({ receipt: prepareFacts().receipt,
  finalStepId: base.finalStepId, finalStepOrdinal: base.finalStepOrdinal })!

function analyzeGraph(withPrepare: boolean) {
  const nodes = [
    { key: "scout", taskId: "scout-task", templateId: "scout", goal: "Scout", successCriteria: ["Find"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification: scoutVerification },
    { key: "analyst", taskId: "analyst-task", templateId: "analyst", goal: "Analyze", successCriteria: ["Score"], dependsOn: ["scout"], depth: 2, verificationDisposition: "typed", verification: analystVerification },
  ]
  if (withPrepare) nodes.push({ key: "prepare", taskId: "prepare-task", templateId: "prepare", goal: "Prepare application materials using the persisted scheduled Analyze checkpoint.",
    successCriteria: ["Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.", "Persist immutable owner-fenced material references and return no resume or letter bodies."],
    dependsOn: ["analyst"], depth: 3, verificationDisposition: "specialized" } as never)
  const prepared = prepareFacts()
  const currentNodes = nodes.map(node => ({ ...node, status: node.templateId === "prepare" ? "completed" : "completed", readiness: "ready",
    resultSummary: null, failureReason: null }))
  const tasks = nodes.map(node => node.templateId === "prepare"
    ? { id: node.taskId, role: "prepare", taskType: TASK_GRAPH_TEMPLATES.prepare.taskType, status: "completed", attemptCount: 1, failureReason: null,
      expectedOutputSchema: TASK_GRAPH_TEMPLATES.prepare.expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES.prepare.allowedActions,
      rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId,
      result: { status: "completed", structuredResult: prepared.result, taskGraphScheduledPrepareProofFacts: prepared } }
    : { id: node.taskId, role: node.templateId, taskType: TASK_GRAPH_TEMPLATES[node.templateId as "scout" | "analyst"].taskType, status: "completed", attemptCount: 1,
      rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, failureReason: null, expectedOutputSchema: TASK_GRAPH_TEMPLATES[node.templateId as "scout" | "analyst"].expectedOutputSchema,
      allowedActions: TASK_GRAPH_TEMPLATES[node.templateId as "scout" | "analyst"].allowedActions })
  return { snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes } as unknown as TaskGraphSnapshot,
    current: { revision: withPrepare ? 9 : 7, nodes: currentNodes } as unknown as TaskGraphCurrentState, tasks }
}

function analyzeGraphWithGate() {
  const graph = analyzeGraph(true)
  const gateNode = { key: SCHEDULED_GATE_TEMPLATE_ID, taskId: "gate-task", templateId: SCHEDULED_GATE_TEMPLATE_ID,
    goal: SCHEDULED_GATE_NODE_GOAL, successCriteria: SCHEDULED_GATE_NODE_CRITERIA, dependsOn: ["prepare"], depth: 4,
    verificationDisposition: "specialized" }
  const gateCurrent = { ...gateNode, status: "waiting_for_user" as const, readiness: "blocked_dependency" as const, resultSummary: null, failureReason: null }
  const gateTask = { id: "gate-task", role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE, status: "waiting_for_user",
    attemptCount: 1, failureReason: null, expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [],
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, result: { status: "waiting_for_user" } }
  return { snapshot: { ...graph.snapshot, nodes: [...graph.snapshot.nodes, gateNode] },
    current: { ...graph.current, revision: 12, nodes: [...graph.current.nodes, gateCurrent] }, tasks: [...graph.tasks, gateTask] }
}

describe("scheduled automation Prepare continuation", () => {
  it("projects only the original Analyze prefix from the exact persisted completed Prepare proof", () => {
    const graph = analyzeGraph(true), projected = projectScheduledAnalyzePrefix(graph.snapshot, graph.current, graph.tasks)
    expect(() => parseTaskGraphSnapshot(graph.snapshot)).not.toThrow()
    expect(projected?.current.revision).toBe(7)
    expect(projected?.snapshot.nodes.map(node => node.templateId)).toEqual(["scout", "analyst"])
    expect(projected?.current.nodes.map(node => node.templateId)).toEqual(["scout", "analyst"])
    expect(projected?.tasks.map(task => task.id)).toEqual(["scout-task", "analyst-task"])
  })

  it("rejects extra or malformed Prepare graph nodes", () => {
    const graph = analyzeGraph(true), extra = { ...graph.snapshot.nodes[2]!, key: "extra" }
    expect(projectScheduledAnalyzePrefix({ ...graph.snapshot, nodes: [...graph.snapshot.nodes, extra] }, graph.current, [...graph.tasks, graph.tasks[2]!])).toBeNull()
    const running = { ...graph.current, nodes: graph.current.nodes.map(node => node.templateId === "prepare" ? { ...node, status: "running" } : node) }
    expect(projectScheduledAnalyzePrefix(graph.snapshot, running as TaskGraphCurrentState, graph.tasks)).toBeNull()
    const badDependency = { ...graph.snapshot, nodes: graph.snapshot.nodes.map(node => node.templateId === "prepare" ? { ...node, dependsOn: ["scout"] } : node) }
    expect(projectScheduledAnalyzePrefix(badDependency, graph.current, graph.tasks)).toBeNull()
  })

  it("reconstructs the Analyze revision from the immutable Prepare proof after the fixed Gate append", () => {
    const graph = analyzeGraphWithGate(), projected = projectScheduledAnalyzePrefix(graph.snapshot, graph.current, graph.tasks)
    expect(projected?.current.revision).toBe(7)
    expect(projected?.snapshot.nodes.map(node => node.templateId)).toEqual(["scout", "analyst"])
    const missingProof = { ...graph, tasks: graph.tasks.map(task => task.id === "prepare-task" ? { ...task, result: null } : task) }
    expect(projectScheduledAnalyzePrefix(missingProof.snapshot, missingProof.current, missingProof.tasks)).toBeNull()
    const wrongGate = { ...graph, snapshot: { ...graph.snapshot, nodes: graph.snapshot.nodes.map(node => node.templateId === "gate" ? { ...node, dependsOn: ["analyst"] } : node) } }
    expect(projectScheduledAnalyzePrefix(wrongGate.snapshot, wrongGate.current, wrongGate.tasks)).toBeNull()
    const wrongOwner = { ...graph, tasks: graph.tasks.map(task => task.id === "gate-task" ? { ...task, parentTaskId: "other-root" } : task) }
    expect(projectScheduledAnalyzePrefix(wrongOwner.snapshot, wrongOwner.current, wrongOwner.tasks)).toBeNull()
    const changedRevision = { ...graph, current: { ...graph.current, revision: 8 } }
    expect(projectScheduledAnalyzePrefix(changedRevision.snapshot, changedRevision.current, changedRevision.tasks)).toBeNull()
  })

  it("appends the fixed child and durable same-root wait using the original final step", async () => {
    const fixture = ports({ choice: { required: true, status: "answered", waitId: expectedChoiceWaitId } }), continuation = createScheduledAutomationPrepareContinuation(fixture)
    await expect(continuation(base)).resolves.toEqual({ status: "waiting_for_dependency", waitId: "wait-1" })
    expect(fixture.readCurrent).toHaveBeenCalledOnce()
    expect(fixture.readCurrent.mock.calls[0]?.[0]).not.toHaveProperty("stepId")
    expect(fixture.appendScheduledPrepare).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ parentTaskId: "root-1", stepId: "step-original", parentAttemptCount: 2 }),
      handoff: proof, attestation,
      proposal: { expectedRevision: 7, nodes: [{ key: "prepare", templateId: "prepare",
        goal: expect.any(String), successCriteria: expect.any(Array), dependsOn: ["analysis"] }] },
    }))
    expect(fixture.wait).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", sessionId: "session-1",
      turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", stepId: "step-original", targetTaskIds: ["prepare-task"],
      mode: "all", timeoutMs: 86_400_000, idempotencyKey: expect.stringMatching(/^scheduled-prepare-dependency:[a-f0-9]{64}$/) }))
  })

  it("persists the scheduled choice before waiting on the Prepare task", async () => {
    const fixture = ports({ receiptStatus: "waiting_for_choice", choice: { required: true, status: "waiting", waitId: expectedChoiceWaitId } })
    const result = await createScheduledAutomationPrepareContinuation(fixture)(base)
    expect(result).toEqual({ status: "waiting_for_choice", waitId: expectedChoiceWaitId })
    expect(fixture.wait).not.toHaveBeenCalled()
  })

  it("replays a deterministic wait key after duplicate delivery", async () => {
    const fixture = ports({ choice: { required: true, status: "answered", waitId: expectedChoiceWaitId } }), continuation = createScheduledAutomationPrepareContinuation(fixture)
    await continuation(base); await continuation(base)
    expect(fixture.wait.mock.calls[0]?.[0].idempotencyKey).toBe(fixture.wait.mock.calls[1]?.[0].idempotencyKey)
  })

  it("returns verified Prepare proof and the separate deterministic choice wait ID when the dependency wait is ready", async () => {
    const fixture = ports({ waitStatus: "ready", waitMatchedTaskIds: ["prepare-task"],
      choice: { required: true, status: "answered", waitId: expectedChoiceWaitId } })
    const proofFacts = prepareFacts()
    const prepareProof = buildScheduledPrepareTaskGraphProof(proofFacts, { waitId: "wait-1", status: "ready", mode: "all",
      targetTaskIds: ["prepare-task"], matchedTaskIds: ["prepare-task"] })
    expect(prepareProof).not.toBeNull()
    expect(scheduledPrepareChoiceWaitId({ receipt: prepareProof?.receipt, finalStepId: base.finalStepId, finalStepOrdinal: base.finalStepOrdinal })).toBeTruthy()
    const verifyReadyPrepare = vi.fn(async () => ({ verified: true as const, facts: proofFacts }))
    const result = await createScheduledAutomationPrepareContinuation({ ...fixture, verifyReadyPrepare })(base)
    expect(result).toMatchObject({ status: "ready", choice: { required: true, status: "answered", scheduledWaitId: expectedChoiceWaitId },
      prepareProof: { completion: { graphRevision: 9, wait: {
      waitId: "wait-1", status: "ready", mode: "all", targetTaskIds: ["prepare-task"], matchedTaskIds: ["prepare-task"],
    } } } })
    if (result.status === "ready") expect(result.choice.required && result.choice.scheduledWaitId).toBe(scheduledPrepareChoiceWaitId({ receipt: result.prepareProof.receipt,
      finalStepId: base.finalStepId, finalStepOrdinal: base.finalStepOrdinal }))
    expect(verifyReadyPrepare).toHaveBeenCalledWith(expect.objectContaining({ prepareTaskId: "prepare-task", scope: expect.objectContaining({ rootTaskId: owner.rootTaskId }) }))
  })

  it("keeps the durable Prepare proof when the persisted snapshot does not require a choice", async () => {
    const fixture = ports({ waitStatus: "ready", waitMatchedTaskIds: ["prepare-task"], choice: { required: false } })
    const proofFacts = prepareFacts()
    const verifyReadyPrepare = vi.fn(async () => ({ verified: true as const, facts: proofFacts }))
    const result = await createScheduledAutomationPrepareContinuation({ ...fixture, verifyReadyPrepare })(base)
    expect(result).toMatchObject({ status: "ready", choice: { required: false },
      prepareProof: { completion: { wait: { status: "ready", targetTaskIds: ["prepare-task"], matchedTaskIds: ["prepare-task"] } } } })
    expect(result.status === "ready" && "scheduledWaitId" in result.choice).toBe(false)
  })

  it("fails closed when a ready Prepare dependency lacks exact matched task proof", async () => {
    const ready = ports({ waitStatus: "ready", waitMatchedTaskIds: ["prepare-task"],
      choice: { required: true, status: "answered", waitId: expectedChoiceWaitId } })
    await expect(createScheduledAutomationPrepareContinuation(ready)(base)).rejects.toThrow("scheduled_prepare_completion_unverified")
    const mismatched = ports({ waitStatus: "ready", choice: { required: true, status: "answered", waitId: expectedChoiceWaitId } })
    await expect(createScheduledAutomationPrepareContinuation({ ...mismatched, verifyReadyPrepare: async () => ({ verified: true, facts: prepareFacts() }) })(base))
      .rejects.toThrow("scheduled_prepare_wait_invalid")
  })

  it("replays the original Analyze binding after the exact Prepare node advances the graph", async () => {
    const fixture = ports({ revision: 8, receiptStatus: "duplicate", choice: { required: true, status: "answered", waitId: expectedChoiceWaitId }, nodes: [
      { key: "discovery", templateId: "scout", taskId: "scout-task", status: "completed", failureReason: null },
      { key: "analysis", templateId: "analyst", taskId: "analyst-task", status: "completed", failureReason: null },
      { key: "prepare", templateId: "prepare", taskId: "prepare-task", status: "completed", failureReason: null,
        goal: "Prepare application materials using the persisted scheduled Analyze checkpoint.",
        successCriteria: ["Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.",
          "Persist immutable owner-fenced material references and return no resume or letter bodies."], dependsOn: ["analysis"] },
    ] })
    const continuation = createScheduledAutomationPrepareContinuation(fixture)

    await expect(continuation(base)).resolves.toEqual({ status: "waiting_for_dependency", waitId: "wait-1" })
    expect(fixture.appendScheduledPrepare).toHaveBeenCalledWith(expect.objectContaining({
      proposal: expect.objectContaining({ expectedRevision: attestation.graphRevision }),
    }))
    expect(fixture.wait).toHaveBeenCalledWith(expect.objectContaining({ targetTaskIds: ["prepare-task"] }))
  })

  it("replays Prepare through the exact fixed Gate suffix without using a current-revision shortcut", async () => {
    const graph = analyzeGraphWithGate()
    const fixture = ports({ revision: graph.current.revision, receiptStatus: "duplicate", choice: { required: false }, nodes: graph.current.nodes })
    const continuation = createScheduledAutomationPrepareContinuation(fixture)
    await expect(continuation(base)).resolves.toMatchObject({ status: "waiting_for_dependency", waitId: "wait-1" })
    expect(fixture.appendScheduledPrepare).toHaveBeenCalledWith(expect.objectContaining({
      proposal: expect.objectContaining({ expectedRevision: attestation.graphRevision }),
    }))
  })

  it("fails closed before scheduling when the Analyze graph has changed or the task is absent", async () => {
    const stale = ports({ revision: 8 }), first = createScheduledAutomationPrepareContinuation(stale)
    await expect(first(base)).rejects.toThrow("scheduled_prepare_analyze_revision_changed")
    expect(stale.appendScheduledPrepare).not.toHaveBeenCalled()

    const missing = ports({ nodes: [] }), second = createScheduledAutomationPrepareContinuation(missing)
    await expect(second(base)).rejects.toThrow("scheduled_prepare_analyst_missing")
    expect(missing.appendScheduledPrepare).not.toHaveBeenCalled()
  })

  it("rejects stale owners, append receipts, and invalid wait states", async () => {
    const fixture = ports(), continuation = createScheduledAutomationPrepareContinuation(fixture)
    await expect(continuation({ ...base, executionOwner: { ...executionOwner, leaseVersion: 6 } })).rejects.toThrow("scheduled_prepare_owner_invalid")
    expect(fixture.readCurrent).not.toHaveBeenCalled()

    const badReceipt = ports({ receiptNodes: [{ key: "other", taskId: "wrong-task", status: "queued" }] })
    await expect(createScheduledAutomationPrepareContinuation(badReceipt)(base)).rejects.toThrow("scheduled_prepare_schedule_invalid")

    const badWait = ports({ waitStatus: "timed_out", choice: { required: true, status: "answered", waitId: expectedChoiceWaitId } })
    await expect(createScheduledAutomationPrepareContinuation(badWait)(base)).rejects.toThrow("scheduled_prepare_wait_invalid")
  })
})
