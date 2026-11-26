import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ context: vi.fn() }))
vi.mock('./objective-journey-report-source', () => ({ readObjectiveJourneyProofContext: mocks.context }))

import { readObjectiveJobEvidence } from './objective-job-evidence'

const userId = 'owner-1', sessionId = 'session-1', finalItemId = 'final-1', graphRevision = 7
const scoutKey = `src_${'a'.repeat(43)}`, secondScoutKey = `src_${'b'.repeat(43)}`, analystKey = `src_${'c'.repeat(43)}`
const digest = 'a'.repeat(64)

describe('Objective saved Job evidence', () => {
  beforeEach(() => mocks.context.mockReset())

  it('projects full Scout membership, deduplicates across tasks, and retains source keys', async () => {
    const scout = sourceTask('scout-task', 'scout', 'partial', ['job-1', 'job-2'], { multiline: true })
    const second = sourceTask('scout-task-2', 'scout', 'completed', ['job-1'])
    mocks.context.mockResolvedValue(context({
      sources: [source(scoutKey, 0, 'scout', 'partial'), source(secondScoutKey, 1, 'scout', 'completed')],
      nodes: [{ taskId: 'scout-task', templateId: 'scout' }, { taskId: 'scout-task-2', templateId: 'scout' }], tasks: [scout, second],
      count: 2, coverage: 'partial', group: 'discoveredJobs', keys: [scoutKey, secondScoutKey],
    }))
    const client = tx([job('job-1', 'Engineer', 'Dublin', 'https://jobs.example/1'), job('job-2', 'Analyst', ' ', 'http://unsafe.example/2')])

    const evidence = await readObjectiveJobEvidence(client as never, { userId, sessionId, finalItemId, graphRevision, group: 'discoveredJobs' })

    expect(evidence).toMatchObject({ group: 'discoveredJobs', coverage: 'partial', count: 2,
      jobs: [{ ordinal: 1, role: 'Engineer', sourceKeys: [scoutKey, secondScoutKey] }, { ordinal: 2, role: 'Analyst', location: null, postingUrl: null, sourceKeys: [scoutKey] }] })
    expect(JSON.stringify(evidence)).not.toContain('Private model summary')
    expect(client.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId, id: { in: ['job-1', 'job-2'] } } }))
  })

  it('projects Analyst membership and ignores an excluded failed source task', async () => {
    const analyst = sourceTask('analyst-task', 'analyst', 'completed', ['job-3'])
    const failed = { id: 'failed-task', parentTaskId: 'root-1', role: 'scout', taskType: 'job_discovery', status: 'failed', result: null }
    mocks.context.mockResolvedValue(context({
      sources: [source(analystKey, 0, 'analyst', 'completed')], nodes: [{ taskId: 'analyst-task', templateId: 'analyst' }], tasks: [analyst, failed],
      count: 1, coverage: 'complete', group: 'analyzedJobs', keys: [analystKey],
    }))
    const evidence = await readObjectiveJobEvidence(tx([job('job-3', 'Reviewer', null, 'https://jobs.example/3')]) as never,
      { userId, sessionId, finalItemId, graphRevision, group: 'analyzedJobs' })
    expect(evidence).toMatchObject({ group: 'analyzedJobs', coverage: 'complete', jobs: [{ role: 'Reviewer', sourceKeys: [analystKey] }] })
  })

  const invalidCases: ReadonlyArray<readonly [string, { count?: number; sourceRole?: 'scout' | 'analyst'; tamperDigest?: boolean; rows?: unknown[] }]> = [
    ['count drift', { count: 2 }],
    ['foreign source role', { sourceRole: 'analyst' }],
    ['tampered digest', { tamperDigest: true }],
    ['missing owned Job', { rows: [] }],
  ]
  it.each(invalidCases)('fails closed for %s', async (_label, options) => {
    const task = sourceTask('scout-task', 'scout', 'completed', ['job-1'], { tamperDigest: options.tamperDigest })
    mocks.context.mockResolvedValue(context({
      sources: [source(scoutKey, 0, options.sourceRole ?? 'scout', 'completed')], nodes: [{ taskId: 'scout-task', templateId: 'scout' }], tasks: [task],
      count: options.count ?? 1, coverage: 'complete', group: 'discoveredJobs', keys: [scoutKey],
    }))
    const result = await readObjectiveJobEvidence(tx(options.rows ?? [job('job-1', 'Engineer', null, null)]) as never,
      { userId, sessionId, finalItemId, graphRevision, group: 'discoveredJobs' })
    expect(result).toBeUndefined()
  })
})

