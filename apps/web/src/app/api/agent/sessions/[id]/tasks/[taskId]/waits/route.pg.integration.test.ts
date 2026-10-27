import { randomBytes, randomUUID } from "node:crypto"
import { AsyncResource } from "node:async_hooks"
import { createRequire } from "node:module"

import { Prisma, PrismaClient } from "@prisma/client"
import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from "@/lib/auth-secret"

const nodeRequire = createRequire(import.meta.url)

// Keep the real signed Bearer path while avoiding NextAuth's framework-only
// cookie/session integration in Vitest's Node runtime.
vi.mock("@/lib/safe-auth", () => ({ safeAuth: async () => null }))

const DATABASE_NAME = "applymate_agent_brain_ci"
const RLS_DATABASE_NAME = "applymate_wait_rls_ci"
const WAIT_TIMEOUT_MS = 5_000

type StoredTargetIds = string[] | { malformed: string }
type FixtureOptions = Readonly<{
  mode?: "any" | "all"
  targetCount?: number
  targetStatuses?: readonly string[]
  deadlineAt?: Date
  parentDeadlineAt?: Date | null
}>
type Fixture = Readonly<{
  ownerId: string
  otherUserId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  parentTaskId: string
  stepId: string
  waitId: string
  targetIds: readonly string[]
  deadlineAt: Date
  parentDeadlineAt: Date | null
  secret: string
}>
type InvalidCase = Readonly<{
  name: string
  targetCount?: number
  prepare: (fixture: Fixture) => Promise<void>
}>

function disposableDatabaseConfig(): Readonly<{ url: string; adminUrl: string; rlsEnabled: boolean }> | null {
  const rlsUrl = process.env.AGENT_WAIT_RLS_DATABASE_URL
  const value = rlsUrl ?? process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.CI === "true" && process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") {
      throw new Error("Task wait PostgreSQL integration requires the disposable CI service")
    }
    return null
  }
  const rlsEnabled = Boolean(rlsUrl)
  const adminUrl = process.env.AGENT_WAIT_RLS_ADMIN_URL ?? (rlsEnabled ? "" : value)
  const url = new URL(value)
  const admin = adminUrl ? new URL(adminUrl) : null
  const runtimeUrl = process.env.AGENT_RUNTIME_PG_TEST_URL
  const runtime = rlsEnabled && runtimeUrl ? new URL(runtimeUrl) : null
  const expectedDatabaseName = rlsEnabled ? RLS_DATABASE_NAME : DATABASE_NAME
  if (process.env.CI !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || process.env.DATABASE_URL !== value
    || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== `/${expectedDatabaseName}`
    || url.search !== ""
    || url.hash !== "") {
    throw new Error("Task wait PostgreSQL integration accepts only the dedicated disposable CI database")
  }
  if (!admin || adminUrl !== value || admin.protocol !== url.protocol || admin.host !== url.host
    || admin.username !== url.username || admin.password !== url.password || admin.pathname !== url.pathname
    || admin.search !== "" || admin.hash !== ""
    || (rlsEnabled && (process.env.RLS_RUNTIME_MODE !== "on" || process.env.RLS_CANDIDATE_ROLE !== "applymate_candidate"
      || !runtime || runtime.protocol !== "postgresql:" || runtime.hostname !== "127.0.0.1" || runtime.port !== "5432"
      || runtime.username !== "postgres" || runtime.password !== "postgres" || runtime.pathname !== `/${DATABASE_NAME}`
      || runtime.search !== "" || runtime.hash !== ""))) {
    throw new Error("Task wait RLS integration requires its isolated owner connection and candidate runtime role")
  }
  return { url: value, adminUrl, rlsEnabled }
}

const databaseConfig = disposableDatabaseConfig()
const databaseUrl = databaseConfig?.url
const describeWithDatabase = databaseConfig ? describe : describe.skip
const itWithRls = databaseConfig?.rlsEnabled ? it : it.skip
let adminDb: PrismaClient | undefined
let routeDb: typeof import("@/lib/db").db | undefined
const cleanupUserIds = new Set<string>()
type UserPolicyProbe = Readonly<{ expectedUserId: string; fixtureUserIds: readonly string[] }>
type CandidateTransactionObservation = Readonly<{
  currentRole: string
  tenantUserId: string | null
  visibleUserIds: readonly string[]
  emptyContextVisibleUserIds: readonly string[]
  routeReadOperations: readonly string[]
}>
const WAIT_ROUTE_READ_MODELS = new Set(["agentSession", "subAgentTask", "agentTurn", "agentStep", "agentWaitCondition"])
let routeBaseClient: PrismaClient | undefined
let restoreRouteTransactionObserver: (() => void) | undefined
let tenantContextRoot: AsyncResource | undefined
let requireStubbed = false
let activeUserPolicyProbe: UserPolicyProbe | null = null
const candidateTransactionObservations: CandidateTransactionObservation[] = []
const previousAuthSecret = process.env.AUTH_SECRET
const previousDatabaseUrl = process.env.DATABASE_URL
const previousRlsRuntimeMode = process.env.RLS_RUNTIME_MODE
const previousRlsCandidateRole = process.env.RLS_CANDIDATE_ROLE

