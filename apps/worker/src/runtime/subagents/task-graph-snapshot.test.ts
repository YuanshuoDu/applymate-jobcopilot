import { describe, expect, it } from "vitest"

import { TASK_GRAPH_LIMITS, type TaskGraphState, type TaskGraphVerificationDisposition } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphLifecycleKey, taskGraphSnapshot,
  taskGraphState, taskGraphWaitLifecycleKey, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

const queuedEvent = {
  type: "task.queued",
  idempotencyKey: "task-graph:node-1:queued",
  expectedRevision: 4,
  nodeKey: "node-1",
} as const

describe("parseTaskGraphEvent", () => {
  it("parses task.queued lifecycle events from objects and JSON", () => {
    expect(parseTaskGraphEvent(queuedEvent)).toEqual(queuedEvent)
    expect(parseTaskGraphEvent(JSON.stringify(queuedEvent))).toEqual(queuedEvent)
  })

  it("parses only the bounded Gate-choice-resume event identity and attempt pair", () => {
    const event = { type: "task.gate_choice_resumed", idempotencyKey: "resume-gate-3", expectedRevision: 8,
      nodeKey: "gate", gateTaskId: "gate-task", requestAttemptCount: 3, resumedAttemptCount: 4 }
    expect(parseTaskGraphEvent(event)).toEqual(event)
    expect(parseTaskGraphEvent(JSON.stringify(event))).toEqual(event)
    expect(parseTaskGraphEvent({ ...event, resumedAttemptCount: 5 })).toBeNull()
    expect(parseTaskGraphEvent({ ...event, choiceId: "skip" })).toBeNull()
  })

  it("rejects unknown and malformed lifecycle events", () => {
    expect(parseTaskGraphEvent({ ...queuedEvent, type: "task.unknown" })).toBeNull()
    expect(parseTaskGraphEvent({ ...queuedEvent, nodeKey: " " })).toBeNull()
    expect(parseTaskGraphEvent({ ...queuedEvent, expectedRevision: -1 })).toBeNull()
    expect(parseTaskGraphEvent({ ...queuedEvent, extra: "unexpected" })).toBeNull()
    expect(parseTaskGraphEvent({ ...queuedEvent, type: "task.failed" })).toBeNull()
  })
})

describe("taskGraphWaitLifecycleKey", () => {
  it("reuses one persisted wait identity and separates distinct waits in the same attempt", () => {
    const first = taskGraphWaitLifecycleKey("root-1", "scout-node", 3, "wait-row-a")
    expect(taskGraphWaitLifecycleKey("root-1", "scout-node", 3, "wait-row-a")).toBe(first)
    expect(taskGraphWaitLifecycleKey("root-1", "scout-node", 3, "wait-row-b")).not.toBe(first)
    expect(taskGraphWaitLifecycleKey("root-1", "other-node", 3, "wait-row-a")).not.toBe(first)
    expect(taskGraphWaitLifecycleKey("root-1", "scout-node", 4, "wait-row-a")).not.toBe(first)
    expect(taskGraphWaitLifecycleKey("other-root", "scout-node", 3, "wait-row-a")).not.toBe(first)
    expect(first).not.toContain("wait-row-a")
    expect(first).not.toBe(taskGraphLifecycleKey("root-1", "scout-node", 3, "task.waiting"))
  })
})

function snapshotWithLists(successCriteria: unknown, dependsOn: unknown) {
  return {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [{
      key: "node-1",
      templateId: "scout",
      goal: "Find evidence",
      successCriteria,
      dependsOn,
      depth: 1,
      taskId: "task-1",
    }],
  }
}

function snapshotWithNodes(nodes: readonly unknown[]) {
  return { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes }
}

function storedNode(key: string, dependsOn: string[] = []) {
  return {
    key,
    templateId: "scout",
    goal: `Find evidence for ${key}`,
    successCriteria: ["Evidence found"],
    dependsOn,
    depth: 1,
    taskId: `task-${key}`,
  }
}

