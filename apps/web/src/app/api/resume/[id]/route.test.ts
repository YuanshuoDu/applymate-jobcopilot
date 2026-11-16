import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  transaction: vi.fn(),
  sourceFence: vi.fn(),
  events: [] as string[],
  outsideResumeFindUnique: vi.fn(),
  outsideResumeFindFirst: vi.fn(),
  outsideResumeUpdate: vi.fn(),
  outsideResumeUpdateMany: vi.fn(),
  outsideResumeDelete: vi.fn(),
  outsideResumeVersionCreate: vi.fn(),
  outsideResumeVersionFindMany: vi.fn(),
  outsideResumeVersionDeleteMany: vi.fn(),
  outsideJobFindFirst: vi.fn(),
  outsideJobUpdateMany: vi.fn(),
  tx: {
    resume: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    resumeVersion: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    job: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    resume: {
      findUnique: mocks.outsideResumeFindUnique,
      findFirst: mocks.outsideResumeFindFirst,
      update: mocks.outsideResumeUpdate,
      updateMany: mocks.outsideResumeUpdateMany,
      delete: mocks.outsideResumeDelete,
    },
    resumeVersion: {
      create: mocks.outsideResumeVersionCreate,
      findMany: mocks.outsideResumeVersionFindMany,
      deleteMany: mocks.outsideResumeVersionDeleteMany,
    },
    job: {
      findFirst: mocks.outsideJobFindFirst,
      updateMany: mocks.outsideJobUpdateMany,
    },
  },
}))

