import { describe, expect, it } from 'vitest'
import { userRowLabel } from './UsersPage'

describe('admin user view model', () => {
  it('formats masked user rows without exposing identity content', () => {
    expect(userRowLabel({ name: 'A*** L***', email: 'a***@example.com', plan: 'pro', accountStatus: 'active' })).toEqual('A*** L*** · a***@example.com · pro · active')
  })
})
