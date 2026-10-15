import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import { protocolScope, type ApprovalScopeInput } from "../runtime/approval/types.js"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"
import type { SubagentLease } from "../runtime/subagents/types.js"
import { acknowledgeApplicationFillCancellation, completeApplicationFillForReview, failApplicationFillBeforeBrowser, persistApplicationFillWait } from "./application-task-completion.js"

type FillTaskFixture = { id: string; jobId: string; resumeId: string | null; coverLetterId: string | null; confirmedAnswers: unknown }
type ApprovalMismatch = "turn" | "user" | "session" | "task" | "job" | "scope" | "payload" | "consumed"
type ApprovalFixtureRow = {
  id: string; userId: string; sessionId: string; turnId: string; jobId: string; type: string; taskId: string
  status: string; toolCallId: string; payload: unknown; resourceHash: string; materialHash: string
  answersHash: string; scopeHash: string; nonceHash: string; revision: number; expiresAt: Date
}

function taskPayload(task: FillTaskFixture) {
  return { applicationTaskId: task.id, jobId: task.jobId, resumeId: task.resumeId, coverLetterId: task.coverLetterId }
}

async function artifactFixture(task: FillTaskFixture, userId: string, mismatch = false) {
  const payload = taskPayload(task), answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers ?? null)
  const content = { schemaVersion: "agent-harness.application-submission.v1", ...payload, answersHash }
  const hash = hashArtifactContent(content), artifactId = `application:${task.id}`, taskRef = `application-task:${task.id}`
  return {
    id: artifactId, userId, jobId: task.jobId, artifactType: "application", lifecycle: "base", baseId: artifactId,
    baseHash: hash, content, hash: mismatch ? "sha256:wrong-artifact-hash" : hash,
    constraintHash: hashArtifactContent({ applicationTaskId: task.id, jobId: task.jobId }),
    provenanceRefs: [taskRef], evidenceRefs: [taskRef], previousHash: null, version: 1,
    answersHash, payload, materialHash: await hashAgentReceiptValue("material", payload),
  }
}

async function approvalFixture(
  task: FillTaskFixture, status: string, revision: number, mismatch?: ApprovalMismatch,
): Promise<ApprovalFixtureRow> {
  const artifact = await artifactFixture(task, "user-a")
  const row = {
    id: `application-fill:${task.id}:turn-a`, userId: "user-a", sessionId: "session-a", turnId: "turn-a", jobId: task.jobId,
    type: "submit_application", taskId: "filler-task", status, toolCallId: `application-submit:${task.id}`,
    payload: artifact.payload, resourceHash: artifact.hash, materialHash: artifact.materialHash, answersHash: artifact.answersHash,
    nonceHash: "sha256:fixture-nonce-hash", revision, expiresAt: new Date("2099-11-01T00:00:00.000Z"), scopeHash: "",
  }
  if (mismatch === "turn") row.turnId = "foreign-turn"
  if (mismatch === "user") row.userId = "foreign-user"
  if (mismatch === "session") row.sessionId = "foreign-session"
  if (mismatch === "task") row.taskId = "foreign-task"
  if (mismatch === "job") row.jobId = "foreign-job"
  if (mismatch === "scope") row.resourceHash = "sha256:foreign-resource-hash"
  if (mismatch === "payload") row.payload = { ...artifact.payload, applicationTaskId: "foreign-application" }
  if (mismatch === "consumed") row.status = "consumed"
  const scope: ApprovalScopeInput = {
    userId: row.userId, sessionId: row.sessionId, turnId: row.turnId, jobId: row.jobId,
    toolCallId: row.toolCallId, action: "submit_application", resourceHash: row.resourceHash,
    materialHash: row.materialHash, answersHash: row.answersHash, revision: row.revision, expiresAt: row.expiresAt,
  }
  row.scopeHash = await hashApprovalScope(protocolScope(scope, row.nonceHash))
  return row
}

