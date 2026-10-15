import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiscoveredJob } from './discover'
import {
  createToolUsage,
  decodeProviderDiscoveryCursor,
  decodeSearchCursor,
  DiscoveryToolError,
  encodeProviderDiscoveryCursor,
  encodeSearchCursor,
  providerDiscoveryOutput,
  selectProviderDiscoveryPage,
} from './discovery-tool-support'

const scope = {
  userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1',
  stepId: 'step-1', toolCallId: 'call-1', role: 'scout' as const,
}

beforeEach(() => vi.stubEnv('AGENT_WORKER_SECRET', 'cursor-test-secret'))
afterEach(() => vi.unstubAllEnvs())

const PROVIDER_PAGE_LIMIT = 64 * 1024
const PAGE_ENVELOPE_RESERVE = 4 * 1024
const RESTORED_OBSERVATION_LIMIT = 256 * 1024
const READ_RESULT_LIMIT = 4096
const ESCAPE_HEAVY_TEXT = ['\\', '"', '\u0001', '\n', '\t'].join('')

function maxFieldDiscoveryJob(description: string, suffix: string): DiscoveredJob {
  return {
    title: 't'.repeat(500), company: 'c'.repeat(500), location: 'l'.repeat(500),
    url: `https://example.test/jobs/${suffix}`.padEnd(4096, 'u'), description, salary: 's'.repeat(500),
    logo: 'g'.repeat(4096), source: 'p'.repeat(80),
  }
}

function projectedPageBytes(jobs: readonly DiscoveredJob[]): number {
  const projected = jobs.map(job => providerDiscoveryOutput(job, 'j'.repeat(256)))
  return Buffer.byteLength(JSON.stringify({
    jobs: projected.map(item => item.job), evidence: projected.map(item => item.evidence),
    nextCursor: 'c'.repeat(512),
  }), 'utf8') + PAGE_ENVELOPE_RESERVE
}

function restoredObservation(index: number, toolCallId: string, toolName: string, input: unknown, output: unknown) {
  return {
    id: `child-resume:${String(index).padStart(24, '0')}`,
    content: { toolCallId, toolName, input, status: 'completed', output, errorCode: null },
  }
}

function chunkedRestoreByteCount(encoded: string): { bytes: number; chunks: number } {
  const data = Buffer.from(encoded, 'utf8')
  const ref = 'tool-result-12345678-1234-4234-8234-123456789abc'
  const sha256 = createHash('sha256').update(data).digest('hex')
  const observations: unknown[] = [restoredObservation(0, 'discover-call-00000000000000000000', 'jobs.discover', {}, {
    $ref: ref, sizeBytes: data.length, sha256,
  })]
  let cursor = 0
  let chunks = 0
  while (cursor < data.length) {
    let end = Math.min(data.length, cursor + READ_RESULT_LIMIT)
    let output: { ref: string; sha256: string; byteCount: number; chunk: string; nextCursor: string | null }
    do {
      output = {
        ref, sha256, byteCount: data.length, chunk: data.subarray(cursor, end).toString('utf8'),
        nextCursor: end < data.length ? String(end) : null,
      }
      if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= READ_RESULT_LIMIT) break
      end -= 1
    } while (end > cursor)
    if (end <= cursor) throw new Error('unable to fit read result chunk')
    observations.push(restoredObservation(chunks + 1, `read-call-${String(chunks).padStart(20, '0')}`, 'tool_results.read', {
      referenceId: ref, ...(cursor === 0 ? {} : { cursor: String(cursor) }),
    }, output))
    cursor = end
    chunks += 1
  }
  return { bytes: Buffer.byteLength(JSON.stringify(observations), 'utf8'), chunks }
}

