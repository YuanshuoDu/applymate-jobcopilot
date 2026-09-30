import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashContent } from '@jobcopilot/shared'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), session: vi.fn(), version: vi.fn(), job: vi.fn(), resume: vi.fn(), persona: vi.fn(), review: vi.fn() }))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.auth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  err: (message: string, status = 400) => Response.json({ error: { message } }, { status }),
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))

vi.mock('@/lib/db', () => ({ db: {
  agentSession: { findFirst: mocks.session }, agentArtifactVersion: { findFirst: mocks.version },
  job: { findFirst: mocks.job }, resume: { findFirst: mocks.resume }, personaFact: { findMany: mocks.persona },
  agentArtifactReview: { findFirst: mocks.review },
} }))

const contentHash = `sha256:${'a'.repeat(64)}`
const jobSource = {
  id: 'job-1', company: 'N26', role: 'Backend Engineer', location: 'Berlin', status: 'saved', score: 88,
  url: 'https://jobs.example.test/1', source: 'greenhouse', salary: '€80k', description: 'Build reliable systems', keywords: 'TypeScript, PostgreSQL',
}
const resumeSource = { id: 'resume-1', content: { contact: { name: 'Private Candidate', email: 'private@example.test', phone: '+353000000000' }, summary: 'Designed secure cloud services', skills: ['TypeScript', 'PostgreSQL', 'Kubernetes', 'AWS', 'Private fifth skill'], experience: [{ role: 'Senior Engineer', company: 'Example', bullets: ['Built high-availability APIs'] }] } }
const personaSources = [{ id: 'fact-1', key: 'experience', value: 'Built reliable systems', sourceRef: 'fact-1', confidence: 0.9 }]
function digestFor(job = jobSource, resume = resumeSource, facts = personaSources) {
  const sources = [
    { sourceRef: `job:${job.id}`, contentHash: hashContent(job) },
    { sourceRef: `resume:${resume.id}`, contentHash: hashContent(resume.content) },
    ...facts.map(fact => ({
      sourceRef: `persona:${fact.id}`,
      contentHash: hashContent({ id: fact.id, key: fact.key, value: fact.value, confidence: Number(fact.confidence), sourceRef: fact.sourceRef }),
    })),
  ].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef))
  return hashContent({ jobId: job.id, sources })
}
const sourceDigest = digestFor()
const refQuery = `?contentHash=${contentHash}&sourceDigest=${sourceDigest}`
const context = { params: Promise.resolve({ id: 'session-1', artifactId: 'artifact-1', version: '2' }) }

function request(query = refQuery) { return new Request(`http://localhost/api/agent/sessions/session-1/artifacts/artifact-1/versions/2${query}`) }
function artifact(overrides: Record<string, unknown> = {}) {
  return { id: 'version-row-1', userId: 'user-1', sessionId: 'session-1', jobId: 'job-1', artifactId: 'artifact-1', version: 2, artifactType: 'cover_letter', content: 'PRIVATE_DRAFT_BODY', contentHash, sourceDigest, provenanceRefs: ['job:job-1', 'resume:resume-1', 'persona:fact-1'], evidenceRefs: ['job:job-1', 'resume:resume-1', 'persona:fact-1'], ...overrides }
}

