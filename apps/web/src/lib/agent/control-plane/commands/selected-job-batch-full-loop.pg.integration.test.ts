import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { PrismaClient } from "@prisma/client"
import { SELECTED_JOB_BATCH_SLOT_IDS, VERIFIED_SHORTLIST_SELECTION_SCHEMA, selectedJobBatchTemplatesForSlot } from "@jobcopilot/agent-protocol"
import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from "@/lib/auth-secret"
import { canonicalTaskGraphItemId } from "@/lib/agent/session/final-task-graph-source-detail"

vi.mock("@/lib/safe-auth", () => ({ safeAuth: async () => null }))

const PG_URL = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci"
const REDIS_URL = "redis://127.0.0.1:6379/15"
const runId = randomUUID().replaceAll("-", "")
const userId = `batch-full-loop-user-${runId}`
const sessionId = `batch-full-loop-session-${runId}`
const sourceTurnId = `batch-full-loop-source-turn-${runId}`
const sourceRootId = `batch-full-loop-source-root-${runId}`
const sourceScoutId = `batch-full-loop-source-scout-${runId}`
const sourceGraphId = canonicalTaskGraphItemId(sourceRootId)
const jobIds = [`batch-full-loop-job-${runId}-1`, `batch-full-loop-job-${runId}-2`] as const
const clientMessageId = `batch-full-loop-command-${runId}`
const resumeId = `batch-full-loop-resume-${runId}`
const selectedJobIds = [...jobIds]

function checkedUrl(value: string | undefined, kind: "postgres" | "redis"): string | null {
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error(`Selected Job batch full-loop requires disposable ${kind}`)
    return null
  }
  const url = new URL(value)
  const valid = kind === "postgres"
    ? process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE === "true" && value === PG_URL && process.env.DATABASE_URL === value
      && url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "5432"
      && url.username === "postgres" && url.password === "postgres" && url.pathname === "/applymate_agent_brain_ci"
      && !url.search && !url.hash
    : process.env.RUN_AGENT_TURN_REDIS_INTEGRATION === "1" && process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE === "true"
      && value === REDIS_URL && process.env.REDIS_URL === value && url.protocol === "redis:"
      && url.hostname === "127.0.0.1" && url.port === "6379" && url.pathname === "/15"
      && !url.username && !url.password && !url.search && !url.hash
  if (!valid) throw new Error(`Selected Job batch full-loop rejects non-dedicated ${kind}`)
  return value
}

const databaseUrl = checkedUrl(process.env.AGENT_RUNTIME_PG_TEST_URL, "postgres")
const redisUrl = checkedUrl(process.env.AGENT_TURN_REDIS_TEST_URL, "redis")
if ((databaseUrl === null) !== (redisUrl === null)) throw new Error("Selected Job batch full-loop requires both disposable services")
if (databaseUrl && redisUrl && process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true") {
  throw new Error("Selected Job batch full-loop requires the explicit disposable PG guard")
}
const enabled = databaseUrl !== null && redisUrl !== null
const describeWithServices = enabled ? describe : describe.skip
const db = new PrismaClient({ datasources: { db: { url: databaseUrl ?? PG_URL } } })
const workerCwd = resolve(process.cwd(), "../worker")
const fixturePath = resolve(workerCwd, "src/queue/selected-job-batch-full-loop.fixture.mjs")

type Fixture = ChildProcess & { readonly lines: string[]; readonly errors: string[]; spawnFailed: boolean }
let worker: Fixture | undefined
let connected = false
let routeDb: PrismaClient | undefined

