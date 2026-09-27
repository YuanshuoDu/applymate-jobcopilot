import { describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "./registry.js"
import type { ToolExecutionContext } from "./types.js"
import { createTaskGraphPlanningTool } from "./planning-executors.js"
import type { TaskGraphCommandPort, TaskGraphScheduleReceipt, TaskGraphTaskTemplate } from "../subagents/task-graph-command-port.js"

const proposal = {
  expectedRevision: 0,
  nodes: [{ key: "research", templateId: "scout", goal: "Find matching roles", successCriteria: ["Return relevant roles"], dependsOn: [] }],
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
      nodes: [{ ...proposal.nodes[0], templateId: "analyst" }],
    }, "1")).toBe(true)
    for (const field of [
      "taskId", "role", "taskType", "actions", "allowedActions", "permissions", "userId", "sessionId", "turnId",
      "rootTaskId", "parentTaskId", "turnLeaseOwner", "turnLeaseVersion", "parentLeaseOwner", "parentAttemptCount",
      "remainingTurnSteps",
    ]) {
      expect(schema).not.toContain(`"${field}"`)
    }
  })

  it("accepts the maximum bounded proposal and rejects every over-limit field", () => {
    const { tool } = setup()
    const registry = new ToolRegistry([tool])
    const maxNode = (index: number) => ({
      key: String(index).padEnd(128, "k"), templateId: "scout", goal: "g".repeat(1200),
      successCriteria: Array.from({ length: 8 }, () => "c".repeat(320)),
      dependsOn: Array.from({ length: 8 }, (_, dep) => String(dep).padEnd(128, "d")),
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
