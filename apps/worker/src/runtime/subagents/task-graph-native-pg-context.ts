import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

import { materializeTaskGraphDependencyContext, isTaskGraphDependencyContextError } from "./task-graph-dependency-context.js"
import { loadTaskGraphDependencyResults } from "./task-graph-pg-dependency-context-loader.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import { TaskGraphCommandError, type TaskGraphNativeCommandInput, type TaskGraphNativeSourceProvenance } from "./task-graph-command-port.js"
import { waitResult } from "../tools/coordination-executor-support.js"
import type { Queryable } from "./pg-store-persistence.js"

type Row = Record<string, unknown>
export type TaskGraphNativeSource = Row & { provenance: TaskGraphNativeSourceProvenance }

export async function withVerifiedDependencyContext(
  client: Queryable, input: TaskGraphNativeCommandInput, loaded: LoadedGraph,
  source: TaskGraphNativeSource | undefined, context: unknown,
): Promise<{ context: unknown; verifiedNodeKey?: string }> {
  const node = source?.provenance.origin === "task_graph" && source.provenance.status === "completed"
    ? loaded.snapshot?.nodes.find(candidate => candidate.key === source.provenance.graphNodeKey) : undefined
  if (!node || node.verificationDisposition !== "typed") return { context }
  const dependencies = await loadTaskGraphDependencyResults(client, input.scope, [node.key], loaded.snapshot!.nodes)
  try {
    return { context: materializeTaskGraphDependencyContext(context, input.scope, [node.key], dependencies), verifiedNodeKey: node.key }
  } catch (error) {
    if (isTaskGraphDependencyContextError(error)) return { context }
    throw error
  }
}

export function followupContext(callerContext: unknown, source: TaskGraphNativeSource): unknown {
  return {
    callerContext: callerContext ?? null,
    sourceContext: source.context ?? {},
    provenance: {
      kind: "agent.followup", sourceTaskId: source.provenance.taskId,
      sourceStatus: source.provenance.status, sourceAttemptCount: source.provenance.attemptCount,
      priorResult: waitResult(source.result), source: source.provenance,
    },
  }
}

export function taskActions(value: unknown): string[] {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || !item.trim())) {
    throw new TaskGraphCommandError("native_policy_invalid", "native_policy_invalid")
  }
  return parsed as string[]
}

export function intersectTaskActions(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set(left.filter(item => right.includes(item)))]
}

export function graphItem(input: TaskGraphNativeCommandInput, itemId: string, content: unknown, revision: number, now: Date) {
  const timestamp = now.toISOString()
  return {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
    stepId: input.scope.stepId ?? null, taskId: input.scope.parentTaskId, type: "task_graph",
    status: "streaming", phase: null, revision, content,
    startedAt: timestamp, completedAt: null, createdAt: timestamp, updatedAt: timestamp,
  }
}

export function nativePgObject(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { return Object.getPrototypeOf(parsed) === Object.prototype ? parsed as Row : null } catch { return null }
}