function startWorker(): Fixture {
  const child = spawn(process.execPath, ["--import", "tsx", "src/queue/selected-job-batch-full-loop.fixture.mjs"], {
    cwd: workerCwd,
    env: {
      ...process.env,
      CI: "true",
      DATABASE_URL: databaseUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl!,
      REDIS_URL: redisUrl!, AGENT_TURN_REDIS_TEST_URL: redisUrl!,
      AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true", AGENT_RUNTIME_PG_TEST_REQUIRED: "true",
      AGENT_TURN_REDIS_TEST_DISPOSABLE: "true", RUN_AGENT_TURN_REDIS_INTEGRATION: "1",
      ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
      SELECTED_JOB_BATCH_FULL_LOOP_USER_ID: userId,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as Fixture
  Object.defineProperties(child, { lines: { value: [] }, errors: { value: [] }, spawnFailed: { value: false, writable: true } })
  child.on("error", () => { child.spawnFailed = true })
  for (const [stream, target] of [[child.stdout, child.lines], [child.stderr, child.errors]] as const) {
    let pending = ""
    stream?.setEncoding("utf8")
    stream?.on("data", chunk => {
      pending += String(chunk)
      const parts = pending.split("\n")
      pending = parts.pop() ?? ""
      target.push(...parts.map(line => line.trim()).filter(Boolean))
    })
  }
  return child
}

function childEnded(child: Fixture): boolean {
  return child.spawnFailed || child.exitCode !== null || child.signalCode !== null
}

function childState(child: Fixture) {
  return { exitCode: child.exitCode, signalCode: child.signalCode, spawnFailed: child.spawnFailed,
    stdoutLineCount: child.lines.length, stderrLineCount: child.errors.length }
}

async function waitForMarker(child: Fixture, marker: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (child.lines.some(line => line === marker || line.startsWith(`${marker} `))) return
    if (childEnded(child)) throw new Error(`Selected Job batch Worker exited before ${marker}; ${JSON.stringify(childState(child))}`)
    await delay(25)
  }
  throw new Error(`Selected Job batch Worker did not reach ${marker}; ${JSON.stringify(childState(child))}`)
}

async function waitForExit(child: Fixture, timeoutMs: number): Promise<boolean> {
  if (childEnded(child)) return true
  return new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once("exit", () => { clearTimeout(timer); resolveExit(true) })
    child.once("error", () => { clearTimeout(timer); resolveExit(true) })
  })
}

async function stopWorker(child: Fixture | undefined): Promise<void> {
  if (!child || childEnded(child)) return
  child.stdin?.write("shutdown\n")
  if (!await waitForExit(child, 10_000)) {
    child.kill("SIGKILL")
    await waitForExit(child, 1_000)
  }
}

function plain(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
  } catch { return null }
}

const DIAGNOSTIC_STATUSES = ["queued", "in_progress", "waiting_for_user", "waiting_for_approval", "running", "retrying", "waiting", "streaming", "started", "completed", "failed", "interrupted", "cancelled", "closed"] as const
const DIAGNOSTIC_ROLES = ["orchestrator", "writer", "reviewer", "scout", "analyst", "prepare", "auditor"] as const
const DIAGNOSTIC_SUMMARY_ROLES = ["orchestrator", "writer", "reviewer", "other"] as const
const DIAGNOSTIC_TOOLS = ["agent.plan", "agent.wait", "cover_letter.draft", "artifact.version.read", "artifact.review"] as const
const DIAGNOSTIC_RESULTS = ["accepted", "duplicate", "ready", "waiting", "passed", "needs_revision", "rejected", "stale", "completed", "failed", "partial", "prepared", "skipped"] as const
const DIAGNOSTIC_FAILURE_CODES = new Set([
  "budget_exhausted", "business_precondition_failed", "child_context_owner_mismatch", "child_resume_unavailable",
  "cover_letter_base_unavailable", "discovery_memory_overflow", "final_unverified", "fixture_child_owner_mismatch",
  "fixture_cross_slot_plan_not_rejected", "fixture_plan_receipt_invalid", "fixture_reviewer_read_receipt_invalid",
  "fixture_reviewer_tool_receipt_invalid", "fixture_selected_job_context_missing", "fixture_turn_owner_mismatch",
  "fixture_wait_limit_exceeded", "fixture_wait_receipt_invalid", "fixture_writer_tool_receipt_invalid", "input_changed",
  "invalid_output", "invalid_provenance", "invalid_structured_result", "no_progress", "not_found", "persistence_conflict",
  "precondition_failed", "receipt_conflict", "root_terminal", "selected_job_base_resume_missing", "selected_job_batch_completion_unavailable",
  "selected_job_batch_plan_invalid", "selected_job_batch_unavailable", "selected_job_context_unavailable", "selected_job_input_unavailable",
  "selected_job_not_found", "selected_job_output_contract_unavailable", "selected_job_scope_invalid", "selected_job_sources_unavailable",
  "stale_hash", "stale_source", "task_fence_denied", "task_graph_revision_mismatch", "task_graph_runtime_dependencies_unavailable",
  "task_graph_schedule_failed", "task_graph_templates_unavailable", "task_graph_verification_unverified", "tool_execution_failed",
  "turn_execution_error", "unrecoverable_error", "writer_review_dependency_invalid", "writer_review_receipt_unavailable",
  "writer_review_status_invalid",
])
const DATABASE_CONSTRAINT_CODES = new Set(["P2002", "P2003", "P2014", "23502", "23503", "23505", "23514"])
const DATABASE_ERROR_CODES = new Set(["40001", "40P01", "57P01"])

