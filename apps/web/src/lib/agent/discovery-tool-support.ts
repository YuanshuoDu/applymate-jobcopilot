import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import type { PipelineCtx } from './types'
import type { DiscoveredJob } from './discover'
import type { JobEvidence, NormalizedJob, ToolUsage } from './discovery-tool-types'

export type DiscoveryToolRole = 'orchestrator' | 'scout' | 'analyst' | 'reviewer' | 'auditor'

export type DiscoveryToolScope = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly toolCallId: string
  readonly role: DiscoveryToolRole
}

export type ScorePipelineContext = Omit<PipelineCtx, 'userId' | 'sessionId'> & {
  userId?: string
  sessionId?: string
}

export type ToolUsageWriter = (usage: ToolUsage) => Promise<void> | void

export type DiscoveryToolContext = {
  readonly scope: DiscoveryToolScope
  readonly signal?: AbortSignal
  readonly pipelineContext?: ScorePipelineContext
  readonly recordUsage?: ToolUsageWriter
}

export type ToolUsageState = {
  requests: number
  jobsProcessed: number
  jobsSucceeded: number
  jobsFailed: number
  providerFailures?: number
  aiCalls: number
  providers: Set<string>
  estimatedCostUsd: number
}

export const TOOL_ROLE_VISIBILITY: Readonly<Record<string, readonly DiscoveryToolRole[]>> = {
  'jobs.search': ['orchestrator', 'scout', 'analyst', 'reviewer', 'auditor'],
  'jobs.enrich': ['orchestrator', 'scout', 'analyst'],
  'jobs.score': ['orchestrator', 'analyst'],
  'jobs.compare': ['orchestrator', 'analyst', 'reviewer', 'auditor'],
}

export function isDiscoveryToolVisible(toolName: string, role: DiscoveryToolRole): boolean {
  return TOOL_ROLE_VISIBILITY[toolName]?.includes(role) ?? false
}

export function assertTenantScope(scope: DiscoveryToolScope): void {
  if (!scope.userId.trim() || !scope.sessionId.trim() || !scope.turnId.trim() || !scope.stepId.trim() || !scope.toolCallId.trim()) {
    throw new DiscoveryToolError('tenant_scope_required', 'Agent tool execution requires a complete tenant and tool scope')
  }
}

export class DiscoveryToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DiscoveryToolError'
  }
}

