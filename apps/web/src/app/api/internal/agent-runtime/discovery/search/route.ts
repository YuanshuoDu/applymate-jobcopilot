import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { executeDiscover } from '@/lib/agent/discovery-tool-executors'
import type { DiscoveryJobMaterializerFence } from '@/lib/agent/discovery-job-materializer'
import { createToolUsage, DiscoveryToolError, type DiscoveryToolContext, type ToolUsageState } from '@/lib/agent/discovery-tool-support'
import type { JobsSearchInput } from '@/lib/agent/discovery-tool-types'
import {
  isValidDiscoverySearchTargetList,
  parseScheduledAutomationSnapshot,
  ScheduledAutomationSnapshotValidationError,
} from '@/lib/agent/scheduled-automation-snapshot'

type DiscoveryRequest = {
  userId: string
  sessionId: string
  turnId: string
  stepId: string
  toolCallId: string
  taskId: string
  rootTaskId: string
  leaseOwner: string
  attemptCount: number
  role: 'scout'
  targetRoles: string[]
  targetLocations: string[]
  source?: string
  pageSize?: number
  cursor?: string
}

const requestKeys = new Set([
  'userId', 'sessionId', 'turnId', 'stepId', 'toolCallId', 'taskId', 'rootTaskId',
  'leaseOwner', 'attemptCount', 'role', 'targetRoles', 'targetLocations', 'source',
  'pageSize', 'cursor',
])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function parseRequest(value: unknown): DiscoveryRequest | null {
  const row = record(value)
  if (!row || !exactKeys(row, requestKeys) || row.role !== 'scout') return null
  const targetRoles = row.targetRoles
  const targetLocations = row.targetLocations
  if (!isValidDiscoverySearchTargetList(targetRoles, 'targetRoles') ||
      !isValidDiscoverySearchTargetList(targetLocations, 'targetLocations')) return null
  if (row.source !== undefined && !text(row.source, 80)) return null
  if (row.pageSize !== undefined && (!Number.isSafeInteger(row.pageSize) || Number(row.pageSize) < 1 || Number(row.pageSize) > 50)) return null
  if (row.cursor !== undefined && !text(row.cursor, 512)) return null
  const scopeKeys = ['userId', 'sessionId', 'turnId', 'stepId', 'toolCallId', 'taskId', 'rootTaskId', 'leaseOwner'] as const
  if (!scopeKeys.every(key => text(row[key]))) return null
  if (!Number.isSafeInteger(row.attemptCount) || Number(row.attemptCount) < 1) return null
  return {
    userId: row.userId as string,
    sessionId: row.sessionId as string,
    turnId: row.turnId as string,
    stepId: row.stepId as string,
    toolCallId: row.toolCallId as string,
    taskId: row.taskId as string,
    rootTaskId: row.rootTaskId as string,
    leaseOwner: row.leaseOwner as string,
    attemptCount: Number(row.attemptCount),
    role: 'scout',
    targetRoles,
    targetLocations,
    ...(row.source !== undefined ? { source: row.source as string } : {}),
    ...(row.pageSize !== undefined ? { pageSize: Number(row.pageSize) } : {}),
    ...(row.cursor !== undefined ? { cursor: row.cursor as string } : {}),
  }
}

function toSearchInput(input: DiscoveryRequest): JobsSearchInput {
  return {
    targetRoles: input.targetRoles,
    targetLocations: input.targetLocations,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  }
}

type ScopedTurn = { id: string; sessionId: string; userId: string; rootTaskId: string | null; source: string; input: unknown }
type ActiveScoutScope = { executionFence: DiscoveryJobMaterializerFence; turn: ScopedTurn }

function toEffectiveSearchInput(input: DiscoveryRequest, turn: ScopedTurn): JobsSearchInput {
  if (turn.source !== 'automation') return toSearchInput(input)
  const persistedInput = record(turn.input)
  const snapshot = parseScheduledAutomationSnapshot(persistedInput?.scheduledAutomationSnapshot)
  return toSearchInput({ ...input, targetRoles: snapshot.targetRoles, targetLocations: snapshot.targetLocations })
}