function db() {
  if (!adminDb) throw new Error("Disposable PostgreSQL admin fixture client is not initialized")
  return adminDb
}

async function signedBearer(userId: string): Promise<string> {
  return new SignJWT({ authVersion: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(EXTENSION_TOKEN_ISSUER)
    .setAudience(EXTENSION_TOKEN_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(getAuthJwtSecret())
}

function waitRequest(sessionId: string, taskId: string, token?: string, search = ""): NextRequest {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined
  return new NextRequest(`http://localhost/api/agent/sessions/${sessionId}/tasks/${taskId}/waits${search}`, { headers })
}

function installRouteTransactionObserver(): () => void {
  const baseClient = (globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma
  if (!baseClient) throw new Error("The route Prisma singleton is not initialized")
  routeBaseClient = baseClient

  const previousDescriptor = Object.getOwnPropertyDescriptor(baseClient, "$transaction")
  const originalTransaction = Reflect.get(baseClient, "$transaction", baseClient)
  if (typeof originalTransaction !== "function") throw new Error("The route Prisma transaction method is unavailable")

  const observedTransaction = new Proxy(originalTransaction, {
    apply(target, thisArg, args) {
      const callback = args[0]
      if (typeof callback !== "function") return Reflect.apply(target, thisArg, args)

      const observedCallback = async (tx: Prisma.TransactionClient) => {
        const routeReadOperations: string[] = []
        const candidateState: { value: Omit<CandidateTransactionObservation, "routeReadOperations"> | null } = { value: null }
        const observedTx = new Proxy(tx, {
          get(transaction, property) {
            const method = Reflect.get(transaction, property, transaction)
            if (property === "$executeRawUnsafe" && typeof method === "function") {
              return async (...sqlArgs: unknown[]) => {
                const result = await Reflect.apply(method, transaction, sqlArgs)
                if (sqlArgs[0] !== 'SET LOCAL ROLE "applymate_candidate"') return result

                const queryRaw = Reflect.get(transaction, "$queryRawUnsafe", transaction)
                if (typeof queryRaw !== "function") throw new Error("The candidate transaction cannot inspect its current role")
                const query = async <T>(sql: string, ...values: unknown[]) =>
                  await Reflect.apply(queryRaw, transaction, [sql, ...values]) as T
                const stateRows = await query<Array<{ current_role: string; tenant_user_id: string | null }>>(
                  "SELECT current_user::text AS current_role, current_setting('app.user_id', true) AS tenant_user_id",
                )
                const state = stateRows[0]
                if (!state) throw new Error("The candidate transaction returned no role state")

                const probe = activeUserPolicyProbe
                let visibleUserIds: string[] = []
                let emptyContextVisibleUserIds: string[] = []
                if (probe) {
                  const readVisibleUserIds = async () => {
                    const visible: string[] = []
                    for (const userId of probe.fixtureUserIds) {
                      const rows = await query<Array<{ id: string }>>('SELECT "id" FROM "User" WHERE "id" = $1', userId)
                      if (rows[0]) visible.push(rows[0].id)
                    }
                    return visible
                  }

                  visibleUserIds = await readVisibleUserIds()
                  await query("SELECT set_config('app.user_id', '', true)")
                  try {
                    emptyContextVisibleUserIds = await readVisibleUserIds()
                  } finally {
                    // Restore the authenticated tenant before the route callback
                    // starts so the probe cannot change route query visibility.
                    await query("SELECT set_config('app.user_id', $1, true)", state.tenant_user_id ?? "")
                  }
                }

                candidateState.value = {
                  currentRole: state.current_role,
                  tenantUserId: state.tenant_user_id,
                  visibleUserIds,
                  emptyContextVisibleUserIds,
                }
                return result
              }
            }

            if (typeof property === "string" && WAIT_ROUTE_READ_MODELS.has(property)
              && method !== null && typeof method === "object") {
              return new Proxy(method, {
                get(delegate, operation) {
                  const operationMethod = Reflect.get(delegate, operation, delegate)
                  if (typeof operationMethod !== "function") return operationMethod
                  return (...operationArgs: unknown[]) => {
                    routeReadOperations.push(`${property}.${String(operation)}`)
                    return Reflect.apply(operationMethod, delegate, operationArgs)
                  }
                },
              })
            }

            return method
          },
        }) as Prisma.TransactionClient
        try {
          return await Reflect.apply(callback, undefined, [observedTx])
        } finally {
          // The auth User lookup is a separate transaction. Only retain role
          // and policy evidence from the transaction that actually reads the
          // wait route's persisted models.
          const state = candidateState.value
          if (state && routeReadOperations.includes("agentSession.findFirst")) {
            candidateTransactionObservations.push({ ...state, routeReadOperations: [...routeReadOperations] })
          }
        }
      }

      return Reflect.apply(target, thisArg, [observedCallback, ...args.slice(1)])
    },
  })

  Object.defineProperty(baseClient, "$transaction", {
    configurable: true,
    writable: true,
    value: observedTransaction,
  })
  return () => {
    if (previousDescriptor) Object.defineProperty(baseClient, "$transaction", previousDescriptor)
    else Reflect.deleteProperty(baseClient, "$transaction")
  }
}

async function runInIsolatedTenantContext<T>(callback: () => Promise<T>): Promise<T> {
  if (!tenantContextRoot) throw new Error("The isolated tenant context root is not initialized")
  let requestResource: AsyncResource | undefined
  tenantContextRoot.runInAsyncScope(() => {
    requestResource = new AsyncResource("agent-wait-test-request")
  })
  if (!requestResource) throw new Error("Could not create an isolated tenant request context")
  try {
    return await requestResource.runInAsyncScope(callback)
  } finally {
    requestResource.emitDestroy()
  }
}

async function getWait(
  fixture: Fixture,
  token?: string,
  search = "",
  options: Readonly<{ authenticatedUserId?: string; assertCandidateRole?: boolean }> = {},
): Promise<Response> {
  const expectedUserId = token ? options.authenticatedUserId ?? fixture.ownerId : null
  const tenantStore = databaseConfig?.rlsEnabled ? await import("@/lib/db/tenant-store") : null

  const observationStart = candidateTransactionObservations.length
  activeUserPolicyProbe = databaseConfig?.rlsEnabled && token && options.assertCandidateRole
    ? { expectedUserId: expectedUserId!, fixtureUserIds: [fixture.ownerId, fixture.otherUserId] }
    : null
  try {
    const { GET } = await import("./route")
    if (tenantStore && (globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma !== routeBaseClient) {
      throw new Error("The isolated request must reuse the initialized Prisma singleton")
    }
    const invoke = async () => {
      if (tenantStore) expect(tenantStore.currentTenantUserId()).toBeNull()
      const response = await GET(waitRequest(fixture.sessionId, fixture.parentTaskId, token, search), {
        params: Promise.resolve({ id: fixture.sessionId, taskId: fixture.parentTaskId }),
      })

      if (activeUserPolicyProbe) {
        const observations = candidateTransactionObservations.slice(observationStart)
        expect(observations.length).toBeGreaterThan(0)
        for (const observation of observations) {
          expect(observation.currentRole).toBe("applymate_candidate")
          expect(observation.routeReadOperations).toContain("agentSession.findFirst")
          // The actual route transaction GUC must match the signed Bearer subject.
          expect(observation.tenantUserId).toBe(activeUserPolicyProbe.expectedUserId)
          expect(observation.visibleUserIds).toEqual([activeUserPolicyProbe.expectedUserId])
          expect(observation.emptyContextVisibleUserIds).toEqual([])
        }
      }
      return response
    }

    return tenantStore ? await runInIsolatedTenantContext(invoke) : await invoke()
  } finally {
    activeUserPolicyProbe = null
  }
}

async function createTask(input: {
  id: string
  sessionId: string
  turnId: string
  rootTaskId: string | null
  parentTaskId: string | null
  secret: string
  role: string
  taskType: string
  status: string
  depth: number
  attemptCount?: number
  absoluteDeadlineAt?: Date | null
}): Promise<void> {
  await db().subAgentTask.create({ data: {
    id: input.id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    rootTaskId: input.rootTaskId,
    parentTaskId: input.parentTaskId,
    path: input.depth === 0 ? "/" : `/${input.depth}/${input.id}`,
    depth: input.depth,
    role: input.role,
    taskType: input.taskType,
    status: input.status,
    goal: `${input.secret} private goal`,
    constraints: [],
    successCriteria: [],
    allowedActions: input.depth === 1 ? ["wait_subagents"] : [],
    context: { privateContext: input.secret },
    expectedOutputSchema: {},
    result: { privateOutput: input.secret },
    failureReason: `${input.secret} private failure`,
    attemptCount: input.attemptCount ?? 1,
    maxAttempts: 3,
    absoluteDeadlineAt: input.absoluteDeadlineAt ?? null,
  } })
}

async function createStep(input: {
  id: string
  sessionId: string
  turnId: string
  taskId: string
  attempt: number
  ordinal: number
  secret: string
}): Promise<void> {
  await db().agentStep.create({ data: {
    id: input.id,
    sessionId: input.sessionId,
    turnId: input.turnId,
    taskId: input.taskId,
    attempt: input.attempt,
    ordinal: input.ordinal,
    status: "waiting_for_tool",
    inputThroughSequence: BigInt(0),
    consumedInputIds: [],
    modelProfileSnapshot: { privateSnapshot: input.secret },
  } })
}

async function createWait(fixture: Fixture, options: Readonly<{
  id?: string
  idempotencyKey?: string
  parentTaskId?: string
  turnId?: string
  stepId?: string
  targetTaskIds?: StoredTargetIds
  matchedTaskIds?: readonly string[]
  mode?: string
  deadlineAt?: Date
  createdAt?: Date
  suspendedAt?: Date | null
}> = {}): Promise<void> {
  const targetTaskIds = options.targetTaskIds ?? [...fixture.targetIds]
  const deadlineAt = options.deadlineAt ?? fixture.deadlineAt
  const createdAt = options.createdAt ?? (deadlineAt.getTime() <= Date.now() ? new Date(deadlineAt.getTime() - 1_000) : undefined)
  await db().agentWaitCondition.create({ data: {
    id: options.id ?? `wait-${randomUUID()}`,
    userId: fixture.ownerId,
    sessionId: fixture.sessionId,
    turnId: options.turnId ?? fixture.turnId,
    parentTaskId: options.parentTaskId ?? fixture.parentTaskId,
    stepId: options.stepId ?? fixture.stepId,
    idempotencyKey: options.idempotencyKey ?? `PRIVATE_IDEMPOTENCY_${randomUUID()}`,
    targetTaskIds,
    mode: options.mode ?? "all",
    status: "waiting",
    deadlineAt,
    ...(createdAt ? { createdAt } : {}),
    matchedTaskIds: [...(options.matchedTaskIds ?? [fixture.targetIds[0]!])],
    result: { privateResult: fixture.secret, prompt: fixture.secret, request: { targetTaskIds, idempotencyKey: fixture.secret } },
    suspendedAt: options.suspendedAt === undefined ? new Date() : options.suspendedAt,
  } })
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const suffix = randomUUID()
  const ownerId = `wait-owner-${suffix}`
  const otherUserId = `wait-other-${suffix}`
  const sessionId = `wait-session-${suffix}`
  const turnId = `wait-turn-${suffix}`
  const rootTaskId = `wait-root-${suffix}`
  const parentTaskId = `wait-parent-${suffix}`
  const stepId = `wait-step-${suffix}`
  const waitId = `wait-row-${suffix}`
  const secret = `PRIVATE_WAIT_${suffix}`
  const deadlineAt = options.deadlineAt ?? new Date(Date.now() + 10 * 60_000)
  const parentDeadlineAt = options.parentDeadlineAt === undefined ? new Date(Date.now() + 60 * 60_000) : options.parentDeadlineAt
  cleanupUserIds.add(ownerId)
  cleanupUserIds.add(otherUserId)
  await db().user.create({ data: { id: ownerId, email: `${ownerId}@example.invalid` } })
  await db().user.create({ data: { id: otherUserId, email: `${otherUserId}@example.invalid` } })
  await db().agentSession.create({ data: { id: sessionId, userId: ownerId, goal: `${secret} private session goal`, status: "running", source: "test" } })
  await db().agentTurn.create({ data: {
    id: turnId,
    userId: ownerId,
    sessionId,
    status: "in_progress",
    source: "user",
    input: { privateInput: secret },
    modelProfileSnapshot: { privateSnapshot: secret },
    toolPolicySnapshot: {},
    budgetSnapshot: {},
  } })
  await createTask({ id: rootTaskId, sessionId, turnId, rootTaskId: null, parentTaskId: null,
    secret, role: "orchestrator", taskType: "root", status: "running", depth: 0 })
  await db().subAgentTask.update({ where: { id: rootTaskId }, data: { rootTaskId } })
  await db().agentTurn.update({ where: { id: turnId }, data: { rootTaskId } })
  await createTask({ id: parentTaskId, sessionId, turnId, rootTaskId, parentTaskId: rootTaskId,
    secret, role: "analyst", taskType: "research", status: "waiting", depth: 1,
    absoluteDeadlineAt: parentDeadlineAt })
  await createStep({ id: stepId, sessionId, turnId, taskId: parentTaskId, attempt: 1, ordinal: 7, secret })

  const targetIds: string[] = []
  const targetCount = options.targetCount ?? 2
  for (let index = 0; index < targetCount; index++) {
    const id = `wait-target-${suffix}-${index}`
    targetIds.push(id)
    await createTask({ id, sessionId, turnId, rootTaskId, parentTaskId, secret,
      role: index === 0 ? "scout" : "analyst", taskType: "research",
      status: options.targetStatuses?.[index] ?? (index === 0 ? "completed" : "running"), depth: 2 })
  }
  const fixture: Fixture = { ownerId, otherUserId, sessionId, turnId, rootTaskId, parentTaskId, stepId,
    waitId, targetIds, deadlineAt, parentDeadlineAt, secret }
  await createWait(fixture, { id: waitId, mode: options.mode ?? "all" })
  return fixture
}

async function createForeignTarget(fixture: Fixture, ownerId: string): Promise<string> {
  const suffix = randomUUID()
  const sessionId = `foreign-session-${suffix}`
  const turnId = `foreign-turn-${suffix}`
  const rootTaskId = `foreign-root-${suffix}`
  const taskId = `foreign-target-${suffix}`
  await db().agentSession.create({ data: { id: sessionId, userId: ownerId, goal: `${fixture.secret} foreign goal`, status: "running", source: "test" } })
  await db().agentTurn.create({ data: { id: turnId, userId: ownerId, sessionId, status: "in_progress", source: "user",
    input: {}, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} } })
  await createTask({ id: rootTaskId, sessionId, turnId, rootTaskId: null, parentTaskId: null,
    secret: fixture.secret, role: "orchestrator", taskType: "root", status: "running", depth: 0 })
  await db().subAgentTask.update({ where: { id: rootTaskId }, data: { rootTaskId } })
  await db().agentTurn.update({ where: { id: turnId }, data: { rootTaskId } })
  await createTask({ id: taskId, sessionId, turnId, rootTaskId, parentTaskId: rootTaskId,
    secret: fixture.secret, role: "scout", taskType: "research", status: "completed", depth: 1 })
  return taskId
}

async function expectNoProjection(response: Response): Promise<void> {
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ wait: null })
}

async function waitForBlockedRouteQuery(timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const waiting = await db().$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND datname = current_database()
        AND state = 'active' AND wait_event_type = 'Lock'
        AND query ILIKE '%sub_agent_tasks%'
      LIMIT 1
    `
    if (waiting.length > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("Authenticated route did not block on the held task-table lock")
}

const invalidWaitCases: readonly InvalidCase[] = [
  { name: "rejects duplicate persisted target IDs", prepare: async fixture => {
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { targetTaskIds: [fixture.targetIds[0]!, fixture.targetIds[0]!] } })
  } },
  { name: "rejects a missing target without returning a partial list", prepare: async fixture => {
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { targetTaskIds: [...fixture.targetIds, `missing-${randomUUID()}`] } })
  } },
  { name: "rejects a foreign-user target without returning a partial list", prepare: async fixture => {
    const foreignId = await createForeignTarget(fixture, fixture.otherUserId)
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { targetTaskIds: [...fixture.targetIds, foreignId] } })
  } },
  { name: "rejects a foreign-session target without returning a partial list", prepare: async fixture => {
    const foreignId = await createForeignTarget(fixture, fixture.ownerId)
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { targetTaskIds: [...fixture.targetIds, foreignId] } })
  } },
  { name: "rejects a target attached to a different direct parent", prepare: async fixture => {
    const siblingParentId = `sibling-parent-${randomUUID()}`
    await createTask({ id: siblingParentId, sessionId: fixture.sessionId, turnId: fixture.turnId,
      rootTaskId: fixture.rootTaskId, parentTaskId: fixture.rootTaskId, secret: fixture.secret,
      role: "analyst", taskType: "research", status: "waiting", depth: 1 })
    const extraTargetId = `extra-target-${randomUUID()}`
    await createTask({ id: extraTargetId, sessionId: fixture.sessionId, turnId: fixture.turnId,
      rootTaskId: fixture.rootTaskId, parentTaskId: siblingParentId, secret: fixture.secret,
      role: "scout", taskType: "research", status: "completed", depth: 2 })
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { targetTaskIds: [...fixture.targetIds, extraTargetId] } })
  } },
  { name: "rejects persisted matched IDs outside the target set", prepare: async fixture => {
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { matchedTaskIds: [`foreign-${randomUUID()}`] } })
  } },
  { name: "rejects ambiguous current wait records", prepare: async fixture => {
    await createWait(fixture, { idempotencyKey: `second-current-${randomUUID()}` })
  } },
  { name: "rejects a stale parent attempt", prepare: async fixture => {
    await db().subAgentTask.update({ where: { id: fixture.parentTaskId }, data: { attemptCount: 2 } })
  } },
  { name: "rejects a wait tied to an older step ordinal", prepare: async fixture => {
    await createStep({ id: `newer-step-${randomUUID()}`, sessionId: fixture.sessionId, turnId: fixture.turnId,
      taskId: fixture.parentTaskId, attempt: 1, ordinal: 8, secret: fixture.secret })
  } },
  { name: "rejects a wait tied to a different Turn", prepare: async fixture => {
    const turnId = `other-turn-${randomUUID()}`
    const stepId = `other-turn-step-${randomUUID()}`
    await db().agentTurn.create({ data: { id: turnId, userId: fixture.ownerId, sessionId: fixture.sessionId,
      status: "completed", source: "user", input: {}, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {},
      completedAt: new Date() } })
    await createStep({ id: stepId, sessionId: fixture.sessionId, turnId, taskId: fixture.parentTaskId,
      attempt: 1, ordinal: 9, secret: fixture.secret })
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { turnId, stepId } })
  } },
  { name: "rejects a parent whose root differs from its children", prepare: async fixture => {
    const rootTaskId = `other-root-${randomUUID()}`
    await createTask({ id: rootTaskId, sessionId: fixture.sessionId, turnId: fixture.turnId, rootTaskId: null,
      parentTaskId: null, secret: fixture.secret, role: "orchestrator", taskType: "root", status: "running", depth: 0 })
    await db().subAgentTask.update({ where: { id: rootTaskId }, data: { rootTaskId } })
    await db().subAgentTask.update({ where: { id: fixture.parentTaskId }, data: { rootTaskId } })
  } },
  { name: "rejects a parent with a lease", prepare: async fixture => {
    await db().subAgentTask.update({ where: { id: fixture.parentTaskId }, data: {
      leaseOwner: "fixture-lease", leaseExpiresAt: new Date(Date.now() + 60_000),
    } })
  } },
  { name: "rejects a parent past its absolute deadline", prepare: async fixture => {
    await db().subAgentTask.update({ where: { id: fixture.parentTaskId }, data: { absoluteDeadlineAt: new Date(Date.now() - 1_000) } })
  } },
  { name: "rejects an inactive Turn", prepare: async fixture => {
    await db().agentTurn.update({ where: { id: fixture.turnId }, data: { status: "completed" } })
  } },
  { name: "rejects an inactive root", prepare: async fixture => {
    await db().subAgentTask.update({ where: { id: fixture.rootTaskId }, data: { status: "completed" } })
  } },
  { name: "rejects an unsuspended wait", prepare: async fixture => {
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { suspendedAt: null } })
  } },
  { name: "rejects a consumed wait", prepare: async fixture => {
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { consumedAt: new Date() } })
  } },
  { name: "returns no wait when another parent owns the current wait", prepare: async fixture => {
    await db().agentWaitCondition.update({ where: { id: fixture.waitId }, data: { status: "ready" } })
    const parentTaskId = `other-parent-${randomUUID()}`
    const stepId = `other-parent-step-${randomUUID()}`
    await createTask({ id: parentTaskId, sessionId: fixture.sessionId, turnId: fixture.turnId,
      rootTaskId: fixture.rootTaskId, parentTaskId: fixture.rootTaskId, secret: fixture.secret,
      role: "analyst", taskType: "research", status: "waiting", depth: 1 })
    await createStep({ id: stepId, sessionId: fixture.sessionId, turnId: fixture.turnId,
      taskId: parentTaskId, attempt: 1, ordinal: 10, secret: fixture.secret })
    await createWait(fixture, { parentTaskId, stepId, idempotencyKey: `other-parent-${randomUUID()}` })
  } },
]

describeWithDatabase("authenticated task wait projection on disposable PostgreSQL", () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET = randomBytes(32).toString("base64url")
    process.env.DATABASE_URL = databaseUrl!
    process.env.RLS_RUNTIME_MODE = databaseConfig!.rlsEnabled ? "on" : "off"
    if (databaseConfig!.rlsEnabled) process.env.RLS_CANDIDATE_ROLE = "applymate_candidate"
    else delete process.env.RLS_CANDIDATE_ROLE
    if (databaseConfig!.rlsEnabled) {
      // tenant-store's Node ESM fallback resolves this test-only require to
      // AsyncLocalStorage; restore the original global after this suite.
      vi.stubGlobal("require", nodeRequire)
      requireStubbed = true
    }
    adminDb = new PrismaClient({ datasources: { db: { url: databaseConfig!.adminUrl } } })
    await adminDb.$connect()
    routeDb = (await import("@/lib/db")).db
    await routeDb.$connect()
    if (databaseConfig!.rlsEnabled) {
      tenantContextRoot = new AsyncResource("agent-wait-test-root")
      restoreRouteTransactionObserver = installRouteTransactionObserver()
    }
  })

  afterEach(async () => {
    if (cleanupUserIds.size === 0 || !adminDb) return
    const ids = [...cleanupUserIds]
    cleanupUserIds.clear()
    const deleted = await adminDb.user.deleteMany({ where: { id: { in: ids } } })
    expect(deleted.count).toBeGreaterThanOrEqual(0)
  })

  afterAll(async () => {
    try {
      restoreRouteTransactionObserver?.()
      await routeDb?.$disconnect()
      await adminDb?.$disconnect()
    } finally {
      tenantContextRoot?.emitDestroy()
      tenantContextRoot = undefined
      if (requireStubbed) {
        vi.unstubAllGlobals()
        requireStubbed = false
      }
      if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET
      else process.env.AUTH_SECRET = previousAuthSecret
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabaseUrl
      if (previousRlsRuntimeMode === undefined) delete process.env.RLS_RUNTIME_MODE
      else process.env.RLS_RUNTIME_MODE = previousRlsRuntimeMode
      if (previousRlsCandidateRole === undefined) delete process.env.RLS_CANDIDATE_ROLE
      else process.env.RLS_CANDIDATE_ROLE = previousRlsCandidateRole
    }
  })

  it.each(["any", "all"] as const)("projects a persisted %s wait with exact direct children and resolver matching", async mode => {
    const fixture = await createFixture({ mode })
    const token = await signedBearer(fixture.ownerId)
    const before = await db().agentWaitCondition.findUnique({ where: { id: fixture.waitId }, select: {
      status: true, matchedTaskIds: true, result: true, consumedAt: true,
    } })
    const response = await getWait(fixture, token, "", { assertCandidateRole: true })
    const text = await response.text()
    const body: unknown = JSON.parse(text)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(body).toEqual({ wait: {
      mode, status: "waiting", deadlineAt: fixture.deadlineAt.toISOString(),
      parentDeadlineAt: fixture.parentDeadlineAt?.toISOString() ?? null, targets: [
        { taskId: fixture.targetIds[0], label: "scout", status: "completed", matched: true },
        { taskId: fixture.targetIds[1], label: "analyst", status: "running", matched: false },
      ],
    } })
    for (const secret of [fixture.secret, fixture.waitId, `PRIVATE_IDEMPOTENCY_`, "private goal", "privateContext", "privateOutput", "private failure"]) {
      expect(text).not.toContain(secret)
    }
    const after = await db().agentWaitCondition.findUnique({ where: { id: fixture.waitId }, select: {
      status: true, matchedTaskIds: true, result: true, consumedAt: true,
    } })
    expect(after).toEqual(before)
  })

  it("keeps an expired wait deadline visible while the parent deadline remains live", async () => {
    const fixture = await createFixture({ deadlineAt: new Date(Date.now() - 1_000) })
    const response = await getWait(fixture, await signedBearer(fixture.ownerId))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ wait: {
      mode: "all", status: "waiting", deadlineAt: fixture.deadlineAt.toISOString(),
      parentDeadlineAt: fixture.parentDeadlineAt?.toISOString() ?? null, targets: [
        { taskId: fixture.targetIds[0], label: "scout", status: "completed", matched: true },
        { taskId: fixture.targetIds[1], label: "analyst", status: "running", matched: false },
      ],
    } })
  })

  it("reports a parent deadline earlier than the persisted wait deadline without rewriting either", async () => {
    const fixture = await createFixture({
      deadlineAt: new Date(Date.now() + 2 * 60 * 60_000),
      parentDeadlineAt: new Date(Date.now() + 60 * 60_000),
    })
    expect(fixture.parentDeadlineAt).not.toBeNull()
    expect(fixture.parentDeadlineAt!.getTime()).toBeLessThan(fixture.deadlineAt.getTime())

    const response = await getWait(fixture, await signedBearer(fixture.ownerId))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ wait: {
      deadlineAt: fixture.deadlineAt.toISOString(),
      parentDeadlineAt: fixture.parentDeadlineAt!.toISOString(),
    } })
  })

  it("projects a persisted child status while redacting private labels and text", async () => {
    const fixture = await createFixture()
    await db().subAgentTask.update({ where: { id: fixture.targetIds[1] }, data: {
      status: "waiting_for_user", role: fixture.secret, taskType: fixture.secret,
    } })
    const response = await getWait(fixture, await signedBearer(fixture.ownerId))
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ wait: { targets: [
      { taskId: fixture.targetIds[0], status: "completed", matched: true },
      { taskId: fixture.targetIds[1], label: null, status: "waiting_for_user", matched: false },
    ] } })
    expect(text).not.toContain(fixture.secret)
  })

  it("uses the authenticated owner, rejects query-selected IDs, and does not expose a foreign session", async () => {
    const fixture = await createFixture()
    const unauthenticated = await getWait(fixture)
    expect(unauthenticated.status).toBe(401)

    const foreignOwner = await getWait(fixture, await signedBearer(fixture.otherUserId), "", {
      authenticatedUserId: fixture.otherUserId,
      assertCandidateRole: true,
    })
    expect(foreignOwner.status).toBe(404)
    expect(await foreignOwner.text()).not.toContain(fixture.secret)

    const query = await getWait(fixture, await signedBearer(fixture.ownerId), `?targetTaskIds=${fixture.targetIds.join(",")}&idempotencyKey=private`)
    expect(query.status).toBe(400)
    expect(await query.text()).not.toContain(fixture.secret)
  })

  it.each(invalidWaitCases)("$name", async scenario => {
    const fixture = await createFixture({ targetCount: scenario.targetCount })
    await scenario.prepare(fixture)
    await expectNoProjection(await getWait(fixture, await signedBearer(fixture.ownerId)))
  })

  it("returns one RepeatableRead snapshot when the persisted wait changes during the route read", async () => {
    const fixture = await createFixture()
    const token = await signedBearer(fixture.ownerId)
    let responsePromise: Promise<Response> | undefined
    await db().$transaction(async tx => {
      await tx.$executeRawUnsafe('LOCK TABLE "sub_agent_tasks" IN ACCESS EXCLUSIVE MODE')
      responsePromise = getWait(fixture, token)
      await waitForBlockedRouteQuery()
      await tx.agentWaitCondition.update({ where: { id: fixture.waitId }, data: { status: "ready", consumedAt: new Date() } })
    }, { maxWait: WAIT_TIMEOUT_MS, timeout: WAIT_TIMEOUT_MS * 3 })

    const response = await responsePromise!
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ wait: { status: "waiting", mode: "all" } })
    await expect(db().agentWaitCondition.findUnique({ where: { id: fixture.waitId }, select: { status: true, consumedAt: true } }))
      .resolves.toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
  })

  it("accepts the eight-target database boundary without reading a ninth row", async () => {
    const fixture = await createFixture({ targetCount: 8, parentDeadlineAt: null })
    const response = await getWait(fixture, await signedBearer(fixture.ownerId))
    expect(response.status).toBe(200)
    const body = await response.json() as { wait: { parentDeadlineAt: string | null; targets: Array<{ taskId: string }> } }
    expect(body.wait.parentDeadlineAt).toBeNull()
    expect(body.wait.targets).toHaveLength(8)
    expect(body.wait.targets.map(target => target.taskId)).toEqual(fixture.targetIds)
  })

  itWithRls("runs the authenticated route as the candidate role and scopes wait reads to tenant context", async () => {
    const fixture = await createFixture({ targetCount: 1 })
    const response = await getWait(fixture, await signedBearer(fixture.ownerId), "", { assertCandidateRole: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ wait: { status: "waiting", targets: [{ taskId: fixture.targetIds[0] }] } })

    const privileges = await db().$queryRaw<Array<{ canSelect: boolean; canInsert: boolean; canUpdate: boolean; canDelete: boolean }>>`
      SELECT has_table_privilege('applymate_candidate', 'public.agent_wait_conditions', 'SELECT') AS "canSelect",
        has_table_privilege('applymate_candidate', 'public.agent_wait_conditions', 'INSERT') AS "canInsert",
        has_table_privilege('applymate_candidate', 'public.agent_wait_conditions', 'UPDATE') AS "canUpdate",
        has_table_privilege('applymate_candidate', 'public.agent_wait_conditions', 'DELETE') AS "canDelete"
    `
    expect(privileges).toEqual([{ canSelect: true, canInsert: false, canUpdate: false, canDelete: false }])

    const foreignTenantRows = await db().$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${fixture.otherUserId}, true)`
      await tx.$executeRawUnsafe('SET LOCAL ROLE "applymate_candidate"')
      return tx.agentWaitCondition.findMany({ where: { id: fixture.waitId }, select: { id: true } })
    })
    expect(foreignTenantRows).toEqual([])

    const noTenantRows = await db().$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE "applymate_candidate"')
      const context = await tx.$queryRaw<Array<{ userId: string | null }>>`SELECT current_setting('app.user_id', true) AS "userId"`
      expect(context[0]?.userId ?? "").toBe("")
      return tx.agentWaitCondition.findMany({ where: { id: fixture.waitId }, select: { id: true } })
    })
    expect(noTenantRows).toEqual([])

    await expect(db().$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${fixture.ownerId}, true)`
      await tx.$executeRawUnsafe('SET LOCAL ROLE "applymate_candidate"')
      await tx.agentWaitCondition.update({ where: { id: fixture.waitId }, data: { status: "ready" } })
    })).rejects.toThrow(/permission denied/i)
  })
})
