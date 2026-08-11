import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  resumeFindUnique: vi.fn(),
  versionFindUnique: vi.fn(),
  versionCreate: vi.fn(),
  resumeUpdate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    resume: {
      findUnique: mocks.resumeFindUnique,
      update: mocks.resumeUpdate,
    },
    resumeVersion: {
      findUnique: mocks.versionFindUnique,
      create: mocks.versionCreate,
    },
  },
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

function request(body: unknown) {
  return new Request('http://localhost:3000/api/resume/resume_1/versions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('resume version restore API', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.resumeFindUnique.mockResolvedValue({
      id: 'resume_1',
      userId: 'user_1',
      content: { basics: { name: 'Current' } },
      name: 'Current',
    })
    mocks.versionCreate.mockResolvedValue({ id: 'snapshot_1' })
    mocks.resumeUpdate.mockResolvedValue({ id: 'resume_1', name: 'Restored' })
  })

  it('rejects a version owned by another user even when it targets the users resume', async () => {
    mocks.versionFindUnique.mockResolvedValue({
      id: 'version_1',
      resumeId: 'resume_1',
      userId: 'user_2',
      content: { basics: { name: 'Private' } },
      name: 'Private',
    })
    const { POST } = await import('./route')

    const response = await POST(request({ versionId: 'version_1' }) as never, {
      params: Promise.resolve({ id: 'resume_1' }),
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Version not found' })
    expect(mocks.versionCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdate).not.toHaveBeenCalled()
  })

  it('restores a version owned by the authenticated user', async () => {
    mocks.versionFindUnique.mockResolvedValue({
      id: 'version_1',
      resumeId: 'resume_1',
      userId: 'user_1',
      content: { basics: { name: 'Restored' } },
      name: 'Restored',
    })
    const { POST } = await import('./route')

    const response = await POST(request({ versionId: 'version_1' }) as never, {
      params: Promise.resolve({ id: 'resume_1' }),
    })

    expect(response.status).toBe(200)
    expect(mocks.versionFindUnique).toHaveBeenCalledWith({
      where: { id: 'version_1' },
      select: { id: true, resumeId: true, userId: true, content: true, name: true },
    })
    expect(mocks.resumeUpdate).toHaveBeenCalledWith({
      where: { id: 'resume_1' },
      data: { content: { basics: { name: 'Restored' } }, name: 'Restored' },
    })
  })
})
