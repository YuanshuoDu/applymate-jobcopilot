import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { hashArtifactContent } from './artifacts/hash'

const mocks = vi.hoisted(() => ({ session: vi.fn(), jobs: vi.fn(), resume: vi.fn(), facts: vi.fn(), versions: vi.fn(), heads: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {
  agentSession: { findFirst: mocks.session }, job: { findMany: mocks.jobs }, resume: { findFirst: mocks.resume },
  personaFact: { findMany: mocks.facts }, agentArtifactVersion: { findMany: mocks.versions }, agentArtifact: { findMany: mocks.heads },
} }))

import { loadScheduledTaskGraphGateMaterials } from './scheduled-taskgraph-gate-materials'

const owner: ScheduledTaskGraphPipelineOwner = { userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1', rootTaskId: 'root-1',
  rootAttemptCount: 1, turnLeaseOwnerId: 'lease-1', turnLeaseVersion: 1, executionId: 'execution-1', executionAttemptCount: 0 }
const scoredJobs = [{ job: { id: 'job-1', userId: owner.userId }, score: 80, matchedKeywords: [], missingKeywords: [], recommendation: 'Prepare.' }]
const job = { id: 'job-1', userId: owner.userId, company: 'Example', role: 'Engineer', location: 'Dublin', status: 'saved', score: 80,
  url: 'https://jobs.example/1', source: 'greenhouse', salary: null, description: 'Role details', keywords: ['TypeScript'] }
const resume = { id: 'resume-1', name: 'Base resume', kind: 'base', origin: 'upload', isDefault: true,
  content: { summary: 'Base resume body' }, createdAt: new Date('2026-10-01T00:00:00.000Z'), updatedAt: new Date('2026-10-02T00:00:00.000Z') }
const facts = [
  { id: 'fact-a', key: 'work_style', category: 'preference', value: 'Used fact', source: 'user', sourceRef: null, confidence: 0.9, allowedUses: ['cover_letter'] },
  { id: 'fact-b', key: 'language', category: 'language', value: 'Unused fact', source: 'user', sourceRef: null, confidence: 0.8, allowedUses: ['cover_letter'] },
]
const materialContent = { summary: 'Tailored resume' }
const materialHash = hashArtifactContent(materialContent)
const constraintHash = `sha256:${'c'.repeat(64)}`
const baseHash = `sha256:${'d'.repeat(64)}`
const requestHash = `sha256:${'e'.repeat(64)}`

function sourceDigest(): string {
  const jobSource = { id: job.id, company: job.company, role: job.role, location: job.location ?? null, status: job.status,
    score: job.score ?? null, url: job.url ?? null, source: job.source ?? null, salary: job.salary ?? null,
    description: job.description ?? null, keywords: job.keywords ?? null }
  const resumeSource = { id: resume.id, name: resume.name, kind: resume.kind, origin: resume.origin, isDefault: resume.isDefault,
    content: resume.content, createdAt: resume.createdAt.toISOString(), updatedAt: resume.updatedAt.toISOString() }
  const allSources = [
    { sourceRef: `job:${job.id}`, content: jobSource }, { sourceRef: `resume:${resume.id}`, content: resumeSource },
    ...facts.map((fact, index) => ({ sourceRef: `persona:${fact.id}`, content: { ...fact, rank: index + 1 } })),
  ].map(item => ({ sourceRef: item.sourceRef, contentHash: hashArtifactContent(item.content) }))
    .sort((a, b) => a.sourceRef.localeCompare(b.sourceRef))
  return hashArtifactContent({ jobId: job.id, sources: allSources })
}

function installGateRows(provenanceRefs: readonly string[], artifactSourceDigest = sourceDigest()) {
  const artifactRef = { artifactId: 'artifact-resume-1', version: 1, contentHash: materialHash, sourceDigest: artifactSourceDigest }
  const version = { id: 'version-1', artifactId: artifactRef.artifactId, version: 1, userId: owner.userId, sessionId: owner.sessionId,
    jobId: job.id, artifactType: 'resume', content: materialContent, contentHash: materialHash, sourceDigest: artifactSourceDigest,
    constraintHash, provenanceRefs: [...provenanceRefs], evidenceRefs: [...provenanceRefs], baseId: 'base-resume-1', baseHash,
    taskId: 'prepare-1', toolCallId: 'scheduled-prepare-call', requestHash }
  const head = { id: artifactRef.artifactId, userId: owner.userId, jobId: job.id, artifactType: 'resume', lifecycle: 'draft',
    baseId: version.baseId, baseHash, content: materialContent, hash: materialHash, constraintHash,
    provenanceRefs: [...provenanceRefs], evidenceRefs: [...provenanceRefs], version: 1 }
  mocks.session.mockResolvedValue({ id: owner.sessionId })
  mocks.jobs.mockResolvedValue([job])
  mocks.resume.mockResolvedValue(resume)
  mocks.facts.mockResolvedValue(facts)
  mocks.versions.mockResolvedValue([version])
  mocks.heads.mockResolvedValue([head])
  return { artifactRef, version, head }
}

function installCoverLetterRows(markerOverrides: Record<string, unknown> = {}) {
  const refs = [`job:${job.id}`, `resume:${resume.id}`]
  const resumeRows = installGateRows(refs)
  const content = 'Dear Example, I build reliable systems.'
  const contentHash = hashArtifactContent(content), digest = sourceDigest()
  const artifactRef = { artifactId: 'artifact-letter-1', version: 1, contentHash, sourceDigest: digest }
  const version = { ...resumeRows.version, id: 'version-letter-1', artifactId: artifactRef.artifactId, artifactType: 'cover_letter',
    content, contentHash, sourceDigest: digest, baseId: 'base-letter-1' }
  const head = { ...resumeRows.head, id: artifactRef.artifactId, artifactType: 'cover_letter', baseId: version.baseId,
    content: { kind: 'agent_artifact_version', artifactId: artifactRef.artifactId, version: artifactRef.version, contentHash, ...markerOverrides },
    hash: contentHash }
  mocks.versions.mockResolvedValue([resumeRows.version, version])
  mocks.heads.mockResolvedValue([resumeRows.head, head])
  return { resumeRef: resumeRows.artifactRef, artifactRef, content }
}