function diagnosticEnum(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : "other"
}

function diagnosticFailureCode(value: unknown): string {
  if (value == null) return "none"
  if (typeof value !== "string" || value.length > 512) return "other"
  if (DIAGNOSTIC_FAILURE_CODES.has(value)) return value
  if (DATABASE_CONSTRAINT_CODES.has(value) || /foreign key|23503|P2003/i.test(value)) return "database_constraint"
  if (DATABASE_ERROR_CODES.has(value) || /SQLSTATE|deadlock detected|serialization failure/i.test(value)) return "database_error"
  return "other"
}

function diagnosticAttempt(value: unknown): string {
  return typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ? "other" : value <= 3 ? String(value) : "4+"
}

function diagnosticGroups<T extends Record<string, string>>(rows: readonly T[]) {
  const groups = new Map<string, { row: T; count: number }>()
  for (const row of rows.slice(0, 64)) {
    const key = JSON.stringify(row), previous = groups.get(key)
    groups.set(key, previous ? { ...previous, count: previous.count + 1 } : { row, count: 1 })
  }
  return [...groups.values()].slice(0, 16).map(({ row, count }) => ({ ...row, count }))
}

function diagnosticBatchRole(templateId: unknown): string {
  for (const slot of SELECTED_JOB_BATCH_SLOT_IDS) {
    const templates = selectedJobBatchTemplatesForSlot(slot)
    if (templateId === templates?.writerTemplateId) return "writer"
    if (templateId === templates?.reviewerTemplateId) return "reviewer"
  }
  return "other"
}

function diagnosticToolResult(value: unknown): string {
  if (value == null) return "none"
  const result = plain(value)
  if (!result) return "value"
  const status = result.status ?? result.reviewStatus
  if (typeof status === "string" && DIAGNOSTIC_RESULTS.includes(status as typeof DIAGNOSTIC_RESULTS[number])) return status
  return diagnosticFailureCode(result.code) !== "none" && diagnosticFailureCode(result.code) !== "other" ? "failed" : "value"
}

