import { describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "./registry.js"
import type { ToolExecutionContext } from "./types.js"
import { createTaskGraphPlanningTool, registerTaskGraphPlanningTool } from "./planning-executors.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphCommandPort, TaskGraphScheduleReceipt, TaskGraphTaskTemplate } from "../subagents/task-graph-command-port.js"
import { resolveRootTaskVerificationRequirements } from "../context/root-task-objective.js"

const proposal = {
  expectedRevision: 0,
  nodes: [{
    key: "research", templateId: "scout", goal: "Find matching roles", successCriteria: ["Return relevant roles"], dependsOn: [],
    verification: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
    },
  }],
} as const

const receipt: TaskGraphScheduleReceipt = {
  status: "accepted",
  revision: 1,
  nodes: [{ key: "research", taskId: "child-1", status: "queued" }],
  readyTaskIds: ["child-1"],
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    scope: { userId: "runtime-user" }, sessionId: "runtime-session", turnId: "runtime-turn", stepId: "runtime-step",
    toolCallId: "server-call-1", taskId: "runtime-root", rootTaskId: "runtime-root", signal: new AbortController().signal,
    remainingTurnSteps: 2, capabilities: ["canManageChildren"], reportProgress: async () => undefined,
    ...overrides,
  }
}

function setup(templates: Readonly<Record<string, TaskGraphTaskTemplate>> = {
  scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
}, verificationRequirements: ReturnType<typeof resolveRootTaskVerificationRequirements> = { status: "absent" }) {
  let received: Parameters<TaskGraphCommandPort["appendAndSchedule"]>[0] | undefined
  let operation: Parameters<NonNullable<TaskGraphCommandPort["appendAndScheduleWithReconciliation"]>>[1] | undefined
  const appendAndSchedule = vi.fn(async (input: Parameters<TaskGraphCommandPort["appendAndSchedule"]>[0]) => { received = input; return receipt })
  const commandPort: TaskGraphCommandPort = {
    appendAndSchedule,
    appendAndScheduleWithReconciliation: vi.fn(async (input, value) => { operation = value; return appendAndSchedule(input) }),
    reconcileSteering: vi.fn(async () => ({ decision: "keep" as const, revision: 0, reconciledInputCount: 0 })),
    readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
  }
  const tool = createTaskGraphPlanningTool({
    commandPort,
    templates,
    verificationRequirements,
    turnLeaseOwner: "server-worker",
    turnLeaseVersion: 9,
    parentLeaseOwner: "server-worker",
    parentAttemptCount: () => 1,
  })
  return { tool, commandPort, getReceived: () => received, getOperation: () => operation }
}

