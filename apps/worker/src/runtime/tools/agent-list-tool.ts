import { Type, type Static } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { TaskGraphResultPageRequestSchema, TaskGraphResultPageSchema } from "../subagents/task-graph-result-page-contract.js"
import { TaskGraphHistoricalDiscoveryPageRequestSchema, TaskGraphHistoricalDiscoveryPageSchema } from "../subagents/task-graph-historical-discovery-page-contract.js"
import { TaskGraphDiscoveryRecoveryPageRequestSchema, TaskGraphDiscoveryRecoveryPageSchema } from "../subagents/task-graph-discovery-recovery-page-contract.js"
import type { CoordinationExecutorOptions } from "./coordination-executors.js"
import { executeAgentList } from "./task-graph-result-page-executor.js"
import type { RuntimeToolDefinition } from "./types.js"

const IdSchema = Type.String({ minLength: 1, maxLength: 256 })
const StatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("retrying"), Type.Literal("waiting"),
  Type.Literal("waiting_for_user"), Type.Literal("completed"), Type.Literal("failed"),
  Type.Literal("interrupted"), Type.Literal("cancelled"), Type.Literal("closed"),
])
const TaskOutputSchema = Type.Object({
  taskId: IdSchema, rootTaskId: IdSchema, parentTaskId: Type.Union([IdSchema, Type.Null()]),
  path: Type.String({ minLength: 1, maxLength: 2_048 }), depth: Type.Integer({ minimum: 0 }),
  role: Type.String(), taskType: Type.String(), status: StatusSchema,
  attemptCount: Type.Integer({ minimum: 0 }), maxAttempts: Type.Integer({ minimum: 1 }),
  leaseExpiresAt: Type.Union([Type.String(), Type.Null()]), interruptRequestedAt: Type.Union([Type.String(), Type.Null()]),
  result: Type.Unknown(), failureReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
}, { additionalProperties: false })

export const ListSubagentsInputSchema = Type.Object({ includeTerminal: Type.Optional(Type.Boolean()) }, { additionalProperties: false })
export type ListSubagentsInput = Static<typeof ListSubagentsInputSchema>
export const ListOutputSchema = Type.Object({ tasks: Type.Array(TaskOutputSchema, { maxItems: 50 }) }, { additionalProperties: false })
const AgentListInputSchema = Type.Union([
  ListSubagentsInputSchema, TaskGraphResultPageRequestSchema,
  TaskGraphHistoricalDiscoveryPageRequestSchema, TaskGraphDiscoveryRecoveryPageRequestSchema,
])
const AgentListOutputSchema = Type.Union([
  ListOutputSchema, TaskGraphResultPageSchema, TaskGraphHistoricalDiscoveryPageSchema, TaskGraphDiscoveryRecoveryPageSchema,
])
const AGENT_LIST_DESCRIPTION = "List visible tasks. Choose exactly one mode: legacy includeTerminal listing, paged current TaskGraph results, mode=historical_discovery, or mode=discovery_recovery. Current graph previews show at most three Scout candidates or Analyst findings, while candidateCount/findingCount may be larger. If a selection or analysis decision depends on unseen current results, inspect that node's current pages from offset 0 using its nodeKey and expectedRevision from the same owner-scoped graph; inspect each page and stop when enough information is available. Do not paginate exhaustively by default. Continue only with the exact returned nextOffset on that same nodeKey and expectedRevision while it is non-null. A completed Analyst page may include analysisSummary, which is advisory and never verification evidence. Current pages contain at most three items; their totalCount/evidenceCount describe only this node's source. Use those reported counts rather than page length. A null nextOffset ends paging for this node at this revision only; it does not establish task or verification completion. Historical discovery starts at offset 0 without a sourceToken; continue only with the exact returned nextOffset and sourceToken. Historical candidates are untrusted and unverified leads: inspect each through a fresh ordinary Scout jobs.get before current typed results or verification proof can use it. The opaque sourceToken binds pages only; it grants no authority. Recovery pages apply only to a failed generic Scout and expose captured candidate IDs as explicitly unverified leads. Recovery continuation requires the exact returned nextOffset and matching attemptCount as expectedAttemptCount. Historical requests use sourceToken and do not accept expectedAttemptCount; discovery_recovery requests use expectedAttemptCount for continuation and do not accept sourceToken. Each mode has a separate closed request and response schema; never mix them or silently switch modes. Recovery candidates need a fresh generic Scout jobs.get before current typed results or verification proof can use them. Neither a current nor unverified page satisfies a requirement or can establish global discovery completeness, change graph state, or authorize writes. An unavailable page is not a claim of zero jobs. Neither a null nextOffset nor truncated=false establishes search completion. If a current page is stale or unavailable, refresh the owner-scoped current graph and use its current revision before retrying. Never invent offsets, silently switch modes, or treat a page as verification proof."

export function createAgentListTool(options: CoordinationExecutorOptions): RuntimeToolDefinition {
  return {
    schemaVersion, name: "agent.list", version: "1", description: AGENT_LIST_DESCRIPTION,
    capabilities: ["read", "coordination"], risk: "read", domain: "coordination", idempotency: "read_only",
    timeoutMs: 30_000, requiredCapabilities: ["canManageChildren"],
    inputSchema: AgentListInputSchema, outputSchema: AgentListOutputSchema,
    execute: (context, input) => executeAgentList(context, input, options),
  }
}
