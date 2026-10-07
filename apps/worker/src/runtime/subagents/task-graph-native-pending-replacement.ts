import type { PoolClient } from "pg"
import { NATIVE_VERIFICATION_CONTROL_SCHEMA } from "./native-verification-contract.js"
import { getSubagentRolePolicy } from "./role-policy.js"
import { prepareGraphTransition, persistGraphTransition } from "./task-graph-pg-lifecycle.js"
import { loadTaskGraph, type GraphParent, type LoadedGraph } from "./task-graph-pg-state.js"
import { TaskGraphCommandError, type TaskGraphNativeCommandInput, type TaskGraphNativeCommandReceipt } from "./task-graph-command-port.js"
import { appendNativeGraphCommand } from "./task-graph-native-pg.js"
import { nativeContextMetrics, type NormalizedNativeCommand } from "./task-graph-native-request.js"
import { TASK_GRAPH_NATIVE_TEMPLATE_ID } from "./task-graph-native-state.js"
import { taskGraphItemId, type StoredTaskGraphNode } from "./task-graph-snapshot.js"

const MAX_REPLACE_REVISION = 2_147_483_644
type Row = Record<string, unknown>

export async function replaceUnstartedNativeFollowup(
  client: PoolClient, input: TaskGraphNativeCommandInput, command: NormalizedNativeCommand,
  parent: GraphParent, loaded: LoadedGraph, now = new Date(),
): Promise<TaskGraphNativeCommandReceipt> {
  const request = command.request
  if (request.kind !== "followup" || !("mode" in request) || request.mode !== "replace_unstarted") reject("task_graph_native_input_invalid")
  const revision = loaded.state?.revision
  if (!loaded.snapshot || !loaded.state || !loaded.item || typeof revision !== "number" || !Number.isSafeInteger(revision)) reject("task_graph_state_missing")
  if (revision > MAX_REPLACE_REVISION) reject("revision_limit")
  if (request.expectedRevision !== revision) throw new TaskGraphCommandError("revision_mismatch", "revision_mismatch", revision)
  const sourceId = request.sourceTaskId
  const node = loaded.snapshot.nodes.find(candidate => candidate.taskId === sourceId)
  const current = loaded.state.nodes.find(candidate => candidate.taskId === sourceId)
  if (!node || !current || !eligibleGraphNode(node, current, input.scope.rootTaskId)) reject("native_replacement_source_invalid")
  if (loaded.snapshot.nodes.some(candidate => candidate.taskId !== sourceId
    && (candidate.dependsOn.includes(node.key) || candidate.nativeDelegation?.source?.taskId === sourceId))) {
    reject("native_replacement_source_invalid")
  }
  const source = await readEligibleSource(client, input, node)
  if (!source) reject("native_replacement_source_invalid")
  const transition = await prepareGraphTransition(client, { taskId: sourceId, sessionId: input.scope.sessionId, type: "task.cancelled", attemptCount: 0 })
  if (!transition || "blocked" in transition || transition.duplicate) reject("native_replacement_source_invalid")
  const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'cancelled', "updatedAt" = $6
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $5
      AND "status" = 'queued' AND "attemptCount" = 0 AND "startedAt" IS NULL AND "leaseOwner" IS NULL
      AND "leaseExpiresAt" IS NULL AND "result" IS NULL AND "failureReason" IS NULL
      AND "interruptRequestedAt" IS NULL AND "completedAt" IS NULL AND "closedAt" IS NULL
      AND "nextAttemptAt" IS NULL
      AND EXISTS (SELECT 1 FROM "agent_sessions" AS session WHERE session."id" = $2 AND session."userId" = $7)`,
  [sourceId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.rootTaskId, now, input.scope.userId])
  if (updated.rowCount !== 1) reject("native_replacement_source_invalid")
  await persistGraphTransition(client, transition, now)
  const next = await loadTaskGraph(client, input.scope, true)
  if (!next.state || !next.snapshot || !next.item) reject("task_graph_state_missing")
  const inherited: NormalizedNativeCommand = {
    ...command,
    request: { ...request, constraints: source.constraints, successCriteria: source.successCriteria, context: request.context },
  }
  return appendNativeGraphCommand(client, input, inherited, parent, next)
}

async function readEligibleSource(client: PoolClient, input: TaskGraphNativeCommandInput, node: StoredTaskGraphNode): Promise<{ constraints: string[]; successCriteria: string[] } | null> {
  const result = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
      task."status", task."attemptCount", task."role", task."taskType", task."goal", task."constraints", task."successCriteria",
      task."allowedActions", task."context", task."expectedOutputSchema", task."result", task."failureReason", task."startedAt",
      task."leaseOwner", task."leaseExpiresAt", task."nextAttemptAt", task."completedAt", task."interruptRequestedAt", task."closedAt",
      task."qualityGateResult", task."outputArtifactIds"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $4 AND session."userId" = $5 FOR UPDATE OF task`,
  [node.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId, input.scope.userId])
  const row = result.rows[0] as Row | undefined
  if (result.rows.length !== 1 || !row || row.status !== "queued" || row.attemptCount !== 0
    || row.role !== node.nativeDelegation?.role || row.taskType !== node.nativeDelegation?.taskType || row.goal !== node.goal
    || row.startedAt !== null || row.leaseOwner !== null || row.leaseExpiresAt !== null || row.nextAttemptAt !== null
    || row.result !== null || row.failureReason !== null || row.completedAt !== null || row.interruptRequestedAt !== null
    || row.closedAt !== null || row.qualityGateResult !== null || row.rootTaskId !== input.scope.rootTaskId
    || row.parentTaskId !== input.scope.rootTaskId || row.turnId !== input.scope.turnId || row.sessionId !== input.scope.sessionId) return null
  const role = getSubagentRolePolicy(String(row.role))
  const schema = object(row.expectedOutputSchema), constraints = stringList(row.constraints, 32, 1_000)
  const criteria = stringList(row.successCriteria, 32, 1_000), actions = stringList(row.allowedActions, 32, 1_000)
  const outputIds = stringList(row.outputArtifactIds, 32, 256)
  if (!role || role.actorRole !== "subagent" || role.canManageChildren || role.externalWritesEnabled
    || row.role === "auditor" && row.taskType === "native_verification"
    || schema?.schemaVersion === NATIVE_VERIFICATION_CONTROL_SCHEMA
    || !constraints || !criteria || JSON.stringify(criteria) !== JSON.stringify(node.successCriteria)
    || !actions || !outputIds || outputIds.length > 0) return null
  const metrics = nativeContextMetrics(row.context)
  if (metrics.contextDigest !== node.nativeDelegation?.contextDigest || metrics.contextBytes !== node.nativeDelegation?.contextBytes) return null
  const evidence = await client.query(`SELECT
    EXISTS (SELECT 1 FROM "sub_agent_tasks" child WHERE child."sessionId" = $2 AND child."turnId" = $3
      AND child."rootTaskId" = $4 AND child."parentTaskId" = $1) AS "hasChildren",
    EXISTS (SELECT 1 FROM "sub_agent_tasks" successor WHERE successor."sessionId" = $2 AND successor."turnId" = $3
      AND successor."rootTaskId" = $4 AND successor."context"->'provenance'->>'sourceTaskId' = $1) AS "hasSuccessor",
    EXISTS (SELECT 1 FROM "agent_steps" step WHERE step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $1) AS "hasSteps",
    EXISTS (SELECT 1 FROM "agent_items" item WHERE item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $1) AS "hasItems",
    EXISTS (SELECT 1 FROM "agent_events" event JOIN "agent_sessions" session ON session."id" = event."sessionId"
      JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      WHERE event."sessionId" = $2 AND event."turnId" = $3 AND session."userId" = $7 AND turn."userId" = $7
        AND turn."rootTaskId" = $4 AND ((event."taskId" = $1 AND (event."type" LIKE 'tool_call.%' OR event."type" LIKE 'tool_result.%'))
          OR (event."taskId" = $4 AND event."itemId" = $5 AND event."type" = 'task_graph.lifecycle'
            AND event."payload"->'event'->>'nodeKey' = $6 AND event."payload"->'event'->>'type' = 'task.started'))) AS "hasExecutionEvents"`,
  [node.taskId, input.scope.sessionId, input.scope.turnId, input.scope.rootTaskId,
    taskGraphItemId(input.scope.rootTaskId), node.key, input.scope.userId])
  const flags = evidence.rows[0] as Row | undefined
  if (!flags || flags.hasChildren === true || flags.hasSuccessor === true || flags.hasSteps === true
    || flags.hasItems === true || flags.hasExecutionEvents === true) return null
  return { constraints, successCriteria: criteria }
}

function eligibleGraphNode(node: StoredTaskGraphNode, current: { status: string }, rootTaskId: string): boolean {
  const metadata = node.nativeDelegation
  return node.templateId === TASK_GRAPH_NATIVE_TEMPLATE_ID && node.verificationDisposition === "legacy_unverified"
    && node.dependsOn.length === 0 && current.status === "queued" && !!metadata
    && metadata.callerTaskId === rootTaskId && (metadata.operationKind === "spawn" || metadata.operationKind === "followup")
}

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function stringList(value: unknown, max: number, length: number): string[] | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!Array.isArray(parsed) || parsed.length > max || Reflect.ownKeys(parsed).length !== parsed.length + 1) return null
  const result: string[] = []
  for (let index = 0; index < parsed.length; index += 1) {
    const item: unknown = parsed[index]
    if (!Object.hasOwn(parsed, index) || typeof item !== "string" || item.length < 1 || item.length > length) return null
    result.push(item)
  }
  return result
}
function reject(code: string): never { throw new TaskGraphCommandError(code, code) }
