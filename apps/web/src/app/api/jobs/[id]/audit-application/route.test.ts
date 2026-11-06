import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseStoredApplicationAudit } from '@/lib/application-audit'
import { signedAuditActivityText, verifyApplicationAuditReceipt } from '@/lib/application-audit-receipt'
import type { ApplicationAudit } from '@/lib/types'
vi.mock('@/lib/auth-secret', () => ({ getAuthJwtSecret: () => new TextEncoder().encode('unit-test-independent-audit-key') }))

const mocks = {
  jobFindFirst: vi.fn(), resumeFindFirst: vi.fn(), coverLetterFindFirst: vi.fn(),
  resumeVersionFindFirst: vi.fn(), agentRoleFindFirst: vi.fn(), modelChat: vi.fn(),
  activityCreate: vi.fn(), activityFindFirst: vi.fn(),
  buildPersona: vi.fn(), prepareAiRoute: vi.fn(), requireAuth: vi.fn(),
  readOperation: vi.fn(), registerOperation: vi.fn(), completeOperation: vi.fn(), failOperation: vi.fn(),
  txJobFindFirst: vi.fn(), txResumeFindFirst: vi.fn(), txCoverLetterFindFirst: vi.fn(), lockMaterials: vi.fn(),
}

const fixtureUpdatedAt = new Date('2026-11-02T09:00:00.000Z')
let observedResumeUpdatedAt = fixtureUpdatedAt
let observedCoverLetterUpdatedAt = fixtureUpdatedAt
let observedResume: Record<string, unknown> = {}
let observedCoverLetter: Record<string, unknown> = {}
vi.mock('@/lib/db', () => ({ db: {
  job: { findFirst: mocks.jobFindFirst },
  resume: { findFirst: async (args: { select?: { content?: boolean } }) => {
    const row = await mocks.resumeFindFirst(args)
    if (!row || args.select?.content) return row
    observedResumeUpdatedAt = row.updatedAt ?? fixtureUpdatedAt
    observedResume = { name: 'Fixture resume', templateId: null, templateOptions: null, ...row, updatedAt: observedResumeUpdatedAt }
    return observedResume
  } },
  coverLetter: { findFirst: async (args: unknown) => {
    const row = await mocks.coverLetterFindFirst(args)
    if (!row) return row
    observedCoverLetterUpdatedAt = row.updatedAt ?? fixtureUpdatedAt
    observedCoverLetter = { id: 'cover_1', tone: 'professional', templateId: null, templateOptions: null, ...row, updatedAt: observedCoverLetterUpdatedAt }
    return observedCoverLetter
  } },
  resumeVersion: { findFirst: mocks.resumeVersionFindFirst },
  agentRole: { findFirst: mocks.agentRoleFindFirst },
  activity: { create: mocks.activityCreate, findFirst: mocks.activityFindFirst },
} }))
vi.mock('@/lib/application-audit-transaction', () => ({
  AuditMaterialBusyError: class extends Error {},
  withApplicationAuditLock: async (_scope: unknown, callback: (tx: unknown) => unknown) => callback({
    job: { findFirst: mocks.txJobFindFirst }, resume: { findFirst: mocks.txResumeFindFirst },
    coverLetter: { findFirst: mocks.txCoverLetterFindFirst },
  }),
  lockApplicationAuditMaterials: mocks.lockMaterials,
}))
vi.mock('@/lib/application-audit-operation', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/application-audit-operation')>(),
  readAuditOperation: mocks.readOperation,
  registerAuditOperation: mocks.registerOperation,
  completeAuditOperation: mocks.completeOperation,
  failAuditOperation: mocks.failOperation,
}))
vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: (raw: string) => JSON.parse(raw),
  APPLYMATE_BACKING: { provider: 'minimax', model: 'MiniMax-M3', thinking: 'adaptive' },
  resolveConfig: (config: { provider: string; model: string; apiKey?: string }) => ({ ...config, resolvedKey: config.apiKey ?? (config.provider === 'minimax' ? 'test-key' : '') }),
  withMiniMaxThinking: (config: { provider: string; model: string }, thinking: 'adaptive' | 'disabled') =>
    config.provider === 'minimax' && config.model === 'MiniMax-M3' ? { ...config, thinking } : config,
}))
vi.mock('@/lib/persona', () => ({ buildPersona: mocks.buildPersona }))