function fixture(options: {
  subtaskLive?: boolean; subtaskOwnerUserId?: string; subtaskOwner?: string; subtaskAttempt?: number; subtaskInterrupted?: boolean; appStatus?: string; appCheckpoint?: string; appTurnId?: string; sessionStatus?: string
  turnStatus?: string; completionApprovalStatus?: string; approvalMismatch?: ApprovalMismatch; artifactMismatch?: boolean
} = {}) {
  const lease = {
    id: "filler-task", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a",
    role: "application_filler", taskType: "application_fill_for_review", status: "running", attemptCount: 2, maxAttempts: 3,
    leaseOwner: "worker-a", leaseExpiresAt: new Date("2026-11-01T00:00:00.000Z"), interruptRequestedAt: null,
    signal: new AbortController().signal, ownerId: "worker-a", goal: "Fill for review", path: "/root/filler", depth: 1,
    constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null,
    budgetSnapshot: {}, toolPolicySnapshot: {},
  } satisfies SubagentLease
  const turn = { id: "turn-a", status: options.turnStatus ?? "in_progress", revision: options.turnStatus === "waiting_for_approval" ? 5 : 4 }
  const task = { id: "application-a", userId: "user-a", sessionId: "session-a", jobId: "job-a", fillTurnId: options.appTurnId ?? "turn-a",
    fillTurnSessionId: "session-a", fillTurnUserId: "user-a", status: options.appStatus ?? "filling",
    checkpoint: options.appCheckpoint ?? "browser_active", resumeId: "resume-a", coverLetterId: null, confirmedAnswers: { eligible: "yes" } }
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes("set_config")) return { rows: [{ set_config: "user-a" }], rowCount: 1 }
      if (sql.startsWith('SELECT "id" FROM "agent_sessions"') && sql.includes('"status" IN (')) return sql.includes(`'${options.sessionStatus ?? "running"}'`)
        ? { rows: [{ id: "session-a" }], rowCount: 1 } : { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-a" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"') && sql.includes('SELECT "id", "status", "revision"')) return { rows: [turn], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"') && sql.includes('SELECT "id"')) return { rows: [{ id: "turn-a" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" AS "subtask"')) {
        const userId = values[6]
        const missingInterrupt = sql.includes('"interruptRequestedAt" IS NOT NULL') && !options.subtaskInterrupted
        return options.subtaskLive === false || missingInterrupt || userId !== (options.subtaskOwnerUserId ?? "user-a")
          || values[3] !== (options.subtaskOwner ?? lease.ownerId) || values[4] !== (options.subtaskAttempt ?? lease.attemptCount)
          ? { rows: [], rowCount: 0 } : { rows: [{ id: lease.id }], rowCount: 1 }
      }
      if (sql.includes('FROM "application_tasks"')) return { rows: [task], rowCount: 1 }
      if (sql.startsWith('UPDATE "application_tasks"')) {
        if (sql.includes("'turn_stopped_before_submit'")) { task.status = "cancelled"; task.checkpoint = "turn_stopped_before_submit" }
        else if (sql.includes("'fill_prestart_failed'")) { task.status = "failed"; task.checkpoint = "fill_prestart_failed" }
        else {
          task.status = String(values[0] === task.id && sql.includes("'waiting_for_authorization'") ? "waiting_for_authorization" : "waiting_for_user")
          task.checkpoint = String(values[0] === task.id && sql.includes("'form_filled'") ? "form_filled" : values[3] ?? task.checkpoint)
        }
        return { rows: [{ id: task.id }], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO "agent_artifact"')) {
        const [id, userId, jobId, artifactType, hash, content, constraintHash, , provenanceRefs, evidenceRefs] = values
        return { rows: [{ id, userId, jobId, artifactType, lifecycle: "base", baseId: id, baseHash: hash,
          content: JSON.parse(String(content)) as unknown, hash, constraintHash, provenanceRefs, evidenceRefs, previousHash: null,
          version: 1, createdAt: new Date(), updatedAt: new Date() }], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO "agent_approvals"')) {
        const [id, sessionId, taskId, userId, turnId, toolCallId, jobId, type, title, body, , payload, resourceHash, materialHash, answersHash, scopeHash, nonceHash, revision, expiresAt] = values
        return { rows: [{ id, sessionId, taskId, userId, turnId, toolCallId, jobId, type, status: "pending", title, body, payload: JSON.parse(String(payload)),
          resourceHash, materialHash, answersHash, scopeHash, nonceHash, revision, expiresAt, decidedAt: null, consumedAt: null, createdAt: new Date() }], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_artifact"')) return {
        rows: [await artifactFixture(task, lease.userId, options.artifactMismatch)], rowCount: 1,
      }
      if (sql.includes('FROM "agent_approvals"')) return options.completionApprovalStatus
        ? { rows: [await approvalFixture(task, options.completionApprovalStatus, turn.revision - 1, options.approvalMismatch)], rowCount: 1 }
        : { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id" FROM "Job"')) return { rows: [{ id: "job-a" }], rowCount: 1 }
      if (sql.includes("UPDATE \"agent_turns\" SET \"status\" = 'waiting_for_approval'")) {
        turn.status = "waiting_for_approval"; turn.revision += 1; return { rows: [{ id: turn.id }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns" SET "status" = \'waiting_for_user\'')) {
        turn.status = "waiting_for_user"; turn.revision += 1; return { rows: [{ id: turn.id }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_sessions" SET "eventSequence"')) return { rows: [{ eventSequence: "12" }], rowCount: 1 }
      if (sql.includes('INSERT INTO "application_task_events"')) return { rows: [], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_transcript_events"') || sql.includes('INSERT INTO "agent_events"') || sql.includes('INSERT INTO "agent_outbox"') || sql.includes('INSERT INTO "agent_items"')) return { rows: [], rowCount: 1 }
      if (sql.startsWith('UPDATE "agent_sessions"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { lease, turn, task, client, pool, calls }
}

describe("ApplicationTask fill completion", () => {
  it("commits the exact bound Turn, task, artifact, approval wait, and session on one client in lock order", async () => {
    const test = fixture()
    const now = new Date()

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease, now })).resolves.toEqual({ status: "completed" })

    const locks = test.calls.filter(call => call.sql.includes("FOR UPDATE")).map(call => call.sql)
    const first = (fragment: string) => locks.findIndex(sql => sql.includes(fragment))
    expect(first('FROM "agent_sessions"')).toBeLessThan(first('FROM "agent_turns"'))
    expect(first('FROM "agent_turns"')).toBeLessThan(first('FROM "sub_agent_tasks"'))
    expect(first('FROM "sub_agent_tasks"')).toBeLessThan(first('FROM "application_tasks"'))
    expect(test.pool.connect).toHaveBeenCalledOnce()
    expect(test.calls.filter(call => call.sql === "BEGIN")).toHaveLength(1)
    expect(test.calls.some(call => call.sql.includes("ON CONFLICT DO NOTHING RETURNING"))).toBe(true)
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "agent_approvals"') && call.values?.[4] === "turn-a")).toBe(true)
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"') && call.sql.includes("'form_filled'") && call.values?.[1] === "application-a")).toBe(true)
    expect(test.calls.some(call => call.sql.includes('FROM "application_tasks"') && call.values?.slice(0, 3).join(",") === "turn-a,session-a,user-a")).toBe(true)
    expect(test.calls.some(call => call.sql.includes('UPDATE "agent_sessions" SET "status" = \'waiting_for_user\''))).toBe(true)
  })

  it("does not write a task, artifact, approval, or wait when the lease attempt is stale", async () => {
    const test = fixture({ subtaskLive: false })

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "stale" })
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("rejects an application task whose returned binding differs from the leased Turn", async () => {
    const test = fixture({ appTurnId: "foreign-turn" })

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "stale" })
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("checks the lease user against the owning session and Turn before locking its subtask", async () => {
    const test = fixture({ subtaskOwnerUserId: "user-a" })
    test.lease.userId = "user-b"

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "stale" })

    const subtaskLock = test.calls.find(call => call.sql.includes('FROM "sub_agent_tasks"'))
    expect(subtaskLock?.sql).toContain('"session"."userId" = $7')
    expect(subtaskLock?.sql).toContain('"scopedTurn"."userId" = $7')
    expect(subtaskLock?.values?.[6]).toBe("user-b")
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("recovers idempotently when the exact approval is still pending", async () => {
    const test = fixture({
      turnStatus: "waiting_for_approval", appStatus: "waiting_for_authorization",
      appCheckpoint: "form_filled", completionApprovalStatus: "pending",
    })

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "completed" })

    const approvalLookup = test.calls.find(call => call.sql.includes('FROM "agent_approvals"'))
    expect(approvalLookup?.sql).toContain('"status" IN (\'pending\', \'approved\')')
    expect(approvalLookup?.values).toEqual(["application-fill:application-a:turn-a", "user-a"])
    expect(test.calls.some(call => call.sql.includes('FROM "agent_artifact"'))).toBe(true)
    expect(test.turn.status).toBe("waiting_for_approval")
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("recovers idempotently when the exact scoped approval was approved before subagent completion", async () => {
    const test = fixture({
      turnStatus: "waiting_for_approval", appStatus: "waiting_for_authorization",
      appCheckpoint: "form_filled", completionApprovalStatus: "approved",
    })

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "completed" })
    expect(test.calls.some(call => call.sql.includes('FROM "agent_artifact"'))).toBe(true)
    expect(test.calls.some(call => call.sql.includes('FROM "agent_approvals"'))).toBe(true)
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("recovers after approval queues submission only with the exact approved receipt", async () => {
    const test = fixture({ turnStatus: "waiting_for_approval", appStatus: "filling", appCheckpoint: "submission_authorized", completionApprovalStatus: "approved" })

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "completed" })
    expect(test.calls.some(call => call.sql.includes('FROM "agent_artifact"'))).toBe(true)
    expect(test.calls.some(call => call.sql.includes('FROM "agent_approvals"'))).toBe(true)
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it.each(["pending", "consumed"] as const)("rejects submission-queued recovery when approval is %s", async status => {
    const test = fixture({ turnStatus: "waiting_for_approval", appStatus: "filling", appCheckpoint: "submission_authorized", completionApprovalStatus: status })

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "conflict" })
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("recovers a failed queue handoff only as historical fill completion", async () => {
    const test = fixture({ turnStatus: "waiting_for_approval", appStatus: "waiting_for_authorization", appCheckpoint: "queue_retry", completionApprovalStatus: "approved" })

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "completed" })
    expect(test.calls.some(call => call.sql.includes('FROM "agent_artifact"'))).toBe(true)
    expect(test.calls.some(call => call.sql.includes('FROM "agent_approvals"'))).toBe(true)
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it.each(["pending", "consumed"] as const)("rejects queue-retry recovery when approval is %s", async status => {
    const test = fixture({ turnStatus: "waiting_for_approval", appStatus: "waiting_for_authorization", appCheckpoint: "queue_retry", completionApprovalStatus: status })

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "conflict" })
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it.each(["turn", "user", "session", "task", "job", "scope", "payload", "consumed"] as const)(
    "rejects recovery when approval %s binding differs or was consumed", async mismatch => {
      const status = mismatch === "consumed" ? "consumed" : "approved"
      const test = fixture({
        turnStatus: "waiting_for_approval", appStatus: "waiting_for_authorization", appCheckpoint: "form_filled",
        completionApprovalStatus: status, approvalMismatch: mismatch,
      })

      await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "conflict" })
      expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
    },
  )

  it("rejects recovery when the immutable application artifact no longer matches the fill", async () => {
    const test = fixture({
      turnStatus: "waiting_for_approval", appStatus: "waiting_for_authorization", appCheckpoint: "form_filled",
      completionApprovalStatus: "approved", artifactMismatch: true,
    })

    await expect(completeApplicationFillForReview(test.pool, { lease: test.lease })).resolves.toEqual({ status: "conflict" })
    expect(test.calls.some(call => call.sql.includes('FROM "agent_approvals"'))).toBe(false)
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("durably records safe form-input labels and puts only the bound Turn into user wait", async () => {
    const test = fixture()

    await expect(persistApplicationFillWait(test.pool, {
      lease: test.lease, checkpoint: "form_answer_required", detail: "required_field",
      needs: { missing: ["Work authorisation"], sensitive: ["Salary"] }, now: new Date("2026-10-15T12:00:00.000Z"),
    })).resolves.toEqual({ status: "waiting" })

    const event = test.calls.find(call => call.sql.includes('INSERT INTO "application_task_events"'))
    const appUpdate = test.calls.find(call => call.sql.startsWith('UPDATE "application_tasks"'))
    const turnWait = test.calls.find(call => call.sql.includes("UPDATE \"agent_turns\" SET \"status\" = 'waiting_for_user'"))
    const question = JSON.parse(String(appUpdate?.values?.[5])) as { waitId?: unknown; missing?: unknown; sensitive?: unknown }
    expect(event?.values?.[2]).toBe("form_answer_required")
    expect(String(event?.values?.[3])).toContain("missing required application information")
    expect(question).toMatchObject({ missing: ["Work authorisation"], sensitive: ["Salary"] })
    expect(question.waitId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(turnWait?.values).toEqual(["turn-a", "session-a", 4, expect.any(Date)])
    expect(test.calls.some(call => call.sql.includes('FROM "agent_turns"') && call.values?.[0] === "turn-a")).toBe(true)
    expect(test.calls.some(call => call.sql.includes("BEGIN"))).toBe(true)
  })

  it("leaves an existing form-answer wait unchanged on Worker recovery", async () => {
    const test = fixture({ appStatus: "waiting_for_user", appCheckpoint: "form_answer_required", turnStatus: "waiting_for_user" })

    await expect(persistApplicationFillWait(test.pool, {
      lease: test.lease, checkpoint: "form_answer_required", detail: "required_field",
    })).resolves.toEqual({ status: "waiting" })

    expect(test.calls.some(call => call.sql.startsWith('UPDATE "application_tasks"'))).toBe(false)
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"'))).toBe(false)
  })

  it("persists a browser-start uncertainty as a wait without creating another artifact or approval", async () => {
    const test = fixture()

    await expect(persistApplicationFillWait(test.pool, {
      lease: test.lease, checkpoint: "fill_outcome_uncertain", detail: "fill_outcome_uncertain", now: new Date("2026-10-15T12:00:00.000Z"),
    })).resolves.toEqual({ status: "waiting" })

    const update = test.calls.find(call => call.sql.startsWith('UPDATE "application_tasks"'))
    expect(update?.values?.[3]).toBe("fill_outcome_uncertain")
    expect(update?.values?.[4]).toBe("The browser stopped after starting the fill. This fill does not submit the application. Stop this Turn before requesting another fill attempt.")
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "agent_artifact"') || call.sql.includes('INSERT INTO "agent_approvals"'))).toBe(false)
  })

  it("fails only the exact queued fill on its final exhausted attempt", async () => {
    const test = fixture({ appCheckpoint: "taskgraph_fill_queued" })
    test.lease.attemptCount = test.lease.maxAttempts

    await expect(failApplicationFillBeforeBrowser(test.pool, { lease: test.lease })).resolves.toEqual({ status: "failed" })

    expect(test.task.status).toBe("failed")
    expect(test.task.checkpoint).toBe("fill_prestart_failed")
    const update = test.calls.find(call => call.sql.startsWith('UPDATE "application_tasks"'))
    expect(update?.sql).toContain('"status" = \'filling\' AND "checkpoint" = \'taskgraph_fill_queued\'')
    expect(update?.values).toEqual(["application-a", "user-a", "session-a", "Application fill could not start after the final retry attempt.", expect.any(Date)])
    const event = test.calls.find(call => call.sql.includes('INSERT INTO "application_task_events"'))
    expect(event?.sql).toContain("'fill_prestart_failed'")
    expect(event?.values?.[2]).toBe("Application fill could not start after the final retry attempt.")
    expect(JSON.parse(String(event?.values?.[3]))).toEqual({ turnId: "turn-a", attemptCount: 3, maxAttempts: 3 })
    expect(test.calls.some(call => call.sql.includes('UPDATE "agent_turns"') || call.sql.includes('UPDATE "agent_sessions"'))).toBe(false)
  })

  it("does not persist a pre-browser failure before the final attempt", async () => {
    const test = fixture({ appCheckpoint: "taskgraph_fill_queued" })

    await expect(failApplicationFillBeforeBrowser(test.pool, { lease: test.lease })).resolves.toEqual({ status: "conflict" })
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it("does not rewrite a browser-active or uncertain fill as pre-browser failure", async () => {
    const browserActive = fixture({ appCheckpoint: "browser_active" })
    browserActive.lease.attemptCount = browserActive.lease.maxAttempts
    await expect(failApplicationFillBeforeBrowser(browserActive.pool, { lease: browserActive.lease })).resolves.toEqual({ status: "conflict" })
    expect(browserActive.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)

    const uncertain = fixture({ appStatus: "waiting_for_user", appCheckpoint: "fill_outcome_uncertain", turnStatus: "waiting_for_user" })
    uncertain.lease.attemptCount = uncertain.lease.maxAttempts
    await expect(failApplicationFillBeforeBrowser(uncertain.pool, { lease: uncertain.lease })).resolves.toEqual({ status: "conflict" })
    expect(uncertain.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it.each([
    { title: "a mismatched Turn binding", options: { appCheckpoint: "taskgraph_fill_queued", appTurnId: "foreign-turn" } },
    { title: "a lost child lease", options: { appCheckpoint: "taskgraph_fill_queued", subtaskLive: false } },
  ])("does not fail before browser start with $title", async ({ options }) => {
    const test = fixture(options)
    test.lease.attemptCount = test.lease.maxAttempts

    await expect(failApplicationFillBeforeBrowser(test.pool, { lease: test.lease })).resolves.toEqual({ status: "stale" })
    expect(test.calls.some(call => /^(UPDATE|INSERT)/.test(call.sql))).toBe(false)
  })

  it.each(["taskgraph_fill_queued", "browser_active"] as const)("cancels %s only after a durable interrupt under the exact live owner and attempt", async appCheckpoint => {
    const test = fixture({ subtaskInterrupted: true, appCheckpoint })
    const controller = new AbortController(); controller.abort(); test.lease.signal = controller.signal

    await expect(acknowledgeApplicationFillCancellation(test.pool, { lease: test.lease, now: new Date("2026-10-15T12:00:00.000Z") }))
      .resolves.toEqual({ status: "cancelled" })

    const childLock = test.calls.find(call => call.sql.includes('FROM "sub_agent_tasks"'))
    expect(childLock?.sql).toContain('"leaseOwner" = $4')
    expect(childLock?.sql).toContain('"attemptCount" = $5')
    expect(childLock?.sql).toContain('"leaseExpiresAt" > GREATEST($6::timestamptz, clock_timestamp())')
    expect(childLock?.sql).toContain('"interruptRequestedAt" IS NOT NULL')
    expect(childLock?.values?.slice(0, 6)).toEqual(["filler-task", "session-a", "turn-a", "worker-a", 2, new Date("2026-10-15T12:00:00.000Z")])
    expect(test.task).toMatchObject({ status: "cancelled", checkpoint: "turn_stopped_before_submit" })
    expect(test.calls.some(call => call.sql.includes('INSERT INTO "application_task_events"') && call.sql.includes("'fill_cancelled'"))).toBe(true)
    const update = test.calls.find(call => call.sql.startsWith('UPDATE "application_tasks"'))
    expect(update?.sql).toContain('"leaseExpiresAt" > clock_timestamp() AND "interruptRequestedAt" IS NOT NULL')
    expect(update?.values).toEqual(["application-a", "user-a", "session-a", "turn-a", expect.any(Date), "filler-task", "worker-a", 2])
    expect(test.calls.some(call => /^(INSERT|UPDATE)/.test(call.sql) && !call.sql.includes('"application_tasks"') && !call.sql.includes('"application_task_events"'))).toBe(false)
  })

  it("acknowledges an aborted session only with the exact durable filler interrupt", async () => {
    const test = fixture({ sessionStatus: "aborted", subtaskInterrupted: true, appCheckpoint: "browser_active" })
    const controller = new AbortController(); controller.abort(); test.lease.signal = controller.signal

    await expect(acknowledgeApplicationFillCancellation(test.pool, { lease: test.lease })).resolves.toEqual({ status: "cancelled" })
    expect(test.calls.find(call => call.sql.includes('FROM "agent_sessions"'))?.sql).toContain("'aborted'")
    expect(test.task).toMatchObject({ status: "cancelled", checkpoint: "turn_stopped_before_submit" })
  })

  it("does not project cancellation without a durable interrupt or after lease loss", async () => {
    for (const options of [{}, { sessionStatus: "aborted" }, { sessionStatus: "aborted", subtaskInterrupted: true, subtaskLive: false },
      { subtaskInterrupted: true, subtaskOwnerUserId: "user-b" }, { subtaskInterrupted: true, subtaskLive: false },
      { subtaskInterrupted: true, subtaskOwner: "worker-b" }, { subtaskInterrupted: true, subtaskAttempt: 1 }, { subtaskInterrupted: true, appTurnId: "foreign-turn" }]) {
      const test = fixture({ appCheckpoint: "browser_active", ...options })
      const controller = new AbortController(); controller.abort(); test.lease.signal = controller.signal
      await expect(acknowledgeApplicationFillCancellation(test.pool, { lease: test.lease })).resolves.toEqual({ status: "stale" })
      expect(test.calls.some(call => /^(INSERT|UPDATE)/.test(call.sql))).toBe(false)
    }
  })

  it("treats the exact prior cancellation projection idempotently", async () => {
    const test = fixture({ subtaskInterrupted: true, appStatus: "cancelled", appCheckpoint: "turn_stopped_before_submit" })
    const controller = new AbortController(); controller.abort(); test.lease.signal = controller.signal

    await expect(acknowledgeApplicationFillCancellation(test.pool, { lease: test.lease })).resolves.toEqual({ status: "cancelled" })
    expect(test.calls.some(call => /^(INSERT|UPDATE)/.test(call.sql))).toBe(false)
  })
})
