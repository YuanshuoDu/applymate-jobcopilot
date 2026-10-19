import { describe, expect, it } from "vitest"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import { mergeTaskGraphCurrentObservation } from "../canonical-turn-task-graph-context.js"
import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphCurrentNode, TaskGraphCurrentState } from "../subagents/task-graph-command-port.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "../subagents/task-graph-command-port.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-verification-report.js"
import { applyCompletionRecovery, tagTaskGraphRepairRecovery } from "./completion-recovery-context.js"
import { buildTaskGraphRecoveryInstruction } from "./task-graph-recovery-guidance.js"
import { buildModelRequest } from "./turn-engine-messages.js"

const REVISION = 5
const ROOT_ID = "root-current"
const CURRENT_GRAPH_ID = "task-graph-current"
const FEEDBACK_LEAD = "TaskGraph required evidence is missing, invalid, failed, or unresolved; node and criterion fields are 1-based ordinals in the current TaskGraph. Replan or repair affected criteria before completing."
const FEEDBACK = `${FEEDBACK_LEAD} issue=verification_report nodeOrdinal=1 criterionOrdinal=1 status=failed reasonCode=criterion_not_met repair=missing`
const STRUCTURED_FAILURE_FEEDBACK = `${FEEDBACK_LEAD} issue=verification_report nodeOrdinal=1 criterionOrdinal=1 status=unverified reasonCode=result_invalid repair=missing`
const CHECK = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 4 } }] }
const ANALYST_CHECK = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 2 } }] }
const UNAVAILABLE_PROJECTION = { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "unavailable" as const }
const digest = "a".repeat(64)

function report(status: "failed" | "passed") {
  const criterionStatus = status === "passed" ? "passed" as const : "failed" as const
  const reasonCode = status === "passed" ? "criteria_met" as const : "criterion_not_met" as const
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status, reasonCode,
    criteria: [{ criterionId: "candidate-count", status: criterionStatus, reasonCode }],
    evidenceDigest: digest, resultDigest: "b".repeat(64) }
}

function sourceNode(): TaskGraphCurrentNode {
  return { key: "research", taskId: "child-private", templateId: "scout", goal: "private goal text",
    successCriteria: ["Return verified evidence"], dependsOn: [], status: "failed", readiness: "terminal",
    resultSummary: null, failureReason: null, resultProjection: UNAVAILABLE_PROJECTION,
    verificationCriterionIds: ["candidate-count"], verification: CHECK, verificationReport: report("failed") }
}

function extraNode(index: number): TaskGraphCurrentNode {
  return { key: `other-${index}`, taskId: `task-${index}`, templateId: "other", goal: "Other node",
    successCriteria: ["Complete"], dependsOn: [], status: "queued", readiness: "ready", resultSummary: null,
    failureReason: null, resultProjection: UNAVAILABLE_PROJECTION }
}

function ordinaryFailedNode(failureReason: string | null = null): TaskGraphCurrentNode {
  return { ...extraNode(99), key: "ordinary-failed", taskId: "ordinary-failed-task", status: "failed", readiness: "terminal", failureReason }
}

function structuredFailureNode(
  category?: NonNullable<TaskGraphCurrentNode["structuredOutputFailureCategory"]>, role: "scout" | "analyst" = "scout",
): TaskGraphCurrentNode {
  const verification = role === "scout" ? CHECK : ANALYST_CHECK
  const criterionId = role === "scout" ? "candidate-count" : "finding-count"
  return {
    key: "typed-failure", taskId: "structured-private-task", templateId: role, goal: "PRIVATE_STRUCTURED_GOAL",
    successCriteria: ["PRIVATE_STRUCTURED_CRITERION"], dependsOn: [], status: "failed", readiness: "terminal",
    resultSummary: null, failureReason: "task_graph_verification_unverified", resultProjection: UNAVAILABLE_PROJECTION,
    verificationCriterionIds: [criterionId], verification,
    verificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
      criteria: [{ criterionId, status: "unverified", reasonCode: "result_invalid" }], evidenceDigest: null, resultDigest: null },
    ...(category === undefined ? {} : { structuredOutputFailureCategory: category }),
  }
}

const REQUEST_MODEL = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false,
  streaming: true, continuationCursor: false } } as unknown as ModelAdapter