export function stableJobId(url: string, company: string, title: string, location: string): string {
  const identity = url.trim() || `${company}\u001f${title}\u001f${location}`
  return `job_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

type SearchCursor = { version: 1; fingerprint: string; offset: number }

type ProviderDiscoveryCursor = { version: 1; offset: number; signature: string }
// Reserve half of the Worker's 256 KiB resume budget for escaped read metadata.
const PROVIDER_DISCOVERY_PAGE_BYTES = 64 * 1024
const PROVIDER_DISCOVERY_ENVELOPE_RESERVE_BYTES = 4 * 1024
const PROVIDER_DISCOVERY_DESCRIPTION_PREVIEW_CHARS = 7_000

export function providerDiscoveryOutput(job: DiscoveredJob, id: string): { job: NormalizedJob; evidence: JobEvidence } {
  const evidenceId = `evidence_${id}_source`
  const descriptionPreview = job.description.slice(0, PROVIDER_DISCOVERY_DESCRIPTION_PREVIEW_CHARS)
  return {
    job: { id, title: job.title, company: job.company, location: job.location, url: job.url, description: descriptionPreview, fullDescription: descriptionPreview, salary: job.salary, logo: job.logo, source: job.source, evidenceRefs: [evidenceId] },
    evidence: { evidenceId, jobId: id, kind: 'source', source: job.source, url: job.url, summary: `Discovered from ${job.source}; full description ${job.description ? 'available' : 'missing'}.` },
  }
}

export function selectProviderDiscoveryPage<T>(candidates: readonly T[], project: (candidate: T) => { job: unknown; evidence: unknown }): T[] {
  const selected: T[] = []
  const jobs: unknown[] = []
  const evidence: unknown[] = []
  for (const candidate of candidates) {
    const output = project(candidate)
    const nextJobs = [...jobs, output.job]
    const nextEvidence = [...evidence, output.evidence]
    const bytes = Buffer.byteLength(JSON.stringify({ jobs: nextJobs, evidence: nextEvidence, nextCursor: 'x'.repeat(512) }), 'utf8') + PROVIDER_DISCOVERY_ENVELOPE_RESERVE_BYTES
    if (bytes > PROVIDER_DISCOVERY_PAGE_BYTES) {
      if (!selected.length) throw new DiscoveryToolError('tool_result_too_large', 'A discovered job exceeds the bounded result size')
      break
    }
    selected.push(candidate)
    jobs.push(output.job)
    evidence.push(output.evidence)
  }
  return selected
}

export function encodeSearchCursor(userId: string, fingerprint: string, offset: number): string {
  const payload: SearchCursor = { version: 1, fingerprint: createHash('sha256').update(`${userId}\u001f${fingerprint}`).digest('hex'), offset }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeSearchCursor(userId: string, fingerprint: string, cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SearchCursor>
    const expected = createHash('sha256').update(`${userId}\u001f${fingerprint}`).digest('hex')
    if (parsed.version !== 1 || parsed.fingerprint !== expected || !Number.isSafeInteger(parsed.offset) || parsed.offset === undefined || parsed.offset < 0) {
      throw new Error('invalid cursor')
    }
    return parsed.offset
  } catch {
    throw new DiscoveryToolError('invalid_cursor', 'The discovery cursor is invalid or belongs to another query')
  }
}

export function encodeProviderDiscoveryCursor(
  scope: Pick<DiscoveryToolScope, 'userId' | 'sessionId' | 'turnId'>,
  fingerprint: string,
  pageSize: number,
  offset: number,
): string {
  const secret = providerDiscoveryCursorSecret()
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new DiscoveryToolError('invalid_cursor', 'The discovery cursor is invalid')
  }
  const payload: ProviderDiscoveryCursor = {
    version: 1,
    offset,
    signature: providerDiscoveryCursorSignature(scope, fingerprint, pageSize, offset, secret),
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeProviderDiscoveryCursor(
  scope: Pick<DiscoveryToolScope, 'userId' | 'sessionId' | 'turnId'>,
  fingerprint: string,
  pageSize: number,
  cursor: string | undefined,
): number {
  const secret = providerDiscoveryCursorSecret()
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<ProviderDiscoveryCursor>
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.offset) || parsed.offset === undefined || parsed.offset < 0 ||
        typeof parsed.signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(parsed.signature)) {
      throw new Error('invalid cursor')
    }
    const actual = Buffer.from(parsed.signature, 'base64url')
    const expected = Buffer.from(providerDiscoveryCursorSignature(scope, fingerprint, pageSize, parsed.offset, secret), 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid cursor signature')
    return parsed.offset
  } catch {
    throw new DiscoveryToolError('invalid_cursor', 'The discovery cursor is invalid or belongs to another query')
  }
}

function providerDiscoveryCursorSecret(): string {
  const secret = process.env.AGENT_WORKER_SECRET
  if (!secret?.trim()) throw new DiscoveryToolError('cursor_signing_unavailable', 'Provider discovery cursor signing is unavailable')
  return secret
}

function providerDiscoveryCursorSignature(
  scope: Pick<DiscoveryToolScope, 'userId' | 'sessionId' | 'turnId'>,
  fingerprint: string,
  pageSize: number,
  offset: number,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify([1, scope.userId, scope.sessionId, scope.turnId, fingerprint, pageSize, offset]))
    .digest('base64url')
}

export function queryFingerprint(input: unknown): string {
  return JSON.stringify(sortValue(input))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortValue(child)]))
  }
  return value
}

export function createToolUsage(scope: DiscoveryToolScope, toolName: string, startedAt: number, data: Omit<ToolUsage, 'ledgerKey' | 'toolName' | 'toolVersion' | 'toolCallId' | 'sessionId' | 'turnId' | 'stepId' | 'durationMs'>): ToolUsage {
  return {
    ...data,
    ledgerKey: `${scope.userId}:${scope.sessionId}:${scope.turnId}:${scope.stepId}:${scope.toolCallId}`,
    toolName,
    toolVersion: '1',
    toolCallId: scope.toolCallId,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    stepId: scope.stepId,
    durationMs: Math.max(0, Date.now() - startedAt),
  }
}
