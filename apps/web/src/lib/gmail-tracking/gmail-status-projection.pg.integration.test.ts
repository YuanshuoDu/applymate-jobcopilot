import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { JobStatus } from '@prisma/client'
import { db } from '@/lib/db'
import { acquireSourceMaterialFence } from '@/lib/agent/source-material-fence'
import {
  trackAndProjectLinkedStatusMessage,
  type GmailStatusProjectionOutcome,
  type GmailTrackedMessageData,
} from './gmail-status-projection'
import type { GmailMatchableJob } from './matching'
import type { NotificationPreferences } from '@/lib/types'

const EXPECTED_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci'
const LOCK_WAIT_TIMEOUT_MS = 8_000
const TEST_TIMEOUT_MS = 30_000

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  const requested = value !== undefined
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== undefined
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== undefined
  if (!value) {
    if (requested) throw new Error('Gmail status projection tests require the fixed disposable PostgreSQL service URL')
    return null
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Gmail status projection tests require the fixed disposable PostgreSQL service URL')
  }
  if (process.env.CI !== 'true'
    || value !== EXPECTED_DATABASE_URL
    || process.env.DATABASE_URL !== EXPECTED_DATABASE_URL
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== 'true'
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== 'true'
    || url.protocol !== 'postgresql:'
    || url.hostname !== '127.0.0.1'
    || url.port !== '5432'
    || url.username !== 'postgres'
    || url.password !== 'postgres'
    || url.pathname !== '/applymate_agent_brain_ci'
    || url.search
    || url.hash) {
    throw new Error('Gmail status projection tests require the fixed disposable PostgreSQL service URL')
  }
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const notificationPreferences: NotificationPreferences = {
  apply: true, reject: true, interview: true, offer: true, weekly: true, followUp: true,
}
const createdUserIds: string[] = []
let trackedMessageSequence = 0

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = LOCK_WAIT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitForAdvisoryWait(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event = 'Advisory'
        AND query LIKE '%pg_advisory_xact_lock%'
    `
    if ((rows[0]?.waiting ?? 0) > 0) return
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Gmail status projection did not wait for the held source-material fence')
}

async function waitForJobUpdateWait(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event <> 'Advisory'
        AND query ILIKE '%UPDATE%jobs%'
    `
    if ((rows[0]?.waiting ?? 0) > 0) return
    await new Promise<void>(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Gmail status projection did not wait for the competing Job update')
}

async function createJobFixture() {
  const userId = 'gmail-fence-user-' + randomUUID()
  const jobId = 'gmail-fence-job-' + randomUUID()
  createdUserIds.push(userId)
  await db.user.create({ data: { id: userId, email: userId + '@example.test' } })
  const job = await db.job.create({
    data: {
      id: jobId,
      userId,
      company: 'Acme Labs',
      role: 'Senior Data Engineer',
      status: 'saved',
      workflowState: 'ready_to_apply',
    },
    select: { id: true, company: true, role: true, status: true },
  })
  return { userId, jobId, job: job as GmailMatchableJob }
}

function startFencedMaterialRead(userId: string, jobId: string, rollbackError?: Error) {
  const observedStatus = deferred<JobStatus | null>()
  const release = deferred<void>()
  const transaction = db.$transaction(async tx => {
    await acquireSourceMaterialFence(tx, [userId])
    const job = await tx.job.findFirst({
      where: { id: jobId, userId },
      select: { status: true },
    })
    observedStatus.resolve(job?.status ?? null)
    await release.promise
    if (rollbackError) throw rollbackError
    return job?.status ?? null
  }, { maxWait: LOCK_WAIT_TIMEOUT_MS, timeout: TEST_TIMEOUT_MS })
  const finished = transaction.then(
    value => ({ state: 'committed' as const, value }),
    error => ({ state: 'rolled-back' as const, error }),
  )
  return { observedStatus: observedStatus.promise, release, finished }
}

function startCompetingJobUpdate(userId: string, jobId: string) {
  const updated = deferred<void>()
  const release = deferred<void>()
  const transaction = db.$transaction(async tx => {
    await tx.job.updateMany({
      where: { id: jobId, userId },
      data: { status: 'interview', workflowState: 'submitted', appliedAt: new Date('2026-11-18T08:00:00Z') },
    })
    updated.resolve()
    await release.promise
  }, { maxWait: LOCK_WAIT_TIMEOUT_MS, timeout: TEST_TIMEOUT_MS })
  return { updated: updated.promise, release, finished: transaction }
}

async function readJob(userId: string, jobId: string) {
  return db.job.findFirst({
    where: { id: jobId, userId },
    select: { status: true, workflowState: true },
  })
}

function trackedMessage(userId: string, jobId: string, gmailMessageId = 'gmail-fence-message-' + ++trackedMessageSequence): GmailTrackedMessageData {
  const receivedAt = new Date('2026-11-18T09:00:00Z')
  return {
    userId,
    gmailMessageId,
    gmailThreadId: 'thread-' + gmailMessageId,
    kind: 'interview_invitation',
    senderEmail: 'talent@example.test',
    senderName: 'Recruiting',
    subject: 'Interview invitation',
    excerpt: 'We would like to interview you.',
    inferredCompany: 'Acme Labs',
    inferredRole: 'Senior Data Engineer',
    receivedAt,
    scheduledAt: null,
    jobId,
    matchConfidence: 1,
    processedAt: receivedAt,
  }
}

beforeAll(async () => {
  if (databaseUrl) await db.$connect()
})

afterEach(async () => {
  const userIds = createdUserIds.splice(0)
  if (databaseUrl && userIds.length > 0) await db.user.deleteMany({ where: { id: { in: userIds } } })
})

afterAll(async () => {
  if (databaseUrl) await db.$disconnect()
})

describeWithPostgres('Gmail status projection source-material fence', () => {
  it('blocks behind a same-user material read through commit', async () => {
    const fixture = await createJobFixture()
    const message = trackedMessage(fixture.userId, fixture.jobId)
    const reader = startFencedMaterialRead(fixture.userId, fixture.jobId)
    let writer: Promise<GmailStatusProjectionOutcome> | undefined
    let observedBlockingWriter = false
    try {
      await expect(withTimeout(reader.observedStatus, 'fenced material read timed out')).resolves.toBe('saved')
      writer = trackAndProjectLinkedStatusMessage(
        fixture.userId, fixture.job, new Date('2026-11-18T09:00:00Z'), 'interview_invitation',
        notificationPreferences, message,
      )
      await waitForAdvisoryWait()
      observedBlockingWriter = true
    } finally {
      reader.release.resolve()
      await withTimeout(reader.finished, 'material-read transaction did not commit')
      if (writer) await withTimeout(writer, 'Gmail writer did not continue after commit')
    }

    expect(observedBlockingWriter).toBe(true)
    await expect(readJob(fixture.userId, fixture.jobId)).resolves.toEqual({ status: 'interview', workflowState: 'submitted' })
    await expect(db.gmailMessage.count({ where: { userId: fixture.userId, gmailMessageId: message.gmailMessageId } })).resolves.toBe(1)
  }, TEST_TIMEOUT_MS)

  it('continues after a same-user material-read transaction rolls back', async () => {
    const fixture = await createJobFixture()
    const message = trackedMessage(fixture.userId, fixture.jobId)
    const rollbackError = new Error('intentional test rollback')
    const reader = startFencedMaterialRead(fixture.userId, fixture.jobId, rollbackError)
    let writer: Promise<GmailStatusProjectionOutcome> | undefined
    let observedBlockingWriter = false
    try {
      await expect(withTimeout(reader.observedStatus, 'fenced material read timed out')).resolves.toBe('saved')
      writer = trackAndProjectLinkedStatusMessage(
        fixture.userId, fixture.job, new Date('2026-11-18T09:00:00Z'), 'interview_invitation',
        notificationPreferences, message,
      )
      await waitForAdvisoryWait()
      observedBlockingWriter = true
    } finally {
      reader.release.resolve()
      const outcome = await withTimeout(reader.finished, 'material-read transaction did not roll back')
      expect(outcome.state).toBe('rolled-back')
      if (outcome.state === 'rolled-back') expect(outcome.error).toBe(rollbackError)
      if (writer) await withTimeout(writer, 'Gmail writer did not continue after rollback')
    }

    expect(observedBlockingWriter).toBe(true)
    await expect(readJob(fixture.userId, fixture.jobId)).resolves.toEqual({ status: 'interview', workflowState: 'submitted' })
    await expect(db.gmailMessage.count({ where: { userId: fixture.userId, gmailMessageId: message.gmailMessageId } })).resolves.toBe(1)
  }, TEST_TIMEOUT_MS)

  it('allows a different user to project status while the first user is fenced', async () => {
    const first = await createJobFixture()
    const second = await createJobFixture()
    const reader = startFencedMaterialRead(first.userId, first.jobId)
    let writerCompletedBeforeRelease = false
    let writer: Promise<GmailStatusProjectionOutcome> | undefined
    try {
      await expect(withTimeout(reader.observedStatus, 'fenced material read timed out')).resolves.toBe('saved')
      writer = trackAndProjectLinkedStatusMessage(
        second.userId, second.job, new Date('2026-11-18T09:00:00Z'), 'interview_invitation',
        notificationPreferences, trackedMessage(second.userId, second.jobId),
      )
      await withTimeout(writer, 'different-user Gmail writer blocked on another tenant fence')
      writerCompletedBeforeRelease = true
    } finally {
      reader.release.resolve()
      await withTimeout(reader.finished, 'material-read transaction did not commit')
      if (writer) await withTimeout(writer, 'different-user Gmail writer did not settle')
    }

    expect(writerCompletedBeforeRelease).toBe(true)
    await expect(readJob(first.userId, first.jobId)).resolves.toEqual({ status: 'saved', workflowState: 'ready_to_apply' })
    await expect(readJob(second.userId, second.jobId)).resolves.toEqual({ status: 'interview', workflowState: 'submitted' })
    await expect(db.gmailMessage.count({ where: { userId: second.userId, jobId: second.jobId } })).resolves.toBe(1)
  }, TEST_TIMEOUT_MS)

  it('rolls back dedupe insertion when the fresh Job CAS loses a concurrent update', async () => {
    const fixture = await createJobFixture()
    const message = trackedMessage(fixture.userId, fixture.jobId)
    const receivedAt = new Date('2026-11-18T09:00:00Z')
    const competingUpdate = startCompetingJobUpdate(fixture.userId, fixture.jobId)
    let writer: Promise<GmailStatusProjectionOutcome> | undefined
    let observedCasWait = false
    try {
      await withTimeout(competingUpdate.updated, 'competing Job update did not acquire its row lock')
      writer = trackAndProjectLinkedStatusMessage(
        fixture.userId, fixture.job, receivedAt, 'application_received', notificationPreferences,
        { ...message, kind: 'application_received' },
      )
      await waitForJobUpdateWait()
      observedCasWait = true
    } finally {
      competingUpdate.release.resolve()
      await withTimeout(competingUpdate.finished, 'competing Job update did not commit')
      if (writer) await withTimeout(writer, 'Gmail writer did not resolve after competing update')
    }

    expect(observedCasWait).toBe(true)
    if (!writer) throw new Error('Gmail writer was not started')
    await expect(writer).resolves.toEqual({ kind: 'retry', reason: 'cas_miss' })
    await expect(readJob(fixture.userId, fixture.jobId)).resolves.toEqual({ status: 'interview', workflowState: 'submitted' })
    await expect(db.gmailMessage.count({ where: { userId: fixture.userId, gmailMessageId: message.gmailMessageId } })).resolves.toBe(0)
    await expect(db.activity.count({ where: { userId: fixture.userId, jobId: fixture.jobId } })).resolves.toBe(0)
    await expect(db.notification.count({ where: { userId: fixture.userId, jobId: fixture.jobId } })).resolves.toBe(0)
  }, TEST_TIMEOUT_MS)

  it('commits only one status projection for concurrent duplicate messages', async () => {
    const fixture = await createJobFixture()
    const message = trackedMessage(fixture.userId, fixture.jobId, 'gmail-fence-concurrent-duplicate')
    const receivedAt = new Date('2026-11-18T09:00:00Z')

    const results = await Promise.all([
      trackAndProjectLinkedStatusMessage(
        fixture.userId, fixture.job, receivedAt, 'interview_invitation', notificationPreferences, message,
      ),
      trackAndProjectLinkedStatusMessage(
        fixture.userId, fixture.job, receivedAt, 'interview_invitation', notificationPreferences, message,
      ),
    ])

    expect(results.filter(result => result.kind === 'tracked')).toHaveLength(1)
    expect(results.filter(result => result.kind === 'tracked' && result.statusUpdated)).toHaveLength(1)
    await expect(readJob(fixture.userId, fixture.jobId)).resolves.toEqual({ status: 'interview', workflowState: 'submitted' })
    await expect(db.gmailMessage.count({ where: { userId: fixture.userId, gmailMessageId: message.gmailMessageId } })).resolves.toBe(1)
    await expect(db.activity.count({ where: { userId: fixture.userId, jobId: fixture.jobId } })).resolves.toBe(1)
    await expect(db.notification.count({ where: { userId: fixture.userId, jobId: fixture.jobId } })).resolves.toBe(1)
  }, TEST_TIMEOUT_MS)
})
