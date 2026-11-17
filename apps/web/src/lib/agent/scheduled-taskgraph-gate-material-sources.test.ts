import { describe, expect, it, vi } from 'vitest'
import { hashArtifactContent } from './artifacts/hash'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { loadScheduledTaskGraphGateMaterialSources } from './scheduled-taskgraph-gate-material-sources'

const owner: ScheduledTaskGraphPipelineOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 1, turnLeaseOwnerId: 'lease-1', turnLeaseVersion: 1, executionId: 'execution-1', executionAttemptCount: 0 }
const job = { id: 'job-1', userId: owner.userId, company: 'Example', role: 'Engineer', location: 'Dublin', status: 'saved', score: 80,
  url: 'https://jobs.example/1', source: 'greenhouse', salary: null, description: 'Role details', keywords: ['TypeScript'] }
const resume = { id: 'resume-1', name: 'Base resume', kind: 'base', origin: 'upload', isDefault: true,
  content: { summary: 'Base resume body' }, createdAt: new Date('2026-10-01T00:00:00.000Z'), updatedAt: new Date('2026-10-02T00:00:00.000Z') }
const fact = { id: 'fact-a', key: 'work_style', category: 'preference', value: 'Reliable', source: 'user', sourceRef: null,
  confidence: 0.9, allowedUses: ['cover_letter'] }

describe('scheduled TaskGraph Gate material sources', () => {
  it('loads and hashes source rows through the supplied transaction reader', async () => {
    const reader = {
      agentSession: { findFirst: vi.fn().mockResolvedValue({ id: owner.sessionId }) },
      job: { findMany: vi.fn().mockResolvedValue([job]) },
      resume: { findFirst: vi.fn().mockResolvedValue(resume) },
      personaFact: { findMany: vi.fn().mockResolvedValue([fact]) },
    }

    const result = await loadScheduledTaskGraphGateMaterialSources(reader as never, owner, ['job-1'])
    const sources = [
      { sourceRef: 'job:job-1', content: { id: job.id, company: job.company, role: job.role, location: job.location, status: job.status,
        score: job.score, url: job.url, source: job.source, salary: job.salary, description: job.description, keywords: job.keywords } },
      { sourceRef: 'resume:resume-1', content: { ...resume, createdAt: resume.createdAt.toISOString(), updatedAt: resume.updatedAt.toISOString() } },
      { sourceRef: 'persona:fact-a', content: { ...fact, rank: 1 } },
    ].map(item => ({ sourceRef: item.sourceRef, contentHash: hashArtifactContent(item.content) }))
      .sort((a, b) => a.sourceRef.localeCompare(b.sourceRef))

    expect(result?.jobs.get('job-1')).toEqual(job)
    expect(result?.byJob.get('job-1')).toEqual({ digest: hashArtifactContent({ jobId: 'job-1', sources }),
      refs: sources.map(item => item.sourceRef), hashes: new Map(sources.map(item => [item.sourceRef, item.contentHash])) })
    expect(reader.agentSession.findFirst).toHaveBeenCalledOnce()
    expect(reader.job.findMany).toHaveBeenCalledOnce()
    expect(reader.resume.findFirst).toHaveBeenCalledOnce()
    expect(reader.personaFact.findMany).toHaveBeenCalledOnce()
  })

  it('stops before querying source rows when the owning session is absent', async () => {
    const reader = {
      agentSession: { findFirst: vi.fn().mockResolvedValue(null) },
      job: { findMany: vi.fn() }, resume: { findFirst: vi.fn() }, personaFact: { findMany: vi.fn() },
    }

    await expect(loadScheduledTaskGraphGateMaterialSources(reader as never, owner, ['job-1'])).resolves.toBeNull()
    expect(reader.job.findMany).not.toHaveBeenCalled()
    expect(reader.resume.findFirst).not.toHaveBeenCalled()
    expect(reader.personaFact.findMany).not.toHaveBeenCalled()
  })
})
