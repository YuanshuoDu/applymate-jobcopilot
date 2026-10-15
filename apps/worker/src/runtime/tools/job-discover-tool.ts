import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { JobDiscoveryClientError, type JobDiscoveryClient, type JobDiscoveryCriteria, type JobDiscoveryRequest } from "./job-discovery-client.js"
import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "./types.js"

const id = Type.String({ minLength: 1, maxLength: 256 })
const nonEmptyText = (maxLength: number) => Type.String({ minLength: 1, maxLength })
const JobDiscoverInputSchema = Type.Object({
  targetRoles: Type.Array(nonEmptyText(160), { minItems: 1, maxItems: 8 }),
  targetLocations: Type.Array(nonEmptyText(160), { maxItems: 8 }),
  source: Type.Optional(nonEmptyText(80)),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  cursor: Type.Optional(nonEmptyText(512)),
}, { additionalProperties: false })

const JobSchema = Type.Object({
  id, title: nonEmptyText(500), company: nonEmptyText(500), location: Type.String({ maxLength: 500 }),
  url: nonEmptyText(4096), description: Type.String({ maxLength: 100_000 }), fullDescription: Type.String({ maxLength: 100_000 }),
  salary: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]), logo: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
  source: nonEmptyText(80), evidenceRefs: Type.Array(id, { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false })
const EvidenceSchema = Type.Object({
  evidenceId: id, jobId: id, kind: Type.Union([Type.Literal("source"), Type.Literal("enrichment"), Type.Literal("analysis"), Type.Literal("comparison")]),
  source: nonEmptyText(80), url: nonEmptyText(4096), summary: nonEmptyText(1000),
}, { additionalProperties: false })
const UsageSchema = Type.Object({
  ledgerKey: id, toolName: id, toolVersion: id, toolCallId: id, sessionId: id, turnId: id, stepId: id,
  requests: Type.Integer({ minimum: 0 }), jobsProcessed: Type.Integer({ minimum: 0 }), jobsSucceeded: Type.Integer({ minimum: 0 }),
  jobsFailed: Type.Integer({ minimum: 0 }), providerFailures: Type.Optional(Type.Integer({ minimum: 0 })), aiCalls: Type.Integer({ minimum: 0 }),
  providers: Type.Array(nonEmptyText(80), { maxItems: 32 }), estimatedCostUsd: Type.Number({ minimum: 0 }), durationMs: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
const JobDiscoverOutputSchema = Type.Object({
  jobs: Type.Array(JobSchema, { maxItems: 50 }), evidence: Type.Array(EvidenceSchema, { maxItems: 400 }),
  nextCursor: Type.Union([nonEmptyText(512), Type.Null()]), usage: UsageSchema,
}, { additionalProperties: false })

export type JobDiscoveryExecutionFence = Readonly<{
  userId: string; sessionId: string; turnId: string; taskId: string; rootTaskId: string
  role: "scout"; leaseOwner: string; attemptCount: number
}>
export type JobDiscoverToolOptions = Readonly<{ client: JobDiscoveryClient; fence: JobDiscoveryExecutionFence }>

type TrustedDiscoveryScope = Omit<JobDiscoveryRequest, keyof JobDiscoveryCriteria>

function validateContext(context: ToolExecutionContext, fence: JobDiscoveryExecutionFence): TrustedDiscoveryScope {
  const callId = context.toolCallId
  if (context.signal.aborted) throw new ToolExecutionError("cancelled", "Job discovery was interrupted")
  if (context.actorRole !== "subagent" || context.scope.userId !== fence.userId || context.sessionId !== fence.sessionId
    || context.turnId !== fence.turnId || context.taskId !== fence.taskId || context.rootTaskId !== fence.rootTaskId
    || !context.stepId.trim() || context.stepId.length > 256 || typeof callId !== "string" || !callId.trim() || callId.length > 256
    || !fence.leaseOwner.trim() || !Number.isSafeInteger(fence.attemptCount) || fence.attemptCount < 1) {
    throw new ToolExecutionError("job_discovery_context_unavailable", "The active Scout execution scope could not be verified")
  }
  return {
    userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId, stepId: context.stepId,
    toolCallId: callId, taskId: context.taskId, rootTaskId: context.rootTaskId, role: fence.role,
    leaseOwner: fence.leaseOwner, attemptCount: fence.attemptCount,
  }
}

export function createJobsDiscoverTool(options: JobDiscoverToolOptions): RuntimeToolDefinition<JobDiscoveryCriteria, unknown> {
  return {
    schemaVersion, name: "jobs.discover", version: "1",
    description: "Discover jobs through approved providers and save them to the current Scout owner's job list.",
    capabilities: ["read", "write"], inputSchema: JobDiscoverInputSchema, outputSchema: JobDiscoverOutputSchema,
    risk: "internal_write", domain: "jobs", idempotency: "idempotent", timeoutMs: 30_000, requiredCapabilities: ["read"],
    execute: async (context, input) => {
      const trusted = validateContext(context, options.fence)
      const criteria: JobDiscoveryCriteria = {
        targetRoles: input.targetRoles, targetLocations: input.targetLocations,
        ...(input.source === undefined ? {} : { source: input.source }), ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }
      try {
        const output = await options.client.discover({ ...trusted, ...criteria }, context.signal)
        if (context.signal.aborted) throw new JobDiscoveryClientError("cancelled")
        return output
      }
      catch (error: unknown) {
        if (error instanceof JobDiscoveryClientError) {
          const safeOutput = error.usage ? { usage: error.usage } : undefined
          throw new ToolExecutionError(error.code, "The job discovery request failed", safeOutput)
        }
        throw new ToolExecutionError("job_discovery_failed", "The job discovery request failed")
      }
    },
  }
}
