import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  prepareAiRoute: vi.fn(),
  resumeFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  modelChat: vi.fn(),
  buildPersona: vi.fn(),
  parseAiJson: vi.fn(),
  resumeCreate: vi.fn(),
  resumeUpdate: vi.fn(),
  resumeUpdateMany: vi.fn(),
  resumeVersionCreate: vi.fn(),
  transaction: vi.fn(),
  activityCreate: vi.fn(),
  hasEffectiveEntitlement: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  prepareAiRoute: mocks.prepareAiRoute,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

vi.mock('@/lib/db', () => ({
  db: {
    resume: { findFirst: mocks.resumeFindFirst, create: mocks.resumeCreate, update: mocks.resumeUpdate, updateMany: mocks.resumeUpdateMany },
    resumeVersion: { create: mocks.resumeVersionCreate },
    job: { findFirst: mocks.jobFindFirst },
    activity: { create: mocks.activityCreate },
    $transaction: mocks.transaction,
  },
}))

vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: mocks.parseAiJson,
}))
vi.mock('@/lib/persona', () => ({ buildPersona: mocks.buildPersona }))
vi.mock('@/lib/entitlements', () => ({ hasEffectiveEntitlement: mocks.hasEffectiveEntitlement }))

describe('tailor resume API', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.prepareAiRoute.mockReset()
    mocks.resumeFindFirst.mockReset()
    mocks.jobFindFirst.mockReset()
    mocks.modelChat.mockReset()
    mocks.buildPersona.mockReset()
    mocks.parseAiJson.mockReset()
    mocks.resumeCreate.mockReset()
    mocks.resumeUpdate.mockReset()
    mocks.resumeUpdateMany.mockReset()
    mocks.resumeVersionCreate.mockReset()
    mocks.transaction.mockReset()
    mocks.activityCreate.mockReset()
    mocks.hasEffectiveEntitlement.mockReset()
    mocks.prepareAiRoute.mockResolvedValue({ userId: 'user_1', cfg: { provider: 'test', model: 'm1' } })
    mocks.hasEffectiveEntitlement.mockResolvedValue(true)
    mocks.buildPersona.mockResolvedValue('EXPERIENCE:\n- Backend engineer')
    mocks.resumeUpdateMany.mockResolvedValue({ count: 1 })
    mocks.resumeVersionCreate.mockResolvedValue({})
    mocks.transaction.mockImplementation(callback => callback({ resume: { updateMany: mocks.resumeUpdateMany }, resumeVersion: { create: mocks.resumeVersionCreate } }))
  })

  it('reuses the tailored resume already linked to the job without calling the AI', async () => {
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_base' })
      .mockResolvedValueOnce({ id: 'resume_tailored' })
    mocks.jobFindFirst.mockResolvedValueOnce({ id: 'job_1', description: 'Build reliable systems.' })
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', body: JSON.stringify({ resumeId: 'resume_base' }), headers: { 'Content-Type': 'application/json' },
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ adaptedResumeId: 'resume_tailored', changes: [], reused: true })
    expect(mocks.resumeFindFirst).toHaveBeenLastCalledWith({
      where: { userId: 'user_1', targetJobId: 'job_1', kind: 'adapted', origin: 'ai-adapted' },
      orderBy: { updatedAt: 'desc' }, select: { id: true, parentResumeId: true, content: true, name: true, updatedAt: true },
    })
    expect(mocks.modelChat).not.toHaveBeenCalled()
  }, 15_000)

  it('uses the confirmed Persona as a fact boundary for newly tailored sections', async () => {
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_base', content: { summary: 'Backend engineer' }, templateId: null, templateOptions: null, directionId: null, basicsDetached: false })
      .mockResolvedValueOnce(null)
    mocks.jobFindFirst.mockResolvedValueOnce({ id: 'job_1', company: 'N26', role: 'Backend Engineer', description: 'Build reliable TypeScript systems.', keywords: 'TypeScript' })
    mocks.modelChat.mockResolvedValue({ text: '{"after":"Backend engineer building TypeScript systems","reason":"Aligned skills"}' })
    mocks.parseAiJson.mockReturnValue({ after: 'Backend engineer building TypeScript systems', reason: 'Aligned skills' })
    mocks.resumeCreate.mockResolvedValue({ id: 'resume_tailored', name: 'Tailored for N26 - Backend Engineer' })
    mocks.activityCreate.mockResolvedValue({})
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', body: JSON.stringify({ resumeId: 'resume_base' }), headers: { 'Content-Type': 'application/json' },
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('CONFIRMED PERSONA') })]), expect.any(Object), 2000)
    expect(mocks.resumeCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ parentResumeId: 'resume_base', content: { summary: 'Backend engineer building TypeScript systems' } }) }))
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['another tailored resume is newest', { id: 'resume_other' }],
    ['no tailored resume exists for the job', null],
  ])('rejects forced repair before any writes or AI when %s', async (_reason, existing) => {
    mocks.resumeFindFirst.mockResolvedValueOnce({ id: 'resume_selected' }).mockResolvedValueOnce(existing)
    mocks.jobFindFirst.mockResolvedValueOnce({ id: 'job_1', description: 'Build reliable systems.' })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_selected', forceRetailor: true }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: expect.stringContaining('Open it to edit') })
    expect(mocks.resumeFindFirst).toHaveBeenNthCalledWith(1, { where: { id: 'resume_selected', userId: 'user_1' } })
    expect(mocks.resumeFindFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { userId: 'user_1', targetJobId: 'job_1', kind: 'adapted', origin: 'ai-adapted' } }))
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({ where: { id: 'job_1', userId: 'user_1' } })
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.buildPersona).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it.each(['resume', 'job'])('rejects forced repair when the account does not own the %s', async missing => {
    mocks.resumeFindFirst.mockResolvedValueOnce(missing === 'resume' ? null : { id: 'resume_selected' }).mockResolvedValueOnce({ id: 'resume_selected' })
    mocks.jobFindFirst.mockResolvedValueOnce(missing === 'job' ? null : { id: 'job_1', description: 'Build reliable systems.' })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_selected', forceRetailor: true }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(404)
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
  })

  it('repairs only the experience section when the audit flags an unsupported role claim', async () => {
    const current = { summary: 'Selected custom summary', experience: [{ role: 'Invented title' }, { role: 'Supported second role' }], skills: ['Rust', 'TypeScript'], custom: { retained: 'Selected only' } }
    const source = { summary: 'Parent summary', experience: [{ role: 'Developer' }, { role: 'Supported second role' }], skills: ['Java'], custom: { retained: 'Parent only' } }
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_tailored', content: current })
      .mockResolvedValueOnce({ id: 'resume_tailored', parentResumeId: 'resume_base', content: current, name: 'Tailored', updatedAt: new Date('2026-01-01T00:00:00Z') })
      .mockResolvedValueOnce({ id: 'resume_base', content: source })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', company: 'N26', role: 'Backend Engineer', description: 'Build reliable systems.', keywords: '' })
    mocks.modelChat.mockResolvedValue({ text: '{"after":[{"role":"Developer"}],"reason":"Removed unsupported title"}' })
    mocks.parseAiJson.mockReturnValue({ after: [{ role: 'Developer' }, { role: 'Supported second role' }], reason: 'Removed unsupported title' })
    mocks.resumeVersionCreate.mockResolvedValue({})
    mocks.resumeUpdate.mockResolvedValue({ id: 'resume_tailored' })
    mocks.activityCreate.mockResolvedValue({})
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_tailored', forceRetailor: true, auditFindings: [{ area: 'resume', severity: 'critical', title: 'Unsupported role title', evidence: 'The experience title is not in the source.', action: 'Restore the source role.' }] }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })

    if (!response) throw new Error('Expected a response')
    expect(response.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenCalledTimes(1)
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('SECTION: experience')
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain(`CURRENT SECTION JSON:\n${JSON.stringify(current.experience, null, 2)}`)
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain(`ORIGINAL RESUME EVIDENCE:\n${JSON.stringify(source, null, 2)}`)
    expect(mocks.resumeVersionCreate).toHaveBeenCalledWith({ data: { resumeId: 'resume_tailored', userId: 'user_1', content: current, name: 'Tailored' } })
    expect(mocks.resumeUpdateMany).toHaveBeenCalledWith({ where: { id: 'resume_tailored', userId: 'user_1', updatedAt: new Date('2026-01-01T00:00:00Z'), content: { equals: current } }, data: { content: { ...current, experience: [{ role: 'Developer' }, { role: 'Supported second role' }] } } })
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
  })

  it.each(['missing reference', 'missing parent'])('fails closed before generating or writing when original evidence is unavailable: %s', async scenario => {
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_tailored', content: { summary: 'Current' } })
      .mockResolvedValueOnce({ id: 'resume_tailored', parentResumeId: scenario === 'missing reference' ? null : 'resume_base', content: { summary: 'Current' }, name: 'Tailored' })
      .mockResolvedValueOnce(null)
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', description: 'Build reliable systems.' })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_tailored', forceRetailor: true, auditFindings: [{ area: 'resume', severity: 'critical', title: 'Summary', evidence: 'Unsupported', action: 'Correct summary' }] }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    expect(response?.status).toBe(404)
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
  })

  it('does not rewrite every section when force repair has no resume issue', async () => {
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_tailored', content: { summary: 'Current' } })
      .mockResolvedValueOnce({ id: 'resume_tailored', parentResumeId: 'resume_base', content: { summary: 'Current' }, name: 'Tailored' })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', description: 'Build reliable systems.' })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_tailored', forceRetailor: true, auditFindings: [] }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    expect(response?.status).toBe(400)
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
  })

  it.each([
    { title: 'Unclear', evidence: 'This claim needs review.', action: 'Correct it.' },
    { title: 'Summary and role', evidence: 'Both are unclear.', action: 'Correct the summary and role.' },
    { target: 'contact', title: 'Contact', evidence: 'Check contact.', action: 'Correct contact.' },
  ])('does not guess an affected section for an ambiguous or unsupported finding', async finding => {
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_tailored', content: { summary: 'Current' } })
      .mockResolvedValueOnce({ id: 'resume_tailored', parentResumeId: 'resume_base', content: { summary: 'Current' }, name: 'Tailored' })
      .mockResolvedValueOnce({ id: 'resume_base', content: { summary: 'Source' } })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', role: 'Engineer', company: 'Acme', description: 'Build systems.' })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_tailored', forceRetailor: true, auditFindings: [{ area: 'resume', severity: 'warning', ...finding }] }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    expect(response?.status).toBe(422)
    expect(mocks.modelChat).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
  })

  it('uses an explicit target without inferring unrelated sections from its wording', async () => {
    const current = { summary: 'Selected summary', experience: [{ role: 'Engineer' }], skills: ['TypeScript'] }
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_tailored', content: current })
      .mockResolvedValueOnce({ id: 'resume_tailored', parentResumeId: 'resume_base', content: current, name: 'Tailored', updatedAt: new Date('2026-01-01T00:00:00Z') })
      .mockResolvedValueOnce({ id: 'resume_base', content: { summary: 'Source', experience: [{ role: 'Developer' }] } })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', role: 'Engineer', company: 'Acme', description: 'Build systems.' })
    mocks.modelChat.mockResolvedValue({ text: '{}' })
    mocks.parseAiJson.mockReturnValue({ after: 'Corrected summary', reason: 'Correct claim' })
    mocks.resumeVersionCreate.mockResolvedValue({})
    mocks.resumeUpdate.mockResolvedValue({ id: 'resume_tailored' })
    mocks.activityCreate.mockResolvedValue({})
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_tailored', forceRetailor: true, auditFindings: [{ area: 'resume', severity: 'warning', target: 'summary', title: 'Summary', evidence: 'The role differs.', action: 'Fix the summary.' }] }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    expect(response?.status).toBe(200)
    expect(mocks.modelChat).toHaveBeenCalledTimes(1)
    expect(mocks.modelChat.mock.calls[0][0][0].content).toContain('SECTION: summary')
    expect(mocks.resumeUpdateMany).toHaveBeenCalledWith({ where: { id: 'resume_tailored', userId: 'user_1', updatedAt: new Date('2026-01-01T00:00:00Z'), content: { equals: current } }, data: { content: { ...current, summary: 'Corrected summary' } } })
  })

  it('does not replace an experience array with a differently shaped AI result', async () => {
    const current = { experience: [{ role: 'Engineer' }] }
    mocks.resumeFindFirst
      .mockResolvedValueOnce({ id: 'resume_tailored', content: current })
      .mockResolvedValueOnce({ id: 'resume_tailored', parentResumeId: 'resume_base', content: current, name: 'Tailored' })
      .mockResolvedValueOnce({ id: 'resume_base', content: current })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', role: 'Engineer', company: 'Acme', description: 'Build systems.' })
    mocks.modelChat.mockResolvedValue({ text: '{}' })
    mocks.parseAiJson.mockReturnValue({ after: { role: 'Developer' } })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_tailored', forceRetailor: true, auditFindings: [{ area: 'resume', severity: 'warning', target: 'experience', title: 'Experience', evidence: 'Check role.', action: 'Correct it.' }] }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    expect(response?.status).toBe(502)
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
  })

  it.each(['content conflict', 'version conflict', 'history failure', 'success'] as const)('protects the read-to-write interleaving: %s', async scenario => {
    const originalContent = { summary: 'Original', skills: ['TypeScript'] }
    const originalTime = new Date('2026-01-01T00:00:00Z')
    let persisted = { id: 'resume_tailored', userId: 'user_1', content: structuredClone(originalContent), updatedAt: originalTime }
    const history: unknown[] = []
    const observed = { id: persisted.id, parentResumeId: 'resume_base', name: 'Tailored', content: structuredClone(originalContent), updatedAt: originalTime }
    mocks.resumeFindFirst.mockResolvedValueOnce({ ...persisted }).mockResolvedValueOnce(observed)
      .mockResolvedValueOnce({ id: 'resume_base', content: { summary: 'Evidence' } })
    mocks.jobFindFirst.mockResolvedValue({ id: 'job_1', role: 'Engineer', company: 'Acme', description: 'Build systems.' })
    let releaseModel = () => {}
    let markModelEntered = () => {}
    const gate = new Promise<void>(resolve => { releaseModel = resolve })
    const entered = new Promise<void>(resolve => { markModelEntered = resolve })
    mocks.modelChat.mockImplementation(async () => { markModelEntered(); await gate; return { text: '{}' } })
    mocks.parseAiJson.mockReturnValue({ after: 'Corrected' })
    mocks.activityCreate.mockResolvedValue({})
    mocks.transaction.mockImplementation(async callback => {
      let staged = structuredClone(persisted)
      const stagedHistory: unknown[] = []
      const result = await callback({
        resume: { updateMany: async ({ where, data }: { where: { id: string; userId: string; updatedAt: Date; content: { equals: unknown } }; data: { content: typeof originalContent } }) => {
          const matches = staged.id === where.id && staged.userId === where.userId && staged.updatedAt.getTime() === where.updatedAt.getTime()
            && JSON.stringify(staged.content) === JSON.stringify(where.content.equals)
          if (!matches) return { count: 0 }
          staged = { ...staged, content: structuredClone(data.content), updatedAt: new Date('2026-01-02T00:00:00Z') }
          return { count: 1 }
        } },
        resumeVersion: { create: async ({ data }: { data: unknown }) => {
          if (scenario === 'history failure') throw new Error('Synthetic history write failure')
          stagedHistory.push(structuredClone(data))
        } },
      })
      persisted = staged
      history.push(...stagedHistory)
      return result
    })
    const { POST } = await import('./route')
    const pending = POST(new NextRequest('http://localhost/api/jobs/job_1/tailor-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeId: 'resume_tailored', forceRetailor: true, auditFindings: [{ area: 'resume', severity: 'warning', target: 'summary', title: 'Summary', evidence: 'Check claim', action: 'Correct it' }] }),
    }) as never, { params: Promise.resolve({ id: 'job_1' }) })
    try {
      await entered
      if (scenario === 'content conflict') persisted = { ...persisted, content: { ...persisted.content, skills: ['Concurrent edit'] } }
      if (scenario === 'version conflict') persisted = { ...persisted, updatedAt: new Date('2026-01-01T00:00:01Z') }
    } finally { releaseModel() }
    const response = await pending
    expect(response?.status).toBe(scenario === 'success' ? 200 : scenario === 'history failure' ? 503 : 409)
    if (scenario === 'success') {
      expect(persisted.content).toEqual({ ...originalContent, summary: 'Corrected' })
      expect(history).toEqual([{ resumeId: 'resume_tailored', userId: 'user_1', content: originalContent, name: 'Tailored' }])
    } else {
      expect(persisted.content).toEqual(scenario === 'content conflict' ? { ...originalContent, skills: ['Concurrent edit'] } : originalContent)
      expect(history).toEqual([])
      expect(mocks.activityCreate).not.toHaveBeenCalled()
    }
  })
})
