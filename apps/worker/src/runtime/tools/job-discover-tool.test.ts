import { describe, expect, it, vi } from "vitest"

import { PolicyEngine } from "../policy/engine.js"
import { InMemoryToolLifecycleSink, ToolLifecycle } from "./lifecycle.js"
import { InMemoryToolResultReferenceStore } from "./redaction.js"
import { ToolRegistry } from "./registry.js"
import { ToolRouter } from "./router.js"
import { createJobsDiscoverTool, type JobDiscoveryExecutionFence } from "./job-discover-tool.js"
import { createJobDiscoveryClient, JobDiscoveryClientError, type JobDiscoveryClient, type JobDiscoveryOutput, type JobDiscoveryRequest } from "./job-discovery-client.js"
import type { RuntimeToolDefinition, ToolExecutionContext } from "./types.js"

const jobId = `c${"a".repeat(24)}`
const fence: JobDiscoveryExecutionFence = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1", rootTaskId: "root-1",
  role: "scout", leaseOwner: "worker-1", attemptCount: 2,
}
const input = { targetRoles: ["Engineer"], targetLocations: ["Dublin"], pageSize: 2 }
const output: JobDiscoveryOutput = {
  jobs: [{ id: jobId, title: "Engineer", company: "Example", location: "Dublin", url: "https://jobs.example/1", description: "Role", fullDescription: "Role details", salary: null, logo: null, source: "greenhouse", evidenceRefs: ["source-1"] }],
  evidence: [{ evidenceId: "source-1", jobId, kind: "source", source: "greenhouse", url: "https://jobs.example/1", summary: "Provider listing" }],
  nextCursor: null,
  usage: { ledgerKey: "ledger-1", toolName: "jobs.discover", toolVersion: "1", toolCallId: "call-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", requests: 1, jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 10 },
}

function context(options: { userId?: string; taskId?: string; actorRole?: ToolExecutionContext["actorRole"]; signal?: AbortSignal } = {}): ToolExecutionContext {
  return {
    scope: { userId: options.userId ?? fence.userId }, sessionId: fence.sessionId, turnId: fence.turnId, stepId: "step-1",
    toolCallId: "call-1", taskId: options.taskId ?? fence.taskId, rootTaskId: fence.rootTaskId, actorRole: options.actorRole ?? "subagent",
    signal: options.signal ?? new AbortController().signal, capabilities: ["read"], reportProgress: async () => undefined,
  }
}

function discoveryPolicy() {
  return new PolicyEngine({ snapshot: { version: "policy.v1", rules: [{
    id: "test-discovery-write", roles: ["subagent"], tools: ["jobs.discover"], toolVersions: ["1"], risks: ["internal_write"],
    domains: ["jobs"], requiredCapabilities: ["read"], outcome: "allow", reasonCode: "test_discovery_allowed", reason: "Test-only exact discovery permission",
  }] } })
}

