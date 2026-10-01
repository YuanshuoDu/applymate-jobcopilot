import { randomBytes, randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { writeFile } from "node:fs/promises"
import { SignJWT } from "jose"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { EXTENSION_TOKEN_AUDIENCE, EXTENSION_TOKEN_ISSUER, getAuthJwtSecret } from "@/lib/auth-secret"

const DATABASE_NAME = "applymate_agent_brain_ci"
const FLAG_ENVIRONMENT = "development"
const targetEventKey = (turnId: string) => `turn:${turnId}:event:turn-started`

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.CI === "true" && process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") {
      throw new Error("Worker-to-SSE integration requires the disposable PostgreSQL service")
    }
    return null
  }
  const url = new URL(value)
  if (
    process.env.CI !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("Worker-to-SSE integration accepts only the dedicated disposable PostgreSQL service")
  return value
}

function disposableRedisUrl(): string | null {
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) {
    if (process.env.CI === "true" && process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") {
      throw new Error("Worker-to-SSE integration requires the disposable Redis DB 15 service")
    }
    return null
  }
  const url = new URL(value)
  if (
    process.env.CI !== "true"
    || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || url.protocol !== "redis:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379"
    || url.pathname !== "/15"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || process.env.REDIS_URL !== value
  ) throw new Error("Worker-to-SSE integration accepts only disposable Redis DB 15")
  return value
}

const databaseUrl = disposableDatabaseUrl()
const redisUrl = disposableRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip

type FixtureChild = ChildProcess & { output: string[]; errors: string[] }
type SseFrame = { event: string | null; id: string | null; data: Record<string, unknown> }

const workerCwd = resolve(process.cwd(), "../worker")
const workerFixturePath = resolve(workerCwd, "src/queue/worker-event-sse-reconnect.fixture.mjs")
let testDb: typeof import("@/lib/db").db | undefined

