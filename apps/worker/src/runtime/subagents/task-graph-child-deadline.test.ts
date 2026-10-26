import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION, TASK_GRAPH_NATIVE_TEMPLATE_ID } from "./task-graph-native-state.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"

import {
  isTaskGraphChildDeadlineReached,
  TASK_GRAPH_CHILD_ABSOLUTE_LIFETIME_MS,
  TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON,
  TASK_GRAPH_CHILD_RUNNING_SEGMENT_MS,
} from "./task-graph-child-deadline.js"

describe("TaskGraph child deadline contract", () => {
  it("keeps the server-owned lifetime, segment, and terminal reason stable", () => {
    expect(TASK_GRAPH_CHILD_ABSOLUTE_LIFETIME_MS).toBe(3_600_000)
    expect(TASK_GRAPH_CHILD_RUNNING_SEGMENT_MS).toBe(300_000)
    expect(TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON).toBe("task_graph_child_deadline_exceeded")
  })

  it("treats equality as expired and leaves null deadlines unbounded", () => {
    const deadline = new Date("2026-10-26T12:00:00.000Z")
    expect(isTaskGraphChildDeadlineReached(deadline, new Date(deadline.getTime() - 1))).toBe(false)
    expect(isTaskGraphChildDeadlineReached(deadline, deadline)).toBe(true)
    expect(isTaskGraphChildDeadlineReached(null, deadline)).toBe(false)
  })

  it("parses the persisted typed Scout-envelope and native-node shapes used by migration fixtures", () => {
    const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
      { dependsOn: [], depth: 1, goal: "Find evidence", key: "registered-scout", successCriteria: ["Evidence found"],
        taskId: "scout-task", templateId: "scout", verificationDisposition: "typed",
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
          { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
          { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
        ] },
        registeredScoutEnvelope: { allowedActions: ["jobs.search"],
          expectedOutputSchema: { role: "scout", schemaVersion: ROLE_RESULT_SCHEMA }, role: "scout", taskType: "research" } },
      { dependsOn: [], depth: 1, goal: "Delegate native work", key: "native-child", successCriteria: [],
        taskId: "native-task", templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID, verificationDisposition: "legacy_unverified",
        nativeDelegation: { schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn",
          operationId: "native-migration-fixture", requestFingerprint: "a".repeat(64), callerTaskId: "root-task",
          role: "auditor", taskType: "native_verification", contextDigest: "b".repeat(64), contextBytes: 0 } },
    ] })
    expect(snapshot.nodes.map(node => node.taskId)).toEqual(["scout-task", "native-task"])
  })

  it("backfills only authoritative root-graph members from their original creation time", async () => {
    const migration = await readFile(new URL("../../../../../apps/web/prisma/migrations/20261026180000_add_task_graph_child_deadline/migration.sql", import.meta.url), "utf8")
    const update = migration.slice(migration.lastIndexOf('UPDATE "sub_agent_tasks"'))
    expect(migration).toContain("encode(sha256(convert_to(parent.\"id\", 'UTF8')), 'hex')")
    expect(migration).toContain('AND parent."id" = root."id"')
    expect(migration).toContain("registeredScoutEnvelope")
    expect(migration).toContain("IS NOT TRUE")
    expect(migration).toContain('session."id" = item."sessionId" AND session."userId" = turn."userId"')
    expect(migration).toContain("child.\"createdAt\" + INTERVAL '60 minutes'")
    expect(migration).toContain("turn.\"source\" <> 'automation' OR turn.\"executionMode\" = 'canonical_task_graph'")
    expect(update).toContain('WHERE task."id" = eligible."id" AND task."absoluteDeadlineAt" IS NULL')
    expect(update).not.toContain('"leaseSegmentStartedAt"')
  })
})
