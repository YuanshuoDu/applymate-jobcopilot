import { describe, expect, it } from 'vitest'
import { getSidebarNavItems } from '@/components/layout/Sidebar'
import { getNotificationTargetPage } from '@/components/layout/AppShell'

describe('app navigation', () => {
  it('does not expose apply history as a standalone sidebar destination', () => {
    const items = getSidebarNavItems((key) => key)

    expect(items.map((item) => item.id)).not.toContain('apply-history')
  })

  it('does not expose the removed extension section', () => {
    const items = getSidebarNavItems((key) => key)

    expect(items.map((item) => item.id)).not.toContain('extension')
  })

  it('routes apply notifications to jobs instead of the removed apply history page', () => {
    expect(getNotificationTargetPage('apply_submitted')).toBe('jobs')
    expect(getNotificationTargetPage('message_received')).toBeNull()
  })
})