const RECOVERY_TOOLS = [{ name: "agent.list" }, { name: "agent.wait" }, { name: "agent.plan" }]

function requestFor(context: StepContext, tools: readonly unknown[] = RECOVERY_TOOLS) {
  return buildModelRequest({ context, model: REQUEST_MODEL, tools, sessionId: "session", turnId: "turn", stepId: "step-resume",
    userId: "user", taskId: ROOT_ID, signal: new AbortController().signal })
}

function recoveryMessage(request: ReturnType<typeof requestFor>) {
  return request.messages.find(message => message.role === "system" && message.content.some(part => part.type === "text"
    && part.text.includes("The current owner-read TaskGraph denial is advisory feedback")))
}

function requestSystemText(request: ReturnType<typeof requestFor>): string {
  return request.messages.filter(message => message.role === "system")
    .flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
}

function replaceGraphNode(context: StepContext, index: number, node: unknown): StepContext {
  const blocks = context.blocks.map(block => {
    if (block.id !== `observation:${CURRENT_GRAPH_ID}`) return block
    const content = block.content
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("expected graph observation")
    const graph = content as Record<string, unknown>, currentNodes = graph.nodes
    if (!Array.isArray(currentNodes) || index < 0 || index >= currentNodes.length) throw new Error("expected graph node")
    const nodes = [...currentNodes]
    nodes[index] = node
    return { ...block, content: { ...graph, nodes } as typeof block.content }
  })
  return { ...context, blocks }
}

function repairNode(status: "queued" | "failed" | "cancelled"): TaskGraphCurrentNode {
  return { key: "repair-attempt", taskId: "repair-private", templateId: "scout", goal: "private repair goal",
    successCriteria: ["Repair evidence"], dependsOn: [], status, readiness: status === "queued" ? "active" : "terminal",
    resultSummary: null, failureReason: null, resultProjection: UNAVAILABLE_PROJECTION,
    verificationCriterionIds: ["candidate-count"], verification: CHECK,
    ...(status === "failed" ? { verificationReport: report("failed") } : {}),
    repairOf: { graphRootTaskId: ROOT_ID, nodeKey: "research", taskId: "child-private", criterionIds: ["candidate-count"] } }
}

function unresolvedSource(index: number): TaskGraphCurrentNode {
  return { ...sourceNode(), key: `research-${index}`, taskId: `child-${index}` }
}

function unresolvedRepair(index: number): TaskGraphCurrentNode {
  const source = unresolvedSource(index)
  return { ...repairNode("failed"), key: `repair-${index}`, taskId: `repair-${index}`,
    verificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "repair_target_unresolved",
      criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: null, resultDigest: "c".repeat(64) },
    repairOf: { graphRootTaskId: ROOT_ID, nodeKey: source.key, taskId: source.taskId, criterionIds: ["candidate-count"] } }
}

