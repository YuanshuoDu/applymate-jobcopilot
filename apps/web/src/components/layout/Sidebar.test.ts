import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui', () => ({ UserAvatar: () => null }))
import { getSidebarNavItems } from './Sidebar'

describe('application journey navigation', () => {
  it('orders discovery before applications while keeping existing page identifiers', () => {
    const items = getSidebarNavItems(key => key)
    expect(items.map(item => item.id)).toEqual(['dashboard', 'search', 'jobs', 'resume', 'gmail', 'agent', 'contact-us'])
    expect(items.find(item => item.id === 'jobs')?.label).toBe('nav.jobs')
    expect(items.find(item => item.id === 'gmail')?.label).toBe('nav.gmail')
  })
})
