import { afterEach, describe, expect, it, vi } from "vitest"
import { createScheduledPostGateChildExecutor, isScheduledPostGateCandidate, isScheduledPostGateLease } from "./scheduled-post-gate-child-runtime.js"
import { SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
  SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE } from "./scheduled-post-gate-contract.js"
import type { ScheduledPostGateChildContext } from "./scheduled-post-gate-context.js"
import type { SubagentLease } from "./types.js"

const mocks = vi.hoisted(() => ({ context: vi.fn() }))
vi.mock("./scheduled-post-gate-context.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-post-gate-context.js")>(), readScheduledPostGateChildContext: mocks.context,
}))

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "root-lease", turnLeaseVersion: 3, executionId: "execution-1", executionAttemptCount: 2 }
const digest = `sha256:${"a".repeat(64)}`
const handoff = { owner, snapshotDigest: digest, continuationKey: `scheduled-taskgraph:sha256:${"b".repeat(64)}` }
const attestation = { schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1", snapshotDigest: digest, owner: {
  userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
  rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion },
  graphRevision: 4, evidenceDigest: "c".repeat(64), scout: {}, analyst: {} }
const actor = { taskId: "execute-1", attemptCount: 1, leaseOwner: "child-lease" }
const refs = ["pkg-a", "pkg-b"]
const report = { processed: 2, applied: 0, queued: 1, pending: 1, skipped: 0, failed: 0, durationMs: 22 }

function lease(kind: "execute" | "audit", overrides: Partial<SubagentLease> = {}): SubagentLease {
  const execute = kind === "execute"
  return { id: execute ? "execute-1" : "audit-1", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, path: "/root/child", depth: execute ? 5 : 6,
    role: execute ? SCHEDULED_POST_GATE_EXECUTE_ROLE : SCHEDULED_POST_GATE_AUDIT_ROLE,
    taskType: execute ? SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE : SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
    status: "running", goal: "fixed", constraints: [], successCriteria: [], allowedActions: [], context: {},
    expectedOutputSchema: execute ? SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA : SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
    modelProfileSnapshot: null, result: null, failureReason: null, attemptCount: 1, maxAttempts: 3, leaseOwner: "child-lease",
    leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {},
    ownerId: "child-lease", signal: new AbortController().signal, ...overrides }
}
function context(kind: "execute" | "audit"): ScheduledPostGateChildContext {
  const common = { owner, handoff, attestation, actor: { ...actor, taskId: kind === "execute" ? "execute-1" : "audit-1" } }
  return kind === "execute" ? { kind, ...common, packageRefs: refs } : { kind, ...common }
}
function client() { return { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() } }
function response(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status }) }

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs() })

describe("scheduled post-Gate fixed child runtime", () => {
  it("runs only the Gate-bound package partition and persists the bounded Execute result", async () => {
    vi.stubEnv("AGENT_WEB_URL", "https://web.example")
    vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret")
    const db = client(), pool = { connect: vi.fn(async () => db) }, fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ action: "scheduled_post_gate_execute", owner, handoff, attestation,
        actor: context("execute").actor, packageRefs: refs })
      return response({ status: "completed", structuredResult: { queued: ["pkg-a"], failed: ["pkg-b"] } })
    })
    mocks.context.mockResolvedValue(context("execute"))
    const task = lease("execute"), executor = createScheduledPostGateChildExecutor({ pool: pool as never, fetcher })

    await expect(executor({ lease: task })).resolves.toEqual({ status: "completed", result: {
      finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
      taskGraphVerificationReport: null, structuredResult: { queued: ["pkg-a"], failed: ["pkg-b"] },
    } })
    expect(db.query.mock.calls.map(call => call[0])).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT"])
    expect(db.release).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://web.example/api/internal/agent-runtime/scheduled-pipeline")
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-agent-worker-secret": "worker-secret" })
  })

  it("runs the fixed Audit request without an Execute packageRefs field", async () => {
    vi.stubEnv("AGENT_WEB_URL", "https://web.example")
    vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret")
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.action).toBe("scheduled_post_gate_audit")
      expect(Object.hasOwn(body, "packageRefs")).toBe(false)
      return response({ status: "completed", report })
    })
    mocks.context.mockResolvedValue(context("audit"))
    await expect(createScheduledPostGateChildExecutor({ pool: { connect: vi.fn(async () => client()) } as never, fetcher })({
      lease: lease("audit"),
    })).resolves.toMatchObject({ status: "completed", result: { structuredResult: report } })
  })

  it("accepts the existing non-submitting Execute result when all packages remain held", async () => {
    vi.stubEnv("AGENT_WEB_URL", "https://web.example")
    vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret")
    mocks.context.mockResolvedValue(context("execute"))
    const fetcher = vi.fn(async () => response({ status: "completed", structuredResult: { queued: [], failed: [] } }))
    await expect(createScheduledPostGateChildExecutor({ pool: { connect: vi.fn(async () => client()) } as never, fetcher })({
      lease: lease("execute"),
    })).resolves.toMatchObject({ status: "completed", result: { structuredResult: { queued: [], failed: [] } } })
  })

  it("keeps transient handoff failures retryable within the inherited bounded task policy", async () => {
    vi.stubEnv("AGENT_WEB_URL", "https://web.example")
    vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret")
    mocks.context.mockResolvedValue(context("execute"))
    const fetcher = vi.fn(async () => response({ status: "blocked", errorCode: "temporarily_unavailable" }, 503))
    await expect(createScheduledPostGateChildExecutor({ pool: { connect: vi.fn(async () => client()) } as never, fetcher })(
      { lease: lease("execute") })).resolves.toEqual({ status: "failed", failureReason: "scheduled_post_gate_handoff_retryable",
      retryDisposition: "retryable" })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("fails closed on mismatched task identity and rejects generic follow-up continuations", async () => {
    const task = lease("execute")
    expect(isScheduledPostGateCandidate(task)).toBe(true)
    expect(isScheduledPostGateLease(task)).toBe(true)
    expect(isScheduledPostGateLease({ ...task, role: "analyst" })).toBe(false)
    const executor = createScheduledPostGateChildExecutor({ pool: { connect: vi.fn() } as never })
    await expect(executor({ lease: task, continuation: { kind: "mailbox_input_pending", missingMessageIds: [], observedMessageIds: [] } }))
      .resolves.toEqual({ status: "failed", failureReason: "scheduled_post_gate_continuation_unsupported", retryDisposition: "terminal" })
    expect(mocks.context).not.toHaveBeenCalled()
  })
})
