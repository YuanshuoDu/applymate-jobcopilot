import { describe, expect, it } from 'vitest'
import { findConfidentGmailJobMatch } from './matching'

const jobs = [
  { id: 'job-1', company: 'Acme Labs', role: 'Senior Data Engineer', status: 'saved' as const },
  { id: 'job-2', company: 'Northstar', role: 'Product Manager', status: 'applied' as const },
]

describe('findConfidentGmailJobMatch', () => {
  it('links only when company and role evidence agree', () => {
    expect(findConfidentGmailJobMatch(jobs, {
      company: 'Acme Labs',
      role: 'Senior Data Engineer',
      subject: 'Application received: Senior Data Engineer at Acme Labs',
      senderEmail: 'talent@acme.example',
    })).toEqual(expect.objectContaining({ job: jobs[0], confidence: 1 }))
  })

  it('does not link an email with only a loose company or sender-domain hint', () => {
    expect(findConfidentGmailJobMatch(jobs, {
      company: 'Acme Labs',
      role: null,
      subject: 'A message from Acme Labs',
      senderEmail: 'talent@acme.example',
    })).toBeNull()
    expect(findConfidentGmailJobMatch(jobs, {
      company: null,
      role: 'Senior Data Engineer',
      subject: 'We have an update for you',
      senderEmail: 'talent@acme.example',
    })).toBeNull()
  })

  it('chooses the strongest matching job when multiple jobs exist', () => {
    const match = findConfidentGmailJobMatch(jobs, {
      company: 'Northstar',
      role: 'Product Manager',
      subject: 'Interview invitation for Product Manager at Northstar',
      senderEmail: 'team@northstar.example',
    })
    expect(match?.job.id).toBe('job-2')
  })
})