describe('session-scoped immutable cover-letter version read', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.auth.mockReset(); mocks.session.mockReset(); mocks.version.mockReset(); mocks.job.mockReset(); mocks.resume.mockReset(); mocks.persona.mockReset(); mocks.review.mockReset()
    mocks.auth.mockResolvedValue({ userId: 'user-1' })
    mocks.session.mockResolvedValue({ id: 'session-1' })
    mocks.version.mockResolvedValue(artifact())
    mocks.job.mockResolvedValue(jobSource)
    mocks.resume.mockResolvedValue(resumeSource)
    mocks.persona.mockResolvedValue(personaSources)
    mocks.review.mockResolvedValue({ status: 'needs_revision', reviewHash: 'review-hash', evidenceRefs: ['resume:fact-2'], findings: [{ code: 'claim', severity: 'warning', message: 'Check this claim.', evidenceRefs: ['resume:fact-2'], privateField: 'MUST_NOT_PROJECT' }] })
  })

  it('returns the exact persisted body only through the dedicated owner-scoped endpoint', async () => {
    const { GET } = await import('./route')
    const response = await GET(request() as never, context)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(mocks.session).toHaveBeenCalledWith({ where: { id: 'session-1', userId: 'user-1' }, select: { id: true } })
    expect(mocks.version).toHaveBeenCalledWith(expect.objectContaining({ where: {
      artifactId: 'artifact-1', version: 2, contentHash, sourceDigest, userId: 'user-1', sessionId: 'session-1', artifactType: 'cover_letter',
    } }))
    expect(mocks.job).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' }, select: {
      id: true, company: true, role: true, location: true, status: true, score: true, url: true,
      source: true, salary: true, description: true, keywords: true,
    } })
    expect(mocks.resume).toHaveBeenCalledWith({
      where: { userId: 'user-1', kind: 'base' }, orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }], select: { id: true, content: true },
    })
    expect(mocks.persona).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'user-1', status: 'confirmed', allowedUses: { has: 'cover_letter' } }),
      orderBy: { updatedAt: 'desc' }, take: 50,
      select: { id: true, key: true, value: true, sourceRef: true, confidence: true },
    }))
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      userId: 'user-1', sessionId: 'session-1', jobId: 'job-1', artifactId: 'artifact-1', version: 2, contentHash, sourceDigest,
    }) }))
    expect(body.job).toEqual({ company: 'N26', role: 'Backend Engineer' })
    expect(body.artifact).toMatchObject({ content: { text: 'PRIVATE_DRAFT_BODY' }, provenanceRefs: ['job:job-1', 'resume:resume-1', 'persona:fact-1'], evidenceRefs: ['job:job-1', 'resume:resume-1', 'persona:fact-1'] })
    expect(body.sourceEvidence).toEqual({ freshness: 'current', items: [
      { reference: 'job:job-1', kind: 'job', label: 'Job description', text: 'Build reliable systems' },
      { reference: 'resume:resume-1', kind: 'resume', label: 'Base resume', text: 'Designed secure cloud services · Skills: TypeScript, PostgreSQL, Kubernetes, AWS · Senior Engineer at Example: Built high-availability APIs' },
      { reference: 'persona:fact-1', kind: 'persona', label: 'Profile fact · experience', text: 'Built reliable systems' },
    ] })
    expect(JSON.stringify(body.sourceEvidence)).not.toContain('private@example.test')
    expect(JSON.stringify(body.sourceEvidence)).not.toContain('Private Candidate')
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect(body.review).toMatchObject({ status: 'needs_revision', findings: [{ code: 'claim', severity: 'warning', message: 'Check this claim.' }] })
    expect(JSON.stringify(body)).not.toContain('MUST_NOT_PROJECT')
  })

  it('requires authentication and checks session ownership before reading the version', async () => {
    mocks.auth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { GET } = await import('./route')
    expect((await GET(request() as never, context)).status).toBe(401)
    expect(mocks.version).not.toHaveBeenCalled()

    mocks.session.mockResolvedValueOnce(null)
    expect((await GET(request() as never, context)).status).toBe(404)
    expect(mocks.version).not.toHaveBeenCalled()
  })

  it('conceals versions from another owner/session/job or a mismatched immutable reference', async () => {
    const { GET } = await import('./route')
    mocks.version.mockResolvedValueOnce(null)
    expect((await GET(request() as never, context)).status).toBe(404)
    mocks.version.mockResolvedValueOnce(artifact({ sessionId: 'foreign-session' }))
    expect((await GET(request() as never, context)).status).toBe(404)
    mocks.version.mockResolvedValueOnce(artifact())
    mocks.job.mockResolvedValueOnce(null)
    expect((await GET(request() as never, context)).status).toBe(404)
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.persona).not.toHaveBeenCalled()

    expect((await GET(request(`?contentHash=sha256:${'c'.repeat(64)}&sourceDigest=${sourceDigest}`) as never, context)).status).toBe(404)
    expect(mocks.version).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ contentHash: `sha256:${'c'.repeat(64)}` }) }))
  })

  it('bounds source evidence and ignores caller-supplied evidence references', async () => {
    const facts = Array.from({ length: 20 }, (_, index) => ({ id: `fact-${index + 1}`, key: `skill-${index + 1}`, value: 'x'.repeat(900), sourceRef: `resume:source-${index + 1}`, confidence: 0.9 }))
    const digest = digestFor(jobSource, resumeSource, facts)
    const persistedRefs = ['job:job-1', 'resume:resume-1', ...facts.map(fact => `persona:${fact.id}`)]
    mocks.persona.mockResolvedValueOnce(facts)
    mocks.version.mockResolvedValueOnce(artifact({ sourceDigest: digest, provenanceRefs: persistedRefs, evidenceRefs: persistedRefs }))
    const { GET } = await import('./route')
    const response = await GET(request(`?contentHash=${contentHash}&sourceDigest=${digest}&evidenceRef=persona:caller-controlled`) as never, context)
    const body = await response.json()
    const items = body.sourceEvidence.items as Array<{ reference: string; label: string; text: string }>

    expect(response.status).toBe(200)
    expect(body.sourceEvidence.freshness).toBe('current')
    expect(items.length).toBeLessThanOrEqual(8)
    expect(items.every(item => persistedRefs.includes(item.reference))).toBe(true)
    expect(items.some(item => item.reference === 'persona:caller-controlled')).toBe(false)
    expect(items.every(item => item.reference.length <= 256 && item.label.length <= 80 && item.text.length <= 600)).toBe(true)
    expect(items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(3_000)
    expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1', kind: 'base' } }))
    expect(mocks.persona).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1', status: 'confirmed', allowedUses: { has: 'cover_letter' } }) }))
  })

  it('withholds evidence when a persisted reference cannot resolve in the owner-scoped source set', async () => {
    mocks.version.mockResolvedValueOnce(artifact({ evidenceRefs: ['persona:foreign-fact'], provenanceRefs: ['persona:foreign-fact'] }))
    const { GET } = await import('./route')
    const response = await GET(request() as never, context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.sourceEvidence).toEqual({ freshness: 'unavailable', items: [] })
    expect(mocks.persona).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1' }) }))
  })

  it('validates references after the display limit before marking evidence current', async () => {
    const facts = Array.from({ length: 6 }, (_, index) => ({ id: `fact-${index + 1}`, key: `skill-${index + 1}`, value: `Skill ${index + 1}`, sourceRef: `resume:source-${index + 1}`, confidence: 0.9 }))
    const digest = digestFor(jobSource, resumeSource, facts)
    const refs = ['job:job-1', 'resume:resume-1', ...facts.map(fact => `persona:${fact.id}`), 'persona:unresolved-ninth-ref']
    mocks.persona.mockResolvedValueOnce(facts)
    mocks.version.mockResolvedValueOnce(artifact({ sourceDigest: digest, evidenceRefs: refs, provenanceRefs: refs }))
    const { GET } = await import('./route')
    const response = await GET(request(`?contentHash=${contentHash}&sourceDigest=${digest}`) as never, context)

    expect(response.status).toBe(200)
    expect((await response.json()).sourceEvidence).toEqual({ freshness: 'unavailable', items: [] })
  })

  it('redacts contact details in source evidence while preserving benign context', async () => {
    const email = 'candidate.private@example.test'
    const phone = '+353 87 123 4567'
    const job = { ...jobSource, description: `Build dependable systems. Contact ${email} or ${phone}.` }
    const resume = { id: 'resume-1', content: { ...resumeSource.content, summary: `Experienced engineer. Contact ${email} or ${phone}.` } }
    const facts = [
      { id: 'email-fact', key: 'contactEmail', value: email, sourceRef: 'resume:contact', confidence: 0.9 },
      { id: 'name-fact', key: 'firstName', value: 'Private Candidate', sourceRef: 'resume:name', confidence: 0.9 },
      { id: 'summary-fact', key: 'profileSummary', value: `Built secure systems. Contact ${email} or ${phone}.`, sourceRef: 'resume:summary', confidence: 0.9 },
    ]
    const digest = digestFor(job, resume, facts)
    const refs = ['job:job-1', 'resume:resume-1', 'persona:email-fact', 'persona:name-fact', 'persona:summary-fact']
    mocks.job.mockResolvedValueOnce(job)
    mocks.resume.mockResolvedValueOnce(resume)
    mocks.persona.mockResolvedValueOnce(facts)
    mocks.version.mockResolvedValueOnce(artifact({ sourceDigest: digest, evidenceRefs: refs, provenanceRefs: refs }))
    const { GET } = await import('./route')
    const response = await GET(request(`?contentHash=${contentHash}&sourceDigest=${digest}`) as never, context)
    const body = await response.json()
    const items = body.sourceEvidence.items as Array<{ reference: string; text: string }>
    const serializedEvidence = JSON.stringify(body.sourceEvidence)

    expect(response.status).toBe(200)
    expect(body.sourceEvidence.freshness).toBe('current')
    expect(serializedEvidence).not.toContain(email)
    expect(serializedEvidence).not.toContain(phone)
    expect(items.find(item => item.reference === 'job:job-1')?.text).toContain('Build dependable systems')
    expect(items.find(item => item.reference === 'job:job-1')?.text).toContain('[redacted email]')
    expect(items.find(item => item.reference === 'job:job-1')?.text).toContain('[redacted phone]')
    expect(items.find(item => item.reference === 'resume:resume-1')?.text).toContain('Experienced engineer')
    expect(items.find(item => item.reference === 'resume:resume-1')?.text).toContain('[redacted email]')
    expect(items.find(item => item.reference === 'persona:email-fact')?.text).toBe('Contact detail withheld')
    expect(items.find(item => item.reference === 'persona:name-fact')?.text).toBe('Contact detail withheld')
    expect(serializedEvidence).not.toContain('Private Candidate')
    expect(items.find(item => item.reference === 'persona:summary-fact')?.text).toContain('Built secure systems')
    expect(items.find(item => item.reference === 'persona:summary-fact')?.text).toContain('[redacted phone]')
  })

  it('keeps the stored review status when current selected-job sources are unchanged', async () => {
    mocks.review.mockResolvedValueOnce({ status: 'passed', reviewHash: 'review-hash', evidenceRefs: ['job:job-1'], findings: [{ code: 'claim', severity: 'info', message: 'Supported claim.', evidenceRefs: ['job:job-1'] }] })
    const { GET } = await import('./route')
    const response = await GET(request() as never, context)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.review).toMatchObject({ status: 'passed', evidenceRefs: ['job:job-1'], findings: [{ message: 'Supported claim.' }] })
  })

  it('keeps a review current when multiple Persona facts share one sourceRef', async () => {
    const sharedSourceFacts = [
      { id: 'fact-1', key: 'language', value: 'English C1', sourceRef: 'resume:source-42', confidence: 0.98 },
      { id: 'fact-2', key: 'experience', value: 'Built reliable systems', sourceRef: 'resume:source-42', confidence: 0.91 },
    ]
    const matchingDigest = digestFor(jobSource, resumeSource, sharedSourceFacts)
    mocks.persona.mockResolvedValueOnce(sharedSourceFacts)
    mocks.version.mockResolvedValueOnce(artifact({ sourceDigest: matchingDigest }))
    mocks.review.mockResolvedValueOnce({ status: 'passed', reviewHash: 'review-hash', evidenceRefs: ['persona:fact-1'], findings: [] })
    const { GET } = await import('./route')
    const response = await GET(request(`?contentHash=${contentHash}&sourceDigest=${matchingDigest}`) as never, context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.review).toEqual({ status: 'passed', reviewHash: 'review-hash', evidenceRefs: ['persona:fact-1'], findings: [] })
  })

  it.each([
    ['job', async () => mocks.job.mockResolvedValueOnce({ ...jobSource, description: 'Updated job description' })],
    ['base resume', async () => mocks.resume.mockResolvedValueOnce({ ...resumeSource, content: { basics: { name: 'Updated candidate' } } })],
    ['confirmed Persona fact', async () => mocks.persona.mockResolvedValueOnce([{ ...personaSources[0]!, value: 'Updated experience' }])],
  ])('projects an old passed review as stale when the current %s changes', async (_source, changeSource) => {
    await changeSource()
    mocks.review.mockResolvedValueOnce({ status: 'passed', reviewHash: 'review-hash', evidenceRefs: ['job:job-1'], findings: [{ code: 'claim', severity: 'info', message: 'Old source finding.', evidenceRefs: ['job:job-1'] }] })
    const { GET } = await import('./route')
    const response = await GET(request() as never, context)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.review).toEqual({ status: 'stale', reviewHash: 'review-hash', evidenceRefs: [], findings: [] })
    expect(body.sourceEvidence).toEqual({ freshness: 'stale', items: [] })
  })

  it('fails closed to a stale review when current source material cannot be loaded', async () => {
    mocks.review.mockResolvedValueOnce({ status: 'passed', reviewHash: 'review-hash', evidenceRefs: ['job:job-1'], findings: [{ code: 'claim', severity: 'info', message: 'Old source finding.', evidenceRefs: ['job:job-1'] }] })
    mocks.resume.mockResolvedValueOnce(null)
    const { GET } = await import('./route')
    const response = await GET(request() as never, context)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.review).toEqual({ status: 'stale', reviewHash: 'review-hash', evidenceRefs: [], findings: [] })
    expect(body.sourceEvidence).toEqual({ freshness: 'unavailable', items: [] })
  })

  it('rejects malformed version and digest values before querying private artifacts', async () => {
    const { GET } = await import('./route')
    expect((await GET(request('?contentHash=bad&sourceDigest=bad') as never, context)).status).toBe(400)
    const invalidContext = { params: Promise.resolve({ id: 'session-1', artifactId: 'artifact-1', version: '02' }) }
    expect((await GET(request() as never, invalidContext)).status).toBe(400)
    expect(mocks.version).not.toHaveBeenCalled()
  })
})