function request(body: unknown) {
  return new Request('http://localhost/api/jobs/job_1/audit-application', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('POST /api/jobs/[id]/audit-application', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'minimax', model: 'MiniMax-M3', thinking: 'adaptive' } })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', company: 'Acme', role: 'Engineer', description: 'Build TypeScript systems.' })
    mocks.resumeFindFirst.mockResolvedValue({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: { name: 'Ada', email: 'ada@example.com', location: 'Dublin' }, summary: 'Engineer', experience: [], education: [], skills: ['TypeScript'] } })
    mocks.coverLetterFindFirst.mockResolvedValue({ content: 'Dear Acme, I built TypeScript systems.' })
    mocks.agentRoleFindFirst.mockResolvedValue(null)
    mocks.activityCreate.mockResolvedValue({ id: 'activity_1' })
    mocks.buildPersona.mockResolvedValue('CONFIRMED APPLICATION ANSWERS:\n- [work] API delivery: Confirmed by candidate')
    mocks.txJobFindFirst.mockResolvedValue({ description: 'Build TypeScript systems.', role: 'Engineer', company: 'Acme' })
    mocks.txResumeFindFirst.mockImplementation(async () => observedResume)
    mocks.txCoverLetterFindFirst.mockImplementation(async () => observedCoverLetter)
    mocks.lockMaterials.mockResolvedValue(true)
    mocks.registerOperation.mockResolvedValue('fixture-operation')
    mocks.failOperation.mockResolvedValue(true)
    mocks.completeOperation.mockImplementation(async (_tx, scope, _operationId, result) => {
      await mocks.activityCreate({ data: { text: signedAuditActivityText(scope, result.resumeId, result.coverLetterId, result.audit, result.versions) } })
      return true
    })
    mocks.readOperation.mockImplementation(async (_tx, scope) => {
      const row = await mocks.activityFindFirst({ where: { jobId: scope.jobId } })
      const audit = parseStoredApplicationAudit(row?.text ?? '')
      return verifyApplicationAuditReceipt(scope, audit) ? { kind: 'legacy', audit } : { kind: 'none' }
    })
  })

  it('audits final material against the tailored resume parent', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
      .mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'pass', matchScore: 82, summary: 'Supported and relevant.', findings: [
      { area: 'resume', severity: 'pass', title: 'Supported facts', evidence: 'Matches source.', action: 'None.' },
      { area: 'cover_letter', severity: 'pass', title: 'Supported letter', evidence: 'Uses source experience.', action: 'None.' },
      { area: 'job_match', severity: 'pass', title: 'Relevant match', evidence: 'TypeScript is required.', action: 'None.' },
    ] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.source).toBe('parent_resume')
    expect(body.verdict).toBe('pass')
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('SOURCE RESUME')
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('current employment status or location')
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('security-threat detection metrics')
    expect(mocks.activityCreate.mock.calls[0][0].data.text).toContain('[Auditor] application-audit')
    expect(verifyApplicationAuditReceipt({ userId: 'user_1', jobId: 'job_1' }, parseStoredApplicationAudit(mocks.activityCreate.mock.calls[0][0].data.text))).toBe(true)
  })

  it('returns and persists the exact resume and cover-letter revisions that were audited', async () => {
    const resumeUpdatedAt = new Date('2026-09-17T10:00:00.000Z')
    const coverLetterUpdatedAt = new Date('2026-09-17T10:01:00.000Z')
    mocks.resumeFindFirst.mockResolvedValueOnce({
      id: 'resume_final', parentResumeId: 'resume_base', updatedAt: resumeUpdatedAt,
      content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] },
    }).mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.coverLetterFindFirst.mockResolvedValue({ content: 'Dear Acme', updatedAt: coverLetterUpdatedAt })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'pass', findings: [
      { area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
      { area: 'cover_letter', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
      { area: 'job_match', severity: 'pass', title: 'Relevant', evidence: 'Relevant.', action: 'None.' },
    ] }) })

    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()

    expect(body).toMatchObject({
      resumeUpdatedAt: resumeUpdatedAt.toISOString(),
      coverLetterUpdatedAt: coverLetterUpdatedAt.toISOString(),
    })
    expect(mocks.activityCreate.mock.calls[0][0].data.text).toContain(`"resumeUpdatedAt":"${resumeUpdatedAt.toISOString()}"`)
    expect(mocks.activityCreate.mock.calls[0][0].data.text).toContain(`"coverLetterUpdatedAt":"${coverLetterUpdatedAt.toISOString()}"`)
  })

  it('audits the final resume without requiring a cover letter', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({
      id: 'resume_final', parentResumeId: 'resume_base',
      content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] },
    }).mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'pass', findings: [
      { area: 'resume', severity: 'pass', title: 'Supported resume', evidence: 'Matches source.', action: 'None.' },
      { area: 'cover_letter', severity: 'critical', title: 'Should be ignored', evidence: 'No letter was supplied.', action: 'Ignore.' },
      { area: 'job_match', severity: 'pass', title: 'Relevant', evidence: 'TypeScript is required.', action: 'None.' },
    ] }) })

    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.verdict).toBe('pass')
    expect(body.findings).not.toEqual(expect.arrayContaining([expect.objectContaining({ area: 'cover_letter' })]))
    expect(mocks.coverLetterFindFirst).not.toHaveBeenCalled()
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('No final cover letter is supplied')
    expect(mocks.modelChat.mock.calls[0][0][0].content).not.toContain('FINAL COVER LETTER TO AUDIT')
    expect(mocks.activityCreate.mock.calls[0][0].data.text).toContain('"coverLetterId":null')
  })

  it('blocks confirmation when the independent auditor finds an unsupported concrete claim', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: null, content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
    mocks.resumeVersionFindFirst.mockResolvedValue({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'pass', findings: [{ area: 'cover_letter', severity: 'critical', title: 'Unsupported metric', evidence: 'Claims 50% growth absent from source.', action: 'Remove or substantiate it.' }] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    const body = await response.json()
    expect(body.source).toBe('previous_version')
    expect(body.verdict).toBe('blocked')
  })

  it('keeps the feature-level model when the Auditor role is the keyless platform default', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
      .mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    const settingsCfg = { provider: 'openai', model: 'gpt-4o', apiKey: 'user-openai-key' }
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: settingsCfg })
    mocks.agentRoleFindFirst.mockResolvedValue({
      enabled: true,
      provider: 'minimax',
      model: 'MiniMax-M3',
      apiKey: null,
      systemPrompt: 'Auditor',
    })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'pass', findings: [
      { area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
      { area: 'cover_letter', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
      { area: 'job_match', severity: 'pass', title: 'Relevant', evidence: 'Relevant.', action: 'None.' },
    ] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(settingsCfg), 4096)
  })

  it('retries one aborted model call before failing the audit', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
      .mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    mocks.modelChat.mockRejectedValueOnce(aborted).mockResolvedValueOnce({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'pass', findings: [
      { area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
      { area: 'cover_letter', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
      { area: 'job_match', severity: 'pass', title: 'Relevant', evidence: 'Relevant.', action: 'None.' },
    ] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenCalledTimes(2)
  })

  it('retries M3 without private reasoning when its adaptive response reaches the limit', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
      .mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockRejectedValueOnce(new Error('minimax returned no final content (finish reason: length)')).mockResolvedValueOnce({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'pass', findings: [
      { area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
      { area: 'cover_letter', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
      { area: 'job_match', severity: 'pass', title: 'Relevant', evidence: 'Relevant.', action: 'None.' },
    ] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ provider: 'minimax', model: 'MiniMax-M3', thinking: 'disabled' }), 4096)
  })

  it('returns a retryable audit state when both model responses are malformed', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
      .mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: '' })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      verdict: 'needs_review',
      summary: expect.stringContaining('did not return a structured result'),
      findings: [expect.objectContaining({ title: 'Audit response needs retry' })],
    })
    expect(mocks.modelChat).toHaveBeenCalledTimes(2)
  })

  it('keeps missing Persona evidence distinct from a factual contradiction', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
      .mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'needs_review', findings: [
      { area: 'resume', severity: 'warning', resolution: 'evidence_needed', title: 'API delivery scope', evidence: 'No source fact confirms the stated API ownership.', action: 'Ask the candidate to confirm the accurate scope or soften the claim.' },
      { area: 'cover_letter', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
      { area: 'job_match', severity: 'pass', title: 'Relevant', evidence: 'Relevant.', action: 'None.' },
    ] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    await expect(response.json()).resolves.toMatchObject({
      verdict: 'needs_review',
      findings: expect.arrayContaining([expect.objectContaining({ title: 'API delivery scope', resolution: 'evidence_needed' })]),
    })
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('CONFIRMED PERSONA')
  })

  it('does not block a truthful package merely because the job asks for missing tooling', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: null, content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
    mocks.resumeVersionFindFirst.mockResolvedValue({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'needs_review', findings: [
      { area: 'resume', severity: 'pass', title: 'Facts supported', evidence: 'All dates and employers match the source.', action: 'None.' },
      { area: 'cover_letter', severity: 'pass', title: 'Facts supported', evidence: 'No unsupported claims.', action: 'None.' },
      { area: 'job_match', severity: 'critical', title: 'MLOps missing', evidence: 'The resume does not claim MLOps.', action: 'Optional future emphasis only.' },
    ] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    await expect(response.json()).resolves.toMatchObject({ verdict: 'pass' })
  })

  it('refuses to pass when no source resume exists for an independent comparison', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: null, content: { contact: {}, summary: 'Only version', experience: [], education: [], skills: [] } })
    mocks.resumeVersionFindFirst.mockResolvedValue(null)
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.modelChat).not.toHaveBeenCalled()
  })

  it('marks a legacy signed audit stale because its job basis was not signed', async () => {
    mocks.activityFindFirst.mockResolvedValue({ text: signedAuditActivityText({ userId: 'user_1', jobId: 'job_1' }, 'resume_final', 'cover_1', ({"resumeId":"resume_final","coverLetterId":"cover_1","audit":{"verdict":"needs_review","summary":"Revise wording.","matchScore":72,"source":"parent_resume","auditedAt":"2026-11-02T09:00:00.000Z","findings":[]}}).audit as ApplicationAudit) })
    const { GET } = await import('./route')
    const response = (await GET(new Request('http://localhost/api/jobs/job_1/audit-application') as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    await expect(response.json()).resolves.toEqual({ state: 'stale' })
    expect(mocks.activityFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ jobId: 'job_1' }) }))
  })

  it('also marks a legacy resume-only audit stale', async () => {
    mocks.activityFindFirst.mockResolvedValue({ text: signedAuditActivityText({ userId: 'user_1', jobId: 'job_1' }, 'resume_final', null, ({"resumeId":"resume_final","coverLetterId":null,"audit":{"verdict":"pass","summary":"Resume supported.","matchScore":80,"source":"parent_resume","auditedAt":"2026-11-02T09:00:00.000Z","findings":[]}}).audit as ApplicationAudit) })
    const { GET } = await import('./route')
    const response = (await GET(new Request('http://localhost/api/jobs/job_1/audit-application') as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    await expect(response.json()).resolves.toEqual({ state: 'stale' })
  })

  it('returns a completed audit only when the signed job basis matches', async () => {
    const { auditJobBasisHash, auditMaterialBasisHash } = await import('@/lib/application-audit-operation')
    const job = { role: 'Engineer', company: 'Acme', description: 'Build TypeScript systems.' }
    const resume = { id: 'resume_final', name: 'Fixture', content: { summary: 'Current' }, templateId: null, templateOptions: null }
    mocks.txResumeFindFirst.mockResolvedValue(resume)
    mocks.readOperation.mockResolvedValue({ kind: 'completed', operationId: 'fixture-operation', jobBasisHash: auditJobBasisHash(job), materialBasisHash: auditMaterialBasisHash(resume, null),
      audit: { resumeId: 'resume_final', coverLetterId: null, audit: { verdict: 'pass', summary: 'Current' } } })
    const { GET } = await import('./route')
    const response = (await GET(new Request('http://localhost/api/jobs/job_1/audit-application') as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    await expect(response.json()).resolves.toMatchObject({ resumeId: 'resume_final', coverLetterId: null, audit: { verdict: 'pass' } })
    mocks.txJobFindFirst.mockResolvedValue({ ...job, description: 'Changed' })
    const stale = (await GET(new Request('http://localhost/api/jobs/job_1/audit-application') as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    await expect(stale.json()).resolves.toEqual({ state: 'stale' })
  })

  it('hides unsigned historical activity until the independent audit is rerun', async () => {
    mocks.activityFindFirst.mockResolvedValue({ text: '[Auditor] application-audit {"resumeId":"resume_final","coverLetterId":null,"audit":{"verdict":"pass","findings":[]}}' })
    const { GET } = await import('./route')
    const response = (await GET(new Request('http://localhost/api/jobs/job_1/audit-application') as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    await expect(response.json()).resolves.toBeNull()
  })

  it.each(['pending', 'failed'] as const)('returns an explicit %s state instead of claiming no audit exists', async state => {
    mocks.readOperation.mockResolvedValue({ kind: state, operationId: 'fixture-operation' })
    const { GET } = await import('./route')
    const response = (await GET(new Request('http://localhost/api/jobs/job_1/audit-application') as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ state })
  })

  it.each(['none', 'pending', 'failed', 'invalid', 'legacy', 'completed', 'not-found', 'unauthenticated'] as const)('GET %s response is private and never cached', async state => {
    const { auditJobBasisHash } = await import('@/lib/application-audit-operation')
    const job = { role: 'Engineer', company: 'Acme', description: 'Build TypeScript systems.' }
    if (state === 'not-found') mocks.txJobFindFirst.mockResolvedValue(null)
    else if (state === 'unauthenticated') mocks.requireAuth.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    else if (state === 'completed') mocks.readOperation.mockResolvedValue({ kind: 'completed', operationId: 'fixture-operation', jobBasisHash: auditJobBasisHash(job), audit: { resumeId: 'resume_final', coverLetterId: null, audit: { verdict: 'pass' } } })
    else if (state === 'legacy') mocks.readOperation.mockResolvedValue({ kind: 'legacy', audit: {} })
    else if (state === 'invalid') mocks.readOperation.mockResolvedValue({ kind: 'invalid', source: 'control' })
    else if (state === 'none') mocks.readOperation.mockResolvedValue({ kind: 'none' })
    else mocks.readOperation.mockResolvedValue({ kind: state, operationId: 'fixture-operation' })
    const { GET } = await import('./route')
    const response = (await GET(new Request('http://localhost/api/jobs/job_1/audit-application') as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(state === 'not-found' ? 404 : state === 'unauthenticated' ? 401 : 200)
    expect(response.headers.get('Cache-Control')).toBe('no-store, private')
  })

  it('does not publish or return an older audit after its operation was superseded', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { summary: 'Final' } })
      .mockResolvedValueOnce({ content: { summary: 'Original' } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ summary: 'Old result', findings: [
      { area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
    ] }) })
    mocks.completeOperation.mockResolvedValue(false)
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(await response.json()).not.toHaveProperty('summary')
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('fails closed if the audited resume changes while the model is running', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { summary: 'Final' } })
      .mockResolvedValueOnce({ content: { summary: 'Original' } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ findings: [
      { area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
    ] }) })
    let readCount = 0
    mocks.txResumeFindFirst.mockImplementation(async () => ({ ...observedResume,
      updatedAt: ++readCount === 1 ? fixtureUpdatedAt : new Date(fixtureUpdatedAt.getTime() + 1_000) }))
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(409)
    expect(mocks.failOperation).toHaveBeenCalledTimes(1)
    expect(mocks.completeOperation).not.toHaveBeenCalled()
  })

  it('allows an owned resume to be reviewed before it is bound as the final resume', async () => {
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', company: 'Acme', role: 'Engineer', description: 'Build TypeScript systems.', finalResumeId: null })
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { summary: 'Final' } })
      .mockResolvedValueOnce({ content: { summary: 'Original' } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ findings: [
      { area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Matches.', action: 'None.' },
    ] }) })
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ verdict: 'pass' })
    expect(mocks.lockMaterials).toHaveBeenCalledWith(expect.anything(), { userId: 'user_1', jobId: 'job_1' }, 'resume_final', null)
  })

  it('does not report a completed audit when its canonical record could not be saved', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_final', parentResumeId: 'resume_base', content: { contact: {}, summary: 'Final', experience: [], education: [], skills: [] } })
      .mockResolvedValueOnce({ content: { contact: {}, summary: 'Original', experience: [], education: [], skills: [] } })
    mocks.modelChat.mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', text: JSON.stringify({ verdict: 'pass', findings: [
      { area: 'resume', severity: 'pass', title: 'Supported facts', evidence: 'Matches source.', action: 'None.' },
      { area: 'cover_letter', severity: 'pass', title: 'Supported letter', evidence: 'Matches source.', action: 'None.' },
      { area: 'job_match', severity: 'pass', title: 'Role fit', evidence: 'Relevant.', action: 'None.' },
    ] }) })
    mocks.activityCreate.mockRejectedValue(new Error('Activity database unavailable'))
    const { POST } = await import('./route')
    const response = (await POST(request({ resumeId: 'resume_final', coverLetterId: 'cover_1' }) as never, { params: Promise.resolve({ id: 'job_1' }) }))!
    await expect(response.json()).resolves.toMatchObject({ error: 'Application audit failed: Activity database unavailable' })
    expect(response.status).toBe(502)
  })
})