async function readBatchFailureDiagnostic(turnId: string) {
  const turn = await db.agentTurn.findFirst({ where: { id: turnId, sessionId, userId },
    select: { status: true, executionMode: true, rootTaskId: true, error: true } })
  if (!turn) return { turnStatus: "missing", root: null, children: [], graph: null, tools: [] }
  const rootId = turn.rootTaskId
  const root = rootId ? await db.subAgentTask.findFirst({ where: { id: rootId, sessionId, turnId, rootTaskId: rootId, parentTaskId: null },
    select: { role: true, status: true, failureReason: true } }) : null
  const children = root ? await db.subAgentTask.findMany({ where: { sessionId, turnId, rootTaskId: rootId, parentTaskId: rootId },
    select: { id: true, role: true, status: true, failureReason: true }, orderBy: { createdAt: "asc" }, take: 8 }) : []
  const taskIds = rootId ? [rootId, ...children.map(task => task.id)] : []
  const taskRoles = new Map<string, string>()
  if (root && rootId) taskRoles.set(rootId, diagnosticEnum(root.role, DIAGNOSTIC_ROLES))
  for (const task of children) taskRoles.set(task.id, diagnosticEnum(task.role, DIAGNOSTIC_ROLES))
  const graph = rootId ? await db.agentItem.findFirst({ where: { sessionId, turnId, taskId: rootId, type: "task_graph" },
    orderBy: { revision: "desc" }, select: { status: true, content: true } }) : null
  const items = taskIds.length ? await db.agentItem.findMany({ where: { sessionId, turnId, taskId: { in: taskIds }, type: { in: ["tool_call", "tool_result"] } },
    orderBy: { createdAt: "asc" }, take: 128, select: { type: true, status: true, taskId: true, content: true } }) : []
  const steps = taskIds.length ? await db.agentStep.findMany({ where: { sessionId, turnId, taskId: { in: taskIds } },
    orderBy: { ordinal: "asc" }, take: 128, select: { taskId: true, status: true, attempt: true, errorCode: true } }) : []
  const calls = new Map<string, Record<string, unknown>>()
  for (const item of items) {
    const content = plain(item.content)
    if (item.type === "tool_call" && typeof content?.toolCallId === "string") calls.set(content.toolCallId, content)
  }
  const toolSummary = DIAGNOSTIC_SUMMARY_ROLES.map(role => {
    const roleItems = items.filter(item => diagnosticEnum(taskRoles.get(item.taskId ?? ""), DIAGNOSTIC_SUMMARY_ROLES) === role)
    const toolCalls = roleItems.filter(item => item.type === "tool_call"), toolResults = roleItems.filter(item => item.type === "tool_result")
    const callRows = toolCalls.map(item => { const call = plain(item.content); return {
      tool: diagnosticEnum(call?.toolName, DIAGNOSTIC_TOOLS), status: diagnosticEnum(call?.status ?? item.status, DIAGNOSTIC_STATUSES),
      failureCode: diagnosticFailureCode(call?.errorCode),
    } })
    const resultRows = toolResults.map(item => { const result = plain(item.content), call = typeof result?.toolCallId === "string" ? calls.get(result.toolCallId) : undefined; return {
      tool: diagnosticEnum(call?.toolName, DIAGNOSTIC_TOOLS), status: diagnosticEnum(call?.status ?? item.status, DIAGNOSTIC_STATUSES),
      result: diagnosticToolResult(result?.output), failureCode: diagnosticFailureCode(call?.errorCode ?? result?.errorCode),
    } })
    return { role, toolCallCount: Math.min(toolCalls.length, 64), toolCalls: diagnosticGroups(callRows),
      toolResultCount: Math.min(toolResults.length, 64), toolResults: diagnosticGroups(resultRows) }
  })
  const stepSummary = DIAGNOSTIC_SUMMARY_ROLES.map(role => {
    const roleSteps = steps.filter(step => diagnosticEnum(taskRoles.get(step.taskId ?? ""), DIAGNOSTIC_SUMMARY_ROLES) === role)
    return { role, count: Math.min(roleSteps.length, 64), states: diagnosticGroups(roleSteps.map(step => ({
      status: diagnosticEnum(step.status, DIAGNOSTIC_STATUSES), attempt: diagnosticAttempt(step.attempt), failureCode: diagnosticFailureCode(step.errorCode),
    }))) }
  })
  const nodes = Array.isArray(plain(graph?.content)?.nodes) ? plain(graph?.content)!.nodes as unknown[] : []
  return {
    turn: { status: diagnosticEnum(turn.status, DIAGNOSTIC_STATUSES), executionMode: turn.executionMode === "canonical_task_graph" ? turn.executionMode : "other",
      failureCode: diagnosticFailureCode(turn.error) },
    root: root ? { role: diagnosticEnum(root.role, DIAGNOSTIC_ROLES), status: diagnosticEnum(root.status, DIAGNOSTIC_STATUSES),
      failureCode: diagnosticFailureCode(root.failureReason) } : null,
    children: children.map(task => ({ role: diagnosticEnum(task.role, DIAGNOSTIC_ROLES), status: diagnosticEnum(task.status, DIAGNOSTIC_STATUSES),
      failureCode: diagnosticFailureCode(task.failureReason) })),
    graph: graph ? { status: diagnosticEnum(graph.status, DIAGNOSTIC_STATUSES), nodeCount: Math.min(nodes.length, 16),
      nodes: nodes.slice(0, 16).map(value => { const node = plain(value); return { role: diagnosticBatchRole(node?.templateId), status: diagnosticEnum(node?.status, DIAGNOSTIC_STATUSES) } }) } : null,
    steps: stepSummary, tools: toolSummary,
  }
}

async function bearer(): Promise<string> {
  return new SignJWT({ authVersion: 1 }).setProtectedHeader({ alg: "HS256" })
    .setIssuer(EXTENSION_TOKEN_ISSUER).setAudience(EXTENSION_TOKEN_AUDIENCE)
    .setSubject(userId).setIssuedAt().setExpirationTime("5m").sign(getAuthJwtSecret())
}

