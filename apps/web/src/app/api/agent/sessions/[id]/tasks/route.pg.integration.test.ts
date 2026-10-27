import { randomBytes, randomUUID } from "node:crypto"
import { AsyncResource } from "node:async_hooks"
import { createRequire } from "node:module"

import { Prisma, PrismaClient } from "@prisma/client"
import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from "@/lib/auth-secret"

const nodeRequire = createRequire(import.meta.url)

// Keep real signed Bearer authentication while bypassing NextAuth's framework-only session path.
vi.mock("@/lib/safe-auth", () => ({ safeAuth: async () => null }))

const DATABASE_NAME = "applymate_agent_brain_ci"
const RLS_DATABASE_NAME = "applymate_wait_rls_ci"

type TenantFixture = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
  childTaskId: string
}>
type RouteRead = Readonly<{
  model: "agentSession" | "subAgentTask"
  operation: "findFirst" | "findMany"
  sessionId: string | null
  ownerId: string | null
}>
type RouteTransactionObservation = Readonly<{
  currentRole: string | null
  tenantUserId: string | null
  routeReads: readonly RouteRead[]
}>
type ParallelReadExpectation = Readonly<{ sessionId: string; userId: string }>
type ParallelReadArrival = Readonly<{
  sessionId: string
  ownerId: string | null
  currentRole: string | null
  tenantUserId: string | null
}>
type ParallelReadBarrier = Readonly<{
  arrive: (arrival: ParallelReadArrival) => Promise<void>
  dispose: () => void
}>

function disposableCandidateRlsDatabaseUrl(): string | null {
  const value = process.env.AGENT_WAIT_RLS_DATABASE_URL
  if (!value) {
    if (process.env.CI === "true" && process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") {
      throw new Error("Task-list RLS integration requires the scoped disposable PostgreSQL fixture")
    }
    return null
  }

  const url = new URL(value)
  const adminUrl = process.env.AGENT_WAIT_RLS_ADMIN_URL
  const runtimeValue = process.env.AGENT_RUNTIME_PG_TEST_URL
  const runtime = runtimeValue ? new URL(runtimeValue) : null
  if (process.env.CI !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || process.env.DATABASE_URL !== value
    || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== `/${RLS_DATABASE_NAME}`
    || url.search !== ""
    || url.hash !== ""
    || adminUrl !== value
    || process.env.RLS_RUNTIME_MODE !== "on"
    || process.env.RLS_CANDIDATE_ROLE !== "applymate_candidate"
    || !runtime
    || runtime.protocol !== "postgresql:"
    || runtime.hostname !== "127.0.0.1"
    || runtime.port !== "5432"
    || runtime.username !== "postgres"
    || runtime.password !== "postgres"
    || runtime.pathname !== `/${DATABASE_NAME}`
    || runtime.search !== ""
    || runtime.hash !== "") {
    throw new Error("Task-list RLS integration accepts only the scoped disposable CI database and candidate role")
  }
  return value
}

const databaseUrl = disposableCandidateRlsDatabaseUrl()
const describeWithCandidateRls = databaseUrl ? describe : describe.skip
let adminDb: PrismaClient | undefined
let routeDb: typeof import("@/lib/db").db | undefined
let routeBaseClient: PrismaClient | undefined
let restoreRouteTransactionObserver: (() => void) | undefined
let tenantContextRoot: AsyncResource | undefined
let requireStubbed = false
const cleanupUserIds = new Set<string>()
const routeTransactionObservations: RouteTransactionObservation[] = []
let activeParallelReadBarrier: ParallelReadBarrier | null = null
const previousEnvironment = {
  authSecret: process.env.AUTH_SECRET,
  databaseUrl: process.env.DATABASE_URL,
  rlsRuntimeMode: process.env.RLS_RUNTIME_MODE,
  rlsCandidateRole: process.env.RLS_CANDIDATE_ROLE,
}