vi.mock('@/lib/agent/source-material-fence', () => ({
  acquireSourceMaterialFence: mocks.sourceFence,
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

function request(body: string) {
  return new Request('http://localhost:3000/api/resume/resume_1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

function expectOutsideDatabaseUnused() {
  for (const outside of [
    mocks.outsideResumeFindUnique, mocks.outsideResumeFindFirst, mocks.outsideResumeUpdate,
    mocks.outsideResumeUpdateMany, mocks.outsideResumeDelete, mocks.outsideResumeVersionCreate,
    mocks.outsideResumeVersionFindMany, mocks.outsideResumeVersionDeleteMany,
    mocks.outsideJobFindFirst, mocks.outsideJobUpdateMany,
  ]) expect(outside).not.toHaveBeenCalled()
}

describe('resume mutation API source fence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mocks.events.length = 0
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
      mocks.events.push('transaction')
      const result = await run(mocks.tx)
      mocks.events.push('committed')
      return result
    })
    mocks.sourceFence.mockImplementation(async () => { mocks.events.push('fence') })
    mocks.tx.resume.findFirst.mockImplementation(async () => {
      mocks.events.push('resume.findFirst')
      return { id: 'resume_1', userId: 'user_1', content: { summary: 'Before' }, name: 'Before', isDefault: false }
    })
    mocks.tx.resume.update.mockImplementation(async () => {
      mocks.events.push('resume.update')
      return { id: 'resume_1', userId: 'user_1', name: 'After' }
    })
    mocks.tx.resume.updateMany.mockImplementation(async () => {
      mocks.events.push('resume.updateMany')
      return { count: 1 }
    })
    mocks.tx.resume.delete.mockImplementation(async () => {
      mocks.events.push('resume.delete')
      return { id: 'resume_1' }
    })
    mocks.tx.resumeVersion.create.mockImplementation(async () => {
      mocks.events.push('resumeVersion.create')
      return { id: 'version_1' }
    })
    mocks.tx.resumeVersion.findMany.mockImplementation(async () => {
      mocks.events.push('resumeVersion.findMany')
      return [{ id: 'old_version_1' }]
    })
    mocks.tx.resumeVersion.deleteMany.mockImplementation(async () => {
      mocks.events.push('resumeVersion.deleteMany')
      return { count: 1 }
    })
    mocks.tx.job.findFirst.mockImplementation(async () => {
      mocks.events.push('job.findFirst')
      return { id: 'job_1' }
    })
    mocks.tx.job.updateMany.mockImplementation(async () => {
      mocks.events.push('job.updateMany')
      return { count: 1 }
    })
  })

  it('fences before reading and keeps snapshot, retention, default, unlink and update in one tenant transaction', async () => {
    const { PATCH } = await import('./route')

    const response = await PATCH(request(JSON.stringify({
      content: { summary: 'After' }, isDefault: true, targetJobId: 'job_1', unlinkJob: true,
    })) as never, { params: Promise.resolve({ id: 'resume_1' }) })

    expect(response.status).toBe(200)
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user_1'])
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'resume.findFirst', 'job.findFirst', 'resumeVersion.create',
      'resumeVersion.findMany', 'resumeVersion.deleteMany', 'resume.updateMany',
      'job.updateMany', 'resume.update', 'committed',
    ])
    expect(mocks.tx.resume.findFirst).toHaveBeenCalledWith({ where: { id: 'resume_1', userId: 'user_1' } })
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith({ where: { id: 'job_1', userId: 'user_1' } })
    expect(mocks.tx.resumeVersion.findMany).toHaveBeenCalledWith({
      where: { resumeId: 'resume_1', userId: 'user_1' },
      orderBy: { createdAt: 'desc' }, skip: 20, select: { id: true },
    })
    expect(mocks.tx.resumeVersion.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old_version_1'] }, resumeId: 'resume_1', userId: 'user_1' },
    })
    expect(mocks.tx.resume.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' }, data: { isDefault: false },
    })
    expect(mocks.tx.job.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', finalResumeId: 'resume_1' }, data: { finalResumeId: null },
    })
    expect(mocks.tx.resume.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'resume_1', userId: 'user_1' },
      data: expect.objectContaining({ isDefault: true, targetJobId: null }),
    }))
    expectOutsideDatabaseUnused()
  })

  it('preserves the owned-resume 404 before parsing a malformed body', async () => {
    mocks.tx.resume.findFirst.mockImplementation(async () => {
      mocks.events.push('resume.findFirst')
      return null
    })
    const { PATCH } = await import('./route')

    const response = await PATCH(request('{') as never, { params: Promise.resolve({ id: 'resume_1' }) })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
    expect(mocks.events).toEqual(['transaction', 'fence', 'resume.findFirst', 'committed'])
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user_1'])
    expect(mocks.tx.resumeVersion.create).not.toHaveBeenCalled()
    expect(mocks.tx.resume.update).not.toHaveBeenCalled()
    expectOutsideDatabaseUnused()
  })

  it('preserves invalid JSON for an owned resume without attempting writes', async () => {
    const { PATCH } = await import('./route')

    const response = await PATCH(request('{') as never, { params: Promise.resolve({ id: 'resume_1' }) })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    expect(mocks.events).toEqual(['transaction', 'fence', 'resume.findFirst', 'committed'])
    expect(mocks.tx.resumeVersion.create).not.toHaveBeenCalled()
    expect(mocks.tx.resume.update).not.toHaveBeenCalled()
    expectOutsideDatabaseUnused()
  })

  it('keeps invalid-job validation before any source writes', async () => {
    mocks.tx.job.findFirst.mockImplementation(async () => {
      mocks.events.push('job.findFirst')
      return null
    })
    const { PATCH } = await import('./route')

    const response = await PATCH(request(JSON.stringify({ content: { summary: 'After' }, targetJobId: 'job_2' })) as never, {
      params: Promise.resolve({ id: 'resume_1' }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid job' })
    expect(mocks.tx.resumeVersion.create).not.toHaveBeenCalled()
    expect(mocks.tx.resume.updateMany).not.toHaveBeenCalled()
    expect(mocks.tx.job.updateMany).not.toHaveBeenCalled()
    expect(mocks.tx.resume.update).not.toHaveBeenCalled()
    expect(mocks.events).toEqual(['transaction', 'fence', 'resume.findFirst', 'job.findFirst', 'committed'])
    expectOutsideDatabaseUnused()
  })

  it('propagates a failed final update so the interactive transaction cannot commit earlier writes', async () => {
    const failure = new Error('resume update failed')
    mocks.tx.resume.update.mockRejectedValue(failure)
    const { PATCH } = await import('./route')

    await expect(PATCH(request(JSON.stringify({
      content: { summary: 'After' }, isDefault: true, unlinkJob: true,
    })) as never, { params: Promise.resolve({ id: 'resume_1' }) })).rejects.toBe(failure)

    expect(mocks.tx.resumeVersion.create).toHaveBeenCalledTimes(1)
    expect(mocks.tx.resume.updateMany).toHaveBeenCalledTimes(1)
    expect(mocks.tx.job.updateMany).toHaveBeenCalledTimes(1)
    expect(mocks.events).not.toContain('committed')
    expectOutsideDatabaseUnused()
  })

  it('propagates a source-fence failure before any source read or write', async () => {
    const failure = new Error('source fence failed')
    mocks.sourceFence.mockRejectedValue(failure)
    const { PATCH } = await import('./route')

    await expect(PATCH(request(JSON.stringify({ name: 'After' })) as never, {
      params: Promise.resolve({ id: 'resume_1' }),
    })).rejects.toBe(failure)

    expect(mocks.events).toEqual(['transaction'])
    expect(mocks.tx.resume.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.resumeVersion.create).not.toHaveBeenCalled()
    expect(mocks.tx.resume.update).not.toHaveBeenCalled()
    expectOutsideDatabaseUnused()
  })

  it('fences deletion and scopes both the ownership check and delete to the authenticated user', async () => {
    const { DELETE } = await import('./route')

    const response = await DELETE(new Request('http://localhost:3000/api/resume/resume_1') as never, {
      params: Promise.resolve({ id: 'resume_1' }),
    })

    expect(response.status).toBe(200)
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user_1'])
    expect(mocks.events).toEqual(['transaction', 'fence', 'resume.findFirst', 'resume.delete', 'committed'])
    expect(mocks.tx.resume.findFirst).toHaveBeenCalledWith({ where: { id: 'resume_1', userId: 'user_1' } })
    expect(mocks.tx.resume.delete).toHaveBeenCalledWith({ where: { id: 'resume_1', userId: 'user_1' } })
    expectOutsideDatabaseUnused()
  })
})