async function postBatch(token: string) {
  const { POST } = await import("@/app/api/agent/sessions/[id]/prepare-selected-jobs/route")
  const request = new NextRequest(`http://localhost/api/agent/sessions/${sessionId}/prepare-selected-jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": clientMessageId },
    body: JSON.stringify({ schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, clientMessageId,
      source: { sessionId, sourceTurnId, rootTaskId: sourceRootId, graphItemId: sourceGraphId, graphRevision: 1 }, selectedJobIds }),
  })
  return POST(request, { params: Promise.resolve({ id: sessionId }) })
}

async function waitForPublishedDispatch(turnId: string, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs, idempotencyKey = `turn-dispatch:${turnId}`
  while (Date.now() < until) {
    const rows = await db.agentOutbox.findMany({ where: { topic: "agent.turn.dispatch", aggregateId: sessionId, idempotencyKey },
      select: { id: true, payload: true, publishedAt: true } })
    if (rows.length === 1 && rows[0]?.publishedAt instanceof Date) return rows
    await delay(50)
  }
  throw new Error("Selected Job batch dispatch was not durably published")
}

async function seedSourceAndOwner(): Promise<void> {
  const user = await db.user.create({ data: { id: userId, email: `${runId}@batch-fixture.example.test`, name: "Synthetic Batch Candidate",
    plan: "pro", accountStatus: "active", authVersion: 1 } })
  expect(user).toMatchObject({ accountStatus: "active", authVersion: 1 })
  await db.job.createMany({ data: jobIds.map((id, index) => ({ id, userId, company: `Synthetic Batch Employer ${index + 1}`,
    role: "Software Engineer", location: "Dublin", status: "saved", score: 90 - index,
    url: `https://jobs.example.invalid/${id}`, description: "Synthetic owned role used only by the disposable selected-job batch fixture.",
    keywords: "TypeScript", workflowState: "draft" })) })
  await db.resume.create({ data: { id: resumeId, userId, name: "Synthetic Batch Resume", isDefault: true,
    content: { basics: { name: user.name, email: user.email }, experience: [], education: [], skills: [] } } })
  await db.agentSession.create({ data: { id: sessionId, userId, goal: "Prepare reviewed draft materials for two synthetic jobs", status: "running", source: "selected_job_batch_fixture" } })
  await db.agentTurn.create({ data: { id: sourceTurnId, sessionId, userId, source: "user", status: "completed",
    rootTaskId: sourceRootId, input: { goal: "Find and rank two synthetic roles", intent: { kind: "interactive_discovery_shortlist", version: 1 } },
    modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {}, completedAt: new Date() } })
  const shortlist = { schemaVersion: 1, status: "completed", failures: [], items: jobIds.map((jobId, index) => ({
    jobId, score: 9 - index, evidenceIds: [`read:job:${jobId}`],
  })) }
  const sourceNode = { key: "source-scout", templateId: "scout", goal: "Find synthetic jobs",
    successCriteria: ["Return owner-scoped synthetic Job evidence"], dependsOn: [], depth: 1, taskId: sourceScoutId }
  await db.subAgentTask.create({ data: { id: sourceRootId, sessionId, turnId: sourceTurnId, rootTaskId: sourceRootId,
    parentTaskId: null, path: "/", depth: 0, role: "orchestrator", taskType: "root", status: "completed",
    goal: "Find and rank two synthetic roles", constraints: [], successCriteria: [], allowedActions: [], context: {},
    expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "orchestrator" },
    result: { status: "completed", stepCount: 1, toolCallCount: 0, finalItemId: "synthetic-discovery-final", waitId: null,
      structuredResult: { interactiveDiscoveryShortlist: shortlist } }, completedAt: new Date() } })
  await db.subAgentTask.create({ data: { id: sourceScoutId, sessionId, turnId: sourceTurnId, rootTaskId: sourceRootId,
    parentTaskId: sourceRootId, path: "/1", depth: 1, role: "scout", taskType: "scout", status: "completed",
    goal: "Find synthetic jobs", constraints: [], successCriteria: sourceNode.successCriteria, allowedActions: [], context: {},
    expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" },
    result: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed",
      candidates: jobIds.map(jobId => ({ jobId, source: "fixture", url: null, evidenceIds: [`read:job:${jobId}`] })),
      evidence: jobIds.map(jobId => ({ id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "fixture" })), summary: "Synthetic completed shortlist source" },
    completedAt: new Date() } })
  await db.agentItem.create({ data: { id: sourceGraphId, sessionId, turnId: sourceTurnId, taskId: sourceRootId,
    type: "task_graph", status: "completed", revision: 1, content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [sourceNode] },
    completedAt: new Date() } })
}

async function callBinding(turnId: string) {
  const turn = await db.agentTurn.findFirst({ where: { id: turnId, sessionId, userId }, select: { id: true, input: true, status: true, executionMode: true, rootTaskId: true } })
  const input = plain(turn?.input), binding = plain(input?.verifiedShortlistSelection)
  return { turn, input, binding }
}

