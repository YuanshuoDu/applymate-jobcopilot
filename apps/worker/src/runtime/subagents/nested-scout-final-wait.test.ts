import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import type { PrepareFinalDependencyWaitInput } from "../turns/turn-execution-options.js"
import { NESTED_SCOUT_PROFILE_MARKER } from "./nested-scout-profile.js"
import { createNestedScoutFinalWait, prepareNestedScoutFinalWait } from "./nested-scout-final-wait.js"
import type { NestedScoutChildRow } from "./nested-scout-tools.js"
import type { SubagentLease } from "./types.js"

const controller = new AbortController()
const lease = {
  id: "parent-task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-task",
  parentTaskId: "root-task", path: "/root-task/parent-task", depth: 1, role: "scout", taskType: "job_discovery",
  ownerId: "owner-1", leaseOwner: "owner-1", attemptCount: 1, status: "running", interruptRequestedAt: null,
  leaseExpiresAt: new Date(Date.now() - 60_000), signal: controller.signal,
  context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER },
} as SubagentLease
const waitInput = (overrides: Partial<PrepareFinalDependencyWaitInput> = {}): PrepareFinalDependencyWaitInput => ({
  identity: { kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "parent-task", rootTaskId: "root-task", ownerId: "owner-1", leaseExpiresAt: new Date(0), attemptCount: 1 },
  step: { id: "step-1", ordinal: 2 },
  context: { schemaVersion: "agent-harness.v2", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", blocks: [], canonicalJson: "{}", inputThroughSequence: 1n, consumedInputIds: [] },
  snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
  signal: controller.signal,
  ...overrides,
})
const child = (taskId: string, status = "running"): NestedScoutChildRow => ({
  taskId, status, role: "scout", taskType: "job_discovery", context: {
    nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: [{ source: "greenhouse", targetRoles: ["Engineer"], targetLocations: [], maxPageSize: 20 }],
  }, result: null, failureReason: null,
})
function waitObservation(status: "ready" | "timed_out" = "ready", taskStatus = "completed", suffix = "1") {
  const id = `child-resume:item-${suffix}`
  const content = {
    toolCallId: `wait-call-${suffix}`, toolName: "wait_subagents", status: "completed", errorCode: null,
    input: { idempotencyKey: `wait-key-${suffix}`, taskIds: ["child-a"], mode: "all", timeoutMs: 30_000 },
    output: { waitId: `wait-id-${suffix}`, status, taskIds: ["child-a"], deadlineAt: new Date(Date.now() - 1).toISOString(),
      matchedTaskIds: taskStatus === "completed" || taskStatus === "failed" || taskStatus === "interrupted" || taskStatus === "cancelled" || taskStatus === "closed" ? ["child-a"] : [],
      tasks: [{ taskId: "child-a", status: taskStatus, role: "scout", result: null, failureReason: null }] },
  }
  return {
    snapshot: { id, content },
    context: { id, layer: "tool_observation" as const, role: "data" as const, trust: "external_untrusted" as const, source: "tool-or-subagent", content },
  }
}

const ownerRow = () => ({ stepId: "step-1", stepOrdinal: 2, stepStatus: "streaming", stepTaskId: "parent-task", stepSessionId: "session-1", stepTurnId: "turn-1", stepAttempt: 1,
  sessionId: "session-1", sessionUserId: "user-1", sessionStatus: "active", turnId: "turn-1", turnSessionId: "session-1", turnRootTaskId: "root-task",
  parentId: "parent-task", parentUserId: "user-1", parentSessionId: "session-1", parentTurnId: "turn-1", parentRootTaskId: "root-task",
  parentTaskId: "root-task", parentDepth: 1, parentPath: "/root-task/parent-task", parentRole: "scout", parentTaskType: "job_discovery",
  parentContext: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER }, parentStatus: "running", parentLeaseOwner: "owner-1", parentAttemptCount: 1, parentInterruptRequestedAt: null })
const childRow = (overrides: Record<string, unknown> = {}) => ({ taskId: "child-a", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  rootTaskId: "root-task", parentTaskId: "parent-task", depth: 2, path: "/root-task/parent-task/child-a", parentPath: "/root-task/parent-task",
  status: "running", role: "scout", taskType: "job_discovery", context: child("child-a").context, ...overrides })