describe("jobs.discover tool", () => {
  it("exposes only criteria as model input and keeps saved Job evidence in its output", async () => {
    const client: JobDiscoveryClient = { discover: vi.fn(async (_request: JobDiscoveryRequest) => output) }
    const tool = createJobsDiscoverTool({ client, fence })
    const registry = new ToolRegistry([tool as RuntimeToolDefinition])

    expect(tool).toMatchObject({ name: "jobs.discover", version: "1", risk: "internal_write", domain: "jobs", idempotency: "idempotent", capabilities: ["read", "write"], requiredCapabilities: ["read"] })
    expect(registry.validateArguments("jobs.discover", input)).toBe(true)
    for (const identity of [
      { userId: "user-2" },
      { owner: "owner-2" },
      { ownerId: "owner-2" },
      { role: "analyst" },
      { sessionId: "session-2" },
      { turnId: "turn-2" },
      { stepId: "step-2" },
      { toolCallId: "call-2" },
      { taskId: "task-2" },
      { rootTaskId: "root-2" },
      { leaseOwner: "worker-2" },
      { attemptCount: 2 },
    ]) {
      expect(registry.validateArguments("jobs.discover", { ...input, ...identity })).not.toBe(true)
    }

    const execution = context()
    const result = await tool.execute(execution, input)
    expect(result).toEqual(output)
    expect(client.discover).toHaveBeenCalledWith({
      ...fence, stepId: "step-1", toolCallId: "call-1", ...input,
    }, execution.signal)
  })

  it("fails closed when runtime scope or role differs from the captured lease", async () => {
    const client: JobDiscoveryClient = { discover: vi.fn(async () => output) }
    const tool = createJobsDiscoverTool({ client, fence })
    await expect(tool.execute(context({ userId: "user-2" }), input)).rejects.toMatchObject({ code: "job_discovery_context_unavailable" })
    await expect(tool.execute(context({ taskId: "child-2" }), input)).rejects.toMatchObject({ code: "job_discovery_context_unavailable" })
    await expect(tool.execute(context({ actorRole: "orchestrator" }), input)).rejects.toMatchObject({ code: "job_discovery_context_unavailable" })
    expect(client.discover).not.toHaveBeenCalled()
  })

  it("marks a cancelled in-flight request without emitting a completed receipt", async () => {
    let markStarted: () => void = () => undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const client: JobDiscoveryClient = {
      discover: vi.fn((_request: JobDiscoveryRequest, signal: AbortSignal) => new Promise<JobDiscoveryOutput>((_resolve, reject) => {
        markStarted()
        signal.addEventListener("abort", () => reject(new JobDiscoveryClientError("cancelled")), { once: true })
      })),
    }
    const sink = new InMemoryToolLifecycleSink()
    const router = new ToolRouter(new ToolRegistry([createJobsDiscoverTool({ client, fence }) as RuntimeToolDefinition]), new ToolLifecycle({
      sink, references: new InMemoryToolResultReferenceStore(),
    }), discoveryPolicy())
    const controller = new AbortController()
    const pending = router.execute({ ...context(), signal: controller.signal }, { id: "call-1", toolName: "jobs.discover", toolVersion: "1", input })
    await started
    controller.abort()

    await expect(pending).resolves.toMatchObject({ status: "cancelled", errorCode: "cancelled" })
    expect(sink.events.map(event => event.phase)).toEqual(["started", "cancelled"])
  })

  it("retains only safe usage metrics from an HTTP failure in the failed lifecycle receipt", async () => {
    const safeUsage = {
      requests: 2, jobsProcessed: 3, jobsSucceeded: 1, jobsFailed: 2, providerFailures: 1,
      providers: ["greenhouse", "lever"], estimatedCostUsd: 0.004, durationMs: 321,
    }
    const privateValues = ["private-ledger-key", "private-user-id", "private-session-id", "private-turn-id", "private-step-id", "private-tool-call-id", "private-upstream-message"]
    const client = createJobDiscoveryClient({
      endpointUrl: "https://web.example/discovery", secret: "worker-secret",
      fetch: vi.fn(async () => Response.json({
        error: { code: "provider_unavailable", message: privateValues[privateValues.length - 1] },
        usage: {
          ledgerKey: privateValues[0], userId: privateValues[1], sessionId: privateValues[2], turnId: privateValues[3],
          stepId: privateValues[4], toolCallId: privateValues[5], toolName: "jobs.discover", toolVersion: "1",
          ...safeUsage, aiCalls: 7,
        },
      }, { status: 502 })),
    })
    const sink = new InMemoryToolLifecycleSink()
    const router = new ToolRouter(new ToolRegistry([createJobsDiscoverTool({ client, fence }) as RuntimeToolDefinition]), new ToolLifecycle({
      sink, references: new InMemoryToolResultReferenceStore(),
    }), discoveryPolicy())

    const result = await router.execute(context(), { id: "call-1", toolName: "jobs.discover", toolVersion: "1", input })
    const failedEvent = sink.events.find(event => event.phase === "failed")
    const failureOutput = JSON.stringify(result.output)

    expect(result).toMatchObject({ status: "failed", errorCode: "provider_unavailable", output: { usage: safeUsage } })
    expect(sink.events.map(event => event.phase)).toEqual(["started", "failed"])
    expect(failedEvent?.item).toMatchObject({ status: "failed", errorCode: "provider_unavailable", output: { usage: safeUsage } })
    expect(failedEvent?.payload.output).toEqual({ usage: safeUsage })
    for (const privateValue of privateValues) {
      expect(failureOutput).not.toContain(privateValue)
      expect(JSON.stringify(failedEvent?.payload.output)).not.toContain(privateValue)
    }
  })
})
