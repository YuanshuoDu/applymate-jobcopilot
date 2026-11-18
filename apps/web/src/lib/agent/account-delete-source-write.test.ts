import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sourceFence: vi.fn() }))
vi.mock('./source-material-fence', () => ({ acquireSourceMaterialFence: mocks.sourceFence }))

import { deleteAccountWithSourceFence } from './account-delete-source-write'

function fixture(email: string | null = 'member@example.com') {
  const events: string[] = []
  const tx = {
    user: {
      findUnique: vi.fn(async () => { events.push('read-user'); return email === null ? null : { email } }),
      delete: vi.fn(async () => { events.push('delete-user') }),
    },
  }
  const client = { $transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)) }
  return { client, tx, events }
}

describe('deleteAccountWithSourceFence', () => {
  beforeEach(() => {
    mocks.sourceFence.mockReset().mockImplementation(async () => undefined)
  })

  it('takes the authenticated user fence before re-reading confirmation and deleting', async () => {
    const value = fixture()
    mocks.sourceFence.mockImplementation(async () => { value.events.push('source-fence') })

    await expect(deleteAccountWithSourceFence(value.client as never, 'user-1', ' MEMBER@EXAMPLE.COM ')).resolves.toBe('deleted')

    expect(value.events).toEqual(['source-fence', 'read-user', 'delete-user'])
    expect(mocks.sourceFence).toHaveBeenCalledWith(expect.anything(), ['user-1'])
    expect(value.tx.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, select: { email: true } })
    expect(value.tx.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } })
  })

  it.each([
    ['missing user', null, 'member@example.com', 'not_found'],
    ['mismatched email', 'member@example.com', 'other@example.com', 'confirmation_required'],
    ['empty confirmation', 'member@example.com', ' ', 'confirmation_required'],
  ] as const)('does not delete for %s', async (_label, email, confirmation, result) => {
    const value = fixture(email)

    await expect(deleteAccountWithSourceFence(value.client as never, 'user-1', confirmation)).resolves.toBe(result)

    expect(value.tx.user.delete).not.toHaveBeenCalled()
  })

  it('fails before reading or deleting when fence acquisition rejects', async () => {
    const value = fixture()
    const failure = new Error('source fence failed')
    mocks.sourceFence.mockRejectedValueOnce(failure)

    await expect(deleteAccountWithSourceFence(value.client as never, 'user-1', 'member@example.com')).rejects.toBe(failure)

    expect(value.tx.user.findUnique).not.toHaveBeenCalled()
    expect(value.tx.user.delete).not.toHaveBeenCalled()
  })
})