function admin() {
  if (!adminDb) throw new Error("Disposable PostgreSQL fixture client is not initialized")
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

function taskListRequest(sessionId: string, token?: string): NextRequest {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined
  return new NextRequest(`http://localhost/api/agent/sessions/${sessionId}/tasks`, { headers })
}

async function runInIsolatedTenantContext<T>(callback: () => Promise<T>): Promise<T> {
  if (!tenantContextRoot) throw new Error("The isolated tenant context root is not initialized")
  let requestResource: AsyncResource | undefined
  tenantContextRoot.runInAsyncScope(() => {
    requestResource = new AsyncResource("agent-task-list-test-request")
  })
  if (!requestResource) throw new Error("Could not create an isolated tenant request context")
  try {
    return await requestResource.runInAsyncScope(callback)
  } finally {
    requestResource.emitDestroy()
  }
}

function recordField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return (value as Record<string, unknown>)[key]
}

function recordStringField(value: unknown, key: string): string | null {
  const field = recordField(value, key)
  return typeof field === "string" ? field : null
}

function responseTasks(body: unknown): Array<{ id: string; status: string }> {
  const tasks = recordField(body, "tasks")
  if (!Array.isArray(tasks)) throw new Error("Task-list response did not contain a task array")
  return tasks.map(task => {
    const id = recordStringField(task, "id")
    const status = recordStringField(task, "status")
    if (!id || !status) throw new Error("Task-list response contained a task without an ID or status")
    return { id, status }
  })
}

