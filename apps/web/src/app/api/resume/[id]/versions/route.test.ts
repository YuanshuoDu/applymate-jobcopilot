import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  transaction: vi.fn(),
  sourceFence: vi.fn(),
  events: [] as string[],
  outsideResumeFindUnique: vi.fn(),
  outsideVersionFindMany: vi.fn(),
  tx: {
    resume: { findFirst: vi.fn(), update: vi.fn() },
    resumeVersion: { findFirst: vi.fn(), create: vi.fn() },
  },
}))

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    resume: { findUnique: mocks.outsideResumeFindUnique },
    resumeVersion: { findMany: mocks.outsideVersionFindMany },
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
  return new Request('http://localhost:3000/api/resume/resume_1/versions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

describe('resume version restore API', () => {
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
      return { id: 'resume_1', userId: 'user_1', content: { basics: { name: 'Current' } }, name: 'Current' }
    })
    mocks.tx.resumeVersion.findFirst.mockImplementation(async () => {
      mocks.events.push('resumeVersion.findFirst')
      return {
        id: 'version_1', resumeId: 'resume_1', userId: 'user_1',
        content: { basics: { name: 'Restored' } }, name: 'Restored',
      }
    })
    mocks.tx.resumeVersion.create.mockImplementation(async () => {
      mocks.events.push('resumeVersion.create')
      return { id: 'snapshot_1' }
    })
    mocks.tx.resume.update.mockImplementation(async () => {
      mocks.events.push('resume.update')
      return { id: 'resume_1', name: 'Restored' }
    })
    mocks.outsideResumeFindUnique.mockResolvedValue({ id: 'resume_1', userId: 'user_1' })
    mocks.outsideVersionFindMany.mockResolvedValue([{ id: 'version_1', name: 'Current' }])
  })

  it('restores a tenant-owned version after fencing, using only the transaction client', async () => {
    const { POST } = await import('./route')

    const response = await POST(request(JSON.stringify({ versionId: 'version_1' })) as never, {
      params: Promise.resolve({ id: 'resume_1' }),
    })

    expect(response.status).toBe(200)
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user_1'])
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'resume.findFirst', 'resumeVersion.findFirst',
      'resumeVersion.create', 'resume.update', 'committed',
    ])
    expect(mocks.tx.resume.findFirst).toHaveBeenCalledWith({ where: { id: 'resume_1', userId: 'user_1' } })
    expect(mocks.tx.resumeVersion.findFirst).toHaveBeenCalledWith({
      where: { id: 'version_1', resumeId: 'resume_1', userId: 'user_1' },
      select: { id: true, resumeId: true, userId: true, content: true, name: true },
    })
    expect(mocks.tx.resumeVersion.create).toHaveBeenCalledWith({
      data: { resumeId: 'resume_1', userId: 'user_1', content: { basics: { name: 'Current' } }, name: 'Current' },
    })
    expect(mocks.tx.resume.update).toHaveBeenCalledWith({
      where: { id: 'resume_1', userId: 'user_1' },
      data: { content: { basics: { name: 'Restored' } }, name: 'Restored' },
    })
    expect(mocks.outsideResumeFindUnique).not.toHaveBeenCalled()
    expect(mocks.outsideVersionFindMany).not.toHaveBeenCalled()
  })

  it('preserves the resume 404 before parsing an invalid body', async () => {
    mocks.tx.resume.findFirst.mockImplementation(async () => {
      mocks.events.push('resume.findFirst')
      return null
    })
    const { POST } = await import('./route')

    const response = await POST(request('{') as never, { params: Promise.resolve({ id: 'resume_1' }) })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
    expect(mocks.events).toEqual(['transaction', 'fence', 'resume.findFirst', 'committed'])
    expect(mocks.tx.resumeVersion.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.resumeVersion.create).not.toHaveBeenCalled()
    expect(mocks.tx.resume.update).not.toHaveBeenCalled()
  })

  it('keeps a missing version ID at 400 without reading or writing versions', async () => {
    const { POST } = await import('./route')

    const response = await POST(request(JSON.stringify({})) as never, { params: Promise.resolve({ id: 'resume_1' }) })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'versionId is required' })
    expect(mocks.events).toEqual(['transaction', 'fence', 'resume.findFirst', 'committed'])
    expect(mocks.tx.resumeVersion.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.resumeVersion.create).not.toHaveBeenCalled()
    expect(mocks.tx.resume.update).not.toHaveBeenCalled()
  })

  it('does not restore a version whose returned owner differs from the authenticated user', async () => {
    mocks.tx.resumeVersion.findFirst.mockResolvedValue({
      id: 'version_1', resumeId: 'resume_1', userId: 'user_2',
      content: { basics: { name: 'Private' } }, name: 'Private',
    })
    const { POST } = await import('./route')

    const response = await POST(request(JSON.stringify({ versionId: 'version_1' })) as never, {
      params: Promise.resolve({ id: 'resume_1' }),
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Version not found' })
    expect(mocks.tx.resumeVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'version_1', resumeId: 'resume_1', userId: 'user_1' },
    }))
    expect(mocks.tx.resumeVersion.create).not.toHaveBeenCalled()
    expect(mocks.tx.resume.update).not.toHaveBeenCalled()
  })

  it('propagates a restore update failure so the transaction does not report a commit', async () => {
    const failure = new Error('resume update failed')
    mocks.tx.resume.update.mockRejectedValue(failure)
    const { POST } = await import('./route')

    await expect(POST(request(JSON.stringify({ versionId: 'version_1' })) as never, {
      params: Promise.resolve({ id: 'resume_1' }),
    })).rejects.toBe(failure)

    expect(mocks.tx.resumeVersion.create).toHaveBeenCalledTimes(1)
    expect(mocks.events).not.toContain('committed')
  })

  it('filters the read-only version list by resume and authenticated user', async () => {
    const { GET } = await import('./route')

    const response = await GET(new Request('http://localhost:3000/api/resume/resume_1/versions') as never, {
      params: Promise.resolve({ id: 'resume_1' }),
    })

    expect(response.status).toBe(200)
    expect(mocks.outsideVersionFindMany).toHaveBeenCalledWith({
      where: { resumeId: 'resume_1', userId: 'user_1' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, name: true, createdAt: true },
    })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.sourceFence).not.toHaveBeenCalled()
  })
})