function startWorker(): FixtureChild {
  const child = spawn(process.execPath, ["--import", "tsx", workerFixturePath], {
    cwd: workerCwd,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl!,
      REDIS_URL: redisUrl!,
      AGENT_RUNTIME_PG_TEST_URL: databaseUrl!,
      AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true",
      AGENT_RUNTIME_PG_TEST_REQUIRED: "true",
      AGENT_TURN_REDIS_TEST_URL: redisUrl!,
      AGENT_TURN_REDIS_TEST_DISPOSABLE: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as FixtureChild
  child.output = []
  child.errors = []
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", chunk => {
    stdout += String(chunk)
    const lines = stdout.split("\n")
    stdout = lines.pop() ?? ""
    child.output.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  child.stderr?.on("data", chunk => {
    stderr += String(chunk)
    const lines = stderr.split("\n")
    stderr = lines.pop() ?? ""
    child.errors.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  return child
}

function workerExited(child: FixtureChild): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)
}

async function waitForWorkerLine(child: FixtureChild, expected: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.output.includes(expected)) return
    if (workerExited(child)) throw new Error(`Worker exited before ${expected}: ${child.errors.join("\n")}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  throw new Error(`Worker did not emit ${expected}; stdout=${child.output.join(" | ")}; stderr=${child.errors.join(" | ")}`)
}

async function stopWorker(child: FixtureChild): Promise<void> {
  if (workerExited(child)) return
  child.stdin?.write("shutdown\n")
  await new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      rejectExit(new Error(`Worker did not stop after shutdown; stderr=${child.errors.join(" | ")}`))
    }, 8_000)
    child.once("exit", () => { clearTimeout(timer); resolveExit() })
    child.once("error", error => { clearTimeout(timer); rejectExit(error) })
  })
  if (child.exitCode !== 0) throw new Error(`Worker exited with ${child.exitCode}; stderr=${child.errors.join(" | ")}`)
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

function eventRequest(sessionId: string, afterSequence: string, token?: string, signal?: AbortSignal): NextRequest {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined
  return new NextRequest(
    `http://localhost/api/agent/sessions/${sessionId}/events?afterSequence=${afterSequence}`,
    { headers, signal },
  )
}

function parseSseFrame(raw: string): SseFrame | null {
  const lines = raw.split("\n")
  const event = lines.find(line => line.startsWith("event: "))?.slice(7) ?? null
  const id = lines.find(line => line.startsWith("id: "))?.slice(4) ?? null
  const data = lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n")
  if (!data) return null
  const parsed: unknown = JSON.parse(data)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  return { event, id, data: parsed as Record<string, unknown> }
}

async function readThroughTerminal(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 20_000): Promise<SseFrame[]> {
  const deadline = Date.now() + timeoutMs
  const decoder = new TextDecoder()
  const frames: SseFrame[] = []
  let pending = ""
  while (Date.now() < deadline) {
    const timeout = Math.max(1, deadline - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for replayed terminal Worker event")), timeout) }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
    if (next.done) throw new Error("SSE stream closed before turn.completed")
    pending += decoder.decode(next.value, { stream: true })
    const blocks = pending.split("\n\n")
    pending = blocks.pop() ?? ""
    for (const block of blocks) {
      const frame = parseSseFrame(block)
      if (!frame) continue
      frames.push(frame)
      if (frame.event === "turn.completed") return frames
    }
  }
  throw new Error("Timed out waiting for replayed terminal Worker event")
}

describeWithServices("agent events route replays a disconnected Worker event", () => {
  const suffix = randomUUID()
  const ownerId = `worker-sse-owner-${suffix}`
  const otherOwnerId = `worker-sse-other-${suffix}`
  const sessionId = `worker-sse-session-${suffix}`
  const featureFlagId = `worker-sse-flag-${suffix}`
  const emailFor = (userId: string) => `${userId}@example.invalid`
  const previousAuthSecret = process.env.AUTH_SECRET
  const previousDatabaseUrl = process.env.DATABASE_URL
  const previousPlatformEnvironment = process.env.PLATFORM_ENV
  let worker: FixtureChild | undefined
  let turnId = ""
  let cursor = BigInt(0)

  beforeAll(async () => {
    process.env.AUTH_SECRET = randomBytes(32).toString("base64url")
    process.env.DATABASE_URL = databaseUrl!
    process.env.PLATFORM_ENV = FLAG_ENVIRONMENT
    testDb = (await import("@/lib/db")).db

    await testDb.user.create({ data: { id: ownerId, email: emailFor(ownerId) } })
    await testDb.user.create({ data: { id: otherOwnerId, email: emailFor(otherOwnerId) } })
    await testDb.platformFeatureFlag.create({
      data: {
        id: featureFlagId,
        key: "AGENT_EVENT_SSE_V2",
        environment: FLAG_ENVIRONMENT,
        enabled: true,
        rolloutPercent: 100,
        targetUserIds: [ownerId, otherOwnerId],
        targetPlans: [],
        status: "active",
        createdById: ownerId,
        updatedById: ownerId,
      },
    })
    await testDb.agentSession.create({
      data: {
        id: sessionId,
        userId: ownerId,
        goal: "Persist a deterministic event from the disposable production Worker",
        status: "running",
        source: "test",
      },
    })
    const { AgentCommandService } = await import("@/lib/agent/control-plane/commands/agent-command-service")
    const command = await new AgentCommandService(testDb).message({
      sessionId,
      userId: ownerId,
      clientMessageId: `worker-sse-reconnect:${suffix}`,
      source: "user",
      delivery: "follow_up",
      content: [{ type: "text", text: "Write a deterministic Worker event for SSE replay proof." }],
    })
    turnId = command.turnId
    const latest = await testDb.agentEvent.findFirst({
      where: { sessionId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    })
    cursor = latest?.sequence ?? BigInt(0)
  }, 20_000)

  afterAll(async () => {
    const cleanupErrors: string[] = []
    if (worker && !workerExited(worker)) {
      try { await stopWorker(worker) } catch (error: unknown) {
        cleanupErrors.push(`worker shutdown: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try { await testDb?.platformFeatureFlag.deleteMany({ where: { id: featureFlagId } }) } catch (error: unknown) {
      cleanupErrors.push(`feature flag cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!worker || workerExited(worker)) {
      try { await testDb?.user.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } }) } catch (error: unknown) {
        cleanupErrors.push(`user/session/turn cleanup: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else cleanupErrors.push("user/session/turn cleanup skipped because the Worker is still running")
    try { await testDb?.$disconnect() } catch (error: unknown) {
      cleanupErrors.push(`web database disconnect: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = previousAuthSecret
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
    if (previousPlatformEnvironment === undefined) delete process.env.PLATFORM_ENV
    else process.env.PLATFORM_ENV = previousPlatformEnvironment
    if (cleanupErrors.length > 0) throw new Error(`Worker-to-SSE fixture cleanup failed:\n${cleanupErrors.join("\n")}`)
  })

  it("replays one durable Worker event after disconnect and rejects other identities", async () => {
    const testDatabase = testDb
    if (!testDatabase) throw new Error("Disposable Web database was not initialized")
    const { GET } = await import("./route")
    const ownerToken = await signedBearer(ownerId)
    const disconnectController = new AbortController()
    const disconnectedResponse = await GET(eventRequest(sessionId, cursor.toString(), ownerToken, disconnectController.signal), {
      params: Promise.resolve({ id: sessionId }),
    })
    expect(disconnectedResponse.status).toBe(200)
    expect(disconnectedResponse.headers.get("content-type")).toContain("text/event-stream")
    const disconnectedReader = disconnectedResponse.body?.getReader()
    expect(disconnectedReader).toBeDefined()
    await disconnectedReader?.cancel()
    disconnectController.abort()

    worker = startWorker()
    await waitForWorkerLine(worker, "WORKER_READY")
    const completionDeadline = Date.now() + 25_000
    let turnStatus = ""
    while (Date.now() < completionDeadline) {
      const turn = await testDatabase.agentTurn.findUnique({ where: { id: turnId }, select: { status: true, error: true } })
      turnStatus = turn?.status ?? "missing"
      if (turnStatus === "completed") break
      if (["failed", "cancelled", "interrupted"].includes(turnStatus)) throw new Error(`Worker turn ${turnStatus}: ${turn?.error ?? "no error"}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    expect(turnStatus).toBe("completed")
    expect(worker.output).toContain("FIXTURE_MODEL_USED")
    await stopWorker(worker)

    const targetInDatabase = await testDatabase.agentEvent.findMany({
      where: { sessionId, turnId, idempotencyKey: targetEventKey(turnId) },
      select: { id: true, sequence: true, type: true, turnId: true },
    })
    expect(targetInDatabase).toHaveLength(1)
    expect(targetInDatabase[0]).toMatchObject({ type: "turn.started", turnId })
    expect(targetInDatabase[0].sequence).toBe(cursor + BigInt(1))
    const expectedDurableEvents = await testDatabase.agentEvent.findMany({
      where: { sessionId, sequence: { gt: cursor } },
      orderBy: { sequence: "asc" },
      select: { sequence: true },
    })

    const reconnectResponse = await GET(eventRequest(sessionId, cursor.toString(), ownerToken), {
      params: Promise.resolve({ id: sessionId }),
    })
    expect(reconnectResponse.status).toBe(200)
    const reconnectReader = reconnectResponse.body?.getReader()
    expect(reconnectReader).toBeDefined()
    let replayedFrames: SseFrame[]
    try {
      replayedFrames = await readThroughTerminal(reconnectReader!)
    } finally {
      await reconnectReader?.cancel().catch(() => undefined)
    }

    const durableFrames = replayedFrames.filter(frame => frame.id !== null)
    const durableSequences = durableFrames.map(frame => BigInt(frame.id!))
    const expectedSequences = expectedDurableEvents.map(event => event.sequence)
    const observedSequenceSet = new Set(durableSequences.map(String))
    const duplicateCount = durableSequences.length - observedSequenceSet.size
    const missedDurableEvents = expectedSequences.filter(sequence => !observedSequenceSet.has(sequence.toString())).length
    expect(durableSequences[0]).toBe(cursor + BigInt(1))
    expect(durableSequences.map(String)).toEqual(expectedSequences.map(String))
    expect(duplicateCount).toBe(0)
    expect(missedDurableEvents).toBe(0)
    const targetFrames = replayedFrames.filter(frame => frame.data.idempotencyKey === targetEventKey(turnId))
    expect(targetFrames).toHaveLength(1)
    expect(targetFrames[0]).toMatchObject({
      event: "turn.started",
      id: (cursor + BigInt(1)).toString(),
      data: { type: "turn.started", sessionId, turnId },
    })

    const unauthenticated = await GET(eventRequest(sessionId, cursor.toString()), {
      params: Promise.resolve({ id: sessionId }),
    })
    expect(unauthenticated.status).toBe(401)
    const crossOwner = await GET(eventRequest(sessionId, cursor.toString(), await signedBearer(otherOwnerId)), {
      params: Promise.resolve({ id: sessionId }),
    })
    expect(crossOwner.status).toBe(404)

    const artifactPath = process.env.AGENT_WORKER_SSE_TRACE_ARTIFACT_PATH
    if (!artifactPath) throw new Error("CI must configure the redacted Worker-to-SSE trace artifact path")
    const trace = {
      schema: "phase5.worker-sse-reconnect.v1",
      runSha: process.env.GITHUB_SHA ?? "local",
      cursorBefore: cursor.toString(),
      firstWorkerSequence: (cursor + BigInt(1)).toString(),
      eventType: targetFrames[0].event,
      workerEventReplayCount: targetFrames.length,
      durableFrameCount: durableFrames.length,
      uniqueDurableSequenceCount: observedSequenceSet.size,
      duplicateCount,
      missedDurableEvents,
      sessionLineageMatched: targetFrames[0].data.sessionId === sessionId,
      turnLineageMatched: targetFrames[0].data.turnId === turnId,
      unauthenticatedStatus: unauthenticated.status,
      crossOwnerStatus: crossOwner.status,
      disconnectedBeforeWorkerCommit: true,
      redacted: true,
    }
    await writeFile(artifactPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8")
  }, 60_000)
})
