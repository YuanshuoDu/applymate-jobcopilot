import { describe, expect, it } from 'vitest'
import { slaLabel, supportMessageLabel } from './ContactUsPage'

describe('admin Contact us view model', () => {
  it('labels SLA without relying on colour', () => {
    expect(slaLabel(new Date('2026-08-05T00:00:00Z'), new Date('2026-08-06T00:00:00Z'))).toBe('Overdue')
  })
  it('distinguishes staff notes from customer-visible replies', () => {
    expect(supportMessageLabel('internal_note')).toBe('Internal note')
    expect(supportMessageLabel('staff_reply')).toBe('Reply to customer')
  })
})
