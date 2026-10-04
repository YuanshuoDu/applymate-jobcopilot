import { describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "./registry.js"
import type { ToolExecutionContext } from "./types.js"
import { createTaskGraphPlanningTool } from "./planning-executors.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphCommandPort, TaskGraphScheduleReceipt, TaskGraphTaskTemplate } from "../subagents/task-graph-command-port.js"

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
    taskId: "runtime-root", rootTaskId: "runtime-root", signal: new AbortController().signal,
    remainingTurnSteps: 2, capabilities: ["canManageChildren"], reportProgress: async () => undefined,
    ...overrides,
  }
}

function setup(templates: Readonly<Record<string, TaskGraphTaskTemplate>> = {
  scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
}) {
  let received: Parameters<TaskGraphCommandPort["appendAndSchedule"]>[0] | undefined
  const commandPort: TaskGraphCommandPort = {
    appendAndSchedule: vi.fn(async input => { received = input; return receipt }),
    readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
  }
  const tool = createTaskGraphPlanningTool({
    commandPort,
    templates,
    turnLeaseOwner: "server-worker",
    turnLeaseVersion: 9,
    parentLeaseOwner: "server-worker",
    parentAttemptCount: () => 1,
  })
  return { tool, commandPort, getReceived: () => received }
}

describe("agent.plan tool executor", () => {
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
    expect(tool.description).toContain("successCriteria prose is explanatory and never proof")
    expect(tool.description).toContain("reported_score_gte checks an Analyst-reported number, not its correctness")
  })

  it("exposes and forwards the bounded repair relation only for typed roles", async () => {
    const { tool, getReceived } = setup({
      scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      analyst: { role: "analyst", taskType: "analysis", allowedActions: ["persona.retrieve"] },
      cover_letter_writer: { role: "writer", taskType: "cover_letter", allowedActions: ["cover_letter.write"] },
    })
    const registry = new ToolRegistry([tool])
    const repairOf = { graphRootTaskId: "runtime-root", nodeKey: "target", taskId: "target-task", criterionIds: ["candidate-count"] }
    const input = { ...proposal, nodes: [{ ...proposal.nodes[0], repairOf }] }
    expect(registry.validateArguments("agent.plan", input, "1")).toBe(true)
    expect(JSON.stringify(tool.inputSchema)).toContain("graphRootTaskId")
    expect(tool.description).toContain("repeats exactly those criteria and checks")
    expect(tool.description).toContain("must not add the target to dependsOn")
    await expect(tool.execute(context(), input)).resolves.toEqual(receipt)
    expect(getReceived()?.proposal.nodes[0]?.repairOf).toEqual(repairOf)

    const writer = {
      ...proposal,
      nodes: [{ key: "writer", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Save draft"], dependsOn: [], repairOf }],
    }
    expect(registry.validateArguments("agent.plan", writer, "1")).toEqual(expect.any(String))
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
    const { tool, getReceived } = setup()

    await tool.execute(context(), proposal)

    expect(getReceived()).toMatchObject({
      proposal,
      scope: {
        userId: "runtime-user", sessionId: "runtime-session", turnId: "runtime-turn", stepId: "runtime-step",
        rootTaskId: "runtime-root", parentTaskId: "runtime-root", turnLeaseOwner: "server-worker", turnLeaseVersion: 9,
        parentLeaseOwner: "server-worker", parentAttemptCount: 1,
      },
    })
    expect(Object.keys(proposal)).toEqual(["expectedRevision", "nodes"])
  })

  it("returns the durable scheduler receipt to the model", async () => {
    const { tool, commandPort } = setup()

    await expect(tool.execute(context(), proposal)).resolves.toEqual(receipt)
    expect(commandPort.appendAndSchedule).toHaveBeenCalledTimes(1)
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
