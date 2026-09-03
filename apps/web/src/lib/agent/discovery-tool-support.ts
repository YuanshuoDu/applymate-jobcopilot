import { createHash } from 'node:crypto'

import type { PipelineCtx } from './types'
import type { ToolUsage } from './discovery-tool-types'

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
