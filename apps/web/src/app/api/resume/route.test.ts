import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  transaction: vi.fn(),
  sourceFence: vi.fn(),
  events: [] as string[],
  outsideDirectionFindFirst: vi.fn(),
  outsideResumeFindMany: vi.fn(),
  outsideResumeUpdateMany: vi.fn(),
  outsideResumeCreate: vi.fn(),
  tx: {
    direction: { findFirst: vi.fn() },
    resume: { updateMany: vi.fn(), create: vi.fn() },
  },
}))

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    direction: { findFirst: mocks.outsideDirectionFindFirst },
    resume: {
      findMany: mocks.outsideResumeFindMany,
      updateMany: mocks.outsideResumeUpdateMany,
      create: mocks.outsideResumeCreate,
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
  return new Request('http://localhost:3000/api/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

function expectOutsideDatabaseUnused() {
  for (const outside of [
    mocks.outsideDirectionFindFirst,
    mocks.outsideResumeUpdateMany,
    mocks.outsideResumeCreate,
  ]) expect(outside).not.toHaveBeenCalled()
}

describe('resume create API source fence', () => {
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
    mocks.tx.direction.findFirst.mockImplementation(async () => {
      mocks.events.push('direction.findFirst')
      return { id: 'direction_1', userId: 'user_1' }
    })
    mocks.tx.resume.updateMany.mockImplementation(async () => {
      mocks.events.push('resume.updateMany')
      return { count: 1 }
    })
    mocks.tx.resume.create.mockImplementation(async () => {
      mocks.events.push('resume.create')
      return { id: 'resume_1', userId: 'user_1', name: 'Engineer', isDefault: true }
    })
    mocks.outsideResumeFindMany.mockResolvedValue([])
  })

  it('fences before tenant-scoped direction lookup and atomically clears defaults and creates', async () => {
    const { POST } = await import('./route')

    const response = await POST(request(JSON.stringify({
      name: 'Engineer', content: { summary: 'Experienced engineer' }, templateId: 'template_1',
      isDefault: true, directionId: 'direction_1', kind: 'base', origin: 'manual',
    })) as never)

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ id: 'resume_1', userId: 'user_1' })
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user_1'])
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'direction.findFirst', 'resume.updateMany', 'resume.create', 'committed',
    ])
    expect(mocks.tx.direction.findFirst).toHaveBeenCalledWith({
      where: { id: 'direction_1', userId: 'user_1' },
    })
    expect(mocks.tx.resume.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' }, data: { isDefault: false },
    })
    expect(mocks.tx.resume.create).toHaveBeenCalledWith({
      data: {
        userId: 'user_1', name: 'Engineer', content: { summary: 'Experienced engineer' },
        templateId: 'template_1', isDefault: true, directionId: 'direction_1',
        kind: 'base', origin: 'manual',
      },
    })
    expectOutsideDatabaseUnused()
  })

  it('rejects a direction outside the authenticated tenant before any resume write', async () => {
    mocks.tx.direction.findFirst.mockImplementation(async () => {
      mocks.events.push('direction.findFirst')
      return null
    })
    const { POST } = await import('./route')

    const response = await POST(request(JSON.stringify({
      name: 'Engineer', content: { summary: 'Experienced engineer' },
      isDefault: true, directionId: 'direction_2',
    })) as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid directionId' })
    expect(mocks.events).toEqual(['transaction', 'fence', 'direction.findFirst', 'committed'])
    expect(mocks.tx.resume.updateMany).not.toHaveBeenCalled()
    expect(mocks.tx.resume.create).not.toHaveBeenCalled()
    expectOutsideDatabaseUnused()
  })

  it('preserves invalid JSON and required-field responses before opening a transaction', async () => {
    const { POST } = await import('./route')

    const invalidJson = await POST(request('{') as never)
    expect(invalidJson.status).toBe(400)
    await expect(invalidJson.json()).resolves.toEqual({ error: 'Invalid JSON body' })

    const missingFields = await POST(request(JSON.stringify({ name: 'Engineer' })) as never)
    expect(missingFields.status).toBe(400)
    await expect(missingFields.json()).resolves.toEqual({ error: 'name and content are required' })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.sourceFence).not.toHaveBeenCalled()
    expectOutsideDatabaseUnused()
  })

  it('propagates a create failure after default clearing so the transaction rolls back', async () => {
    const failure = new Error('resume create failed')
    mocks.tx.resume.create.mockRejectedValue(failure)
    const { POST } = await import('./route')

    await expect(POST(request(JSON.stringify({
      name: 'Engineer', content: { summary: 'Experienced engineer' }, isDefault: true,
    })) as never)).rejects.toBe(failure)

    expect(mocks.events).toEqual(['transaction', 'fence', 'resume.updateMany'])
    expect(mocks.tx.resume.updateMany).toHaveBeenCalledTimes(1)
    expect(mocks.tx.resume.create).toHaveBeenCalledTimes(1)
    expect(mocks.events).not.toContain('committed')
    expectOutsideDatabaseUnused()
  })

  it('propagates a fence failure before direction or resume reads and writes', async () => {
    const failure = new Error('source fence failed')
    mocks.sourceFence.mockRejectedValue(failure)
    const { POST } = await import('./route')

    await expect(POST(request(JSON.stringify({
      name: 'Engineer', content: { summary: 'Experienced engineer' },
      isDefault: true, directionId: 'direction_1',
    })) as never)).rejects.toBe(failure)

    expect(mocks.events).toEqual(['transaction'])
    expect(mocks.tx.direction.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.resume.updateMany).not.toHaveBeenCalled()
    expect(mocks.tx.resume.create).not.toHaveBeenCalled()
    expectOutsideDatabaseUnused()
  })

  it('keeps GET on the existing nontransactional read path', async () => {
    const { GET } = await import('./route')

    const response = await GET()

    expect(response.status).toBe(200)
    expect(mocks.outsideResumeFindMany).toHaveBeenCalledWith({
      where: { userId: 'user_1' },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true, name: true, isDefault: true,
        directionId: true, kind: true, parentResumeId: true,
        targetJobId: true, origin: true, basicsDetached: true,
        createdAt: true, updatedAt: true,
        _count: { select: { finalForJobs: true } },
      },
    })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.sourceFence).not.toHaveBeenCalled()
  })
})