async function hasActiveScoutScope(input: DiscoveryRequest): Promise<ActiveScoutScope | null> {
  const { userId, sessionId, turnId, stepId, taskId, rootTaskId } = input
  const [session, turn] = await Promise.all([
    db.agentSession.findFirst({ where: { id: sessionId, userId, status: 'running' }, select: { id: true } }),
    db.agentTurn.findFirst({ where: { id: turnId, sessionId, userId, status: 'in_progress' }, select: {
      id: true, sessionId: true, userId: true, rootTaskId: true, source: true, input: true,
    } }),
  ])
  if (!session || !turn || turn.id !== turnId || turn.sessionId !== sessionId || turn.userId !== userId || turn.rootTaskId !== rootTaskId) return null
  const [step, root, child] = await Promise.all([
    db.agentStep.findFirst({ where: { id: stepId, sessionId, turnId, taskId, status: 'streaming' }, select: { id: true, attempt: true } }),
    db.subAgentTask.findFirst({ where: {
      id: rootTaskId, sessionId, turnId, rootTaskId, parentTaskId: null,
      role: 'orchestrator', taskType: 'root', status: 'running', interruptRequestedAt: null, closedAt: null,
    }, select: { id: true } }),
    db.subAgentTask.findFirst({ where: {
      id: taskId, sessionId, turnId, rootTaskId, parentTaskId: rootTaskId,
      role: 'scout', taskType: 'job_discovery', status: 'running',
      interruptRequestedAt: null, closedAt: null, leaseOwner: input.leaseOwner,
      attemptCount: input.attemptCount, leaseExpiresAt: { gt: new Date() },
    }, select: { id: true, allowedActions: true, leaseOwner: true, attemptCount: true } }),
  ])
  const allowedActions = child?.allowedActions
  if (!step || step.attempt !== input.attemptCount || !root || !child || child.leaseOwner !== input.leaseOwner ||
      child.attemptCount !== input.attemptCount || !Array.isArray(allowedActions) || !allowedActions.includes('jobs.discover')) return null
  return {
    executionFence: {
      userId, sessionId, turnId, stepId, taskId, rootTaskId,
      leaseOwner: input.leaseOwner, attemptCount: input.attemptCount,
    },
    turn: {
      id: turn.id, sessionId: turn.sessionId, userId: turn.userId, rootTaskId: turn.rootTaskId,
      source: turn.source, input: turn.input,
    },
  }
}

function usageState(): ToolUsageState {
  return { requests: 0, jobsProcessed: 0, jobsSucceeded: 0, jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: new Set(), estimatedCostUsd: 0 }
}

function usageFor(context: DiscoveryToolContext, startedAt: number, usage: ToolUsageState) {
  const providers = [...new Set([...usage.providers].map(provider => provider.slice(0, 80)))]
    .sort()
    .slice(0, 32)
  return createToolUsage(context.scope, 'jobs.discover', startedAt, { ...usage, providers })
}

function errorDetails(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof ScheduledAutomationSnapshotValidationError) {
    return { code: 'invalid_scheduled_automation_snapshot', message: 'Scheduled automation snapshot is invalid', status: 409 }
  }
  if (error instanceof DiscoveryToolError) {
    const status = error.code === 'invalid_cursor' ? 400 : error.code === 'cancelled' ? 409 : error.code === 'agent_scope_mismatch' ? 404 : 502
    return { code: error.code, message: error.message.slice(0, 300), status }
  }
  return { code: 'discovery_unavailable', message: 'Provider discovery could not be completed', status: 503 }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!process.env.AGENT_WORKER_SECRET?.trim() ||
      request.headers.get('x-agent-worker-secret') !== process.env.AGENT_WORKER_SECRET) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 })
  }
  const input = parseRequest(await request.json().catch(() => null))
  if (!input) return NextResponse.json({ error: { code: 'invalid_request' } }, { status: 400 })
  const startedAt = Date.now()
  const usage = usageState()
  const context: DiscoveryToolContext = {
    scope: {
      userId: input.userId, sessionId: input.sessionId, turnId: input.turnId,
      stepId: input.stepId, toolCallId: input.toolCallId, role: 'scout',
    },
    signal: request.signal,
  }
  const activeScope = await hasActiveScoutScope(input)
  if (!activeScope) return NextResponse.json({ error: { code: 'agent_scope_mismatch' } }, { status: 404 })
  try {
    const output = await executeDiscover(toEffectiveSearchInput(input, activeScope.turn), context, {
      executionFence: activeScope.executionFence,
    }, usage)
    return NextResponse.json({ ...output, usage: usageFor(context, startedAt, usage) })
  } catch (error) {
    const details = errorDetails(error)
    if (details.code !== 'cancelled') usage.jobsFailed = Math.max(usage.jobsFailed, usage.jobsProcessed - usage.jobsSucceeded)
    return NextResponse.json({ error: { code: details.code, message: details.message }, usage: usageFor(context, startedAt, usage) }, { status: details.status })
  }
}
