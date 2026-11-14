import { describe, expect, it } from "vitest"

import {
  appendScheduledPostGateTaskGraphProposal,
  appendTaskGraphProposal,
  createInitialTaskGraphState,
  deriveReadyTaskGraphNodes,
  deriveTaskGraphReadModel,
  reduceTaskGraphEvent,
  validateTaskGraphProposal,
  TASK_GRAPH_LIMITS,
  type TaskGraphNodeProposal,
  type TaskGraphNodeStatus,
  type TaskGraphState,
  type TaskGraphValidationOptions,
} from "./task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "./task-graph-verification.js"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "../subagents/task-graph-child-deadline.js"

const options: TaskGraphValidationOptions = {
  registeredTemplateIds: new Set(["scout", "analyst", "writer"]), maxNodes: 8, maxDepth: 4,
}
function node(key: string, overrides: Partial<TaskGraphNodeProposal> = {}): TaskGraphNodeProposal {
  const templateId = overrides.templateId ?? "scout"
  const role = templateId === "analyst" ? "analyst" : "scout"
  const defaultVerification: TaskGraphNodeProposal["verification"] = templateId === "writer" ? undefined : {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role,
    criteria: [{ id: "minimum-results", check: { kind: role === "scout" ? "candidate_count_gte" : "finding_count_gte", minimum: 1 } }],
  }
  return {
    key, templateId, goal: `Research ${key}`, successCriteria: [`Evidence for ${key}`], dependsOn: [],
    ...(defaultVerification ? { verification: defaultVerification } : {}), ...overrides,
  }
}
function append(state: TaskGraphState, nodes: readonly TaskGraphNodeProposal[], limits = options): TaskGraphState {
  const result = appendTaskGraphProposal(state, { expectedRevision: state.revision, nodes }, limits)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.state
}
function event(state: TaskGraphState, type: string, nodeKey: string, idempotencyKey: string, extra: Record<string, unknown> = {}) {
  return reduceTaskGraphEvent(state, { type, nodeKey, idempotencyKey, expectedRevision: state.revision, ...extra })
}
function transition(state: TaskGraphState, type: string, nodeKey: string, idempotencyKey: string, extra: Record<string, unknown> = {}): TaskGraphState {
  const result = event(state, type, nodeKey, idempotencyKey, extra)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.state
}
function withNodeStatus(state: TaskGraphState, key: string, status: TaskGraphNodeStatus): TaskGraphState {
  return { ...state, nodes: state.nodes.map(item => item.key === key ? { ...item, status } : item) }
}
function stateAtStatus(status: TaskGraphNodeStatus): TaskGraphState {
  let state = append(createInitialTaskGraphState(), [node("a")])
  if (status === "queued") return state
  if (status === "interrupted" || status === "cancelled") return transition(state, `task.${status}`, "a", `set-${status}`)
  if (status === "closed") return transition(state, "task.closed", "a", "set-closed")
  if (status === "retrying") return withNodeStatus(state, "a", "retrying")
  state = transition(state, "task.started", "a", "set-running")
  if (status === "running") return state
  if (status === "waiting") return transition(state, "task.waiting", "a", "set-waiting")
  if (status === "waiting_for_user") return transition(state, "task.waiting_for_user", "a", "set-waiting-for-user")
  if (status === "completed") return transition(state, "task.completed", "a", "set-completed")
  if (status === "failed") return transition(state, "task.failed", "a", "set-failed", { failureReason: "failed" })
  throw new Error(`Unsupported test status: ${status}`)
}

