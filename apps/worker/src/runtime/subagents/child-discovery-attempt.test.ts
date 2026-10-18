import { describe, expect, it } from "vitest"
import { PolicyEngine } from "../policy/engine.js"
import { InMemoryToolLifecycleSink, ToolLifecycle } from "../tools/lifecycle.js"
import { createJobsDiscoverTool, type JobDiscoveryExecutionFence } from "../tools/job-discover-tool.js"
import { JobDiscoveryClientError, type JobDiscoveryClient, type JobDiscoveryUsageSummary } from "../tools/job-discovery-client.js"
import { ToolRegistry } from "../tools/registry.js"
import { ToolRouter } from "../tools/router.js"
import type { RuntimeToolDefinition } from "../tools/types.js"

import {
  createChildDiscoveryAttemptCollector,
  DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
  parseDiscoveryAttemptHealth,
  parseDiscoveryAttemptSidecar,
} from "./child-discovery-attempt.js"
import type { DiscoveryAttemptLifecycleEvent, LifecycleCall } from "../tools/lifecycle.js"

const fence = { taskId: "task-1", rootTaskId: "root-1", sessionId: "session-1", turnId: "turn-1", attemptCount: 2 }
const call: LifecycleCall = {
  id: "call-1", toolName: "jobs.discover", toolVersion: "1", sessionId: fence.sessionId,
  turnId: fence.turnId, stepId: "step-1", taskId: fence.taskId, rootTaskId: fence.rootTaskId,
}

function usage(overrides: Record<string, unknown> = {}) {
  return {
    ledgerKey: "server-ledger-key", toolName: "jobs.discover", toolVersion: "1", toolCallId: call.id,
    sessionId: call.sessionId, turnId: call.turnId, stepId: call.stepId,
    requests: 1, jobsProcessed: 0, jobsSucceeded: 0, jobsFailed: 0, providerFailures: 0,
    aiCalls: 0, providers: ["provider-private"], estimatedCostUsd: 0, durationMs: 1, ...overrides,
  }
}

function output(overrides: Record<string, unknown> = {}) {
  return { jobs: [], evidence: [], nextCursor: null, usage: usage(), ...overrides }
}

function failureUsage(overrides: Partial<JobDiscoveryUsageSummary> = {}): JobDiscoveryUsageSummary {
  return {
    requests: 2, jobsProcessed: 3, jobsSucceeded: 1, jobsFailed: 2, providerFailures: 1,
    providers: ["greenhouse", "lever"], estimatedCostUsd: 0.004, durationMs: 321, ...overrides,
  }
}

function observe(collector: ReturnType<typeof createChildDiscoveryAttemptCollector>, event: DiscoveryAttemptLifecycleEvent): void {
  collector.observeLifecycleEvent(event)
}