describe('scheduled TaskGraph Gate materials', () => {
  beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset() })

  it('returns an empty package set without querying material sources when no jobs qualify', async () => {
    await expect(loadScheduledTaskGraphGateMaterials({ owner, scoredJobs, minScore: 90, dailyCap: 5,
      taskId: 'prepare-1', jobs: [], materials: [] })).resolves.toEqual({ packages: [], materials: [] })
    expect(mocks.session).not.toHaveBeenCalled()
    expect(mocks.versions).not.toHaveBeenCalled()
  })

  it('rejects prepared jobs without a resume artifact before loading source rows', async () => {
    await expect(loadScheduledTaskGraphGateMaterials({ owner, scoredJobs, minScore: 70, dailyCap: 5, taskId: 'prepare-1',
      jobs: [{ jobId: 'job-1', status: 'prepared' }], materials: [] })).resolves.toBeNull()
    expect(mocks.session).not.toHaveBeenCalled()
    expect(mocks.versions).not.toHaveBeenCalled()
  })

  it('accepts a job-only provenance set while retaining the full source digest', async () => {
    const refs = ['job:job-1', 'resume:resume-1']
    const { artifactRef } = installGateRows(refs)

    await expect(loadScheduledTaskGraphGateMaterials({ owner, scoredJobs, minScore: 70, dailyCap: 5, taskId: 'prepare-1',
      jobs: [{ jobId: 'job-1', status: 'prepared' }], materials: [{ jobId: 'job-1', kind: 'resume', artifactRef }] }))
      .resolves.toMatchObject({ materials: [{ jobId: 'job-1', kind: 'resume' }], packages: [{ jobId: 'job-1' }] })
  })

  it('accepts a cited Persona subset from the complete source bundle', async () => {
    const refs = ['job:job-1', 'persona:fact-a', 'resume:resume-1']
    const { artifactRef } = installGateRows(refs)

    await expect(loadScheduledTaskGraphGateMaterials({ owner, scoredJobs, minScore: 70, dailyCap: 5, taskId: 'prepare-1',
      jobs: [{ jobId: 'job-1', status: 'prepared' }], materials: [{ jobId: 'job-1', kind: 'resume', artifactRef }] }))
      .resolves.toMatchObject({ packages: [{ jobId: 'job-1' }] })
    expect(mocks.facts).toHaveBeenCalledOnce()
  })

  it('loads a cover letter from its immutable body while validating the content-free head marker', async () => {
    const rows = installCoverLetterRows()

    await expect(loadScheduledTaskGraphGateMaterials({ owner, scoredJobs, minScore: 70, dailyCap: 5, taskId: 'prepare-1',
      jobs: [{ jobId: 'job-1', status: 'prepared' }], materials: [
        { jobId: 'job-1', kind: 'resume', artifactRef: rows.resumeRef },
        { jobId: 'job-1', kind: 'cover_letter', artifactRef: rows.artifactRef },
      ] })).resolves.toMatchObject({
        packages: [{ package: { coverLetter: rows.content, coverLetterId: rows.artifactRef.artifactId } }],
        materials: [{ kind: 'resume' }, { kind: 'cover_letter' }],
      })
  })

  it('rejects a cover-letter head marker that does not match its immutable artifact reference', async () => {
    const rows = installCoverLetterRows({ artifactId: 'foreign-artifact' })

    await expect(loadScheduledTaskGraphGateMaterials({ owner, scoredJobs, minScore: 70, dailyCap: 5, taskId: 'prepare-1',
      jobs: [{ jobId: 'job-1', status: 'prepared' }], materials: [
        { jobId: 'job-1', kind: 'resume', artifactRef: rows.resumeRef },
        { jobId: 'job-1', kind: 'cover_letter', artifactRef: rows.artifactRef },
      ] })).resolves.toBeNull()
  })

  it.each([
    ['missing job ref', ['resume:resume-1']],
    ['missing base resume ref', ['job:job-1']],
    ['foreign ref', ['job:job-1', 'persona:foreign', 'resume:resume-1']],
    ['duplicate ref', ['job:job-1', 'job:job-1', 'resume:resume-1']],
    ['unsorted refs', ['resume:resume-1', 'job:job-1']],
  ])('rejects %s in artifact provenance', async (_label, refs) => {
    const { artifactRef } = installGateRows(refs)

    await expect(loadScheduledTaskGraphGateMaterials({ owner, scoredJobs, minScore: 70, dailyCap: 5, taskId: 'prepare-1',
      jobs: [{ jobId: 'job-1', status: 'prepared' }], materials: [{ jobId: 'job-1', kind: 'resume', artifactRef }] }))
      .resolves.toBeNull()
  })

  it('rejects material rows whose complete source digest has drifted', async () => {
    const refs = ['job:job-1', 'resume:resume-1']
    const { artifactRef } = installGateRows(refs, `sha256:${'f'.repeat(64)}`)

    await expect(loadScheduledTaskGraphGateMaterials({ owner, scoredJobs, minScore: 70, dailyCap: 5, taskId: 'prepare-1',
      jobs: [{ jobId: 'job-1', status: 'prepared' }], materials: [{ jobId: 'job-1', kind: 'resume', artifactRef }] }))
      .resolves.toBeNull()
  })
})