describe('provider discovery cursor', () => {
  it('round-trips signed offsets bound to owner, session, Turn, query, and page size', () => {
    const cursor = encodeProviderDiscoveryCursor(scope, 'query-a', 2, 2)

    expect(decodeProviderDiscoveryCursor(scope, 'query-a', 2, cursor)).toBe(2)
    for (const args of [
      [{ ...scope, userId: 'user-2' }, 'query-a', 2],
      [{ ...scope, sessionId: 'session-2' }, 'query-a', 2],
      [{ ...scope, turnId: 'turn-2' }, 'query-a', 2],
      [scope, 'query-b', 2],
      [scope, 'query-a', 3],
    ] as const) {
      expect(() => decodeProviderDiscoveryCursor(args[0], args[1], args[2], cursor)).toThrow(DiscoveryToolError)
    }

    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { version: 1; offset: number; signature: string }
    const offsetTampered = Buffer.from(JSON.stringify({ ...payload, offset: 3 }), 'utf8').toString('base64url')
    expect(() => decodeProviderDiscoveryCursor(scope, 'query-a', 2, offsetTampered)).toThrow(DiscoveryToolError)
  })

  it('rejects malformed and unsafe offsets while preserving the existing jobs.search cursor contract', () => {
    expect(decodeProviderDiscoveryCursor(scope, 'query-a', 10, undefined)).toBe(0)
    const unsafe = Buffer.from(JSON.stringify({ version: 1, offset: -1, signature: 'A'.repeat(43) }), 'utf8').toString('base64url')
    expect(() => decodeProviderDiscoveryCursor(scope, 'query-a', 10, unsafe)).toThrow(DiscoveryToolError)

    const searchCursor = encodeSearchCursor(scope.userId, 'query-a', 4)
    expect(decodeSearchCursor(scope.userId, 'query-a', searchCursor)).toBe(4)
  })

  it('fails closed when the signing secret is missing', () => {
    vi.stubEnv('AGENT_WORKER_SECRET', '')
    expect(() => encodeProviderDiscoveryCursor(scope, 'query-a', 2, 2)).toThrow(DiscoveryToolError)
    expect(() => decodeProviderDiscoveryCursor(scope, 'query-a', 2, undefined)).toThrow(DiscoveryToolError)
  })

  it('leaves providerFailures absent from existing tool usage output', () => {
    const usage = createToolUsage(scope, 'jobs.search', Date.now(), {
      requests: 0,
      jobsProcessed: 0,
      jobsSucceeded: 0,
      jobsFailed: 0,
      aiCalls: 0,
      providers: [],
      estimatedCostUsd: 0,
    })

    expect(usage).not.toHaveProperty('providerFailures')
  })
})

describe('provider discovery durable page budget', () => {
  it('bounds a full-size candidate preview and keeps its full materialization page resumable', () => {
    const fullDescription = ESCAPE_HEAVY_TEXT.repeat(20_000)
    const first = maxFieldDiscoveryJob(fullDescription, '1')
    const second = maxFieldDiscoveryJob(fullDescription, '2')
    expect(projectedPageBytes([first])).toBeGreaterThan(56 * 1024)
    expect(projectedPageBytes([first])).toBeLessThanOrEqual(PROVIDER_PAGE_LIMIT)
    expect(first.description).toHaveLength(100_000)
    expect(first.description).toContain('\\')
    expect(first.description).toContain('\u0001')
    expect(projectedPageBytes([first, second])).toBeGreaterThan(PROVIDER_PAGE_LIMIT)
    expect(projectedPageBytes([first, second])).toBeLessThan(256 * 1024)

    const page = selectProviderDiscoveryPage([first, second], job => providerDiscoveryOutput(job, 'j'.repeat(256)))
    expect(page).toEqual([first])
    expect(page[0]).toBe(first)
    expect(page[0]?.description).toHaveLength(100_000)
    const projected = providerDiscoveryOutput(first, 'j'.repeat(256))
    expect(projected.job.description).toHaveLength(7_000)
    expect(projected.job.fullDescription).toBe(projected.job.description)
    const nextCursor = encodeProviderDiscoveryCursor(scope, 'query', 2, page.length)
    expect(decodeProviderDiscoveryCursor(scope, 'query', 2, nextCursor)).toBe(1)
    const output = {
      jobs: [projected.job], evidence: [projected.evidence], nextCursor,
      usage: {
        ledgerKey: 'l'.repeat(256), toolName: 'jobs.discover', toolVersion: '1', toolCallId: 'c'.repeat(256),
        sessionId: 's'.repeat(256), turnId: 't'.repeat(256), stepId: 'p'.repeat(256), requests: 32,
        jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0, providerFailures: 0, aiCalls: 0,
        providers: Array.from({ length: 32 }, (_, index) => `provider-${index}-${'p'.repeat(64)}`),
        estimatedCostUsd: 0, durationMs: 999_999,
      },
    }
    const encoded = JSON.stringify(output)
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(PROVIDER_PAGE_LIMIT)
    const restored = chunkedRestoreByteCount(encoded)
    expect(restored.chunks).toBeGreaterThan(16)
    expect(restored.chunks + 1).toBeLessThanOrEqual(256)
    expect(restored.bytes).toBeLessThan(RESTORED_OBSERVATION_LIMIT - 32 * 1024)
  })
})