describe("child discovery attempt health", () => {
  it("distinguishes a captured empty response from provider failure and does not claim search exhaustion", () => {
    const collector = createChildDiscoveryAttemptCollector(fence)
    observe(collector, { call, phase: "started" })
    observe(collector, { call, phase: "completed", output: output() })

    expect(collector.sidecar()).toEqual({
      attemptCount: 2,
      health: {
        schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
        attemptedCalls: 1, completedCalls: 1, failedCalls: 0, unresolvedCalls: 0,
        candidateCount: 0, providerFailures: 0, materializationFailures: 0, hasMore: false,
      },
    })
    const failedProviders = createChildDiscoveryAttemptCollector(fence)
    observe(failedProviders, { call, phase: "started" })
    observe(failedProviders, { call, phase: "completed", output: output({ usage: usage({ providerFailures: 2 }) }) })
    expect(failedProviders.sidecar()?.health).toMatchObject({ candidateCount: 0, providerFailures: 2, hasMore: false })
    expect(failedProviders.sidecar()?.health).not.toHaveProperty("searchComplete")
  })

  it("retains safe failure counters while candidate count and cursor remain unknown", () => {
    const collector = createChildDiscoveryAttemptCollector(fence)
    observe(collector, { call, phase: "started" })
    observe(collector, { call, phase: "failed", output: { usage: failureUsage() } })
    expect(collector.sidecar()?.health).toEqual({
      schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
      attemptedCalls: 1, completedCalls: 0, failedCalls: 1, unresolvedCalls: 0,
      candidateCount: null, providerFailures: 1, materializationFailures: 2, hasMore: null,
    })
    expect(JSON.stringify(collector.sidecar())).not.toMatch(/greenhouse|lever|ledger|toolCallId/i)
  })

  it("fails closed on an unrecognized server failure usage receipt", () => {
    const collector = createChildDiscoveryAttemptCollector(fence)
    observe(collector, { call, phase: "started" })
    observe(collector, { call, phase: "failed", output: { usage: { ...failureUsage(), privateProviderId: "do-not-project" } } })
    expect(collector.sidecar()?.health).toMatchObject({
      attemptedCalls: 1, failedCalls: 1, unresolvedCalls: 0,
      candidateCount: null, providerFailures: null, materializationFailures: null, hasMore: null,
    })
  })

  it("captures the reduced JobDiscoveryClientError usage through ToolRouter and persisted lifecycle events", async () => {
    const collector = createChildDiscoveryAttemptCollector(fence)
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink, onDiscoveryAttemptLifecycleEvent: event => collector.observeLifecycleEvent(event) })
    const discoveryFence: JobDiscoveryExecutionFence = {
      userId: "user-1", sessionId: fence.sessionId, turnId: fence.turnId, taskId: fence.taskId, rootTaskId: fence.rootTaskId,
      role: "scout", leaseOwner: "worker-1", attemptCount: fence.attemptCount,
    }
    const client: JobDiscoveryClient = {
      discover: async () => { throw new JobDiscoveryClientError("provider_unavailable", failureUsage()) },
    }
    const tool = createJobsDiscoverTool({ client, fence: discoveryFence }) as RuntimeToolDefinition
    const router = new ToolRouter(new ToolRegistry([tool]), lifecycle, new PolicyEngine({ snapshot: { version: "policy.v1", rules: [{
      id: "test-discovery-write", roles: ["subagent"], tools: ["jobs.discover"], toolVersions: ["1"], risks: ["internal_write"],
      domains: ["jobs"], requiredCapabilities: ["read"], outcome: "allow", reasonCode: "test_discovery_allowed", reason: "Test-only exact discovery permission",
    }] } }))
    const result = await router.execute({
      scope: { userId: "user-1" }, sessionId: fence.sessionId, turnId: fence.turnId, stepId: call.stepId,
      taskId: fence.taskId, rootTaskId: fence.rootTaskId, actorRole: "subagent", capabilities: ["read"], signal: new AbortController().signal,
    }, { id: call.id, toolName: "jobs.discover", toolVersion: "1", input: { targetRoles: ["Engineer"], targetLocations: ["Dublin"] } })

    expect(result).toMatchObject({ status: "failed", errorCode: "provider_unavailable", output: { usage: failureUsage() } })
    expect(sink.events.map(event => event.phase)).toEqual(["started", "failed"])
    expect(collector.sidecar()?.health).toEqual({
      schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
      attemptedCalls: 1, completedCalls: 0, failedCalls: 1, unresolvedCalls: 0,
      candidateCount: null, providerFailures: 1, materializationFailures: 2, hasMore: null,
    })
  })

  it("marks an observed start without a captured terminal result unresolved", () => {
    const collector = createChildDiscoveryAttemptCollector(fence)
    observe(collector, { call, phase: "started" })
    expect(collector.sidecar()?.health).toEqual({
      schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
      attemptedCalls: 1, completedCalls: 0, failedCalls: 0, unresolvedCalls: 1,
      candidateCount: null, providerFailures: null, materializationFailures: null, hasMore: null,
    })
  })

  it("deduplicates identical lifecycle callbacks and rejects conflicting or terminal-only events", () => {
    const collector = createChildDiscoveryAttemptCollector(fence)
    observe(collector, { call, phase: "started" })
    const terminal: DiscoveryAttemptLifecycleEvent = { call, phase: "completed", output: output() }
    observe(collector, terminal)
    observe(collector, terminal)
    expect(collector.sidecar()?.health.attemptedCalls).toBe(1)

    const conflicting = createChildDiscoveryAttemptCollector(fence)
    observe(conflicting, { call, phase: "started" })
    observe(conflicting, terminal)
    observe(conflicting, { call, phase: "completed", output: output({ jobs: [{}] }) })
    expect(conflicting.sidecar()).toBeUndefined()

    const missingStart = createChildDiscoveryAttemptCollector(fence)
    observe(missingStart, terminal)
    expect(missingStart.sidecar()).toBeUndefined()
  })

  it("fails closed on mismatched task fences, cap overflow, and malformed receipts", () => {
    const wrongTask = createChildDiscoveryAttemptCollector(fence)
    observe(wrongTask, { call: { ...call, taskId: "other-task" }, phase: "started" })
    expect(wrongTask.sidecar()).toBeUndefined()

    const overflow = createChildDiscoveryAttemptCollector(fence)
    for (let index = 0; index < 33; index += 1) {
      const currentCall = { ...call, id: `call-${index}`, stepId: `step-${index}` }
      observe(overflow, { call: currentCall, phase: "started" })
    }
    expect(overflow.sidecar()).toBeUndefined()

    const malformed = createChildDiscoveryAttemptCollector(fence)
    observe(malformed, { call, phase: "started" })
    observe(malformed, { call, phase: "completed", output: output({ usage: usage({ toolCallId: "other-call" }) }) })
    expect(malformed.sidecar()?.health).toMatchObject({
      attemptedCalls: 1, completedCalls: 1, unresolvedCalls: 0,
      candidateCount: null, providerFailures: null, materializationFailures: null, hasMore: null,
    })
  })

  it("parses only exact bounded health and current-attempt sidecars", () => {
    const health = {
      schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
      attemptedCalls: 1, completedCalls: 1, failedCalls: 0, unresolvedCalls: 0,
      candidateCount: 0, providerFailures: null, materializationFailures: 0, hasMore: false,
    }
    expect(parseDiscoveryAttemptHealth(health)).toEqual(health)
    expect(parseDiscoveryAttemptHealth({ ...health, extra: "not allowed" })).toBeNull()
    expect(parseDiscoveryAttemptHealth({ ...health, candidateCount: Number.MAX_SAFE_INTEGER })).toBeNull()
    expect(parseDiscoveryAttemptHealth({ ...health, attemptedCalls: 2 })).toBeNull()
    expect(parseDiscoveryAttemptHealth({ ...health, unresolvedCalls: 1 })).toBeNull()
    expect(parseDiscoveryAttemptSidecar({ attemptCount: 1, health }, 2)).toBeNull()
    expect(parseDiscoveryAttemptSidecar({ attemptCount: 2, health }, 2)).toEqual(health)
  })
})