describe("agent.plan tool executor", () => {
  it("publishes advisory deadline replacement guidance on the registered public tool", () => {
    const templates = {
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
    } as const
    const { commandPort } = setup(templates)
    const registry = new ToolRegistry([])
    registerTaskGraphPlanningTool(registry, true, {
      commandPort,
      templates,
      turnLeaseOwner: "server-worker",
      turnLeaseVersion: 9,
      parentLeaseOwner: "server-worker",
      parentAttemptCount: () => 1,
    })
    const tool = registry.list(["coordination", "canManageChildren"]).find(item => item.name === "agent.plan")

    expect(tool).toBeDefined()
    expect(tool?.description).toContain("For a server-reported resume_state_unavailable failure on a fixed typed read-only Scout or Analyst")
    expect(tool?.description).toContain("For a server-reported execution_deadline_exceeded cue for an eligible started typed Scout or Analyst, you may make the same explicit replaceOperationalFailure proposal")
    expect(tool?.description).toContain("The cue is advisory only and grants no authority")
    expect(tool?.description).toContain("the server independently verifies the current owner, attempt, lifecycle, durable receipt, persisted deadline, and budget before accepting it")
    expect(tool?.description).toContain("never supply a failure reason, status, proof")
  })

  it("passes server-resolved requirements to the locked scheduler and ignores model-provided requirements", async () => {
    const resolution = resolveRootTaskVerificationRequirements({ input: { verificationRequirements: {
      schemaVersion: "agent-harness.v2.objective-requirements.v1",
      requirements: [{ id: "candidate-total", check: { kind: "candidate_count_gte", minimum: 2 } }],
    } } })
    const { tool, commandPort } = setup(undefined, resolution)
    const hostile = { ...proposal, verificationRequirements: { status: "absent" }, context: { verificationRequirements: [] } }
    await expect(tool.execute(context(), hostile)).resolves.toEqual(receipt)
    expect(commandPort.appendAndScheduleWithReconciliation).toHaveBeenCalledOnce()
    expect(commandPort.appendAndSchedule).toHaveBeenCalledWith(expect.objectContaining({ verificationRequirements: resolution }))
  })

  it("returns only canonical typed diagnostics from a locked coverage refusal", async () => {
    const resolution = resolveRootTaskVerificationRequirements({ input: { verificationRequirements: {
      schemaVersion: "agent-harness.v2.objective-requirements.v1",
      requirements: [{ id: "candidate-total", check: { kind: "candidate_count_gte", minimum: 2 } }],
    } } })
    const { tool, commandPort } = setup(undefined, resolution)
    vi.mocked(commandPort.appendAndScheduleWithReconciliation!).mockRejectedValueOnce(Object.assign(
      new Error("TaskGraph plan does not cover the canonical objective requirements"), {
        code: "task_graph_objective_coverage_incomplete",
        requirements: [{ id: "candidate-total", kind: "candidate_count_gte", role: "scout", minimum: 2 }],
      },
    ))

    await expect(tool.execute(context(), proposal)).rejects.toMatchObject({
      code: "task_graph_objective_coverage_incomplete",
      safeOutput: { code: "task_graph_objective_coverage_incomplete", requirements: [
        { id: "candidate-total", kind: "candidate_count_gte", role: "scout", minimum: 2 },
      ] },
    })
  })

  it("drops malformed coverage diagnostics instead of exposing untyped fields", async () => {
    const { tool, commandPort } = setup()
    vi.mocked(commandPort.appendAndScheduleWithReconciliation!).mockRejectedValueOnce(Object.assign(
      new Error("TaskGraph plan does not cover the canonical objective requirements"), {
        code: "task_graph_objective_coverage_incomplete",
        requirements: [{ id: "private-value", kind: "unknown", role: "analyst", minimum: 2, raw: "must not escape" }],
      },
    ))

    await expect(tool.execute(context(), proposal)).rejects.toMatchObject({
      code: "task_graph_objective_coverage_incomplete", safeOutput: { code: "task_graph_objective_coverage_incomplete" },
    })
  })

  it("keeps invalid optional requirements distinct while allowing prose-only planning", async () => {
    const invalid = resolveRootTaskVerificationRequirements({ input: { verificationRequirements: { malformed: true } } })
    expect(invalid).toEqual({ status: "invalid" })
    const { tool, commandPort } = setup(undefined, invalid)
    await expect(tool.execute(context(), proposal)).resolves.toEqual(receipt)
    expect(commandPort.appendAndScheduleWithReconciliation).toHaveBeenCalledOnce()
  })

  it("rejects malformed model proposals before the scheduler port runs", () => {
    const { tool, commandPort } = setup()
    const registry = new ToolRegistry([tool])

    for (const field of ["userId", "sessionId", "turnId", "taskId", "budget", "lease", "permissions", "remainingTurnSteps"]) {
      expect(registry.validateArguments("agent.plan", { ...proposal, [field]: "model-controlled" }, "1")).toEqual(expect.any(String))
    }
    expect(tool).toMatchObject({ risk: "internal_write", domain: "coordination", requiredCapabilities: ["coordination", "canManageChildren"] })
    expect(commandPort.appendAndSchedule).not.toHaveBeenCalled()
  })

  it("requires the role-bound typed contract and treats successCriteria prose as explanatory", () => {
    expect(() => setup({ scout: { role: "analyst", taskType: "analysis", allowedActions: ["persona.retrieve"] } }))
      .toThrow("task_graph_verification_template_role_mismatch")
    const { tool } = setup({
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      analyst: { role: "analyst", taskType: "analysis", allowedActions: ["persona.retrieve"] },
      cover_letter_writer: { role: "writer", taskType: "cover_letter_draft", allowedActions: ["cover_letter.draft"] },
      cover_letter_reviewer: { role: "reviewer", taskType: "cover_letter_review", allowedActions: ["artifact.review"] },
    })
    const registry = new ToolRegistry([tool])
    const { verification: _verification, ...withoutVerification } = proposal.nodes[0]
    expect(registry.validateArguments("agent.plan", { ...proposal, nodes: [{
      ...withoutVerification, successCriteria: ["Everything is verified and proven"],
    }] }, "1")).toEqual(expect.any(String))
    expect(registry.validateArguments("agent.plan", { ...proposal, nodes: [{
      ...proposal.nodes[0], verification: { ...proposal.nodes[0].verification, role: "analyst" },
    }] }, "1")).toEqual(expect.any(String))
    expect(registry.validateArguments("agent.plan", { ...proposal, nodes: [{
      ...proposal.nodes[0], verification: { ...proposal.nodes[0].verification, criteria: [{
        id: "bad-check", check: { kind: "finding_count_gte", minimum: 1 },
      }] },
    }] }, "1")).toEqual(expect.any(String))
    expect(registry.validateArguments("agent.plan", {
      ...proposal,
      nodes: [{ ...proposal.nodes[0], templateId: "analyst", verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
        criteria: [{ id: "reported-score", check: { kind: "reported_score_gte", minimumScore: 7, minimumFindings: 1, aggregation: "any" } }],
      } }],
    }, "1")).toBe(true)
    const scout = { ...proposal.nodes[0], key: "scout-source" }
    const analyst = {
      key: "analysis", templateId: "analyst", goal: "Analyze Scout jobs",
      successCriteria: ["Analyze jobs from the selected Scout"], dependsOn: ["scout-source"],
      verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
        criteria: [{ id: "source-membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-source" } }],
      },
    }
    expect(registry.validateArguments("agent.plan", { ...proposal, nodes: [scout, analyst] }, "1")).toBe(true)
    const coverageAnalyst = { ...analyst, verification: { ...analyst.verification, criteria: [{ id: "coverage",
      check: { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout-source", minimumPercent: 75 } }] } }
    expect(registry.validateArguments("agent.plan", { ...proposal, nodes: [scout, coverageAnalyst] }, "1")).toBe(true)
    for (const minimumPercent of [0, 101, 75.5]) {
      expect(registry.validateArguments("agent.plan", { ...proposal, nodes: [scout, { ...coverageAnalyst,
        verification: { ...coverageAnalyst.verification, criteria: [{ id: "coverage", check: {
          kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout-source", minimumPercent,
        } }] },
      }] }, "1")).not.toBe(true)
    }
    expect(registry.validateArguments("agent.plan", { ...proposal, nodes: [{
      ...analyst, verification: { ...analyst.verification, criteria: [{
        id: "source-membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-source", taskId: "forged" },
      }] },
    }] }, "1")).toEqual(expect.any(String))
    expect(registry.validateArguments("agent.plan", { ...proposal, nodes: [{
      ...scout, verification: { ...scout.verification, criteria: [{
        id: "source-membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-source" },
      }] },
    }] }, "1")).toEqual(expect.any(String))
    expect(tool.description).toContain("successCriteria prose is explanatory and never proof")
    expect(tool.description).toContain("reported_score_gte checks an Analyst-reported number, not its correctness")
    expect(tool.description).toContain("findings_from_scout_dependency")
    expect(tool.description).toContain("findings_cover_scout_candidates_gte is Analyst-only")
    expect(tool.description).toContain("Allowed checks: candidate_count_gte, finding_count_gte, evidence_count_gte, all_candidates_have_evidence, all_findings_have_evidence, reported_score_gte, findings_from_scout_dependency, findings_cover_scout_candidates_gte, findings_from_scout_union, findings_cover_scout_candidate_union_gte")
    expect(tool.description).toContain("findings_from_scout_union is Analyst-only and selects 2 to 8 unique direct typed Scout keys")
    expect(tool.description).toContain("it requires nonempty findings and a nonempty deduplicated candidate union, and every finding must belong to that selected group")
    expect(tool.description).toContain("findings_cover_scout_candidate_union_gte uses its own selected group")
    expect(tool.description).toContain("coverage is aggregate across unique candidates")
    expect(tool.description).toContain("Each union criterion selects its own group")
    expect(tool.description).toContain("Canonical scheduled Prepare/Gate still supports a single Scout")
    expect(tool.description).toContain("remap dependsOn edges, scalar dependencyNodeKey selectors, and each mapped key in dependencyNodeKeys arrays. Preserve selector-array order and references outside the source-to-replacement mapping")
    expect(tool.description).toContain("remap scalar dependencyNodeKey selectors and internal dependencyNodeKeys array entries, preserving authored order and references outside the mapping")
    expect(tool.description).toContain("At most seven Scout nodes plus one Analyst fit before counting any other retained nodes")
    expect(tool.description).toContain("Omitting it preserves normal top-N selection")
    expect(tool.description).toContain("append exactly one cover_letter_writer directly after that Reviewer")
    expect(tool.description).toContain("the Worker does not schedule it automatically")
    expect(tool.description).toContain("To retire a failed strategy")
    expect(tool.description).toContain("every descendant is queued or dependency-waiting with attemptCount=0 and no lease, execution, wait condition, result, or evidence")
    expect(tool.description).toContain("atomically cancels eligible descendants as part of this plan")
    expect(tool.description).toContain("failure alone does not cancel them")
    expect(tool.description).toContain("Use repairOf for an ordinary criterion retry when the strategy remains sound")
    expect(tool.description).toContain("Every ancestor outside the closure must be an ordinary typed node completed and verified before the Scout failure; repairOf ancestors are unsupported")
    expect(tool.description).toContain("Do not use this for intentional/user cancellation, Root-failure cleanup, ordinary criterion repair, or ambiguous provenance")
    expect(tool.description).toContain("the server derives eligibility from persisted task/event history, not a model-supplied failure label")
    expect(tool.description).toContain("after new information, it does not require another human message")
  })

  it("advertises Writer revision guidance only when both selected-job templates are registered", () => {
    const scout = { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } as const
    const writer = { role: "writer", taskType: "cover_letter_draft", allowedActions: ["cover_letter.draft"] } as const
    const reviewer = { role: "reviewer", taskType: "cover_letter_review", allowedActions: ["artifact.review"] } as const
    const registries = [
      { templates: { scout }, expected: false },
      { templates: { scout, cover_letter_writer: writer }, expected: false },
      { templates: { scout, cover_letter_reviewer: reviewer }, expected: false },
      { templates: { scout, cover_letter_writer: writer, cover_letter_reviewer: reviewer }, expected: true },
    ] as const

    for (const { templates, expected } of registries) {
      const { tool } = setup(templates)
      expect(tool.description.includes("completed Reviewer dependency reports needs_revision")).toBe(expected)
      expect(tool.description.includes("append exactly one cover_letter_writer directly after that Reviewer")).toBe(expected)
    }
  })

  it("binds omitted repair roots at the executor and accepts only the matching legacy value", async () => {
    const templates = {
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      analyst: { role: "analyst", taskType: "analysis", allowedActions: ["persona.retrieve"] },
      cover_letter_writer: { role: "writer", taskType: "cover_letter", allowedActions: ["cover_letter.write"] },
    } as const
    const repairOf = { nodeKey: "target", taskId: "target-task", criterionIds: ["candidate-count"] }
    const inputs = [
      { ...proposal, nodes: [{ ...proposal.nodes[0], repairOf }] },
      { ...proposal, nodes: [{ ...proposal.nodes[0], repairOf: { ...repairOf, graphRootTaskId: "runtime-root" } }] },
    ]
    const normalized: Array<Parameters<TaskGraphCommandPort["appendAndSchedule"]>[0]["proposal"] | undefined> = []
    for (const input of inputs) {
      const { tool, getReceived } = setup(templates)
      const registry = new ToolRegistry([tool])
      expect(registry.validateArguments("agent.plan", input, "1")).toBe(true)
      await expect(tool.execute(context(), input)).resolves.toEqual(receipt)
      normalized.push(getReceived()?.proposal)
    }
    expect(normalized[0]).toEqual(normalized[1])
    expect(normalized[0]?.nodes[0]?.repairOf).toEqual({ ...repairOf, graphRootTaskId: "runtime-root" })

    const { tool: nonRepairTool, getReceived: getNonRepair } = setup(templates)
    await expect(nonRepairTool.execute(context(), proposal)).resolves.toEqual(receipt)
    expect(getNonRepair()?.proposal).toEqual(proposal)
    const { tool: descriptionTool } = setup(templates)
    expect(descriptionTool.description).toContain("Repeat exactly those criteria and checks")
    expect(descriptionTool.description).toContain("omit graphRootTaskId because the server binds the active Root")
    expect(descriptionTool.description).toContain("must not add the target to dependsOn")
    expect(descriptionTool.description).toContain("eight-node limit on the current graph snapshot, including retained terminal nodes")
    expect(descriptionTool.description).toContain("not a lifetime task-creation cap")
    expect(descriptionTool.description).toContain("task_graph_current.nodeCapacity")
    expect(descriptionTool.description).toContain("may use the reserve in any node order")
    expect(descriptionTool.description).toContain("it does not pass a criterion")
    expect(descriptionTool.description).toContain("do not spend the reserve with agent.spawn or agent.followup")

    const { tool: typedTool } = setup(templates)
    const registry = new ToolRegistry([typedTool])
    const writer = { ...proposal, nodes: [{ key: "writer", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Save draft"], dependsOn: [], repairOf }] }
    expect(registry.validateArguments("agent.plan", writer, "1")).toEqual(expect.any(String))
    for (const invalidRepairOf of [
      { taskId: "target-task", criterionIds: ["candidate-count"] },
      { nodeKey: "target", criterionIds: ["candidate-count"] },
      { nodeKey: "target", taskId: "target-task" },
      { nodeKey: "target", taskId: "target-task", criterionIds: [] },
      { nodeKey: "target", taskId: "target-task", criterionIds: ["Not-an-id"] },
      { nodeKey: "target", taskId: "target-task", criterionIds: ["candidate-count"], extra: true },
    ]) {
      expect(registry.validateArguments("agent.plan", {
        ...proposal, nodes: [{ ...proposal.nodes[0], repairOf: invalidRepairOf }],
      }, "1")).toEqual(expect.any(String))
    }
  })

  it("rejects a mismatched legacy repair root before any command-port call", async () => {
    const { tool, commandPort } = setup()
    const registry = new ToolRegistry([tool])
    const input = { ...proposal, nodes: [{
      ...proposal.nodes[0],
      repairOf: { graphRootTaskId: "other-root", nodeKey: "target", taskId: "target-task", criterionIds: ["candidate-count"] },
    }] }
    expect(registry.validateArguments("agent.plan", input, "1")).toBe(true)
    await expect(tool.execute(context(), input)).rejects.toMatchObject({
      code: "task_graph_repair_root_mismatch",
      safeOutput: { code: "task_graph_repair_root_mismatch" },
    })
    expect(commandPort.appendAndScheduleWithReconciliation).not.toHaveBeenCalled()
    expect(commandPort.appendAndSchedule).not.toHaveBeenCalled()
    expect(commandPort.reconcileSteering).not.toHaveBeenCalled()
  })

  it("keeps Writer and Reviewer on specialized gates without generic verification fields", async () => {
    const { tool, commandPort, getReceived } = setup({
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      cover_letter_writer: { role: "writer", taskType: "cover_letter", allowedActions: ["cover_letter.write"] },
      cover_letter_reviewer: { role: "reviewer", taskType: "review", allowedActions: ["cover_letter.review"] },
    })
    const registry = new ToolRegistry([tool])
    for (const templateId of ["cover_letter_writer", "cover_letter_reviewer"]) {
      const specialized = { ...proposal, nodes: [{
        key: templateId, templateId, goal: "Use the specialized gate", successCriteria: ["Persist the expected artifact"], dependsOn: [],
      }] }
      expect(registry.validateArguments("agent.plan", specialized, "1")).toBe(true)
      await tool.execute(context(), specialized)
      expect(commandPort.appendAndSchedule).toHaveBeenCalledTimes(templateId === "cover_letter_writer" ? 1 : 2)
      expect(getReceived()?.proposal.nodes[0]).not.toHaveProperty("verification")
    }
    expect(registry.validateArguments("agent.plan", { ...proposal, nodes: [{
      ...proposal.nodes[0], templateId: "cover_letter_writer", verification: proposal.nodes[0].verification,
    }] }, "1")).toEqual(expect.any(String))
  })

  it("rejects contact and credential text in keys before scheduling", async () => {
    const sensitiveKeys = [
      "candidate@example.com",
      "+1 (415) 555-0132",
      "password=private-token-value",
    ]

    for (const key of sensitiveKeys) {
      const { tool, commandPort } = setup()
      const input = { ...proposal, nodes: [{ ...proposal.nodes[0], key }] }

      await expect(tool.execute(context(), input)).rejects.toMatchObject({ code: "task_graph_sensitive_key_rejected" })
      expect(commandPort.appendAndSchedule).not.toHaveBeenCalled()
    }
  })

  it("accepts text-safe punctuation and Unicode in TaskGraph keys", async () => {
    const { tool, getReceived } = setup()
    const key = "source / résumé:💼"
    const input = { ...proposal, nodes: [{ ...proposal.nodes[0], key }] }

    await expect(tool.execute(context(), input)).resolves.toEqual(receipt)
    expect(getReceived()?.proposal.nodes[0]?.key).toBe(key)
  })

  it("accepts bounded optional root requirements without replacing the proposal or human goal input", async () => {
    const { tool, getReceived } = setup()
    const input = { ...proposal, rootSuccessCriteria: ["  Include evidence for each role  ", "Include evidence for each role", "Keep the full search scope"] }
    const registry = new ToolRegistry([tool])
    expect(registry.validateArguments("agent.plan", proposal, "1")).toBe(true)
    expect(registry.validateArguments("agent.plan", input, "1")).toBe(true)
    expect(tool.description).toContain("the server prepends the complete original human objective as a mandatory criterion")
    expect(tool.description).toContain("untrusted acceptance requirements")
    expect(tool.description).toContain("it grants no proof, permission, or completion authority")

    await tool.execute(context(), input)

    expect(getReceived()?.rootSuccessCriteria).toEqual(["Include evidence for each role", "Keep the full search scope"])
    expect(getReceived()?.proposal).toEqual(proposal)
  })

  it("rejects malformed or UTF-8 oversized root criteria before reaching the command port", async () => {
    const { tool, commandPort } = setup()
    const registry = new ToolRegistry([tool])
    for (const list of [[], Array.from({ length: 5 }, () => "criterion")]) {
      expect(registry.validateArguments("agent.plan", { ...proposal, rootSuccessCriteria: list }, "1")).not.toBe(true)
    }
    for (const item of ["  ", "x".repeat(513), "💼".repeat(129)]) {
      const input = { ...proposal, rootSuccessCriteria: [item] }
      expect(registry.validateArguments("agent.plan", input, "1")).toBe(true)
      await expect(tool.execute(context(), input)).rejects.toMatchObject({ code: "task_graph_root_criteria_invalid" })
    }
    const exactUnicodeBoundary = { ...proposal, rootSuccessCriteria: ["💼".repeat(128)] }
    await expect(tool.execute(context(), exactUnicodeBoundary)).resolves.toEqual(receipt)
    expect(commandPort.appendAndSchedule).toHaveBeenCalledTimes(1)
  })

  it("publishes only registered template IDs and their allowed catalog details", () => {
    const { tool } = setup({
      analyst: {
        role: "analyst", taskType: "analysis", allowedActions: ["persona.retrieve", "resume.get_base"],
        constraints: ["private server constraint"],
      },
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
    })
    const registry = new ToolRegistry([tool])
    const schema = JSON.stringify(tool.inputSchema)

    expect(schema).toContain('"const":"analyst"')
    expect(schema).toContain('"const":"scout"')
    expect(schema).not.toContain('"const":"unregistered"')
    expect((JSON.parse(schema) as { properties?: Record<string, unknown> }).properties).not.toHaveProperty("role")
    expect(schema).toContain('"role":{"const":"analyst"')
    expect(tool.description).toContain('- "analyst": role "analyst"; allowed actions: "persona.retrieve", "resume.get_base"')
    expect(tool.description).toContain('- "scout": role "scout"; allowed actions: "jobs.search"')
    expect(tool.description).not.toContain("unregistered")
    expect(tool.description).not.toContain("analysis")
    expect(tool.description).not.toContain("private server constraint")
    expect(registry.validateArguments("agent.plan", {
      ...proposal,
      nodes: [{ ...proposal.nodes[0], templateId: "unregistered" }],
    }, "1")).toEqual(expect.any(String))
    expect(registry.validateArguments("agent.plan", {
      ...proposal,
      nodes: [{ ...proposal.nodes[0], templateId: "analyst", verification: {
        schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
        criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
      } }],
    }, "1")).toBe(true)
    for (const field of [
      "taskType", "actions", "allowedActions", "permissions", "userId", "sessionId", "turnId",
      "rootTaskId", "parentTaskId", "turnLeaseOwner", "turnLeaseVersion", "parentLeaseOwner", "parentAttemptCount",
      "remainingTurnSteps",
    ]) {
      expect(schema).not.toContain(`"${field}"`)
    }
    const nodeVariants = (JSON.parse(schema) as {
      properties?: { nodes?: { items?: { anyOf?: Array<{ properties?: Record<string, unknown> }>; properties?: Record<string, unknown> } } }
    }).properties?.nodes?.items
    const variants = nodeVariants?.anyOf ?? (nodeVariants ? [nodeVariants] : [])
    expect(variants.length).toBeGreaterThan(0)
    for (const variant of variants) expect(variant.properties).not.toHaveProperty("taskId")
  })

  it("accepts the maximum bounded proposal and rejects every over-limit field", () => {
    const { tool } = setup()
    const registry = new ToolRegistry([tool])
    const maxNode = (index: number) => ({
      key: String(index).padEnd(128, "k"), templateId: "scout", goal: "g".repeat(1200),
      successCriteria: Array.from({ length: 8 }, () => "c".repeat(320)),
      dependsOn: Array.from({ length: 8 }, (_, dep) => String(dep).padEnd(128, "d")),
      verification: proposal.nodes[0].verification,
    })
    const bounded = { expectedRevision: Number.MAX_SAFE_INTEGER, nodes: Array.from({ length: 8 }, (_, index) => maxNode(index)) }
    expect(registry.validateArguments("agent.plan", bounded, "1")).toBe(true)

    const overLimit = [
      { ...proposal, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...proposal, nodes: Array.from({ length: 9 }, (_, index) => ({ ...proposal.nodes[0], key: `node-${index}` })) },
      { ...proposal, nodes: [{ ...proposal.nodes[0], key: "k".repeat(129) }] },
      { ...proposal, nodes: [{ ...proposal.nodes[0], templateId: "t".repeat(129) }] },
      { ...proposal, nodes: [{ ...proposal.nodes[0], goal: "g".repeat(1201) }] },
      { ...proposal, nodes: [{ ...proposal.nodes[0], successCriteria: Array.from({ length: 9 }, () => "criterion") }] },
      { ...proposal, nodes: [{ ...proposal.nodes[0], successCriteria: ["c".repeat(321)] }] },
      { ...proposal, nodes: [{ ...proposal.nodes[0], dependsOn: Array.from({ length: 9 }, (_, index) => `d-${index}`) }] },
      { ...proposal, nodes: [{ ...proposal.nodes[0], dependsOn: ["d".repeat(129)] }] },
    ]
    for (const input of overLimit) expect(registry.validateArguments("agent.plan", input, "1")).toEqual(expect.any(String))
  })

  it("rejects an oversized aggregate proposal before scheduling", async () => {
    const { tool, commandPort } = setup()
    const input = {
      expectedRevision: 0,
      nodes: Array.from({ length: 8 }, (_, index) => ({
        key: `node-${index}`.padEnd(128, "k"), templateId: "scout", goal: "g".repeat(1200),
        successCriteria: Array.from({ length: 8 }, () => "c".repeat(320)),
        dependsOn: Array.from({ length: 8 }, (_, dependency) => `dep-${dependency}`.padEnd(128, "d")),
        verification: proposal.nodes[0].verification,
      })),
    }
    expect(new ToolRegistry([tool]).validateArguments("agent.plan", input, "1")).toBe(true)
    await expect(tool.execute(context(), input)).rejects.toMatchObject({
      code: "task_graph_proposal_too_large", safeOutput: { code: "task_graph_proposal_too_large", maxBytes: 32_000 },
    })
    expect(commandPort.appendAndSchedule).not.toHaveBeenCalled()
  })

  it("sources tenant, turn, and parent fence identity from runtime context", async () => {
    const { tool, getReceived, getOperation } = setup()

    await tool.execute(context(), proposal)

    expect(getReceived()).toMatchObject({
      proposal,
      scope: {
        userId: "runtime-user", sessionId: "runtime-session", turnId: "runtime-turn", stepId: "runtime-step",
        rootTaskId: "runtime-root", parentTaskId: "runtime-root", turnLeaseOwner: "server-worker", turnLeaseVersion: 9,
        parentLeaseOwner: "server-worker", parentAttemptCount: 1,
      },
    })
    expect(getOperation()).toMatchObject({ decision: "revise", expectedRevision: 0, callId: "server-call-1", scope: getReceived()?.scope })
    expect(getReceived()).not.toHaveProperty("rootSuccessCriteria")
    expect(Object.keys(proposal)).toEqual(["expectedRevision", "nodes"])
  })

  it("passes one typed-leaf replacement to the trusted scheduler for fingerprinting", async () => {
    const { tool, commandPort, getReceived, getOperation } = setup()
    const registry = new ToolRegistry([tool])
    const input = { ...proposal, replaceUnstarted: { nodeKey: "stale-scout" }, nodes: [{
      ...proposal.nodes[0], goal: "Refresh Dublin roles", successCriteria: ["An earlier run reported these roles verified"],
    }] }
    expect(registry.validateArguments("agent.plan", input, "1")).toBe(true)
    await expect(tool.execute(context(), input)).resolves.toEqual(receipt)
    expect(getOperation()).toMatchObject({ decision: "revise", expectedRevision: 0, replaceUnstartedNodeKey: "stale-scout" })
    expect(getReceived()).toMatchObject({ replaceUnstarted: { nodeKey: "stale-scout" } })
    expect(getReceived()).not.toHaveProperty("replacementFingerprint")
    expect(getReceived()?.proposal.nodes[0]).toMatchObject({ goal: input.nodes[0].goal, successCriteria: input.nodes[0].successCriteria })
    expect(getReceived()?.proposal.nodes[0]?.verification).toEqual(proposal.nodes[0].verification)
    expect(commandPort.appendAndScheduleWithReconciliation).toHaveBeenCalledOnce()
    await expect(tool.execute(context(), { ...input, nodes: [input.nodes[0], input.nodes[0]] })).rejects.toMatchObject({
      code: "task_graph_supersession_requires_one_replacement",
    })
    expect(registry.validateArguments("agent.plan", { ...input, replaceUnstarted: { nodeKey: "stale-scout", taskId: "forged" } }, "1")).toEqual(expect.any(String))
  })

  it("passes an exact multi-node branch mapping and rejects mixed replacement modes", async () => {
    const { tool, commandPort, getReceived, getOperation } = setup({
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      analyst: { role: "analyst", taskType: "job_analysis", allowedActions: ["jobs.get"] },
    })
    const branchInput = {
      expectedRevision: 4,
      nodes: [
        { ...proposal.nodes[0], key: "scout-new", goal: "Search with the revised approach" },
        { key: "analyst-new", templateId: "analyst", goal: "Reassess current evidence", successCriteria: ["Explain the new evidence"],
          dependsOn: ["scout-new"], verification: {
            schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
            criteria: [{ id: "source-match", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-new" } }],
          } },
      ],
      replaceBranch: {
        root: { nodeKey: "scout-old", taskId: "task-scout-old" },
        sources: [
          { nodeKey: "scout-old", taskId: "task-scout-old", replacementKey: "scout-new" },
          { nodeKey: "analyst-old", taskId: "task-analyst-old", replacementKey: "analyst-new" },
        ],
      },
    }
    const registry = new ToolRegistry([tool])
    expect(registry.validateArguments("agent.plan", branchInput, "1")).toBe(true)
    await expect(tool.execute(context(), branchInput)).resolves.toEqual(receipt)
    expect(getReceived()?.replaceBranch).toEqual(branchInput.replaceBranch)
    expect(getOperation()).toMatchObject({ decision: "revise", expectedRevision: 4, replaceBranch: branchInput.replaceBranch })
    expect(getReceived()?.proposal.nodes.map(node => node.key)).toEqual(["scout-new", "analyst-new"])

    const mixed = { ...branchInput, replaceUnstarted: { nodeKey: "scout-old" } }
    expect(registry.validateArguments("agent.plan", mixed, "1")).toBe(true)
    await expect(tool.execute(context(), mixed)).rejects.toMatchObject({ code: "task_graph_replacement_modes_conflict" })
    expect(commandPort.appendAndScheduleWithReconciliation).toHaveBeenCalledOnce()
  })

  it("passes a singleton operational-failure mapping and keeps it exclusive from legacy modes", async () => {
    const { tool, commandPort, getReceived, getOperation } = setup({
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      analyst: { role: "analyst", taskType: "job_analysis", allowedActions: ["jobs.get"] },
    })
    const input = {
      expectedRevision: 11,
      nodes: [{ key: "analyst-retry", templateId: "analyst", goal: "Reassess available evidence",
        successCriteria: ["Return current findings"], dependsOn: ["scout-source"], verification: {
          schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
          criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
        } }],
      replaceOperationalFailure: {
        root: { nodeKey: "analyst-old", taskId: "task-analyst-old" },
        sources: [{ nodeKey: "analyst-old", taskId: "task-analyst-old", replacementKey: "analyst-retry" }],
      },
    }
    const registry = new ToolRegistry([tool])
    expect(registry.validateArguments("agent.plan", input, "1")).toBe(true)
    await expect(tool.execute(context(), input)).resolves.toEqual(receipt)
    expect(getReceived()?.replaceOperationalFailure).toEqual(input.replaceOperationalFailure)
    expect(getReceived()?.replaceBranch).toBeUndefined()
    expect(getReceived()?.replaceUnstarted).toBeUndefined()
    expect(getOperation()).toMatchObject({ decision: "revise", expectedRevision: 11,
      replaceOperationalFailure: input.replaceOperationalFailure })

    for (const conflict of [
      { replaceUnstarted: { nodeKey: "analyst-old" } },
      { replaceBranch: { root: input.replaceOperationalFailure.root, sources: [
        { ...input.replaceOperationalFailure.sources[0], replacementKey: "analyst-retry" },
        { nodeKey: "second", taskId: "task-second", replacementKey: "second-new" },
      ] } },
    ]) {
      expect(registry.validateArguments("agent.plan", { ...input, ...conflict }, "1")).toBe(true)
      await expect(tool.execute(context(), { ...input, ...conflict })).rejects.toMatchObject({
        code: "task_graph_replacement_modes_conflict",
      })
    }
    expect(commandPort.appendAndScheduleWithReconciliation).toHaveBeenCalledOnce()
  })

  it("rejects operational mappings with model-authored failure claims or unmapped proposals", async () => {
    const { tool, commandPort } = setup()
    const operational = { root: { nodeKey: "scout-old", taskId: "scout-old-task" },
      sources: [{ nodeKey: "scout-old", taskId: "scout-old-task", replacementKey: "research" }] }
    const registry = new ToolRegistry([tool])
    for (const value of [
      { ...proposal, replaceOperationalFailure: { ...operational, reason: "child_resume_unavailable" } },
      { ...proposal, replaceOperationalFailure: { ...operational, sources: [{ ...operational.sources[0], proof: "passed" }] } },
      { ...proposal, replaceOperationalFailure: operational, failureReason: "child_resume_unavailable" },
      { ...proposal, replaceOperationalFailure: operational, status: "failed" },
      { ...proposal, replaceOperationalFailure: operational, nodes: [{ ...proposal.nodes[0], result: { status: "passed" } }] },
    ]) expect(registry.validateArguments("agent.plan", value, "1")).not.toBe(true)
    const unmapped = { ...proposal, replaceOperationalFailure: operational,
      nodes: [proposal.nodes[0], { ...proposal.nodes[0], key: "extra" }] }
    expect(registry.validateArguments("agent.plan", unmapped, "1")).toBe(true)
    await expect(tool.execute(context(), unmapped)).rejects.toMatchObject({
      code: "task_graph_operational_failure_replacement_invalid",
    })
    expect(commandPort.appendAndScheduleWithReconciliation).not.toHaveBeenCalled()
  })

  it("rejects accessor-backed replacement fields before executing their getters", async () => {
    const { tool, commandPort } = setup()
    let invoked = false
    const input = Object.defineProperty({ ...proposal }, "replaceOperationalFailure", {
      enumerable: true, get: () => { invoked = true; return { root: {}, sources: [] } },
    })
    await expect(tool.execute(context(), input)).rejects.toMatchObject({ code: "task_graph_replacement_mode_invalid" })
    expect(invoked).toBe(false)
    expect(commandPort.appendAndScheduleWithReconciliation).not.toHaveBeenCalled()
  })

  it("rejects an incomplete branch mapping before calling the command port", async () => {
    const { tool, commandPort } = setup({
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      analyst: { role: "analyst", taskType: "job_analysis", allowedActions: ["jobs.get"] },
    })
    const invalid = {
      expectedRevision: 4,
      nodes: [proposal.nodes[0], proposal.nodes[0]],
      replaceBranch: {
        root: { nodeKey: "scout-old", taskId: "task-scout-old" },
        sources: [{ nodeKey: "scout-old", taskId: "task-scout-old", replacementKey: proposal.nodes[0].key },
          { nodeKey: "analyst-old", taskId: "task-analyst-old", replacementKey: "analyst-new" }],
      },
    }
    await expect(tool.execute(context(), invalid)).rejects.toMatchObject({ code: "task_graph_branch_replacement_invalid" })
    expect(commandPort.appendAndScheduleWithReconciliation).not.toHaveBeenCalled()
  })

  it("returns the durable scheduler receipt to the model", async () => {
    const { tool, commandPort } = setup()

    await expect(tool.execute(context(), proposal)).resolves.toEqual(receipt)
    expect(commandPort.appendAndSchedule).toHaveBeenCalledTimes(1)
    expect(commandPort.appendAndScheduleWithReconciliation).toHaveBeenCalledTimes(1)
  })

  it("surfaces the fixed repair-conflict code without the port's dynamic details", async () => {
    const { tool, commandPort } = setup()
    const privateDetail = "target-task-91 failed because criterion salary-floor is still pending"
    vi.mocked(commandPort.appendAndSchedule).mockRejectedValue(Object.assign(new Error(privateDetail), {
      code: "task_graph_repair_conflict", targetTaskId: "target-task-91",
    }))

    const error = await tool.execute(context(), proposal).then(() => undefined, failure => failure)
    expect(error).toMatchObject({
      code: "task_graph_repair_conflict",
      message: "TaskGraph proposal could not be durably scheduled",
      safeOutput: { code: "task_graph_repair_conflict" },
    })
    expect(JSON.stringify(error)).not.toContain(privateDetail)
    expect(JSON.stringify(error)).not.toContain("target-task-91")
    expect(tool.description).toContain("If agent.plan returns task_graph_repair_conflict, inspect or refresh the current owner-scoped graph")
    expect(tool.description).toContain("if none is active, correct the rejected batch so each target/criterion has only one proposed attempt")
    expect(tool.description).toContain("wait for it to become terminal and retry only if the criterion remains unresolved and capacity permits")
    expect(tool.description).toContain("An active repair is not evidence of success")
  })

  it("gives the model accurate branch-replanning and current-capacity guidance", () => {
    const { tool } = setup()
    const description = tool.description

    expect(description).toContain("refresh the owner-scoped current TaskGraph and current Step agenda")
    expect(description).toContain("replaceBranch: { root: { nodeKey, taskId }, sources: [{ nodeKey, taskId, replacementKey }, ...] }")
    expect(description).toContain("every node in its transitive dependsOn descendant closure")
    expect(description).toContain("preserve topology, registered roles, exact typed verification IDs/checks")
    expect(description).toContain("remap scalar dependencyNodeKey selectors and internal dependencyNodeKeys array entries, preserving authored order and references outside the mapping")
    expect(description).toContain("replaceBranch, replaceUnstarted, and replaceOperationalFailure are mutually exclusive")
    expect(description).toContain("replaceOperationalFailure: { root: { nodeKey, taskId }, sources: [{ nodeKey, taskId, replacementKey }, ...] }")
    expect(description).toContain("one source")
    expect(description).toContain("The server proves the failure")
    expect(description).toContain("Replacements inherit no evidence or authorization")
    expect(description).toContain("every source must be queued or dependency-waiting with attemptCount=0")
    expect(description).toContain("no lease, execution, wait condition, result, artifact, evidence, or reservation")
    expect(description).toContain("a fresh model Step with the current graph and agenda revision")
    expect(description).toContain("it does not require another human message")
    expect(description).toContain("remaining is current-snapshot space")
    expect(description).toContain("separate from active-child maxFanOut")
    expect(description).toContain("Existing cumulative Root execution usage and reservations remain in force")
    expect(description).toContain("not a lifetime task-creation cap")
    expect(description).toContain("one global final current-snapshot slot for a valid failed-target criterion repair")
    expect(description).not.toContain("eight-node lifetime history cap")
    expect(description).not.toContain("consumes one lifetime slot")
  })

  it("requires two remaining root steps before persisting a plan", async () => {
    const { tool, commandPort } = setup()

    await expect(tool.execute(context({ remainingTurnSteps: undefined }), proposal)).rejects.toMatchObject({
      code: "task_graph_continuation_budget_required",
      safeOutput: { code: "task_graph_continuation_budget_required", requiredSteps: 2 },
    })
    await expect(tool.execute(context({ remainingTurnSteps: 0 }), proposal)).rejects.toMatchObject({
      code: "task_graph_continuation_budget_required",
      safeOutput: { code: "task_graph_continuation_budget_required", requiredSteps: 2 },
    })
    await expect(tool.execute(context({ remainingTurnSteps: 1 }), proposal)).rejects.toMatchObject({
      code: "task_graph_continuation_budget_required",
      safeOutput: { code: "task_graph_continuation_budget_required", requiredSteps: 2 },
    })
    await expect(tool.execute(context({ remainingTurnSteps: Number.MAX_SAFE_INTEGER + 1 }), proposal)).rejects.toMatchObject({
      code: "task_graph_continuation_budget_required",
      safeOutput: { code: "task_graph_continuation_budget_required", requiredSteps: 2 },
    })
    expect(commandPort.appendAndSchedule).not.toHaveBeenCalled()

    await expect(tool.execute(context({ remainingTurnSteps: 2 }), proposal)).resolves.toEqual(receipt)
    expect(commandPort.appendAndSchedule).toHaveBeenCalledTimes(1)
  })

  it("exposes only a bounded current revision when the durable append is stale", async () => {
    const { tool, commandPort } = setup()
    vi.mocked(commandPort.appendAndSchedule).mockRejectedValue(Object.assign(new Error("stale"), {
      code: "revision_mismatch", currentRevision: 4, userId: "must-not-leak", proposal: { private: true },
    }))

    await expect(tool.execute(context(), proposal)).rejects.toMatchObject({
      code: "revision_mismatch", safeOutput: { code: "revision_mismatch", currentRevision: 4 },
    })
  })
})
