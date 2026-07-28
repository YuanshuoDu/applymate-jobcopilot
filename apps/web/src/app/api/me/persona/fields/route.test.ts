import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  confirm: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique, update: mocks.update } } }))
vi.mock('@/lib/persona-facts', () => ({ confirmPersonaFacts: mocks.confirm, listConfirmedPersonaFacts: mocks.list, revokePersonaFact: mocks.revoke }))

describe('POST /api/me/persona/fields', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findUnique.mockReset()
    mocks.update.mockReset()
    mocks.confirm.mockReset(); mocks.list.mockReset(); mocks.revoke.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.findUnique.mockResolvedValue({ personaFields: [] })
    mocks.update.mockImplementation(async ({ data }: { data: { personaFields: unknown } }) => ({ personaFields: data.personaFields }))
    mocks.confirm.mockImplementation(async (_userId: string, fields: Array<Record<string, unknown>>) => fields.map(field => ({ ...field, consentAt: '2026-07-28T09:00:00.000Z', updatedAt: '2026-07-28T09:00:00.000Z' })))
    mocks.list.mockResolvedValue([])
  })

  it('stores only a valid user-confirmed field and records the save time', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/persona/fields', {
      method: 'POST', body: JSON.stringify({ fields: [{ key: 'notice_period', label: 'Notice period', value: 'One month', category: 'work', confidence: 1, source: 'manual', updatedAt: '' }] }),
    }) as never)

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.fields[0]).toMatchObject({ key: 'notice_period', consentAt: expect.any(String) })
    expect(mocks.confirm).toHaveBeenCalledWith('user_1', [expect.objectContaining({ key: 'notice_period' })])
  })

  it('does not persist sensitive data', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/me/persona/fields', {
      method: 'POST', body: JSON.stringify({ fields: [{ key: 'disability_status', label: 'Disability status', value: 'No', category: 'personal' }] }),
    }) as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('Sensitive') })
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