describeWithServices("selected-job batch production full-loop", () => {
  beforeAll(async () => {
    if (!enabled) return
    await db.$connect()
    connected = true
  }, 60_000)

  afterAll(async () => {
    await stopWorker(worker)
    if (connected) {
      await db.user.deleteMany({ where: { id: userId } })
      await db.$disconnect()
      if (routeDb) await routeDb.$disconnect()
      connected = false
    }
  }, 60_000)

  it("replays one authenticated batch command through two real Writer/Reviewer pairs and grounded receipts", async () => {
    await seedSourceAndOwner()
    worker = startWorker()
    await waitForMarker(worker, "BATCH_WORKER_READY")

    const { db: importedRouteDb } = await import("@/lib/db")
    routeDb = importedRouteDb
    const token = await bearer()
    const first = await postBatch(token)
    expect(first.status).toBe(202)
    const started = plain(await first.json())
    expect(started).toMatchObject({ disposition: "started" })
    const turnId = started?.turnId
    expect(typeof turnId).toBe("string")
    if (typeof turnId !== "string") throw new Error("Selected Job batch command did not return its canonical Turn")

    await waitForMarker(worker, "BATCH_CROSS_SLOT_REJECTED")
    await waitForMarker(worker, "BATCH_PLAN_PERSISTED")
    const atBarrier = await callBinding(turnId)
    expect(atBarrier.turn).toMatchObject({ status: "in_progress", executionMode: "canonical_task_graph" })
    expect(atBarrier.input?.intent).toEqual({ kind: "selected_job_batch_preparation", version: 1 })
    expect(atBarrier.binding?.selectedJobIds).toEqual(selectedJobIds)
    expect(atBarrier.binding?.source).toEqual({ sessionId, sourceTurnId, rootTaskId: sourceRootId, graphItemId: sourceGraphId, graphRevision: 1 })
    expect(atBarrier.turn?.rootTaskId).toBeTruthy()

    const events = await db.agentItem.findMany({ where: { sessionId, turnId, type: { in: ["tool_call", "tool_result"] } },
      select: { type: true, content: true } })
    const calls = events.filter(item => item.type === "tool_call").map(item => plain(item.content)).filter((item): item is Record<string, unknown> => item !== null)
    const results = new Map(events.filter(item => item.type === "tool_result").map(item => plain(item.content))
      .filter((item): item is Record<string, unknown> => item !== null).map(item => [String(item.toolCallId), item]))
    const batchPlanCalls = calls.filter(call => call.toolName === "agent.plan")
    const rejectedPlan = batchPlanCalls.find(call => call.status === "failed" && call.errorCode === "selected_job_batch_plan_invalid")
    expect(rejectedPlan).toBeDefined()
    const rejectedInput = plain(rejectedPlan?.input)
    const rejectedNodes = Array.isArray(rejectedInput?.nodes) ? rejectedInput.nodes.map(plain).filter((node): node is Record<string, unknown> => node !== null) : []
    const slot1 = selectedJobBatchTemplatesForSlot(SELECTED_JOB_BATCH_SLOT_IDS[0])!
    const slot2 = selectedJobBatchTemplatesForSlot(SELECTED_JOB_BATCH_SLOT_IDS[1])!
    const crossedDependency = [slot1, slot2].some((reviewerSlot, index) => {
      const otherWriterSlot = index === 0 ? slot2 : slot1
      const reviewerNode = rejectedNodes.find(node => node.templateId === reviewerSlot.reviewerTemplateId)
      const otherWriter = rejectedNodes.find(node => node.templateId === otherWriterSlot.writerTemplateId)
      return typeof otherWriter?.key === "string" && Array.isArray(reviewerNode?.dependsOn)
        && reviewerNode.dependsOn.length === 1 && reviewerNode.dependsOn[0] === otherWriter.key
    })
    expect(crossedDependency).toBe(true)
    const acceptedBatchPlans = batchPlanCalls.filter(call => call.status === "completed" && call.errorCode === null
      && plain(results.get(String(call.toolCallId))?.output)?.status === "accepted")
    expect(batchPlanCalls).toHaveLength(2)
    expect(acceptedBatchPlans).toHaveLength(1)
    const acceptedPlanOutput = plain(results.get(String(acceptedBatchPlans[0]?.toolCallId))?.output)
    const admissionRevision = acceptedPlanOutput?.revision
    expect(acceptedPlanOutput?.status).toBe("accepted")
    if (typeof admissionRevision !== "number" || !Number.isSafeInteger(admissionRevision)) {
      throw new Error("Accepted batch plan did not return an integer revision")
    }
    expect(admissionRevision).toBe(1)

    const graph = await db.agentItem.findFirst({ where: { sessionId, turnId, taskId: atBarrier.turn?.rootTaskId, type: "task_graph" },
      select: { id: true, revision: true, content: true } })
    const graphContent = plain(graph?.content), nodes = Array.isArray(graphContent?.nodes)
      ? graphContent.nodes.map(plain).filter((node): node is Record<string, unknown> => node !== null) : []
    const barrierRevision = graph?.revision
    if (typeof barrierRevision !== "number" || !Number.isSafeInteger(barrierRevision)) {
      throw new Error("Barrier TaskGraph did not have an integer revision")
    }
    expect(barrierRevision).toBeGreaterThanOrEqual(admissionRevision)
    expect(nodes).toHaveLength(4)
    for (let index = 0; index < jobIds.length; index++) {
      const templates = selectedJobBatchTemplatesForSlot(SELECTED_JOB_BATCH_SLOT_IDS[index]!)!
      const writer = nodes.find(node => node.templateId === templates.writerTemplateId)
      const reviewer = nodes.find(node => node.templateId === templates.reviewerTemplateId)
      expect(writer?.dependsOn).toEqual([])
      expect(reviewer?.dependsOn).toEqual([writer?.key])
    }

    const duplicate = await postBatch(token)
    expect(duplicate.status).toBe(202)
    expect(await duplicate.json()).toMatchObject({ disposition: "duplicate", turnId })
    expect(await db.agentInput.count({ where: { sessionId, userId, clientMessageId } })).toBe(1)
    const dispatchRows = await waitForPublishedDispatch(turnId)
    expect(dispatchRows).toHaveLength(1)
    expect(plain(dispatchRows[0]?.payload)).toMatchObject({ turnId, sessionId, ownerId: `web:${turnId}` })
    expect(dispatchRows[0]?.publishedAt).toBeInstanceOf(Date)
    const sessionTurns = await db.agentTurn.findMany({ where: { sessionId, userId }, select: { id: true, input: true } })
    expect(sessionTurns.filter(row => plain(plain(row.input)?.intent)?.kind === "selected_job_batch_preparation").map(row => row.id)).toEqual([turnId])

    worker.stdin?.write("continue-batch\n")
    const terminal = await waitForTurnTerminal(turnId, worker)
    if (terminal.status !== "completed") {
      try { console.error(`Selected Job batch terminal diagnostic ${JSON.stringify(await readBatchFailureDiagnostic(turnId))}`) }
      catch { console.error('Selected Job batch terminal diagnostic {"diagnostic":"unavailable"}') }
    }
    expect({ status: terminal.status, executionMode: terminal.executionMode }).toMatchObject({ status: "completed", executionMode: "canonical_task_graph" })
    const rootTaskId = terminal.rootTaskId
    expect(rootTaskId).toBeTruthy()
    if (!rootTaskId) throw new Error("Completed batch Turn has no canonical Root")
    const childRows = await db.subAgentTask.findMany({ where: { sessionId, turnId, rootTaskId, parentTaskId: rootTaskId },
      select: { id: true, role: true, status: true, context: true } })
    expect(childRows).toHaveLength(4)
    const terminalGraph = await db.agentItem.findFirst({ where: { sessionId, turnId, taskId: rootTaskId, type: "task_graph" },
      select: { id: true, content: true, revision: true } })
    const terminalNodes = Array.isArray(plain(terminalGraph?.content)?.nodes)
      ? (plain(terminalGraph?.content)!.nodes as unknown[]).map(plain).filter((node): node is Record<string, unknown> => node !== null) : []
    expect(terminalGraph?.id).toBe(graph?.id)
    const terminalRevision = terminalGraph?.revision
    if (typeof terminalRevision !== "number" || !Number.isSafeInteger(terminalRevision)) {
      throw new Error("Terminal TaskGraph did not have an integer revision")
    }
    expect(terminalRevision).toBeGreaterThanOrEqual(barrierRevision)
    expect(terminalRevision).toBeGreaterThan(admissionRevision)
    const nodeIdentity = (node: Record<string, unknown>) => ({
      key: node.key, taskId: node.taskId, templateId: node.templateId, dependsOn: node.dependsOn,
    })
    expect(terminalNodes.map(nodeIdentity)).toEqual(nodes.map(nodeIdentity))
    for (let index = 0; index < jobIds.length; index++) {
      const templates = selectedJobBatchTemplatesForSlot(SELECTED_JOB_BATCH_SLOT_IDS[index]!)!
      const writerNode = terminalNodes.find(node => node.templateId === templates.writerTemplateId)
      const reviewerNode = terminalNodes.find(node => node.templateId === templates.reviewerTemplateId)
      const writer = childRows.find(row => row.id === writerNode?.taskId)
      const reviewer = childRows.find(row => row.id === reviewerNode?.taskId)
      expect(writer).toMatchObject({ role: "writer", status: "completed" })
      expect(reviewer).toMatchObject({ role: "reviewer", status: "completed" })
      expect(plain(plain(writer?.context)?.selectedJobPreparation)?.jobId).toBe(jobIds[index])
      expect(plain(plain(reviewer?.context)?.selectedJobPreparation)?.jobId).toBe(jobIds[index])
      expect(reviewerNode?.dependsOn).toEqual([writerNode?.key])
    }

    const versions = await db.agentArtifactVersion.findMany({ where: { userId, sessionId, jobId: { in: selectedJobIds }, artifactType: "cover_letter" },
      select: { id: true, artifactId: true, version: true, jobId: true, contentHash: true, sourceDigest: true, taskId: true } })
    const reviews = await db.agentArtifactReview.findMany({ where: { userId, sessionId, jobId: { in: selectedJobIds } },
      select: { artifactVersionId: true, artifactId: true, version: true, jobId: true, contentHash: true, sourceDigest: true,
        currentSourceDigest: true, status: true, taskId: true, reviewHash: true } })
    expect(versions).toHaveLength(2)
    expect(reviews).toHaveLength(2)
    expect(new Set(versions.map(row => row.jobId))).toEqual(new Set(selectedJobIds))
    expect(new Set(reviews.map(row => row.jobId))).toEqual(new Set(selectedJobIds))
    expect(new Set(versions.map(row => row.sourceDigest)).size).toBe(2)
    expect(new Set(versions.map(row => row.artifactId)).size).toBe(2)
    for (const version of versions) {
      const review = reviews.find(row => row.jobId === version.jobId)
      const reviewer = childRows.find(row => row.id === review?.taskId)
      const writerNode = terminalNodes.find(node => {
        const task = childRows.find(candidate => candidate.id === node.taskId)
        return task?.role === "writer" && plain(plain(task.context)?.selectedJobPreparation)?.jobId === version.jobId
      })
      expect(review).toMatchObject({ artifactVersionId: version.id, artifactId: version.artifactId,
        version: version.version, contentHash: version.contentHash, sourceDigest: version.sourceDigest,
        currentSourceDigest: version.sourceDigest, status: "passed" })
      expect(review?.reviewHash).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(version.taskId).toBe(writerNode?.taskId)
      expect(reviewer).toMatchObject({ role: "reviewer", status: "completed" })
    }

    const finalItem = await db.agentItem.findFirst({ where: { sessionId, turnId, taskId: rootTaskId,
      type: "agent_message", phase: "final_answer", status: "completed" }, select: { content: true } })
    const finalText = JSON.stringify(finalItem?.content ?? terminal.finalResponse ?? "")
    expect(finalText).toContain("Job 1: Writer completed; Reviewer completed; review passed.")
    expect(finalText).toContain("Job 2: Writer completed; Reviewer completed; review passed.")

    const terminalToolItems = await db.agentItem.findMany({ where: { sessionId, turnId, type: "tool_call" }, select: { content: true } })
    const actionTools = terminalToolItems.map(item => plain(item.content)?.toolName).filter((name): name is string => typeof name === "string")
    expect(actionTools).not.toContain("apply.submit")
    expect(actionTools.some(name => name.startsWith("browser.") || name.startsWith("form.") || name.startsWith("application.")
      || name.startsWith("approval.") || name.startsWith("employer."))).toBe(false)
    expect(await db.agentApproval.count({ where: { userId, sessionId } })).toBe(0)
    expect(await db.applicationTask.count({ where: { userId, sessionId } })).toBe(0)
    expect(await db.submissionAttempt.count({ where: { userId, jobId: { in: selectedJobIds } } })).toBe(0)
  }, 180_000)
})

async function waitForTurnTerminal(turnId: string, child: Fixture, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const turn = await db.agentTurn.findFirst({ where: { id: turnId, sessionId, userId },
      select: { id: true, status: true, executionMode: true, rootTaskId: true, finalResponse: true } })
    if (turn && ["completed", "failed", "interrupted", "cancelled"].includes(turn.status)) return turn
    if (childEnded(child)) throw new Error(`Selected Job batch Worker exited before terminal Turn; ${JSON.stringify(childState(child))}`)
    await delay(100)
  }
  throw new Error(`Selected Job batch Turn did not terminalize; ${JSON.stringify(childState(child))}`)
}