function poolFixture(options: { ownerRows?: Record<string, unknown>[]; childRows?: Record<string, unknown>[]; failChildren?: boolean; subAgentTaskHasUserId?: boolean } = {}) {
  const sequence: string[] = []
  const client = {
    query: vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      sequence.push(sql)
      if (options.subAgentTaskHasUserId === false && /\b(parent|child)\."userId"/.test(sql)) {
        throw Object.assign(new Error('column "userId" does not exist'), { code: "42703" })
      }
      if (sql.includes("FROM \"agent_steps\" step")) return { rows: options.ownerRows ?? [ownerRow()], rowCount: (options.ownerRows ?? [ownerRow()]).length }
      if (sql.includes("FROM \"sub_agent_tasks\" child")) {
        if (options.failChildren) throw new Error("private database detail")
        return { rows: options.childRows ?? [childRow()], rowCount: (options.childRows ?? [childRow()]).length }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(() => sequence.push("RELEASE")),
  }
  const connect = vi.fn(async () => client)
  return { pool: { connect } as never, connect, client, sequence }
}

describe("nested Scout final dependency wait", () => {
  it("waits on every exact direct child when active", () => {
    expect(prepareNestedScoutFinalWait(waitInput(), lease, [child("child-a"), child("child-b", "completed")])).toEqual({ taskIds: ["child-a", "child-b"] })
  })

  it("waits for terminal outcomes that have not reached the model context", () => {
    expect(prepareNestedScoutFinalWait(waitInput(), lease, [child("child-a", "completed")])).toEqual({ taskIds: ["child-a"] })
  })

  it("does not treat snapshot-only timeout receipts as delivered", () => {
    const observed = waitObservation("timed_out", "running"), input = waitInput({ snapshot: { ...waitInput().snapshot, toolObservations: [observed.snapshot] } })
    expect(prepareNestedScoutFinalWait(input, lease, [child("child-a")])).toEqual({ taskIds: ["child-a"] })
  })

  it.each([["ready", "completed"], ["timed_out", "completed"]] as const)("stops only after the exact %s all-terminal outcome is source-bound and model-visible", (status, taskStatus) => {
    const observed = waitObservation(status, taskStatus), base = waitInput()
    const input = { ...base, snapshot: { ...base.snapshot, toolObservations: [observed.snapshot] }, context: { ...base.context, blocks: [observed.context] } }
    expect(prepareNestedScoutFinalWait(input, lease, [child("child-a", taskStatus)])).toBeNull()
  })

  it("requires another wait when a source-bound receipt was dropped from the built context", () => {
    const observed = waitObservation(), base = waitInput()
    const input = { ...base, snapshot: { ...base.snapshot, toolObservations: [observed.snapshot] } }
    expect(prepareNestedScoutFinalWait(input, lease, [child("child-a", "completed")])).toEqual({ taskIds: ["child-a"] })
  })

  it("never lets an old ready receipt bypass currently active children", () => {
    const observed = waitObservation("ready", "completed"), base = waitInput()
    const input = { ...base, snapshot: { ...base.snapshot, toolObservations: [observed.snapshot] }, context: { ...base.context, blocks: [observed.context] } }
    expect(prepareNestedScoutFinalWait(input, lease, [child("child-a", "running")])).toEqual({ taskIds: ["child-a"] })
  })

  it("uses the latest delivered receipt when earlier waits for the same children timed out", () => {
    const old = waitObservation("timed_out", "running", "old"), latest = waitObservation("ready", "completed", "new"), base = waitInput()
    const input = { ...base, snapshot: { ...base.snapshot, toolObservations: [old.snapshot, latest.snapshot] },
      context: { ...base.context, blocks: [old.context, latest.context] } }
    expect(prepareNestedScoutFinalWait(input, lease, [child("child-a", "completed")])).toBeNull()
  })

  it("ignores a foreign or malformed wait output and asks the server for a new receipt", () => {
    const observed = waitObservation(), base = waitInput()
    const foreign = { ...observed, snapshot: { ...observed.snapshot, content: { ...observed.snapshot.content, output: { ...observed.snapshot.content.output, taskIds: ["other-child"] } } } }
    const input = { ...base, snapshot: { ...base.snapshot, toolObservations: [foreign.snapshot] }, context: { ...base.context, blocks: [observed.context] } }
    expect(prepareNestedScoutFinalWait(input, lease, [child("child-a", "completed")])).toEqual({ taskIds: ["child-a"] })
  })

  it("fails closed for malformed, cross-scope, or over-limit child rows", () => {
    expect(() => prepareNestedScoutFinalWait(waitInput(), lease, [{ ...child("child-a"), role: "analyst" }])).toThrow("children_invalid")
    expect(() => prepareNestedScoutFinalWait(waitInput(), lease, [{ ...child("child-a"), context: {} }])).toThrow("children_invalid")
    expect(() => prepareNestedScoutFinalWait(waitInput(), lease, [child("child-a"), child("child-a")])).toThrow("children_invalid")
    expect(() => prepareNestedScoutFinalWait(waitInput(), lease, [child("a"), child("b"), child("c")])).toThrow("children_invalid")
  })

  it("reads current streaming Step and DB-renewed lease, and closes the read transaction", async () => {
    const fixture = poolFixture({ childRows: [childRow(), childRow({ taskId: "child-b", path: "/root-task/parent-task/child-b" })] })
    const request = waitInput()
    const result = await createNestedScoutFinalWait({ pool: fixture.pool, lease })(request)
    expect(result).toEqual({ taskIds: ["child-a", "child-b"] })
    expect(fixture.sequence).toEqual(expect.arrayContaining(["BEGIN READ ONLY", "COMMIT", "RELEASE"]))
    expect(fixture.client.query.mock.calls.map(([sql]) => sql).join("\n")).toContain('step."status" = \'streaming\'')
    expect(fixture.client.query.mock.calls.map(([sql]) => sql).join("\n")).toContain('parent."leaseExpiresAt" > clock_timestamp()')
    expect(fixture.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT")
    expect(fixture.sequence.at(-1)).toBe("RELEASE")
  })

  it("reads owner and child rows using the columns present in the Prisma schema", async () => {
    const schema = readFileSync(new URL("../../../../../apps/web/prisma/schema.prisma", import.meta.url), "utf8")
    const taskModel = schema.match(/model SubAgentTask\s*\{([\s\S]*?)^\}/m)?.[1]
    expect(taskModel).toBeDefined()
    const hasUserIdColumn = (taskModel ?? "").split(/\r?\n/).some(line => /^\s*userId\s+/.test(line))
    expect(hasUserIdColumn).toBe(false)

    const fixture = poolFixture({ subAgentTaskHasUserId: hasUserIdColumn })
    await expect(createNestedScoutFinalWait({ pool: fixture.pool, lease })(waitInput())).resolves.toEqual({ taskIds: ["child-a"] })
  })

  it("fails closed on stale Step ownership and always rolls back before release", async () => {
    const fixture = poolFixture({ ownerRows: [{ ...ownerRow(), stepStatus: "completed" }] })
    await expect(createNestedScoutFinalWait({ pool: fixture.pool, lease })(waitInput())).rejects.toThrow("owner_unavailable")
    expect(fixture.sequence.slice(-2)).toEqual(["ROLLBACK", "RELEASE"])
  })

  it("fails closed on DB read errors and malformed cross-scope rows", async () => {
    const failed = poolFixture({ failChildren: true })
    await expect(createNestedScoutFinalWait({ pool: failed.pool, lease })(waitInput())).rejects.toThrow("final_wait_unavailable")
    expect(failed.sequence.slice(-2)).toEqual(["ROLLBACK", "RELEASE"])
    const crossScope = poolFixture({ childRows: [childRow({ sessionId: "other-session" })] })
    await expect(createNestedScoutFinalWait({ pool: crossScope.pool, lease })(waitInput())).rejects.toThrow("final_wait_unavailable")
    expect(crossScope.sequence.slice(-2)).toEqual(["ROLLBACK", "RELEASE"])
  })

  it("returns no wait when there are no children and skips DB access for an aborted signal", async () => {
    const empty = poolFixture({ childRows: [] })
    await expect(createNestedScoutFinalWait({ pool: empty.pool, lease })(waitInput())).resolves.toBeNull()
    const aborted = poolFixture()
    await expect(createNestedScoutFinalWait({ pool: aborted.pool, lease })(waitInput({ signal: AbortSignal.abort() }))).resolves.toBeNull()
    expect(aborted.connect).not.toHaveBeenCalled()
  })

  it("rejects stale, unrelated, or signal-mismatched execution contexts", () => {
    const input = waitInput()
    expect(() => prepareNestedScoutFinalWait({ ...input, identity: { ...input.identity, turnId: "other-turn" } }, lease, [child("child-a")])).toThrow("owner_unavailable")
    expect(() => prepareNestedScoutFinalWait({ ...input, signal: new AbortController().signal }, lease, [child("child-a")])).toThrow("owner_unavailable")
    expect(prepareNestedScoutFinalWait({ ...input, signal: AbortSignal.abort() }, lease, [child("child-a")])).toBeNull()
  })
})
