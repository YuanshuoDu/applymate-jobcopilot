import { describe, expect, it } from "vitest"
import { canonicalNativeVerificationJson, digestNativeVerificationValue, type NativeVerificationPacket } from "./native-verification-contract.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import { ensureNativeVerificationControl, nativeVerificationControlContentMatches } from "./native-verification-pg-request.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"

type Row = Record<string, unknown>

describe("native verification durable request replay identity", () => {
  it("ignores root review feedback in stable packet replay while retaining it in the persisted packet", () => {
    const packet: NativeVerificationPacket = {
      schemaVersion: "agent-harness.v2.native-verifier-packet.v1", controlOperationId: "operation-1", controlTaskId: "control-1",
      goal: "Meet the original goal", criteria: [{ criterionId: "criterion-1", requirement: "Use source facts" }],
      target: { kind: "root_goal", candidateDigest: "a".repeat(64), referenceId: "candidate:1", candidateText: "answer" },
      evidence: [
        { referenceId: "history:1", kind: "review_history", summary: "prior review was negative" },
        { referenceId: "graph:1", kind: "graph_history", summary: "persisted graph facts" },
      ],
    }
    const replay = { goal: packet.goal, criteria: packet.criteria, target: packet.target, evidence: [
      { referenceId: "history:2", kind: "review_history", summary: "different prior feedback" }, packet.evidence[1]!,
    ] }
    expect(nativeVerificationControlContentMatches(packet, replay)).toBe(true)
    expect(nativeVerificationControlContentMatches(packet, { ...replay, evidence: [replay.evidence[0]!,
      { referenceId: "graph:1", kind: "graph_history", summary: "changed source facts" }] })).toBe(false)
    expect(packet.evidence[0]?.summary).toContain("prior review was negative")
  })

  it("does not ignore child packet evidence changes during replay validation", () => {
    const packet = {
      schemaVersion: "agent-harness.v2.native-verifier-packet.v1", controlOperationId: "operation-2", controlTaskId: "control-2",
      goal: "Review child", criteria: [{ criterionId: "criterion-1", requirement: "Use exact tool output" }],
      target: { kind: "child", taskId: "child-1", attempt: 1, resultDigest: "b".repeat(64), referenceId: "target:1", resultText: "{}" },
      evidence: [{ referenceId: "tool:1", kind: "tool_result", summary: "persisted fact" }],
    } as NativeVerificationPacket
    expect(nativeVerificationControlContentMatches(packet, { goal: packet.goal, criteria: packet.criteria,
      target: packet.target, evidence: [{ referenceId: "tool:1", kind: "tool_result", summary: "changed fact" }] })).toBe(false)
  })

  it("clears inherited parent actions in the atomic control bind before dispatch", async () => {
    const ids = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
    const parentActions = ["jobs.search", "agent.spawn", "agent.followup"]
    const parent: Row = {
      ...ids, id: ids.rootTaskId, parentTaskId: null, path: "/root-1", depth: 0, role: "orchestrator", taskType: "root",
      status: "running", goal: "Original goal", constraints: [], successCriteria: [], allowedActions: parentActions,
      context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 1, maxAttempts: 2,
      nextAttemptAt: null, leaseOwner: "turn-owner", leaseExpiresAt: new Date(), interruptRequestedAt: null,
      budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } },
      modelProfileSnapshot: {}, toolPolicySnapshot: {},
    }
    const scope: TaskGraphExecutionScope = {
      ...ids, parentTaskId: ids.rootTaskId, stepId: "root-step", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1,
      parentLeaseOwner: "root-owner", parentAttemptCount: 1,
    }
    const targetResult = { status: "completed", fact: "source fact" }
    const resultDigest = digestNativeVerificationValue(targetResult)
    const content: NativeVerificationPacketContent = {
      goal: "Independently review the child result",
      criteria: [{ criterionId: "criterion-1", requirement: "Use the exact persisted source fact" }],
      target: { kind: "child", taskId: "target-task", attempt: 1, resultDigest,
        referenceId: "target:target-task", resultText: canonicalNativeVerificationJson(targetResult) },
      evidence: [{ referenceId: "fact:1", kind: "tool_result", summary: "{\"fact\":\"source fact\"}" }],
    }
    const target = { kind: "child" as const, nodeId: "node-1", nativeOperationId: "native-op-1",
      fingerprint: "a".repeat(64), taskId: "target-task", attempt: 1, resultDigest }
    const calls: Array<{ sql: string; values: unknown[] }> = []
    const outboxTopics: string[] = []
    const state: { taskRow: Row | null; allowedActionsBeforeBind: unknown } = { taskRow: null, allowedActionsBeforeBind: undefined }
    const queryResult = (rows: Row[] = []) => ({ rows, rowCount: rows.length })
    const client = {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values })
        if (sql.startsWith('SELECT task."id"') && sql.includes('task."role" = \'auditor\'')
          && sql.includes('task."taskType" = \'native_verification\'')) return queryResult()
        if (sql.startsWith('SELECT session."id"') && sql.includes('pause_request')) return queryResult([{ id: ids.sessionId }])
        if (sql.startsWith('SELECT "id" FROM "agent_turns"') && sql.includes("FOR UPDATE")) return queryResult([{ id: ids.turnId }])
        if (sql.includes('SELECT "rootTaskId", "turnId" FROM "sub_agent_tasks"')) return queryResult([{ rootTaskId: ids.rootTaskId, turnId: ids.turnId }])
        if (sql.includes('SELECT root."id", root."turnId", root."status"')) return queryResult([{ id: ids.rootTaskId, turnId: ids.turnId, status: "running", interruptRequestedAt: null }])
        if (sql.includes('SELECT "id", "rootTaskId", "path", "depth", "status", "allowedActions"')
          && sql.includes('FROM "sub_agent_tasks"') && sql.includes("FOR UPDATE")) return queryResult([parent])
        if (sql.startsWith('SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks"')) return queryResult([{ count: 0 }])
        if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) {
          state.taskRow = {
            id: values[0], sessionId: values[1], turnId: values[2], rootTaskId: values[3], parentTaskId: values[4],
            path: values[5], depth: values[6], role: values[7], taskType: values[8], goal: values[9],
            constraints: JSON.parse(String(values[10])) as unknown, successCriteria: JSON.parse(String(values[11])) as unknown,
            allowedActions: JSON.parse(String(values[12])) as unknown, context: JSON.parse(String(values[13])) as unknown,
            expectedOutputSchema: JSON.parse(String(values[14])) as unknown, modelProfileSnapshot: JSON.parse(String(values[15])) as unknown,
            toolPolicySnapshot: JSON.parse(String(values[16])) as unknown, budgetSnapshot: JSON.parse(String(values[17])) as unknown,
            status: "queued", result: null, failureReason: null, attemptCount: 0, maxAttempts: values[18], nextAttemptAt: null,
            leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, userId: ids.userId,
          }
          return queryResult([{ id: String(values[0]) }])
        }
        if (sql.includes('FROM "sub_agent_tasks" task JOIN "agent_sessions" session') && sql.includes('WHERE task."id" = $1')) {
          return state.taskRow ? queryResult([state.taskRow]) : queryResult()
        }
        if (sql.startsWith('UPDATE "sub_agent_tasks" AS task SET')) {
          state.allowedActionsBeforeBind = state.taskRow?.allowedActions
          if (sql.includes('\"allowedActions\" = \'[]\'::jsonb') && state.taskRow) state.taskRow.allowedActions = []
          if (state.taskRow) {
            state.taskRow.expectedOutputSchema = JSON.parse(String(values[5])) as unknown
            state.taskRow.context = JSON.parse(String(values[6])) as unknown
          }
          return queryResult(state.taskRow ? [{ id: state.taskRow.id }] : [])
        }
        if (sql.startsWith('INSERT INTO "agent_outbox"')) {
          outboxTopics.push(sql.includes("'agent.subagent.dispatch'") ? "agent.subagent.dispatch" : "agent.session.event")
          return queryResult([{ id: "outbox-intent" }])
        }
        if (sql.startsWith('UPDATE "agent_sessions" AS session') && sql.includes('SET "eventSequence"')) return queryResult([{ eventSequence: "42" }])
        if (sql.startsWith('INSERT INTO "agent_events"')) return queryResult([{ id: "request-event" }])
        throw new Error(`Unexpected native verification request SQL: ${sql.slice(0, 120)}`)
      },
    }

    const control = await ensureNativeVerificationControl(client as never, { scope, parent, target, content })
    expect(control?.status).toBe("queued")
    expect(parent.allowedActions).toEqual(parentActions)
    expect(state.allowedActionsBeforeBind).toEqual(parentActions)
    expect(state.taskRow?.allowedActions).toEqual([])
    const bindIndex = calls.findIndex(call => call.sql.startsWith('UPDATE "sub_agent_tasks" AS task SET'))
    const dispatchIndex = calls.findIndex(call => call.sql.startsWith('INSERT INTO "agent_outbox"') && call.sql.includes("'agent.subagent.dispatch'"))
    expect(calls[bindIndex]?.sql).toContain('\"allowedActions\" = \'[]\'::jsonb')
    expect(bindIndex).toBeGreaterThan(-1)
    expect(dispatchIndex).toBeGreaterThan(bindIndex)
    expect(outboxTopics).toEqual(["agent.subagent.dispatch", "agent.session.event"])
  })
})
