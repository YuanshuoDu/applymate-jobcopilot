import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validate } from '@jobcopilot/agent-protocol'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))

vi.mock('@/lib/db', () => ({ db: { job: { findMany: mocks.findMany } } }))

import {
  createDiscoveryAnalysisTools,
  visibleDiscoveryAnalysisTools,
  type DiscoveryToolContext,
  type DiscoveryToolDependencies,
  type ScorePipelineContext,
  type AgentDiscoveryTool,
} from './discovery-tools'
import { JobsSearchInputSchema, JobsSearchOutputSchema, type JobsEnrichInput, type JobsEnrichOutput, type JobsScoreInput, type JobsScoreOutput, type JobsSearchInput, type JobsSearchOutput } from './discovery-tool-types'

const scope = (role: DiscoveryToolContext['scope']['role'] = 'orchestrator'): DiscoveryToolContext['scope'] => ({
  userId: 'tenant-a', sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', toolCallId: 'call-1', role,
})

const job = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, userId: 'tenant-a', company: 'Acme', role: 'Backend Engineer', location: 'Dublin', url: `https://jobs.example.test/${id}`,
  description: 'A complete job description with enough detail for analysis.', salary: '€70k', score: null, source: 'greenhouse', ...overrides,
})

function context(role: DiscoveryToolContext['scope']['role'] = 'orchestrator', recordUsage = vi.fn()): DiscoveryToolContext {
  return { scope: scope(role), recordUsage }
}

