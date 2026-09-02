import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => ({
  'access.pendingInvitations': 'Pending invitations',
  'access.email': 'Account email',
  'access.role': 'Role',
  'access.expires': 'Expires',
  'access.actions': 'Actions',
  'access.revokeInvitation': 'Revoke invitation',
}[key] ?? key) }) }))
vi.mock('lucide-react', () => ({ XCircle: () => null }))

import { AdminPendingInvitations } from './AdminPendingInvitations'

describe('AdminPendingInvitations', () => {
  it('renders a revoke action for every pending invitation', () => {
    const html = renderToStaticMarkup(React.createElement(AdminPendingInvitations, {
      invitations: [{ id: 'inv-1', email: 'invited@example.com', status: 'pending', expiresAt: '2030-01-01T00:00:00.000Z', createdAt: '2029-12-25T00:00:00.000Z', role: { key: 'operations', name: 'Operations' } }],
      onRevoke: vi.fn(),
    }))

    expect(html).toContain('Pending invitations')
    expect(html).toContain('Revoke invitation invited@example.com')
  })

  it('does not render an empty pending-invitations section', () => {
    const html = renderToStaticMarkup(React.createElement(AdminPendingInvitations, { invitations: [], onRevoke: vi.fn() }))

    expect(html).toBe('')
  })
})