function createParallelReadBarrier(expectations: readonly ParallelReadExpectation[], timeoutMs: number): ParallelReadBarrier {
  const expectedBySession = new Map(expectations.map(expectation => [expectation.sessionId, expectation.userId]))
  const arrived = new Set<string>()
  let resolveGate: (() => void) | undefined
  let rejectGate: ((error: Error) => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve
    rejectGate = reject
  })
  // A disposed barrier can be rejected before an arrival is awaiting it.
  void gate.catch(() => undefined)

  return {
    arrive: async arrival => {
      if (settled) {
        await gate
        return
      }
      const expectedUserId = expectedBySession.get(arrival.sessionId)
      if (!expectedUserId || arrival.ownerId !== expectedUserId
        || arrival.currentRole !== "applymate_candidate" || arrival.tenantUserId !== expectedUserId
        || arrived.has(arrival.sessionId)) {
        settled = true
        clearTimeout(timeout)
        rejectGate?.(new Error("Parallel task-list transaction reached the barrier with an unexpected session, role, GUC, or duplicate arrival"))
        await gate
        return
      }
      arrived.add(arrival.sessionId)
      if (arrived.size === expectedBySession.size) {
        settled = true
        if (timeout) clearTimeout(timeout)
        resolveGate?.()
      } else if (!timeout) {
        // Start the bounded wait only once the first real route transaction is held.
        timeout = setTimeout(() => {
          if (settled) return
          settled = true
          rejectGate?.(new Error("Timed out waiting for both candidate task-list transactions at the route-read barrier"))
        }, timeoutMs)
      }
      await gate
    },
    dispose: () => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (arrived.size === 0) resolveGate?.()
      else rejectGate?.(new Error("Parallel task-list route-read barrier was disposed before both users arrived"))
    },
  }
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
        const routeReads: RouteRead[] = []
        const candidateState: { value: Omit<RouteTransactionObservation, "routeReads"> | null } = { value: null }
        const observedTx = new Proxy(tx, {
          get(transaction, property) {
            const method = Reflect.get(transaction, property, transaction)
            if (property === "$executeRawUnsafe" && typeof method === "function") {
              return async (...sqlArgs: unknown[]) => {
                const result = await Reflect.apply(method, transaction, sqlArgs)
                if (sqlArgs[0] !== 'SET LOCAL ROLE "applymate_candidate"') return result

                const queryRaw = Reflect.get(transaction, "$queryRawUnsafe", transaction)
                if (typeof queryRaw !== "function") throw new Error("Candidate transaction cannot inspect its role and tenant context")
                const query = async <T>(sql: string, ...values: unknown[]) =>
                  await Reflect.apply(queryRaw, transaction, [sql, ...values]) as T
                const rows = await query<Array<{ currentRole: string; tenantUserId: string | null }>>(
                  "SELECT current_user::text AS \"currentRole\", current_setting('app.user_id', true) AS \"tenantUserId\"",
                )
                const state = rows[0]
                if (!state) throw new Error("Candidate transaction returned no role state")
                candidateState.value = { currentRole: state.currentRole, tenantUserId: state.tenantUserId }
                return result
              }
            }

            if ((property === "agentSession" || property === "subAgentTask")
              && method !== null && typeof method === "object") {
              return new Proxy(method, {
                get(delegate, operation) {
                  const operationMethod = Reflect.get(delegate, operation, delegate)
                  const expectedOperation = property === "agentSession" ? "findFirst" : "findMany"
                  if (operation !== expectedOperation || typeof operationMethod !== "function") return operationMethod
                  return async (...operationArgs: unknown[]) => {
                    const where = recordField(operationArgs[0], "where")
                    const routeRead: RouteRead = {
                      model: property,
                      operation: expectedOperation,
                      sessionId: property === "agentSession"
                        ? recordStringField(where, "id")
                        : recordStringField(where, "sessionId"),
                      ownerId: property === "agentSession" ? recordStringField(where, "userId") : null,
                    }
                    routeReads.push(routeRead)
                    const result = await Reflect.apply(operationMethod, delegate, operationArgs)
                    if (property === "agentSession" && activeParallelReadBarrier && routeRead.sessionId) {
                      // Hold the completed SQL read open until both candidate transactions have been observed.
                      await activeParallelReadBarrier.arrive({
                        sessionId: routeRead.sessionId,
                        ownerId: routeRead.ownerId,
                        currentRole: candidateState.value?.currentRole ?? null,
                        tenantUserId: candidateState.value?.tenantUserId ?? null,
                      })
                    }
                    return result
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
          if (routeReads.length > 0) {
            routeTransactionObservations.push({
              currentRole: candidateState.value?.currentRole ?? null,
              tenantUserId: candidateState.value?.tenantUserId ?? null,
              routeReads: [...routeReads],
            })
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

async function getTasks(sessionId: string, token?: string): Promise<Response> {
  const { GET } = await import("./route")
  if ((globalThis as typeof globalThis & { prisma?: PrismaClient }).prisma !== routeBaseClient) {
    throw new Error("Task-list route did not reuse the observed Prisma singleton")
  }
  return GET(taskListRequest(sessionId, token), { params: Promise.resolve({ id: sessionId }) })
}

async function createTask(input: {
  id: string
  sessionId: string
  turnId: string
  rootTaskId: string | null
  parentTaskId: string | null
  depth: number
  role: string
  taskType: string
  status: string
}): Promise<void> {
  await admin().subAgentTask.create({ data: {
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
    goal: `private ${input.role} task goal`,
    constraints: [],
    successCriteria: [],
    allowedActions: [],
    context: {},
    expectedOutputSchema: {},
    failureReason: null,
    attemptCount: 1,
    maxAttempts: 3,
  } })
}

async function createTenantFixture(prefix: string): Promise<TenantFixture> {
  const suffix = randomUUID()
  const userId = `${prefix}-user-${suffix}`
  const sessionId = `${prefix}-session-${suffix}`
  const turnId = `${prefix}-turn-${suffix}`
  const rootTaskId = `${prefix}-root-${suffix}`
  const childTaskId = `${prefix}-child-${suffix}`
  cleanupUserIds.add(userId)

  await admin().user.create({ data: { id: userId, email: `${userId}@example.invalid` } })
  await admin().agentSession.create({ data: { id: sessionId, userId, goal: "private session goal", status: "running", source: "test" } })
  await admin().agentTurn.create({ data: {
    id: turnId,
    userId,
    sessionId,
    status: "in_progress",
    source: "user",
    input: {},
    modelProfileSnapshot: {},
    toolPolicySnapshot: {},
    budgetSnapshot: {},
  } })
  await createTask({ id: rootTaskId, sessionId, turnId, rootTaskId: null, parentTaskId: null,
    depth: 0, role: "orchestrator", taskType: "root", status: "running" })
  await admin().subAgentTask.update({ where: { id: rootTaskId }, data: { rootTaskId } })
  await admin().agentTurn.update({ where: { id: turnId }, data: { rootTaskId } })
  await createTask({ id: childTaskId, sessionId, turnId, rootTaskId, parentTaskId: rootTaskId,
    depth: 1, role: "scout", taskType: "research", status: "queued" })
  return { userId, sessionId, turnId, rootTaskId, childTaskId }
}

function assertObservedRouteScope(
  fixture: TenantFixture,
  observations: readonly RouteTransactionObservation[],
  expectTaskRead = true,
): void {
  const routeObservations = observations.filter(observation =>
    observation.routeReads.some(read => read.sessionId === fixture.sessionId),
  )
  expect(routeObservations.length).toBeGreaterThan(0)
  for (const observation of routeObservations) {
    expect(observation.currentRole).toBe("applymate_candidate")
    expect(observation.tenantUserId).toBe(fixture.userId)
    expect(observation.routeReads.every(read => read.sessionId === fixture.sessionId)).toBe(true)
  }
  const reads = routeObservations.flatMap(observation => observation.routeReads)
  const expectedReads: RouteRead[] = [
    { model: "agentSession", operation: "findFirst", sessionId: fixture.sessionId, ownerId: fixture.userId },
  ]
  if (expectTaskRead) expectedReads.push({
    model: "subAgentTask", operation: "findMany", sessionId: fixture.sessionId, ownerId: null,
  })
  expect(reads).toEqual(expect.arrayContaining(expectedReads))
}

describeWithCandidateRls("authenticated task-list tenant RLS on disposable PostgreSQL", () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET = randomBytes(32).toString("base64url")
    process.env.DATABASE_URL = databaseUrl!
    process.env.RLS_RUNTIME_MODE = "on"
    process.env.RLS_CANDIDATE_ROLE = "applymate_candidate"
    vi.stubGlobal("require", nodeRequire)
    requireStubbed = true

    adminDb = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await adminDb.$connect()
    routeDb = (await import("@/lib/db")).db
    await routeDb.$connect()
    tenantContextRoot = new AsyncResource("agent-task-list-test-root")
    restoreRouteTransactionObserver = installRouteTransactionObserver()
  })

  afterAll(async () => {
    try {
      restoreRouteTransactionObserver?.()
      if (cleanupUserIds.size > 0 && adminDb) {
        await adminDb.user.deleteMany({ where: { id: { in: [...cleanupUserIds] } } })
      }
      await routeDb?.$disconnect()
      await adminDb?.$disconnect()
    } finally {
      tenantContextRoot?.emitDestroy()
      tenantContextRoot = undefined
      if (requireStubbed) {
        vi.unstubAllGlobals()
        requireStubbed = false
      }
      if (previousEnvironment.authSecret === undefined) delete process.env.AUTH_SECRET
      else process.env.AUTH_SECRET = previousEnvironment.authSecret
      if (previousEnvironment.databaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousEnvironment.databaseUrl
      if (previousEnvironment.rlsRuntimeMode === undefined) delete process.env.RLS_RUNTIME_MODE
      else process.env.RLS_RUNTIME_MODE = previousEnvironment.rlsRuntimeMode
      if (previousEnvironment.rlsCandidateRole === undefined) delete process.env.RLS_CANDIDATE_ROLE
      else process.env.RLS_CANDIDATE_ROLE = previousEnvironment.rlsCandidateRole
    }
  })

  it("keeps parallel signed-Bearer task reads isolated and hides foreign and unscoped rows", async () => {
    const ownerA = await createTenantFixture("task-a")
    const ownerB = await createTenantFixture("task-b")
    const tenantStore = await import("@/lib/db/tenant-store")
    expect(tenantStore.currentTenantUserId()).toBeNull()

    const unauthenticatedStart = routeTransactionObservations.length
    const unauthenticated = await runInIsolatedTenantContext(() => getTasks(ownerA.sessionId))
    expect(unauthenticated.status).toBe(401)
    expect(routeTransactionObservations.slice(unauthenticatedStart)).toEqual([])
    expect(tenantStore.currentTenantUserId()).toBeNull()

    const tokenA = await signedBearer(ownerA.userId)
    const tokenB = await signedBearer(ownerB.userId)
    const parallelStart = routeTransactionObservations.length
    const readBarrier = createParallelReadBarrier([
      { sessionId: ownerA.sessionId, userId: ownerA.userId },
      { sessionId: ownerB.sessionId, userId: ownerB.userId },
    ], 4_000)
    activeParallelReadBarrier = readBarrier
    let parallelResults: PromiseSettledResult<Response>[]
    try {
      parallelResults = await Promise.allSettled([
        runInIsolatedTenantContext(() => getTasks(ownerA.sessionId, tokenA)),
        runInIsolatedTenantContext(() => getTasks(ownerB.sessionId, tokenB)),
      ])
    } finally {
      activeParallelReadBarrier = null
      readBarrier.dispose()
    }
    const rejected = parallelResults.find(result => result.status === "rejected")
    if (rejected?.status === "rejected") throw rejected.reason
    const responses = parallelResults.map(result => {
      if (result.status !== "fulfilled") throw new Error("Parallel task-list route call did not complete")
      return result.value
    })
    const [responseA, responseB] = responses
    expect(responseA.status).toBe(200)
    expect(responseB.status).toBe(200)
    const bodyA = await responseA.json()
    const bodyB = await responseB.json()
    const expectedTasksA = [
      { id: ownerA.rootTaskId, status: "running" },
      { id: ownerA.childTaskId, status: "queued" },
    ]
    const expectedTasksB = [
      { id: ownerB.rootTaskId, status: "running" },
      { id: ownerB.childTaskId, status: "queued" },
    ]
    expect(responseTasks(bodyA).sort((left, right) => left.id.localeCompare(right.id)))
      .toEqual(expectedTasksA.sort((left, right) => left.id.localeCompare(right.id)))
    expect(responseTasks(bodyB).sort((left, right) => left.id.localeCompare(right.id)))
      .toEqual(expectedTasksB.sort((left, right) => left.id.localeCompare(right.id)))
    expect(JSON.stringify(bodyA)).not.toContain(ownerB.sessionId)
    expect(JSON.stringify(bodyA)).not.toContain(ownerB.childTaskId)
    expect(JSON.stringify(bodyB)).not.toContain(ownerA.sessionId)
    expect(JSON.stringify(bodyB)).not.toContain(ownerA.childTaskId)

    const parallelObservations = routeTransactionObservations.slice(parallelStart)
    assertObservedRouteScope(ownerA, parallelObservations)
    assertObservedRouteScope(ownerB, parallelObservations)
    expect(tenantStore.currentTenantUserId()).toBeNull()

    const foreignStart = routeTransactionObservations.length
    const foreignResponse = await runInIsolatedTenantContext(() => getTasks(ownerA.sessionId, tokenB))
    expect(foreignResponse.status).toBe(404)
    const foreignObservations = routeTransactionObservations.slice(foreignStart)
    assertObservedRouteScope({ ...ownerA, userId: ownerB.userId }, foreignObservations, false)
    expect(foreignObservations.flatMap(observation => observation.routeReads)
      .some(read => read.model === "subAgentTask")).toBe(false)

    // This exercises the default task list only; graph-filter RLS integration is not covered here.
    const noContext = await admin().$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE "applymate_candidate"')
      const context = await tx.$queryRaw<Array<{ currentRole: string; tenantUserId: string | null }>>`
        SELECT current_user::text AS "currentRole", current_setting('app.user_id', true) AS "tenantUserId"
      `
      const userRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM public."User" WHERE "id" IN (${Prisma.join([ownerA.userId, ownerB.userId])})
      `
      const sessionRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM public.agent_sessions WHERE "id" IN (${Prisma.join([ownerA.sessionId, ownerB.sessionId])})
      `
      const taskRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM public.sub_agent_tasks
        WHERE "id" IN (${Prisma.join([ownerA.rootTaskId, ownerA.childTaskId, ownerB.rootTaskId, ownerB.childTaskId])})
      `
      return { context: context[0], userRows, sessionRows, taskRows }
    })
    expect(noContext.context?.currentRole).toBe("applymate_candidate")
    expect(noContext.context?.tenantUserId ?? "").toBe("")
    expect(noContext.userRows).toEqual([])
    expect(noContext.sessionRows).toEqual([])
    expect(noContext.taskRows).toEqual([])
    expect(tenantStore.currentTenantUserId()).toBeNull()
  }, 30_000)
})