function pipelineContext(): ScorePipelineContext {
  return {
    agentCfg: {} as ScorePipelineContext['agentCfg'], roleConfigs: {} as ScorePipelineContext['roleConfigs'],
    resumeText: 'TypeScript engineer', resumeContent: {} as ScorePipelineContext['resumeContent'],
    defaultResume: { id: 'resume-1', name: 'Base', templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: { provider: 'minimax', model: 'MiniMax-M3' }, autonomous: false, emit: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findMany.mockResolvedValue([])
})

describe('discovery and analysis typed tools', () => {
  it('publishes four typed contracts and rejects model-supplied tenant fields', () => {
    const tools = createDiscoveryAnalysisTools()
    expect(tools.map(tool => tool.name)).toEqual(['jobs.search', 'jobs.enrich', 'jobs.score', 'jobs.compare'])
    expect(tools.find(tool => tool.name === 'jobs.score')).toMatchObject({ risk: 'draft_write', idempotency: 'idempotent' })
    expect(validate(JobsSearchInputSchema as never, { targetRoles: ['Engineer'], targetLocations: [], userId: 'tenant-b' })).toBe(false)
    expect(validate(JobsSearchInputSchema as never, { targetRoles: ['Engineer'], targetLocations: [], pageSize: 2 })).toBe(true)
  })

  it('validates direct tool calls at the adapter boundary', async () => {
    const search = createDiscoveryAnalysisTools().find(tool => tool.name === 'jobs.search')! as AgentDiscoveryTool<JobsSearchInput, JobsSearchOutput>
    await expect(search.execute(context(), { targetRoles: [], targetLocations: [] })).rejects.toThrow('schema_error:jobs.search:input')
  })

  it('paginates stable IDs with source and full-description evidence and records tool usage', async () => {
    const discover = vi.fn(async (input: Parameters<NonNullable<DiscoveryToolDependencies['discover']>>[0]) => {
      await input.onProviderCall?.({ provider: 'greenhouse', role: 'Engineer', location: 'Dublin', jobsReturned: 3, status: 'success', latencyMs: 1 })
      return [job('a'), job('b', { source: 'lever', description: 'A'.repeat(220) }), job('c')].map(item => ({
        title: item.role, company: item.company, location: item.location, url: item.url, description: item.description, salary: item.salary, logo: null, source: item.source,
      }))
    })
    const recordUsage = vi.fn()
    const search = createDiscoveryAnalysisTools({ discover }).find(tool => tool.name === 'jobs.search')! as AgentDiscoveryTool<JobsSearchInput, JobsSearchOutput>
    const first = await search.execute({ ...context('scout', recordUsage), scope: scope('scout') }, { targetRoles: ['Engineer'], targetLocations: ['Dublin'], pageSize: 2 })
    expect(first.jobs).toHaveLength(2)
    expect(first.jobs[1]).toMatchObject({ source: 'lever', fullDescription: 'A'.repeat(220) })
    expect(first.evidence).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()
    expect(first.usage).toMatchObject({ toolName: 'jobs.search', toolCallId: 'call-1', requests: 1, jobsSucceeded: 2, providers: ['greenhouse', 'lever'] })
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ ledgerKey: expect.stringContaining('tenant-a:session-1:turn-1:step-1:call-1') }))

    const second = await search.execute({ ...context('scout'), scope: scope('scout') }, { targetRoles: ['Engineer'], targetLocations: ['Dublin'], pageSize: 2, cursor: first.nextCursor! })
    expect(second.jobs).toHaveLength(1)
    expect(second.jobs[0].id).not.toBe(first.jobs[0].id)
    expect(validate(JobsSearchOutputSchema as never, first)).toBe(true)
  })

  it('isolates enrichment failures and keeps the successful full description', async () => {
    mocks.findMany.mockResolvedValue([job('a'), job('b')])
    const enrich = vi.fn(async (input: { url: string }) => {
      if (input.url.endsWith('/b')) throw new Error('provider timeout')
      return { description: 'Full ATS description', applyUrl: input.url, method: 't0-ats' as const }
    })
    const tool = createDiscoveryAnalysisTools({ enrich: enrich as unknown as NonNullable<DiscoveryToolDependencies['enrich']> }).find(item => item.name === 'jobs.enrich')! as AgentDiscoveryTool<JobsEnrichInput, JobsEnrichOutput>
    const result = await tool.execute(context('analyst'), { jobs: [{ jobId: 'a', html: '<html />' }, { jobId: 'b', html: '<html />' }] })
    expect(result.results).toEqual([
      expect.objectContaining({ jobId: 'a', status: 'enriched', fullDescription: 'Full ATS description' }),
      expect.objectContaining({ jobId: 'b', status: 'failed', code: 'enrichment_failed' }),
    ])
    expect(result.usage).toMatchObject({ jobsSucceeded: 1, jobsFailed: 1, requests: 2 })
  })

  it('isolates scoring failures per job and attributes the analyst provider', async () => {
    mocks.findMany.mockResolvedValue([job('a'), job('b')])
    const analyze = vi.fn(async (jobs: Array<{ id: string }>) => {
      if (jobs[0]!.id === 'b') throw new Error('model unavailable')
      return { ok: true, data: { scoredJobs: [{ job: jobs[0], score: 88, matchedKeywords: ['TypeScript'], missingKeywords: [], recommendation: 'Apply.' }], failed: 0 }, metrics: { count: 1, durationMs: 1 }, stage: 'analyze' }
    }) as unknown as NonNullable<DiscoveryToolDependencies['analyze']>
    const tool = createDiscoveryAnalysisTools({ analyze }).find(item => item.name === 'jobs.score')! as AgentDiscoveryTool<JobsScoreInput, JobsScoreOutput>
    const result = await tool.execute({ ...context('analyst'), pipelineContext: pipelineContext() }, { jobIds: ['a', 'b'] })
    expect(result.results).toEqual([
      expect.objectContaining({ jobId: 'a', status: 'scored', score: 88 }),
      expect.objectContaining({ jobId: 'b', status: 'failed', code: 'score_failed' }),
    ])
    expect(result.usage).toMatchObject({ aiCalls: 2, jobsSucceeded: 1, jobsFailed: 1, providers: ['minimax'] })
  })

  it('filters every DB lookup by the runtime tenant and never returns another tenant job', async () => {
    mocks.findMany.mockResolvedValue([job('a')])
    const compare = createDiscoveryAnalysisTools().find(item => item.name === 'jobs.compare')! as AgentDiscoveryTool<import('./discovery-tool-types').JobsCompareInput, import('./discovery-tool-types').JobsCompareOutput>
    const result = await compare.execute(context('reviewer'), { jobIds: ['a', 'foreign'] })
    expect(mocks.findMany).toHaveBeenCalledWith({ where: { userId: 'tenant-a', id: { in: ['a', 'foreign'] } } })
    expect(result.comparisons.map(item => item.jobId)).toEqual(['a'])
    expect(result.failures).toEqual([expect.objectContaining({ jobId: 'foreign', code: 'job_not_visible' })])
  })

  it('exposes only the role-appropriate tools and fails closed on execution', async () => {
    expect(visibleDiscoveryAnalysisTools('scout').map(tool => tool.name)).toEqual(['jobs.search', 'jobs.enrich'])
    expect(visibleDiscoveryAnalysisTools('analyst').map(tool => tool.name)).toEqual(['jobs.search', 'jobs.enrich', 'jobs.score', 'jobs.compare'])
    const score = createDiscoveryAnalysisTools().find(tool => tool.name === 'jobs.score')!
    await expect(score.execute({ ...context('reviewer'), scope: scope('reviewer') }, { jobIds: ['a'] })).rejects.toThrow('tool_visibility_denied')
  })
})