describe("TaskGraph planning kernel", () => {
  it.each(["queued", "retrying", "waiting", "waiting_for_user"] as const)("accepts the internal deadline failure from %s only", status => {
    const state = stateAtStatus(status)
    expect(event(state, "task.failed", "a", `deadline-${status}`, { failureReason: TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON })).toMatchObject({ ok: true })
    expect(event(state, "task.failed", "a", `worker-${status}`, { failureReason: "worker failed" })).toMatchObject({ ok: false, error: { code: "invalid_transition" } })
  })
  it("rejects malformed exact-shape proposals and unregistered templates", () => {
    const state = createInitialTaskGraphState()
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a")], extra: true }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [{ ...node("a"), extra: true }] }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    const proposalWithServerMetadata: TaskGraphNodeProposal = {
      ...node("server-metadata"),
      // @ts-expect-error verificationDisposition is runtime-owned and excluded from model proposals
      verificationDisposition: "legacy_unverified",
    }
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [proposalWithServerMetadata] }, state, options))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a", { successCriteria: [] })] }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a", { templateId: "unregistered" })] }, state, options)).toMatchObject({ ok: false, error: { code: "unknown_template" } })
    expect(event(state, "toString", "a", "prototype-event")).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
  })

  it("requires typed verification for Scout and Analyst while preserving writer-specific gates", () => {
    const state = createInitialTaskGraphState()
    const scout = node("scout")
    const { verification: _scoutVerification, ...scoutWithoutVerification } = scout
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [scoutWithoutVerification] }, state, options))
      .toMatchObject({ ok: false, error: { code: "verification_required", path: "nodes[0].verification" } })

    const analyst = node("analyst", { templateId: "analyst" })
    const { verification: _analystVerification, ...analystWithoutVerification } = analyst
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [analystWithoutVerification] }, state, options))
      .toMatchObject({ ok: false, error: { code: "verification_required" } })
    const acceptedAnalyst = validateTaskGraphProposal({ expectedRevision: 0, nodes: [analyst] }, state, options)
    expect(acceptedAnalyst).toMatchObject({ ok: true, addedNodes: [{ verification: analyst.verification }] })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("writer", { templateId: "writer" })] }, state, options))
      .toMatchObject({ ok: true, addedNodes: [{ templateId: "writer" }] })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("mismatch", {
      templateId: "scout", verification: { ...analyst.verification!, role: "analyst" },
    })] }, state, options)).toMatchObject({ ok: false, error: { code: "verification_invalid" } })
  })

  it("accepts only exact typed repairs of prior same-role criteria without a dependency edge", () => {
    const targetVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [
        { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
        { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
      ],
    } as const
    const target = node("target", { verification: targetVerification })
    const state: TaskGraphState = {
      revision: 1, nodes: [{ ...target, depth: 1, status: "completed", taskId: "task-target", verificationDisposition: "typed" }], appliedEvents: [],
    }
    const repairOf = { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["candidate-count"] }
    const repair = node("repair", { verification: { ...targetVerification, criteria: [targetVerification.criteria[0]] }, repairOf })
    expect(validateTaskGraphProposal({ expectedRevision: 1, nodes: [repair] }, state, options))
      .toMatchObject({ ok: true, proposal: { nodes: [{ repairOf }] } })

    const invalidNodes = [
      node("missing-target", { verification: repair.verification, repairOf: { ...repairOf, nodeKey: "missing" } }),
      node("stale-target", { verification: repair.verification, repairOf: { ...repairOf, taskId: "stale-task" } }),
      node("wrong-criteria", { verification: repair.verification, repairOf: { ...repairOf, criterionIds: ["missing"] } }),
      node("wrong-check", { verification: { ...repair.verification!, criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }] }, repairOf }),
      node("extra-criteria", { verification: targetVerification, repairOf }),
      node("target-edge", { verification: repair.verification, repairOf, dependsOn: ["target"] }),
      node("wrong-role", { templateId: "analyst", verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
        criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
      }, repairOf }),
    ]
    for (const invalid of invalidNodes) {
      expect(validateTaskGraphProposal({ expectedRevision: 1, nodes: [invalid] }, state, options))
        .toMatchObject({ ok: false, error: { code: "repair_invalid" } })
    }
    const legacyState = { ...state, nodes: state.nodes.map(item => ({ ...item, verificationDisposition: "legacy_unverified" as const })) }
    expect(validateTaskGraphProposal({ expectedRevision: 1, nodes: [repair] }, legacyState, options))
      .toMatchObject({ ok: false, error: { code: "repair_invalid" } })
    const specializedState = { ...state, nodes: state.nodes.map(item => ({ ...item, verificationDisposition: "specialized" as const })) }
    expect(validateTaskGraphProposal({ expectedRevision: 1, nodes: [repair] }, specializedState, options))
      .toMatchObject({ ok: false, error: { code: "repair_invalid" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [target, repair] }, createInitialTaskGraphState(), options))
      .toMatchObject({ ok: false, error: { code: "repair_invalid" } })
  })

  it("requires location-aware repairs to carry the exact target location invariant", () => {
    const verification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout",
      criteria: [
        { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
        { id: "candidate-location", check: { kind: "candidate_location_in", locations: ["Dublin", "Berlin"] } },
      ],
    } as const
    const target = node("target", { verification })
    const state: TaskGraphState = {
      revision: 1, nodes: [{ ...target, depth: 1, status: "failed", taskId: "task-target", verificationDisposition: "typed" }], appliedEvents: [],
    }
    const relation = { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["candidate-count"] }
    const makeRepair = (criteria: readonly NonNullable<TaskGraphNodeProposal["verification"]>["criteria"][number][], criterionIds = relation.criterionIds) =>
      node("repair", { verification: { ...verification, criteria }, repairOf: { ...relation, criterionIds } })
    const count = verification.criteria[0]
    const location = verification.criteria[1]

    expect(validateTaskGraphProposal({ expectedRevision: 1, nodes: [makeRepair([count, location])] }, state, options))
      .toMatchObject({ ok: true, addedNodes: [{ repairOf: relation, verification: { criteria: [count, {
        id: "candidate-location", check: { kind: "candidate_location_in", locations: ["berlin", "dublin"] },
      }] } }] })
    expect(validateTaskGraphProposal({ expectedRevision: 1, nodes: [makeRepair([location], ["candidate-location"])] }, state, options))
      .toMatchObject({ ok: true })
    expect(validateTaskGraphProposal({ expectedRevision: 1, nodes: [makeRepair([count, location], ["candidate-count", "candidate-location"])] }, state, options))
      .toMatchObject({ ok: true })

    const invalid = [
      makeRepair([count]),
      makeRepair([count, { ...location, check: { kind: "candidate_location_in", locations: ["Dublin"] } }]),
      makeRepair([count, location, { id: "extra", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } }]),
    ]
    for (const repair of invalid) {
      expect(validateTaskGraphProposal({ expectedRevision: 1, nodes: [repair] }, state, options))
        .toMatchObject({ ok: false, error: { code: "repair_invalid" } })
    }
  })

  it("requires exact non-empty repairOf shape and unique criterion IDs", () => {
    const state = createInitialTaskGraphState()
    for (const repairOf of [
      { graphRootTaskId: " ", nodeKey: "target", taskId: "task-target", criterionIds: ["criterion"] },
      { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["criterion", "criterion"] },
      { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: [] },
      { graphRootTaskId: "root-task", nodeKey: "target", taskId: "task-target", criterionIds: ["criterion"], extra: true },
    ]) {
      expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("repair", { repairOf })] }, state, options))
        .toMatchObject({ ok: false, error: { code: "invalid_shape", path: "nodes[0].repairOf" } })
    }
  })

  it("rejects duplicate keys, missing dependencies, cycles, and caller bounds", () => {
    const state = createInitialTaskGraphState()
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a"), node("a")] }, state, options)).toMatchObject({ ok: false, error: { code: "duplicate_key" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a", { dependsOn: ["missing"] })] }, state, options)).toMatchObject({ ok: false, error: { code: "missing_dependency" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("sparse-criteria", { successCriteria: new Array<string>(1) })] }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape", path: "nodes[0].successCriteria" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("sparse-dependencies", { dependsOn: new Array<string>(1) })] }, state, options)).toMatchObject({ ok: false, error: { code: "invalid_shape", path: "nodes[0].dependsOn" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a", { dependsOn: ["b"] }), node("b", { dependsOn: ["a"] })] }, state, options)).toMatchObject({ ok: false, error: { code: "dependency_cycle" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a"), node("b"), node("c")] }, state, { ...options, maxNodes: 2 })).toMatchObject({ ok: false, error: { code: "node_limit" } })
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [node("a"), node("b", { dependsOn: ["a"] })] }, state, { ...options, maxDepth: 1 })).toMatchObject({ ok: false, error: { code: "depth_limit" } })
    const forward = append(state, [node("child", { dependsOn: ["parent"] }), node("parent")])
    expect(forward.nodes.map(item => [item.key, item.depth])).toEqual([["child", 2], ["parent", 1]])
    expect(deriveReadyTaskGraphNodes(forward).map(item => item.key)).toEqual(["parent"])
  })

  it("requires unique typed package references only on scheduled Execute proposals", () => {
    const executeTemplate = "scheduled.application.execute"
    const execute = { key: "execute-1", templateId: executeTemplate, goal: "Prepare approved jobs",
      successCriteria: ["Each approved package was prepared"], dependsOn: [], packageRefs: ["job-1"] }
    const scheduledOptions = { ...options, registeredTemplateIds: new Set([...options.registeredTemplateIds, executeTemplate]) }
    const valid = validateTaskGraphProposal({ expectedRevision: 0, nodes: [execute] }, createInitialTaskGraphState(), scheduledOptions)
    expect(valid).toMatchObject({ ok: true, proposal: { nodes: [{ packageRefs: ["job-1"] }] }, addedNodes: [{ packageRefs: ["job-1"] }] })
    for (const invalid of [
      { ...execute, packageRefs: ["job-1", "job-1"] },
      { ...execute, packageRefs: [" job-1"] },
      { ...execute, packageRefs: Array.from({ length: TASK_GRAPH_LIMITS.maxScheduledPackageRefs + 1 }, (_, index) => `job-${index}`) },
      { ...execute, packageRefs: undefined },
      { ...execute, templateId: "writer" },
    ]) {
      expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [invalid] }, createInitialTaskGraphState(), scheduledOptions))
        .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    }
  })

  it("enforces canonical persisted field and graph limits even when caller bounds are looser", () => {
    const state = createInitialTaskGraphState()
    const oversizedTemplateId = "t".repeat(129)
    const looseOptions: TaskGraphValidationOptions = {
      registeredTemplateIds: new Set([...options.registeredTemplateIds, oversizedTemplateId]),
      maxNodes: 16,
      maxDepth: 16,
    }
    const invalidNodes = [
      node("long-goal", { goal: "g".repeat(1201) }),
      node("long-criterion", { successCriteria: ["c".repeat(321)] }),
      node("too-many-criteria", { successCriteria: Array.from({ length: 9 }, (_, index) => `criterion ${index}`) }),
      node("long-key", { key: "k".repeat(129) }),
      node("long-template", { templateId: oversizedTemplateId }),
    ]
    for (const invalid of invalidNodes) {
      expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: [invalid] }, state, looseOptions)).toMatchObject({
        ok: false, error: { code: "invalid_shape" },
      })
    }
    expect(validateTaskGraphProposal({ expectedRevision: 0, nodes: Array.from({ length: 9 }, (_, index) => node(`node-${index}`)) }, state, looseOptions))
      .toMatchObject({ ok: false, error: { code: "node_limit" } })
  })

  it("keeps generic append at eight while the scheduled server append adds at most four up to eleven", () => {
    const seed = append(createInitialTaskGraphState(), Array.from({ length: 7 }, (_, index) =>
      node(index === 6 ? "gate" : `seed-${index}`, { templateId: "writer" })))
    const postGateOptions = { ...options, maxNodes: TASK_GRAPH_LIMITS.maxPersistedNodes,
      registeredTemplateIds: new Set([...options.registeredTemplateIds, "scheduled.application.execute", "scheduled_audit", "scheduled.post_gate_audit"]) }
    const executeNodes = Array.from({ length: 3 }, (_, index) => ({
      key: `execute-${index + 1}`, templateId: "scheduled.application.execute", goal: `Prepare ${index + 1}`,
      successCriteria: ["Prepare only the approved packages"], dependsOn: ["gate"], packageRefs: [`job-${index + 1}`],
    }))
    const suffix: TaskGraphNodeProposal[] = [...executeNodes, {
      key: "scheduled.post_gate_audit", templateId: "scheduled.post_gate_audit", goal: "Return the fixed report",
      successCriteria: ["Return the report"], dependsOn: executeNodes.map(item => item.key),
    }]
    const scheduled = appendScheduledPostGateTaskGraphProposal(seed, { expectedRevision: seed.revision, nodes: suffix }, postGateOptions)
    expect(scheduled).toMatchObject({ ok: true, state: { nodes: { length: TASK_GRAPH_LIMITS.maxPersistedNodes } } })
    const emptyExecute = { ...executeNodes[0]!, key: "execute-empty", packageRefs: [] }
    const emptyPlan = appendScheduledPostGateTaskGraphProposal(seed, { expectedRevision: seed.revision, nodes: [emptyExecute, {
      key: "scheduled.post_gate_audit", templateId: "scheduled.post_gate_audit", goal: "Return the fixed report",
      successCriteria: ["Return the report"], dependsOn: ["execute-empty"],
    }] }, postGateOptions)
    expect(emptyPlan).toMatchObject({ ok: true })
    expect(appendScheduledPostGateTaskGraphProposal(seed, { expectedRevision: seed.revision, nodes: [
      emptyExecute, { ...executeNodes[1]!, key: "execute-nonempty" }, {
        key: "scheduled.post_gate_audit", templateId: "scheduled.post_gate_audit", goal: "Return the fixed report",
        successCriteria: ["Return the report"], dependsOn: ["execute-empty", "execute-nonempty"],
      },
    ] }, postGateOptions)).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(appendScheduledPostGateTaskGraphProposal(seed, { expectedRevision: seed.revision, nodes: [{
      key: "scheduled_audit", templateId: "scheduled_audit", goal: "Legacy fixed report",
      successCriteria: ["Return the report"], dependsOn: ["gate"],
    }] }, postGateOptions)).toMatchObject({ ok: true })

    expect(appendTaskGraphProposal(seed, { expectedRevision: seed.revision, nodes: suffix.slice(0, 2) }, postGateOptions))
      .toMatchObject({ ok: false, error: { code: "node_limit" } })
    expect(appendScheduledPostGateTaskGraphProposal(seed, { expectedRevision: seed.revision, nodes: [...suffix, {
      key: "execute-overflow", templateId: "scheduled.application.execute", goal: "Over capacity",
      successCriteria: ["No"], dependsOn: ["gate"], packageRefs: ["job-extra"],
    }] }, postGateOptions))
      .toMatchObject({ ok: false, error: { code: "node_limit" } })
    expect(appendScheduledPostGateTaskGraphProposal(seed, { expectedRevision: seed.revision, nodes: suffix.slice(0, 3) }, postGateOptions))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(appendScheduledPostGateTaskGraphProposal(seed, { expectedRevision: seed.revision, nodes: [
      executeNodes[0]!, { ...executeNodes[1]!, packageRefs: ["job-1"] },
      { key: "scheduled.post_gate_audit", templateId: "scheduled.post_gate_audit", goal: "Report", successCriteria: ["Report"], dependsOn: ["execute-1", "execute-2"] },
    ] }, postGateOptions)).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(appendScheduledPostGateTaskGraphProposal(scheduled.ok ? scheduled.state : seed,
      { expectedRevision: scheduled.ok ? scheduled.state.revision : seed.revision, nodes: [{
        key: "scheduled_audit", templateId: "scheduled_audit", goal: "Report", successCriteria: ["Report"], dependsOn: ["gate"],
      }] }, postGateOptions))
      .toMatchObject({ ok: false, error: { code: "node_limit" } })
  })

  it("derives parallel ready nodes in stable proposal order", () => {
    let state = append(createInitialTaskGraphState(), [node("z"), node("a"), node("after-z", { dependsOn: ["z"] })])
    expect(deriveReadyTaskGraphNodes(state).map(item => item.key)).toEqual(["z", "a"])
    state = transition(state, "task.started", "z", "start-z")
    state = transition(state, "task.completed", "z", "complete-z")
    expect(deriveReadyTaskGraphNodes(state).map(item => item.key)).toEqual(["a", "after-z"])
  })

  it("fences revisions, replays exact events idempotently, and rejects idempotency-key reuse", () => {
    let state = append(createInitialTaskGraphState(), [node("a")])
    expect(appendTaskGraphProposal(state, { expectedRevision: 0, nodes: [node("stale")] }, options)).toMatchObject({ ok: false, error: { code: "revision_mismatch" } })
    const start = { type: "task.started", nodeKey: "a", idempotencyKey: "event-1", expectedRevision: state.revision }
    const first = reduceTaskGraphEvent(state, start)
    expect(first).toMatchObject({ ok: true, duplicate: false })
    if (!first.ok) throw new Error(first.error.message)
    state = first.state
    const replay = reduceTaskGraphEvent(state, start)
    expect(replay).toMatchObject({ ok: true, duplicate: true })
    if (replay.ok) expect(replay.state).toBe(state)
    expect(reduceTaskGraphEvent(state, { ...start, type: "task.waiting" })).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } })
    expect(reduceTaskGraphEvent(state, { type: "task.completed", nodeKey: "a", idempotencyKey: "event-2", expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: "revision_mismatch" } })
  })

  it("keeps a prior waiting receipt exact while allowing a later wait with a fresh identity", () => {
    let state = append(createInitialTaskGraphState(), [node("a")])
    state = transition(state, "task.started", "a", "start-first")
    state = transition(state, "task.waiting", "a", "legacy-wait-key")
    state = transition(state, "task.queued", "a", "resume-first")
    state = transition(state, "task.started", "a", "start-second")

    expect(event(state, "task.waiting", "a", "legacy-wait-key")).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } })
    expect(event(state, "task.waiting", "a", "wait-row-second")).toMatchObject({ ok: true, duplicate: false, state: { revision: state.revision + 1 } })
  })

  it("resumes only the exact scheduled Gate node after an answered private choice", () => {
    const state: TaskGraphState = { revision: 12, appliedEvents: [], nodes: [
      { ...node("prepare", { templateId: "prepare" }), depth: 3, status: "completed", taskId: "prepare-task", verificationDisposition: "specialized" },
      { ...node("gate", { templateId: "gate", dependsOn: ["prepare"] }), depth: 4, status: "waiting_for_user", taskId: "gate-task", verificationDisposition: "specialized" },
    ] }
    const resumed = { type: "task.gate_choice_resumed", nodeKey: "gate", gateTaskId: "gate-task", requestAttemptCount: 3,
      resumedAttemptCount: 4, idempotencyKey: "gate-choice-resume-3", expectedRevision: 12 }
    const result = reduceTaskGraphEvent(state, resumed)
    expect(result).toMatchObject({ ok: true, duplicate: false, state: { revision: 13, nodes: [{ status: "completed" }, { status: "queued" }] } })
    expect(reduceTaskGraphEvent(state, { ...resumed, gateTaskId: "other-task" })).toMatchObject({ ok: false, error: { code: "invalid_transition" } })
    expect(reduceTaskGraphEvent(state, { ...resumed, resumedAttemptCount: 5 })).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    const ordinaryGate = { ...state, nodes: state.nodes.map(item => item.key === "gate" ? { ...item, templateId: "analyst" } : item) }
    expect(reduceTaskGraphEvent(ordinaryGate, resumed)).toMatchObject({ ok: false, error: { code: "invalid_transition" } })
    const staleGate = { ...state, nodes: state.nodes.map(item => item.key === "gate" ? { ...item, status: "waiting" as const } : item) }
    expect(reduceTaskGraphEvent(staleGate, resumed)).toMatchObject({ ok: false, error: { code: "invalid_transition" } })
  })

  it("appends without rewriting active or completed nodes", () => {
    let state = append(createInitialTaskGraphState(), [node("active"), node("done")])
    state = transition(state, "task.started", "active", "start-active")
    state = transition(state, "task.started", "done", "start-done")
    state = transition(state, "task.completed", "done", "complete-done")
    const prior = state
    expect(appendTaskGraphProposal(state, { expectedRevision: state.revision, nodes: [node("done", { goal: "rewrite" })] }, options)).toMatchObject({ ok: false, error: { code: "duplicate_key" } })
    const result = appendTaskGraphProposal(state, { expectedRevision: state.revision, nodes: [node("follow-up", { dependsOn: ["done"] })] }, options)
    expect(result).toMatchObject({ ok: true, state: { revision: state.revision + 1 } })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.state.nodes[0]).toBe(prior.nodes[0])
    expect(result.state.nodes[1]).toBe(prior.nodes[1])
    expect(result.state.nodes.slice(0, 2).map(item => [item.goal, item.status])).toEqual([["Research active", "running"], ["Research done", "completed"]])
    expect(prior.nodes).toHaveLength(2)
  })

  it("maps waiting and cancellation to Worker statuses and exposes blocked dependencies", () => {
    let state = append(createInitialTaskGraphState(), [node("root"), node("child", { dependsOn: ["root"] }), node("leaf", { dependsOn: ["child"] })])
    state = transition(state, "task.started", "root", "start-root")
    state = transition(state, "task.waiting", "root", "wait-root")
    expect(deriveTaskGraphReadModel(state).map(item => [item.key, item.status, item.readiness])).toEqual([
      ["root", "waiting", "ready"], ["child", "queued", "waiting_for_dependencies"], ["leaf", "queued", "waiting_for_dependencies"],
    ])
    state = transition(state, "task.cancelled", "root", "cancel-root")
    expect(deriveTaskGraphReadModel(state).map(item => item.readiness)).toEqual(["terminal", "blocked_dependency", "blocked_dependency"])
    expect(deriveReadyTaskGraphNodes(state)).toEqual([])
  })

  it("propagates final failure through descendants and rejects starting blocked work", () => {
    let state = append(createInitialTaskGraphState(), [node("root"), node("child", { dependsOn: ["root"] }), node("leaf", { dependsOn: ["child"] })])
    state = transition(state, "task.started", "root", "start-root")
    const failed = event(state, "task.failed", "root", "fail-root", { failureReason: "No evidence" })
    expect(failed).toMatchObject({ ok: true })
    if (!failed.ok) throw new Error(failed.error.message)
    state = failed.state
    expect(state.nodes[0]).toMatchObject({ status: "failed", failureReason: "No evidence" })
    expect(deriveTaskGraphReadModel(state).map(item => item.readiness)).toEqual(["terminal", "blocked_dependency", "blocked_dependency"])
    expect(event(state, "task.started", "leaf", "start-leaf")).toMatchObject({ ok: false, error: { code: "blocked_dependency" } })
  })

  it("derives waiting-node readiness from dependencies without dispatching waiting tasks", () => {
    const graph = append(createInitialTaskGraphState(), [node("root"), node("child", { dependsOn: ["root"] })])
    const waiting = withNodeStatus(graph, "child", "waiting")
    expect(deriveTaskGraphReadModel(waiting).map(item => [item.key, item.readiness])).toEqual([
      ["root", "ready"], ["child", "waiting_for_dependencies"],
    ])
    expect(deriveReadyTaskGraphNodes(waiting).map(item => item.key)).toEqual(["root"])
    expect(event(waiting, "task.queued", "child", "queue-too-early")).toMatchObject({ ok: false, error: { code: "dependencies_incomplete" } })

    const completedDependency = withNodeStatus(waiting, "root", "completed")
    expect(deriveTaskGraphReadModel(completedDependency).find(item => item.key === "child")?.readiness).toBe("ready")
    expect(deriveReadyTaskGraphNodes(completedDependency)).toEqual([])
    const queued = event(completedDependency, "task.queued", "child", "queue-after-dependency")
    expect(queued).toMatchObject({ ok: true, duplicate: false })
    if (!queued.ok) throw new Error(queued.error.message)
    expect(queued.state.nodes.find(item => item.key === "child")?.status).toBe("queued")
    expect(deriveReadyTaskGraphNodes(queued.state).map(item => item.key)).toEqual(["child"])

    const failedDependency = withNodeStatus(waiting, "root", "failed")
    expect(deriveTaskGraphReadModel(failedDependency).find(item => item.key === "child")?.readiness).toBe("blocked_dependency")
    expect(event(failedDependency, "task.queued", "child", "queue-after-failure")).toMatchObject({ ok: false, error: { code: "blocked_dependency" } })
  })

  it("keeps repaired prerequisites failed while allowing only receipt-derived readiness", () => {
    const graph = append(createInitialTaskGraphState(), [node("root"), node("child", { dependsOn: ["root"] })])
    const waiting = withNodeStatus(graph, "child", "waiting")
    const state: TaskGraphState = { ...withNodeStatus(waiting, "root", "failed"), repairSatisfiedNodeKeys: ["root"] }
    expect(state.nodes[0]?.status).toBe("failed")
    expect(deriveTaskGraphReadModel(state).find(item => item.key === "child")?.readiness).toBe("ready")
    const queued = event(state, "task.queued", "child", "queue-after-repair")
    expect(queued).toMatchObject({ ok: true })
    if (!queued.ok) throw new Error(queued.error.message)
    expect(queued.state.nodes[0]?.status).toBe("failed")
    expect(queued.state.repairSatisfiedNodeKeys).toEqual(["root"])
  })

  it("keeps unresolved typed failures waiting instead of terminally blocking repair", () => {
    const graph = append(createInitialTaskGraphState(), [node("root"), node("child", { dependsOn: ["root"] })])
    const waiting = withNodeStatus(graph, "child", "waiting")
    const state: TaskGraphState = { ...withNodeStatus(waiting, "root", "failed"), repairPendingNodeKeys: ["root"] }
    expect(deriveTaskGraphReadModel(state).find(item => item.key === "child")?.readiness).toBe("waiting_for_dependencies")
    expect(event(state, "task.queued", "child", "queue-before-repair")).toMatchObject({ ok: false, error: { code: "dependencies_incomplete" } })
  })

  it("records retrying tasks as queued, matching the durable Worker status", () => {
    let state = append(createInitialTaskGraphState(), [node("retry")])
    state = transition(state, "task.started", "retry", "start-retry")
    state = transition(state, "task.retrying", "retry", "retry-again")
    expect(state.nodes[0]?.status).toBe("queued")
    expect(deriveReadyTaskGraphNodes(state).map(item => item.key)).toEqual(["retry"])
  })

  it.each(["queued", "running", "retrying", "waiting", "waiting_for_user"] as const)("closes a %s task and blocks its dependents", status => {
    const initial = stateAtStatus(status)
    const withChild = append(initial, [node("child", { dependsOn: ["a"] })])
    const result = event(withChild, "task.closed", "a", `close-${status}`)
    expect(result).toMatchObject({ ok: true, duplicate: false })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.state.nodes[0]?.status).toBe("closed")
    expect(deriveTaskGraphReadModel(result.state).map(item => item.readiness)).toEqual(["terminal", "blocked_dependency"])
  })

  it.each(["completed", "failed", "interrupted", "cancelled", "closed"] as const)("rejects closing a %s terminal task", status => {
    const state = stateAtStatus(status)
    expect(event(state, "task.closed", "a", `close-terminal-${status}`)).toMatchObject({ ok: false, error: { code: "invalid_transition" } })
  })
})