function contextFor(input: {
  nodes?: readonly TaskGraphCurrentNode[]
  graphRevision?: number
  markerRevision?: number
  contextRevision?: number
  duplicateMarker?: boolean
  spoofMarker?: boolean
  feedback?: string
} = {}): StepContext {
  const revision = input.graphRevision ?? REVISION
  const seed = applyCompletionRecovery({ system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    "step-denied", tagTaskGraphRepairRecovery(input.feedback ?? FEEDBACK, input.markerRevision ?? REVISION))
    .system[0]!
  const withGraph = mergeTaskGraphCurrentObservation({ ...seedSnapshot(seed), taskGraphRevision: revision }, {
    revision, nodes: input.nodes ?? [sourceNode()],
  })
  let system = [...withGraph.system]
  if (input.duplicateMarker) system.push({ ...system[0]! })
  const systemBlocks = system.map(item => ({ id: `system:${item.id}`, layer: "system" as const, role: "instruction" as const,
    trust: input.spoofMarker && item.id.startsWith("completion-recovery:") ? "external_untrusted" as const : "system" as const,
    source: input.spoofMarker && item.id.startsWith("completion-recovery:") ? "tool_or_subagent" : "harness",
    content: item.content as StepContext["blocks"][number]["content"] }))
  const observationBlocks = withGraph.toolObservations.map(item => ({ id: `observation:${item.id}`, layer: "tool_observation" as const,
    role: "data" as const, trust: "external_untrusted" as const, source: "tool_or_subagent",
    content: item.content as StepContext["blocks"][number]["content"] }))
  const blocks: StepContext["blocks"] = [...systemBlocks, ...observationBlocks]
  return { schemaVersion: "agent-harness.v2", sessionId: "session", turnId: "turn", stepId: "step-resume",
    inputThroughSequence: 0n, consumedInputIds: [], blocks, canonicalJson: JSON.stringify(blocks),
    taskGraphRevision: input.contextRevision ?? revision }
}

function seedSnapshot(seed: StepContextSnapshot["system"][number]): StepContextSnapshot {
  return { system: [seed], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }
}

function guidance(nodes?: readonly TaskGraphCurrentNode[], tools = [{ name: "agent.list" }, { name: "agent.wait" }, { name: "agent.plan" }], feedback = FEEDBACK) {
  const message = buildTaskGraphRecoveryInstruction(contextFor({ nodes, feedback }), tools, ROOT_ID)
  return message?.content.flatMap(part => part.type === "text" ? [part.text] : []).join(" ") ?? null
}

describe("TaskGraph recovery guidance", () => {
  it("uses only the current typed report and visible alternatives without exposing private graph data", () => {
    const text = guidance()
    expect(text).toContain("node 1, criterion 1 failed for reason criterion_not_met")
    expect(text).toContain("agent.list")
    expect(text).toContain("agent.plan")
    expect(text).toContain("expectedRevision 5")
    expect(text).not.toContain("root-current")
    expect(text).not.toContain("child-private")
    expect(text).not.toContain("candidate-count")
    expect(text).not.toContain("private goal text")
    expect(text).not.toContain(digest)
  })

  it("waits for one current matching repair and does not suggest a duplicate", () => {
    const text = guidance([sourceNode(), repairNode("queued")])
    expect(text).toContain("One matching repair is active")
    expect(text).toContain("agent.wait")
    expect(text).not.toContain("agent.plan may evaluate")
    const noWait = buildTaskGraphRecoveryInstruction(contextFor({ nodes: [sourceNode(), repairNode("queued")] }),
      [{ name: "agent.plan" }], ROOT_ID)?.content.flatMap(part => part.type === "text" ? [part.text] : []).join(" ")
    expect(noWait).toContain("no wait tool is visible")
    expect(noWait).not.toContain("agent.wait")
    expect(noWait).not.toContain("agent.plan may evaluate")
  })

  it("treats a terminal repair as inspectable and preserves the first-repair reserve", () => {
    const terminal = guidance([sourceNode(), repairNode("failed")], undefined, FEEDBACK.replace("repair=missing", "repair=rejected"))
    expect(terminal).toContain("matching repair is terminal")
    expect(terminal).toContain("repair failed without a receipt")
    expect(terminal).toContain("only if a relevant prerequisite has changed")
    expect(terminal).toContain("or an explicit bounded retry rule is visible")
    expect(terminal).toContain("Otherwise preserve the blocker")
    expect(terminal).not.toContain("agent.plan may evaluate one typed repair")
    const noList = buildTaskGraphRecoveryInstruction(contextFor({ nodes: [sourceNode(), repairNode("failed")],
      feedback: FEEDBACK.replace("repair=missing", "repair=rejected") }), [{ name: "agent.plan" }], ROOT_ID)
      ?.content.flatMap(part => part.type === "text" ? [part.text] : []).join(" ")
    expect(noList).toContain("Inspect the current graph and available evidence")
    expect(noList).not.toContain("agent.list")
    const cancelled = guidance([sourceNode(), repairNode("cancelled")], undefined, FEEDBACK.replace("repair=missing", "repair=terminal"))
    expect(cancelled).toContain("matching repair is terminal")
    expect(cancelled).not.toContain("agent.plan may evaluate")
    const stalePending = guidance([sourceNode(), repairNode("failed")], undefined, FEEDBACK.replace("repair=missing", "repair=pending"))
    expect(stalePending).toContain("denial recorded a pending repair")
    expect(stalePending).not.toContain("agent.plan may evaluate")
    const sevenNodes = [sourceNode(), ...Array.from({ length: 6 }, (_, index) => extraNode(index))]
    const reserved = guidance(sevenNodes)
    expect(reserved).toContain("agent.plan may evaluate one typed repair")
    expect(JSON.stringify(mergeTaskGraphCurrentObservation(seedSnapshot({ id: "other", content: "seed" }), {
      revision: REVISION, nodes: sevenNodes,
    }).toolObservations.at(-1)?.content)).toContain('"ordinaryRemaining":0')
    expect(reserved).toContain("capacity is advisory, including any first-repair reserve")
  })

  it("does not suggest a repair when current capacity is full or its report has passed", () => {
    const full = [sourceNode(), ...Array.from({ length: 7 }, (_, index) => extraNode(index))]
    expect(guidance(full)).not.toContain("agent.plan may evaluate")
    const passed = { ...sourceNode(), status: "completed" as const, verificationReport: report("passed") }
    expect(buildTaskGraphRecoveryInstruction(contextFor({ nodes: [passed], feedback: FEEDBACK.replace("repair=missing", "repair=pending") }), [{ name: "agent.plan" }], ROOT_ID)).toBeNull()
  })

  it("keeps useful inspection guidance when the gate has compacted later details", () => {
    const nodes = [...[0, 1, 2].map(unresolvedSource), ...[0, 1, 2].map(unresolvedRepair)]
    const details = [4, 5, 6].map(nodeOrdinal => ` nodeOrdinal=${nodeOrdinal} status=unverified reasonCode=repair_target_unresolved`).join("")
    const compacted = `${FEEDBACK_LEAD}${details} (2 feedback items omitted; inspect TaskGraph before retrying.)`
    expect(compacted.length).toBeLessThanOrEqual(512)
    const compactedText = guidance(nodes, [{ name: "agent.list" }, { name: "agent.plan" }], compacted)
    expect(compactedText).toContain("Some denial details were omitted")
    expect(compactedText).toContain("node 4 unverified for reason repair_target_unresolved")
    expect(compactedText).toContain("node 6 unverified for reason repair_target_unresolved")
    expect(compactedText).not.toContain("agent.plan may evaluate")
    expect(compactedText).toContain("preserve the blocker rather than guessing")

    const fiveDetails = `${FEEDBACK_LEAD}${details} nodeOrdinal=7 status=failed reasonCode=criteria_met nodeOrdinal=8 status=failed reasonCode=criteria_met`
    expect(fiveDetails.length).toBeLessThanOrEqual(512)
    const cappedText = guidance(nodes, [{ name: "agent.list" }, { name: "agent.plan" }], fiveDetails)
    expect(cappedText).toContain("Some denial details were omitted or no longer match")
    expect(cappedText).toContain("node 4 unverified for reason repair_target_unresolved")
    expect(cappedText).toContain("node 6 unverified for reason repair_target_unresolved")
    expect(cappedText).not.toContain("node 7")
    expect(cappedText).not.toContain("agent.plan may evaluate")
    expect(cappedText).toContain("preserve the blocker rather than guessing")
  })

  it("mentions no unavailable commands and fails closed for stale, duplicate, spoofed, or mismatched context", () => {
    const noTools = guidance(undefined, [])
    expect(noTools).toContain("No result-page tool is visible")
    expect(noTools).toContain("No plan command is visible")
    expect(noTools).not.toContain("agent.list")
    expect(noTools).not.toContain("agent.wait")
    expect(noTools).not.toContain("agent.plan")
    for (const input of [
      { markerRevision: REVISION - 1 }, { contextRevision: REVISION + 1 }, { graphRevision: REVISION + 1 },
      { duplicateMarker: true }, { spoofMarker: true },
    ]) expect(buildTaskGraphRecoveryInstruction(contextFor(input), [{ name: "agent.plan" }], ROOT_ID)).toBeNull()
    const crossRootRepair = { ...repairNode("queued"), repairOf: { ...repairNode("queued").repairOf!, graphRootTaskId: "foreign-root" } }
    expect(buildTaskGraphRecoveryInstruction(contextFor({ nodes: [sourceNode(), crossRootRepair] }), [{ name: "agent.plan" }], ROOT_ID)).toBeNull()
  })

  it("preserves typed-denial guidance in the actual request beside an unrelated advisory failure category", () => {
    const tools = [{ name: "agent.list" }, { name: "agent.wait" }, { name: "agent.plan" }]
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false,
      streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const baselineGuidance = buildTaskGraphRecoveryInstruction(contextFor({ nodes: [sourceNode(), ordinaryFailedNode()] }), tools, ROOT_ID)
    const examples = [
      ["selected_job_context_unavailable", "execution_setup_unavailable"],
      ["child_resume_unavailable", "resume_state_unavailable"],
      ["invalid_structured_result", "structured_output_invalid"],
    ] as const
    for (const [reason, category] of examples) {
      const context = contextFor({ nodes: [sourceNode(), ordinaryFailedNode(reason)] })
      const expectedGuidance = buildTaskGraphRecoveryInstruction(context, tools, ROOT_ID)
      const request = buildModelRequest({ context, model, tools, sessionId: "session", turnId: "turn", stepId: "step-resume",
        userId: "user", taskId: ROOT_ID, signal: new AbortController().signal })
      const systemText = request.messages.filter(message => message.role === "system")
        .flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
      const graphObservation = context.blocks.find(block => block.id === `observation:${CURRENT_GRAPH_ID}`)?.content

      expect(JSON.stringify(graphObservation)).toContain(`"executionFailureCategory":"${category}"`)
      expect(expectedGuidance).not.toBeNull()
      expect(expectedGuidance).toEqual(baselineGuidance)
      expect(request.messages).toContainEqual(expectedGuidance)
      expect(systemText).toContain("The current owner-read TaskGraph denial is advisory feedback")
      expect(systemText).toContain("node 1, criterion 1 failed for reason criterion_not_met")
      expect(systemText).not.toContain(category)
      expect(systemText).not.toContain(reason)
      expect(systemText).not.toContain("ordinary-failed-task")
      expect(systemText).not.toContain("private goal text")
    }

    const categoryContext = contextFor({ nodes: [ordinaryFailedNode("selected_job_context_unavailable")] })
    const withoutMarker = { ...categoryContext, blocks: categoryContext.blocks.filter(block => !block.id.startsWith("system:completion-recovery:task-graph:")) }
    expect(buildTaskGraphRecoveryInstruction(withoutMarker, tools, ROOT_ID)).toBeNull()
  })

  it("rejects malformed, nonfailed, verified, native, inherited, and accessor category fields", () => {
    const context = contextFor({ nodes: [sourceNode(), ordinaryFailedNode()] })
    const validCategory = "execution_setup_unavailable"
    const cases: unknown[] = [
      { ...ordinaryFailedNode(), executionFailureCategory: "provider-private-detail" },
      { ...ordinaryFailedNode(), executionFailureCategory: 4 },
      { ...ordinaryFailedNode(), status: "queued", readiness: "ready", executionFailureCategory: validCategory },
      { ...sourceNode(), key: "reported-node", taskId: "reported-task", executionFailureCategory: validCategory },
      { ...ordinaryFailedNode(), native: {}, executionFailureCategory: validCategory },
    ]
    for (const node of cases) {
      expect(buildTaskGraphRecoveryInstruction(replaceGraphNode(context, 1, node), [{ name: "agent.plan" }], ROOT_ID)).toBeNull()
    }

    let getterCalled = false
    const accessor = { ...ordinaryFailedNode() }
    Object.defineProperty(accessor, "executionFailureCategory", {
      enumerable: true, get: () => { getterCalled = true; return validCategory },
    })
    expect(buildTaskGraphRecoveryInstruction(replaceGraphNode(context, 1, accessor), [{ name: "agent.plan" }], ROOT_ID)).toBeNull()
    expect(getterCalled).toBe(false)

    const inherited = Object.assign(Object.create({ executionFailureCategory: validCategory }), ordinaryFailedNode())
    expect(buildTaskGraphRecoveryInstruction(replaceGraphNode(context, 1, inherited), [{ name: "agent.plan" }], ROOT_ID)).toBeNull()
  })

  it("keeps all recognized structured failure categories observable while preserving byte-identical matched-denial guidance", () => {
    const categories = ["missing_final_output", "result_too_large", "result_shape_invalid", "evidence_binding_invalid"] as const
    const noCategoryRequest = requestFor(contextFor({ nodes: [structuredFailureNode()], feedback: STRUCTURED_FAILURE_FEEDBACK }))
    const noCategoryMessage = recoveryMessage(noCategoryRequest)
    expect(noCategoryMessage).toBeDefined()

    for (const category of categories) {
      const context = contextFor({ nodes: [structuredFailureNode(category)], feedback: STRUCTURED_FAILURE_FEEDBACK })
      const request = requestFor(context)
      const message = recoveryMessage(request)
      const graph = context.blocks.find(block => block.id === `observation:${CURRENT_GRAPH_ID}`)?.content
      const systemText = requestSystemText(request)

      expect(JSON.stringify(graph)).toContain(`"structuredOutputFailureCategory":"${category}"`)
      expect(message).toBeDefined()
      expect(JSON.stringify(message)).toBe(JSON.stringify(noCategoryMessage))
      expect(systemText).toContain("The current owner-read TaskGraph denial is advisory feedback")
      expect(systemText).toContain("node 1, criterion 1 unverified for reason result_invalid")
      expect(systemText).toContain("agent.plan may evaluate one typed repair under its current expectedRevision 5 contract")
      expect(systemText).toContain("The existing planner and completion gate decide validity")
      expect(systemText).not.toContain(category)
      expect(systemText).not.toContain("structuredOutputFailureCategory")
      expect(systemText).not.toContain("structured-private-task")
      expect(systemText).not.toContain("PRIVATE_STRUCTURED_GOAL")
      expect(systemText).not.toContain("PRIVATE_STRUCTURED_CRITERION")
      expect(systemText).not.toContain(digest)
    }
  })

  it("accepts an analyst typed result-invalid report through the same matched denial", () => {
    const context = contextFor({ nodes: [structuredFailureNode("evidence_binding_invalid", "analyst")],
      feedback: STRUCTURED_FAILURE_FEEDBACK })
    const request = requestFor(context)
    const graph = context.blocks.find(block => block.id === `observation:${CURRENT_GRAPH_ID}`)?.content
    const systemText = requestSystemText(request)

    expect(JSON.stringify(graph)).toContain('"templateId":"analyst"')
    expect(JSON.stringify(graph)).toContain('"structuredOutputFailureCategory":"evidence_binding_invalid"')
    expect(recoveryMessage(request)).toBeDefined()
    expect(systemText).toContain("agent.plan may evaluate one typed repair under its current expectedRevision 5 contract")
    expect(systemText).not.toContain("evidence_binding_invalid")
    expect(systemText).not.toContain("structured-private-task")
  })

  it("fails closed for invalid category ownership, eligibility, reports, criteria, digests, and native markers", () => {
    const eligible = structuredFailureNode("result_shape_invalid")
    const context = contextFor({ nodes: [eligible], feedback: STRUCTURED_FAILURE_FEEDBACK })
    const validReport = eligible.verificationReport!
    const invalidRows: unknown[] = [
      { ...eligible, structuredOutputFailureCategory: "private_exception_text" },
      { ...eligible, structuredOutputFailureCategory: 3 },
      { ...eligible, structuredOutputFailureCategory: { category: "result_shape_invalid" } },
      { ...eligible, status: "queued", readiness: "ready" },
      { ...eligible, templateId: "analyst" },
      (() => { const { verificationReport: _report, ...withoutReport } = eligible; return withoutReport })(),
      { ...eligible, verificationReport: report("failed") },
      { ...eligible, verificationReport: { ...validReport, reasonCode: "result_ambiguous",
        criteria: [{ criterionId: "candidate-count", status: "unverified", reasonCode: "result_ambiguous" }] } },
      { ...eligible, verificationReport: { ...validReport,
        criteria: [{ criterionId: "different-criterion", status: "unverified", reasonCode: "result_invalid" }] } },
      { ...eligible, verificationReport: { ...validReport, evidenceDigest: digest } },
      { ...eligible, verificationReport: { ...validReport, resultDigest: digest } },
      { ...eligible, native: {} },
      { ...eligible, nativeResult: {} },
    ]
    for (const row of invalidRows) {
      expect(buildTaskGraphRecoveryInstruction(replaceGraphNode(context, 0, row), RECOVERY_TOOLS, ROOT_ID)).toBeNull()
    }

    let getterCalled = false
    const accessor = { ...eligible }
    Object.defineProperty(accessor, "structuredOutputFailureCategory", {
      enumerable: true, get: () => { getterCalled = true; return "result_shape_invalid" },
    })
    expect(buildTaskGraphRecoveryInstruction(replaceGraphNode(context, 0, accessor), RECOVERY_TOOLS, ROOT_ID)).toBeNull()
    expect(getterCalled).toBe(false)

    const nonEnumerable = { ...eligible }
    Object.defineProperty(nonEnumerable, "structuredOutputFailureCategory", { enumerable: false, value: "result_shape_invalid" })
    expect(buildTaskGraphRecoveryInstruction(replaceGraphNode(context, 0, nonEnumerable), RECOVERY_TOOLS, ROOT_ID)).toBeNull()

    const { structuredOutputFailureCategory: _category, ...withoutCategory } = eligible
    const inherited = Object.assign(Object.create({ structuredOutputFailureCategory: "result_shape_invalid" }), withoutCategory)
    expect(buildTaskGraphRecoveryInstruction(replaceGraphNode(context, 0, inherited), RECOVERY_TOOLS, ROOT_ID)).toBeNull()
  })

  it("rejects category-bearing repair markers, missing or stale denials, hidden actions, full capacity, and resolved reports", () => {
    const eligible = structuredFailureNode("result_shape_invalid")
    const matched = contextFor({ nodes: [eligible], feedback: STRUCTURED_FAILURE_FEEDBACK })
    const repair = {
      ...structuredFailureNode("result_shape_invalid"), key: "typed-repair", taskId: "typed-repair-task",
      repairOf: { graphRootTaskId: ROOT_ID, nodeKey: eligible.key, taskId: eligible.taskId, criterionIds: ["candidate-count"] },
    }
    const withRepairCategory = replaceGraphNode(contextFor({ nodes: [eligible, ordinaryFailedNode()], feedback: STRUCTURED_FAILURE_FEEDBACK }), 1, repair)
    expect(buildTaskGraphRecoveryInstruction(withRepairCategory, RECOVERY_TOOLS, ROOT_ID)).toBeNull()

    const withoutMarker = { ...matched, blocks: matched.blocks.filter(block => !block.id.startsWith("system:completion-recovery:task-graph:")) }
    expect(recoveryMessage(requestFor(withoutMarker))).toBeUndefined()
    expect(recoveryMessage(requestFor(contextFor({ nodes: [eligible], markerRevision: REVISION - 1,
      feedback: STRUCTURED_FAILURE_FEEDBACK })))).toBeUndefined()
    expect(recoveryMessage(requestFor(contextFor({ nodes: [eligible], feedback: FEEDBACK })))).toBeUndefined()

    const hiddenRequest = requestFor(matched, [])
    const hiddenText = requestSystemText(hiddenRequest)
    expect(recoveryMessage(hiddenRequest)).toBeDefined()
    expect(hiddenText).toContain("No result-page tool is visible")
    expect(hiddenText).toContain("No plan command is visible")
    expect(hiddenText).not.toContain("agent.plan may evaluate")
    expect(hiddenText).not.toContain("agent.list")
    expect(hiddenText).not.toContain("agent.wait")

    const fullGraph = [eligible, ...Array.from({ length: 7 }, (_, index) => extraNode(index))]
    const fullText = requestSystemText(requestFor(contextFor({ nodes: fullGraph, feedback: STRUCTURED_FAILURE_FEEDBACK })))
    expect(fullText).toContain("node 1, criterion 1 unverified for reason result_invalid")
    expect(fullText).not.toContain("agent.plan may evaluate one typed repair")

    const resolved = structuredFailureNode()
    const passedReport = report("passed")
    const resolvedWithoutCategory = { ...resolved, status: "completed" as const, verificationReport: passedReport }
    const resolvedWithCategory = { ...resolvedWithoutCategory, structuredOutputFailureCategory: "result_shape_invalid" as const }
    expect(recoveryMessage(requestFor(contextFor({ nodes: [resolvedWithoutCategory], feedback: STRUCTURED_FAILURE_FEEDBACK })))).toBeUndefined()
    expect(recoveryMessage(requestFor(contextFor({ nodes: [resolvedWithCategory], feedback: STRUCTURED_FAILURE_FEEDBACK })))).toBeUndefined()
  })
})