function context(input: { sources: unknown[]; nodes: unknown[]; tasks: unknown[]; count: number; coverage: 'complete' | 'partial'; group: 'discoveredJobs' | 'analyzedJobs'; keys: string[] }) {
  const tasks = new Map((input.tasks as Array<{ id: string }>).map(task => [task.id, task]))
  return {
    userId, sessionId, sourceTurnId: 'turn-1', rootTaskId: 'root-1', finalItemId, graphRevision,
    manifest: { schemaVersion: 'agent-harness.v2.task-graph-sources.v1', graphRevision, sources: input.sources },
    sidecar: { schemaVersion: 'agent-harness.v2.objective-tailor-final-outcomes.v2', graphRevision, slots: [], sourceCounts: {
      discoveredJobs: { knownCount: input.group === 'discoveredJobs' ? input.count : 0, coverage: input.group === 'discoveredJobs' ? input.coverage : 'complete' },
      analyzedJobs: { knownCount: input.group === 'analyzedJobs' ? input.count : 0, coverage: input.group === 'analyzedJobs' ? input.coverage : 'complete' },
    } },
    progress: { marker: { slots: [] }, nodes: input.nodes }, tasks,
    sourceGroups: { schemaVersion: 'agent-harness.v2.objective-tailor-source-groups.v1', graphRevision,
      groups: { discoveredJobs: input.group === 'discoveredJobs' ? input.keys : [], analyzedJobs: input.group === 'analyzedJobs' ? input.keys : [] } },
  }
}

function source(sourceKey: string, nodeIndex: number, role: 'scout' | 'analyst', roleResultStatus: 'completed' | 'partial') {
  return { sourceKey, nodeIndex, role, taskStatus: 'completed', resultState: 'valid', roleResultStatus }
}
function sourceTask(id: string, role: 'scout' | 'analyst', status: 'completed' | 'partial', jobIds: string[], options: { multiline?: boolean; tamperDigest?: boolean } = {}) {
  const evidence = jobIds.map(jobId => ({ id: `evidence-${id}-${jobId}`, kind: 'job', ref: jobId, source: 'greenhouse' }))
  const structuredResult = role === 'scout'
    ? { schemaVersion: 'agent-harness.v2.subagent.result', role, status, summary: options.multiline ? 'Private model summary\nwith details' : 'summary',
      candidates: jobIds.map((jobId, index) => ({ jobId, source: 'greenhouse', url: `https://jobs.example/${jobId}`, evidenceIds: [evidence[index]!.id] })), evidence }
    : { schemaVersion: 'agent-harness.v2.subagent.result', role, status, summary: 'summary',
      findings: jobIds.map((jobId, index) => ({ jobId, score: 8, evidenceIds: [evidence[index]!.id] })), evidence }
  return { id, parentTaskId: 'root-1', role, taskType: role === 'scout' ? 'job_discovery' : 'job_analysis', status: 'completed',
    result: envelope(structuredResult, options.tamperDigest) }
}
function envelope(structuredResult: Record<string, unknown>, tamperDigest = false) {
  return { finalItemId: null, finalText: 'private', status: 'completed', stepCount: 1, toolCallCount: 1, structuredResult,
    taskGraphVerificationReport: { verifierVersion: 'agent-harness.v2.task-graph-verifier.v1', status: 'passed', reasonCode: 'criteria_met',
      criteria: [{ criterionId: 'candidate-count', status: 'passed', reasonCode: 'criteria_met' }], evidenceDigest: digest,
      resultDigest: tamperDigest ? 'b'.repeat(64) : workerDigest(structuredResult) } }
}
function workerDigest(value: unknown): string { return createHash('sha256').update(workerCanonicalJson(value)).digest('hex') }
function workerCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(workerCanonicalJson).join(',')}]`
  if (value && typeof value === 'object') { const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${workerCanonicalJson(row[key])}`).join(',')}}` }
  return JSON.stringify(value) ?? ''
}
function job(id: string, role: string, location: string | null, url: string | null) { return { id, userId, company: 'Acme', role, location, url } }
function tx(rows: unknown[]) { return { job: { findMany: vi.fn(async () => rows) } } }