function scheduledPostGateNodes(executePackageRefs: readonly string[] = ["job-1", "job-2"]) {
  const scouts = [storedNode("scout-1"), storedNode("scout-2")]
  const analyst = { ...storedNode("analyst", scouts.map(node => node.key)), templateId: "analyst", depth: 2 }
  const prepare = { ...storedNode("prepare", ["analyst"]), templateId: "prepare", depth: 3, verificationDisposition: "specialized" }
  const gate = { ...storedNode("gate", ["prepare"]), templateId: "gate", depth: 4, verificationDisposition: "specialized" }
  const execute = { ...storedNode("execute-1", ["gate"]), templateId: "scheduled.application.execute", packageRefs: [...executePackageRefs],
    depth: 5, verificationDisposition: "specialized" }
  const audit = { ...storedNode("scheduled.post_gate_audit", ["execute-1"]), templateId: "scheduled.post_gate_audit", depth: 6,
    verificationDisposition: "specialized" }
  return [...scouts, analyst, prepare, gate, execute, audit]
}

const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const
const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout",
  criteria: [
    { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
    { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
  ],
} as const
const registeredScoutEnvelope = {
  role: "scout",
  taskType: "research",
  expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
  allowedActions: ["jobs.search"],
} as const

function boundedEightNodeSnapshot(useUnicode: boolean) {
  const keys = Array.from({ length: 8 }, (_, index) => `${"k".repeat(127)}${index}`)
  return snapshotWithNodes(keys.map((key, index) => ({
    key,
    templateId: "t".repeat(128),
    goal: useUnicode ? "😀".repeat(600) : "g".repeat(1200),
    successCriteria: Array.from({ length: 8 }, () => useUnicode ? "😀".repeat(160) : "c".repeat(320)),
    dependsOn: keys.slice(0, index),
    depth: index + 1,
    taskId: `${"x".repeat(127)}${index}`,
  })))
}

describe("parseTaskGraphSnapshot", () => {
  it("parses well-formed dependency and success-criteria arrays", () => {
    expect(parseTaskGraphSnapshot(snapshotWithLists(["Evidence found"], []))).toMatchObject({
      schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: [{ key: "node-1", successCriteria: ["Evidence found"], dependsOn: [], verificationDisposition: "legacy_unverified" }],
    })
  })

  it("marks Application Filler graph nodes specialized without a typed verification contract", () => {
    const state: TaskGraphState = {
      revision: 1,
      nodes: [{ key: "fill", templateId: "application_filler", goal: "Prepare for review", successCriteria: ["Ready for review"], dependsOn: [], depth: 1, status: "queued" }],
      appliedEvents: [],
    }
    const snapshot = taskGraphSnapshot(state, new Map([["fill", "task-fill"]]))

    expect(snapshot.nodes[0]).toMatchObject({ templateId: "application_filler", verificationDisposition: "specialized" })
    expect(snapshot.nodes[0]).not.toHaveProperty("verification")
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(snapshot))).toEqual(snapshot)
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([{
      ...storedNode("typed-fill"), templateId: "application_filler", verification: analystVerification, verificationDisposition: "typed",
    }]))).toThrow("task_graph_snapshot_verification_invalid")
  })

  it("round-trips the optional pinned root checklist while preserving legacy snapshots", () => {
    const legacy = parseTaskGraphSnapshot(snapshotWithNodes([storedNode("legacy")]));
    expect(legacy).not.toHaveProperty("rootSuccessCriteria");
    const pinned = parseTaskGraphSnapshot({ ...snapshotWithNodes([storedNode("pinned")]), rootSuccessCriteria: ["Whole human objective", "Include evidence"] });
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(pinned))).toEqual(pinned);
    const state = taskGraphState(pinned, 1, new Map([["task-pinned", { status: "queued", failureReason: null }]]), [])
    expect(taskGraphSnapshot(state, new Map([ ["pinned", "task-pinned"] ]))).toEqual(pinned);
    const maximumPin = ["g".repeat(2_000), ...Array.from({ length: 4 }, (_, index) => `${index}${"x".repeat(511)}`)]
    expect(parseTaskGraphSnapshot({ ...snapshotWithNodes([storedNode("maximum")]), rootSuccessCriteria: maximumPin }).rootSuccessCriteria).toEqual(maximumPin);
    for (const rootSuccessCriteria of [[], null, ["Whole human objective", "Whole human objective"], ["x".repeat(2_001)],
      ["Whole human objective", "x".repeat(513)], ["Whole human objective", ...Array.from({ length: 6 }, (_, index) => `extra ${index}`)]]) {
      expect(() => parseTaskGraphSnapshot({ ...snapshotWithNodes([storedNode("invalid")]), rootSuccessCriteria })).toThrow();
    }
    let getterReads = 0
    const accessor = snapshotWithNodes([storedNode("accessor")]) as Record<string, unknown>
    Object.defineProperty(accessor, "rootSuccessCriteria", {
      enumerable: true, get: () => { getterReads += 1; return ["Whole human objective"] },
    })
    expect(() => parseTaskGraphSnapshot(accessor)).toThrow("task_graph_snapshot_root_criteria_invalid")
    expect(getterReads).toBe(0)
  })

  it("preserves normalized typed contracts in canonical snapshots and identifies old nodes as legacy", () => {
    const typed = parseTaskGraphSnapshot(snapshotWithNodes([{
      ...storedNode("typed"), templateId: "analyst", verification: analystVerification, verificationDisposition: "typed",
    }]))
    expect(typed.nodes[0]).toMatchObject({ verificationDisposition: "typed", verification: analystVerification })
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(typed))).toEqual(typed)
    const typedState = taskGraphState(typed, 1, new Map([["task-typed", { status: "retrying", failureReason: null }]]), [])
    const persistedDisposition: TaskGraphVerificationDisposition = typedState.nodes[0].verificationDisposition!
    expect(persistedDisposition).toBe("typed")
    expect(taskGraphSnapshot(typedState, new Map([["typed", "task-typed"]]))).toEqual(typed)

    const legacy = parseTaskGraphSnapshot(snapshotWithNodes([storedNode("old")]))
    expect(legacy.nodes[0]).toMatchObject({ verificationDisposition: "legacy_unverified" })
    expect(legacy.nodes[0]).not.toHaveProperty("verification")
    expect(canonicalTaskGraphJson(legacy)).toContain('"verificationDisposition":"legacy_unverified"')
    expect(parseTaskGraphSnapshot(snapshotWithNodes([{
      ...storedNode("old-writer"), templateId: "cover_letter_writer",
    }])).nodes[0]).toMatchObject({ verificationDisposition: "legacy_unverified" })

    const resumed = taskGraphState(legacy, 1, new Map([["task-old", { status: "queued", failureReason: null }]]), [])
    const rewritten = taskGraphSnapshot(resumed, new Map([["old", "task-old"]]))
    expect(rewritten.nodes[0]).toMatchObject({ verificationDisposition: "legacy_unverified" })
    expect(rewritten.nodes[0]).not.toHaveProperty("verification")
  })

  it("keeps a previously persisted full typed graph readable after first-repair capacity closes", () => {
    const fullTyped = snapshotWithNodes(Array.from({ length: 8 }, (_, index) => ({
      ...storedNode(`historical-${index + 1}`, index === 0 ? [] : [`historical-${index}`]),
      templateId: "analyst",
      verification: analystVerification,
      verificationDisposition: "typed",
    })))
    const parsed = parseTaskGraphSnapshot(fullTyped)
    const persistedAgain = parseTaskGraphSnapshot(canonicalTaskGraphJson(parsed))
    const current = taskGraphState(parsed, 8, new Map(parsed.nodes.map(node => [node.taskId, {
      status: "completed" as const,
      failureReason: null,
    }])), [])

    expect(parsed.nodes).toHaveLength(TASK_GRAPH_LIMITS.maxNodes)
    expect(parsed.nodes.every(node => node.verificationDisposition === "typed")).toBe(true)
    expect(persistedAgain).toEqual(parsed)
    expect(current.nodes).toHaveLength(TASK_GRAPH_LIMITS.maxNodes)
    expect(current.nodes.map(node => node.key)).toEqual(Array.from({ length: 8 }, (_, index) => `historical-${index + 1}`))
    expect(current.nodes.map(node => node.dependsOn)).toEqual([
      [], ...Array.from({ length: 7 }, (_, index) => [`historical-${index + 1}`]),
    ])
    expect(current.nodes.every(node => node.status === "completed" && node.verificationDisposition === "typed")).toBe(true)
  })

  it("round-trips a persisted scheduled graph with eleven nodes while rejecting a twelfth", () => {
    const scouts = Array.from({ length: 4 }, (_, index) => storedNode(`scout-${index + 1}`))
    const analyst = { ...storedNode("analyst", scouts.map(node => node.key)), templateId: "analyst", depth: 2 }
    const prepare = { ...storedNode("prepare", ["analyst"]), templateId: "prepare", depth: 3, verificationDisposition: "specialized" }
    const gate = { ...storedNode("gate", ["prepare"]), templateId: "gate", depth: 4, verificationDisposition: "specialized" }
    const executes = Array.from({ length: 3 }, (_, index) => ({ ...storedNode(`execute-${index + 1}`, ["gate"]),
      templateId: "scheduled.application.execute", packageRefs: [`job-${index + 1}`], depth: 5, verificationDisposition: "specialized" }))
    const audit = { ...storedNode("scheduled.post_gate_audit", executes.map(node => node.key)), templateId: "scheduled.post_gate_audit",
      depth: 6, verificationDisposition: "specialized" }
    const nodes = [...scouts, analyst, prepare, gate, ...executes, audit]
    const parsed = parseTaskGraphSnapshot(snapshotWithNodes(nodes))
    const current = taskGraphState(parsed, 11, new Map(parsed.nodes.map(node => [node.taskId, {
      status: "completed" as const, failureReason: null,
    }])), [])
    expect(parsed.nodes).toHaveLength(TASK_GRAPH_LIMITS.maxPersistedNodes)
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(parsed))).toEqual(parsed)
    expect(current.nodes).toHaveLength(TASK_GRAPH_LIMITS.maxPersistedNodes)
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([...nodes, storedNode("scheduled-overflow")]))).toThrow("task_graph_snapshot_invalid")
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes(Array.from({ length: TASK_GRAPH_LIMITS.maxNodes + 1 }, (_, index) => storedNode(`generic-${index}`)))))
      .toThrow("task_graph_snapshot_capacity_invalid")
  })

  it("preserves typed packageRefs only on specialized scheduled Execute nodes", () => {
    const nodes = scheduledPostGateNodes()
    const executeNode = nodes[5]!
    const parsed = parseTaskGraphSnapshot(snapshotWithNodes(nodes))
    const statuses = new Map(nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }]))
    const taskIds = new Map(nodes.map(node => [node.key, node.taskId]))
    const state = taskGraphState(parsed, 1, statuses, [])
    const written = taskGraphSnapshot(state, taskIds)
    expect(parsed.nodes[5]?.packageRefs).toEqual(["job-1", "job-2"])
    expect(written.nodes[5]?.packageRefs).toEqual(["job-1", "job-2"])
    for (const invalid of [
      { ...executeNode, templateId: "scout" },
      { ...executeNode, packageRefs: ["job-1", "job-1"] },
      { ...executeNode, packageRefs: [" job-1"] },
      { ...executeNode, verificationDisposition: "legacy_unverified" },
      { ...executeNode, packageRefs: undefined },
    ]) {
      expect(() => parseTaskGraphSnapshot(snapshotWithNodes([...nodes.slice(0, 5), invalid, nodes[6]]))).toThrow()
    }
    const missingRefs = { ...executeNode }
    Reflect.deleteProperty(missingRefs, "packageRefs")
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([...nodes.slice(0, 5), missingRefs, nodes[6]]))).toThrow()
  })

  it("strictly round-trips a registered Scout envelope while keeping undeclared legacy snapshots compatible", () => {
    const typedScout = {
      ...storedNode("registered-scout"), verification: scoutVerification, verificationDisposition: "typed",
      registeredScoutEnvelope,
    }
    const snapshot = parseTaskGraphSnapshot(snapshotWithNodes([typedScout]))
    expect(snapshot.nodes[0]?.registeredScoutEnvelope).toEqual(registeredScoutEnvelope)
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(snapshot))).toEqual(snapshot)

    const legacy = parseTaskGraphSnapshot(snapshotWithNodes([storedNode("legacy-scout")]))
    expect(legacy.nodes[0]).not.toHaveProperty("registeredScoutEnvelope")

    const inheritedActions = parseTaskGraphSnapshot(snapshotWithNodes([{
      ...typedScout, registeredScoutEnvelope: { ...registeredScoutEnvelope, allowedActions: [] },
    }]))
    expect(inheritedActions.nodes[0]?.registeredScoutEnvelope).toEqual({ ...registeredScoutEnvelope, allowedActions: [] })

    const sparseActions = new Array<string>(1)
    const malformed = [
      { ...registeredScoutEnvelope, role: "analyst" },
      { ...registeredScoutEnvelope, taskType: " " },
      { ...registeredScoutEnvelope, expectedOutputSchema: { ...registeredScoutEnvelope.expectedOutputSchema, schemaVersion: "other" } },
      { ...registeredScoutEnvelope, unexpected: true },
      { ...registeredScoutEnvelope, allowedActions: sparseActions },
      { ...registeredScoutEnvelope, allowedActions: Object.assign(["jobs.search"], { extra: true }) },
    ]
    for (const envelope of malformed) {
      expect(() => parseTaskGraphSnapshot(snapshotWithNodes([{ ...typedScout, registeredScoutEnvelope: envelope }]))).toThrow()
    }
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([{
      ...typedScout, templateId: "analyst", verification: analystVerification,
    }]))).toThrow()
  })

  it("requires a named findings source to be a direct typed registered Scout in the same snapshot", () => {
    const check = { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-source" }
    const scout = { ...storedNode("scout-source"), verification: scoutVerification, verificationDisposition: "typed" }
    const analyst = {
      ...storedNode("analyst", ["scout-source"]), templateId: "analyst",
      verification: { ...analystVerification, criteria: [{ id: "in-scout", check }] }, verificationDisposition: "typed",
    }
    expect(parseTaskGraphSnapshot(snapshotWithNodes([scout, analyst])).nodes[1]).toMatchObject({ key: "analyst" })

    const middle = { ...storedNode("middle", ["scout-source"]), templateId: "analyst", verification: analystVerification, verificationDisposition: "typed" }
    const legacyScout = { ...storedNode("scout-source"), verificationDisposition: "legacy_unverified" }
    for (const nodes of [
      [scout, { ...analyst, dependsOn: ["middle"] }, middle],
      [legacyScout, analyst],
      [{ ...scout, templateId: "analyst", verification: analystVerification }, analyst],
    ]) {
      expect(() => parseTaskGraphSnapshot(snapshotWithNodes(nodes))).toThrow("task_graph_snapshot_verification_dependency_invalid")
    }
  })

  it("rejects conflicting or invalid verification dispositions instead of upgrading legacy nodes", () => {
    const base = storedNode("node-1")
    for (const node of [
      { ...base, verificationDisposition: "typed" },
      { ...base, verificationDisposition: "legacy_unverified", verification: analystVerification },
      { ...base, verificationDisposition: "specialized" },
      { ...base, verification: analystVerification, verificationDisposition: "typed" },
      { ...base, verificationDisposition: "unknown" },
    ]) {
      expect(() => parseTaskGraphSnapshot(snapshotWithNodes([node]))).toThrow()
    }
  })

  it("round-trips unsupported legacy templates but limits new specialized nodes to registered templates", () => {
    const unknownLegacy = storedNode("old-custom")
    unknownLegacy.templateId = "custom_agent"
    const legacySnapshot = parseTaskGraphSnapshot(snapshotWithNodes([unknownLegacy]))
    expect(legacySnapshot.nodes[0]).toMatchObject({ templateId: "custom_agent", verificationDisposition: "legacy_unverified" })
    const restoredState = taskGraphState(legacySnapshot, 1, new Map([["task-old-custom", { status: "queued", failureReason: null }]]), [])
    const rewritten = taskGraphSnapshot(restoredState, new Map([["old-custom", "task-old-custom"]]))
    expect(rewritten.nodes[0]).toMatchObject({ templateId: "custom_agent", verificationDisposition: "legacy_unverified" })
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(rewritten))).toEqual(rewritten)
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([{
      ...unknownLegacy, verificationDisposition: "specialized",
    }]))).toThrow("task_graph_snapshot_verification_disposition_invalid")

    const state: TaskGraphState = {
      revision: 1,
      nodes: [{
        key: "custom", templateId: "custom_agent", goal: "Do custom work",
        successCriteria: ["Complete custom work"], dependsOn: [], depth: 1, status: "queued",
      }],
      appliedEvents: [],
    }
    expect(() => taskGraphSnapshot(state, new Map([["custom", "task-custom"]])))
      .toThrow("task_graph_snapshot_template_unsupported")
  })

  it("keeps Writer, Reviewer, Prepare, and fixed Audit templates on specialized verification paths", () => {
    const state: TaskGraphState = {
      revision: 1,
      nodes: [{
        key: "writer", templateId: "cover_letter_writer", goal: "Create a draft",
        successCriteria: ["Persist draft"], dependsOn: [], depth: 1, status: "queued",
      }, {
        key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the draft",
        successCriteria: ["Persist review"], dependsOn: ["writer"], depth: 2, status: "queued",
      }, {
        key: "prepare", templateId: "prepare", goal: "Prepare scheduled materials",
        successCriteria: ["Persist safe artifact references"], dependsOn: [], depth: 1, status: "queued",
      }, {
        key: "gate", templateId: "gate", goal: "Authorize scheduled apply",
        successCriteria: ["Approve safe applications"], dependsOn: ["prepare"], depth: 4, status: "queued",
      }, {
        key: "scheduled_audit", templateId: "scheduled_audit", goal: "Run fixed scheduled Audit",
        successCriteria: ["Return exact report"], dependsOn: ["gate"], depth: 5, status: "queued",
      }],
      appliedEvents: [],
    }
    const snapshot = taskGraphSnapshot(state, new Map([["writer", "task-writer"], ["reviewer", "task-reviewer"], ["prepare", "task-prepare"],
      ["gate", "task-gate"], ["scheduled_audit", "task-audit"]]))

    expect(snapshot.nodes).toMatchObject([
      { key: "writer", verificationDisposition: "specialized" },
      { key: "reviewer", verificationDisposition: "specialized" },
      { key: "prepare", verificationDisposition: "specialized" },
      { key: "gate", verificationDisposition: "specialized" },
      { key: "scheduled_audit", verificationDisposition: "specialized" },
    ])
    expect(snapshot.nodes.every(node => !Object.hasOwn(node, "verification"))).toBe(true)
    expect(parseTaskGraphSnapshot(snapshot)).toEqual(snapshot)
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([{
      ...storedNode("invalid-prepare"), templateId: "prepare", verification: analystVerification, verificationDisposition: "typed",
    }]))).toThrow("task_graph_snapshot_verification_invalid")
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([{
      ...storedNode("invalid-audit"), templateId: "scheduled_audit", verification: analystVerification, verificationDisposition: "typed",
    }]))).toThrow("task_graph_snapshot_verification_invalid")
  })

  it("round-trips repair lineage without rewriting its target or marking it passed", () => {
    const target = {
      ...storedNode("target"), verification: scoutVerification, verificationDisposition: "typed", registeredScoutEnvelope,
    }
    const repairOf = { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["candidate-count"] }
    const repair = {
      ...storedNode("repair"), verification: { ...scoutVerification, criteria: [scoutVerification.criteria[0]] },
      verificationDisposition: "typed", repairOf, registeredScoutEnvelope,
    }
    const snapshot = parseTaskGraphSnapshot(snapshotWithNodes([target, repair]))
    expect(snapshot.nodes[0]).toMatchObject({ verification: scoutVerification, verificationDisposition: "typed" })
    expect(snapshot.nodes[0]?.registeredScoutEnvelope).toEqual(registeredScoutEnvelope)
    expect(snapshot.nodes[0]).not.toHaveProperty("repairOf")
    expect(snapshot.nodes[1]?.repairOf).toEqual(repairOf)
    expect(snapshot.nodes[1]).not.toHaveProperty("verdict")
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(snapshot))).toEqual(snapshot)

    const state = taskGraphState(snapshot, 1, new Map([
      ["task-target", { status: "completed", failureReason: null }],
      ["task-repair", { status: "queued", failureReason: null }],
    ]), [])
    expect(state.nodes[0]?.taskId).toBe("task-target")
    expect(taskGraphSnapshot(state, new Map([ ["target", "task-target"], ["repair", "task-repair"] ]))).toEqual(snapshot)
    expect(taskGraphSnapshot(state, new Map([ ["target", "task-target"], ["repair", "task-repair"] ])).nodes[0]?.registeredScoutEnvelope).toEqual(registeredScoutEnvelope)
  })

  it("rejects stale, future, mismatched, dependent, or untyped repair targets", () => {
    const target = { ...storedNode("target"), verification: scoutVerification, verificationDisposition: "typed" }
    const relation = { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["candidate-count"] }
    const repair = {
      ...storedNode("repair"), verification: { ...scoutVerification, criteria: [scoutVerification.criteria[0]] },
      verificationDisposition: "typed", repairOf: relation,
    }
    const legacyTarget = { ...storedNode("target"), verificationDisposition: "legacy_unverified" }
    const invalid = [
      [target, { ...repair, repairOf: { ...relation, taskId: "stale-task" } }],
      [{ ...repair, key: "repair" }, target],
      [target, { ...repair, repairOf: { ...relation, nodeKey: "missing" } }],
      [target, { ...repair, repairOf: { ...relation, criterionIds: ["missing"] } }],
      [target, { ...repair, verification: { ...repair.verification, criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }] } }],
      [target, { ...repair, verification: scoutVerification }],
      [target, { ...repair, templateId: "analyst", verification: analystVerification }],
      [target, { ...repair, dependsOn: ["target"] }],
      [legacyTarget, repair],
      [target, { ...repair, repairOf: { ...relation, criterionIds: ["candidate-count", "candidate-count"] } }],
      [target, { ...repair, repairOf: { ...relation, graphRootTaskId: " " } }],
    ]
    for (const nodes of invalid) expect(() => parseTaskGraphSnapshot(snapshotWithNodes(nodes))).toThrow()
  })

  it("requires persisted location-aware repairs to preserve the exact inherited target guard", () => {
    const targetVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout",
      criteria: [
        { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
        { id: "candidate-location", check: { kind: "candidate_location_in", locations: ["Dublin", "Berlin"] } },
      ],
    } as const
    const relation = { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["candidate-count"] }
    const target = { ...storedNode("target"), verification: targetVerification, verificationDisposition: "typed" }
    const exactRepair = { ...storedNode("repair"), verification: targetVerification, verificationDisposition: "typed", repairOf: relation }
    const persisted = parseTaskGraphSnapshot(snapshotWithNodes([target, exactRepair]))
    expect(parseTaskGraphSnapshot(canonicalTaskGraphJson(persisted))).toEqual(persisted)
    expect(persisted.nodes[1]?.repairOf?.criterionIds).toEqual(["candidate-count"])
    expect(persisted.nodes[1]?.verification?.criteria.map(item => item.id)).toEqual(["candidate-count", "candidate-location"])
    expect(parseTaskGraphSnapshot(snapshotWithNodes([target, { ...exactRepair,
      verification: { ...targetVerification, criteria: [targetVerification.criteria[1]] },
      repairOf: { ...relation, criterionIds: ["candidate-location"] },
    }])).nodes[1]?.repairOf?.criterionIds).toEqual(["candidate-location"])
    expect(parseTaskGraphSnapshot(snapshotWithNodes([target, { ...exactRepair,
      repairOf: { ...relation, criterionIds: ["candidate-count", "candidate-location"] },
    }])).nodes[1]?.repairOf?.criterionIds).toEqual(["candidate-count", "candidate-location"])

    const invalidRepairs = [
      { ...exactRepair, verification: { ...targetVerification, criteria: [targetVerification.criteria[0]] } },
      { ...exactRepair, verification: { ...targetVerification, criteria: [targetVerification.criteria[0], {
        id: "candidate-location", check: { kind: "candidate_location_in", locations: ["Dublin"] },
      }] } },
      { ...exactRepair, verification: { ...targetVerification, criteria: [...targetVerification.criteria, {
        id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 },
      }] } },
    ]
    for (const repair of invalidRepairs) expect(() => parseTaskGraphSnapshot(snapshotWithNodes([target, repair]))).toThrow()
  })

  it("rejects sparse arrays and arrays with extra own properties", () => {
    const sparseSuccessCriteria = new Array<string>(1)
    const sparseDependencies = new Array<string>(1)
    const extraStringProperty = Object.assign(["Evidence found"], { extra: "unexpected" })
    const extraSymbolProperty = ["node-1"]
    Object.defineProperty(extraSymbolProperty, Symbol("extra"), { value: "unexpected" })

    for (const [successCriteria, dependsOn] of [
      [sparseSuccessCriteria, []],
      [["Evidence found"], sparseDependencies],
      [extraStringProperty, []],
      [["Evidence found"], extraSymbolProperty],
    ]) {
      expect(() => parseTaskGraphSnapshot(snapshotWithLists(successCriteria, dependsOn))).toThrow("task_graph_snapshot_invalid")
    }
  })

  it("rejects duplicate dependency keys", () => {
    const nodes = [storedNode("node-1", ["node-2", "node-2"]), storedNode("node-2")]

    expect(() => parseTaskGraphSnapshot(snapshotWithNodes(nodes))).toThrow("task_graph_snapshot_dependency_invalid")
  })

  it("rejects dependency cycles", () => {
    const nodes = [storedNode("node-1", ["node-2"]), storedNode("node-2", ["node-1"])]

    expect(() => parseTaskGraphSnapshot(snapshotWithNodes(nodes))).toThrow("task_graph_snapshot_cycle_invalid")
  })

  it("rejects unexpected snapshot and node keys and malformed JSON", () => {
    const valid = snapshotWithNodes([storedNode("node-1")])

    expect(() => parseTaskGraphSnapshot({ ...valid, unexpected: true })).toThrow("task_graph_snapshot_invalid")
    expect(() => parseTaskGraphSnapshot(snapshotWithNodes([{ ...storedNode("node-1"), unexpected: true }]))).toThrow("task_graph_snapshot_invalid")
    expect(() => parseTaskGraphSnapshot("{broken json")).toThrow("task_graph_snapshot_invalid")
  })

  it("enforces persisted node, text, list, and depth limits", () => {
    const base = storedNode("node-1")
    const oversizedNodes = Array.from({ length: 9 }, (_, index) => storedNode(`node-${index}`))
    const oversizedCriteria = Array.from({ length: 9 }, () => "criterion")
    const oversizedDependencies = Array.from({ length: 9 }, (_, index) => `node-${index}`)

    expect(() => parseTaskGraphSnapshot(snapshotWithNodes(oversizedNodes))).toThrow("task_graph_snapshot_capacity_invalid")
    for (const snapshot of [
      snapshotWithNodes([{ ...base, key: "k".repeat(129) }]),
      snapshotWithNodes([{ ...base, templateId: "t".repeat(129) }]),
      snapshotWithNodes([{ ...base, taskId: "t".repeat(129) }]),
      snapshotWithNodes([{ ...base, goal: "g".repeat(1201) }]),
      snapshotWithNodes([{ ...base, successCriteria: oversizedCriteria }]),
      snapshotWithNodes([{ ...base, successCriteria: ["c".repeat(321)] }]),
      snapshotWithNodes([{ ...base, dependsOn: oversizedDependencies }]),
      snapshotWithNodes([{ ...base, dependsOn: ["d".repeat(129)] }]),
      snapshotWithNodes([{ ...base, depth: 9 }]),
    ]) {
      expect(() => parseTaskGraphSnapshot(snapshot)).toThrow("task_graph_snapshot_invalid")
    }
  })

  it("measures the persisted snapshot cap in UTF-8 bytes of canonical JSON", () => {
    const ascii = boundedEightNodeSnapshot(false)
    const unicode = boundedEightNodeSnapshot(true)
    const asciiBytes = Buffer.byteLength(canonicalTaskGraphJson(ascii), "utf8")
    const unicodeBytes = Buffer.byteLength(canonicalTaskGraphJson(unicode), "utf8")

    expect(asciiBytes).toBeLessThanOrEqual(TASK_GRAPH_LIMITS.maxSnapshotBytes)
    expect(unicodeBytes).toBeGreaterThan(TASK_GRAPH_LIMITS.maxSnapshotBytes)
    expect(() => parseTaskGraphSnapshot(ascii)).not.toThrow()
    expect(() => parseTaskGraphSnapshot(unicode)).toThrow("task_graph_snapshot_too_large")
  })

  it("applies the snapshot byte cap when building the persistence representation", () => {
    const keys = Array.from({ length: 8 }, (_, index) => `${"k".repeat(127)}${index}`)
    const state: TaskGraphState = {
      revision: 1,
      nodes: keys.map((key, index) => ({
        key,
        templateId: "scout",
        goal: "😀".repeat(600),
        successCriteria: Array.from({ length: 8 }, () => "😀".repeat(160)),
        dependsOn: keys.slice(0, index),
        depth: index + 1,
        status: "queued",
      })),
      appliedEvents: [],
    }
    const taskIds = new Map(state.nodes.map((node, index) => [node.key, `task-${index}`] as const))

    expect(() => taskGraphSnapshot(state, taskIds)).toThrow("task_graph_snapshot_too_large")
  })
})
