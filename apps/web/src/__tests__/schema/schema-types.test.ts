import { describe, it, expect } from 'vitest'
import type { Direction, CoverLetter, ResumeListItem, Job } from '@/lib/types'

describe('Schema type definitions', () => {
  it('Direction type has required fields', () => {
    const d: Direction = {
      id: 'c1', userId: 'u1', name: 'Marketing',
      color: '#185FA5', icon: '📈', sortOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    expect(d.name).toBe('Marketing')
  })

  it('CoverLetter type has required fields', () => {
    const cl: CoverLetter = {
      id: 'cl1', userId: 'u1', jobId: 'j1', resumeId: null,
      content: 'Dear Hiring Manager,', tone: 'professional',
      templateId: null, templateOptions: null,
      origin: 'manual', isFinal: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    expect(cl.isFinal).toBe(true)
  })

  it('ResumeListItem has direction and kind fields', () => {
    const r: ResumeListItem = {
      id: 'r1', name: 'Marketing Master', isDefault: false,
      directionId: 'd1', kind: 'base', parentResumeId: null,
      targetJobId: null, origin: 'manual', basicsDetached: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    expect(r.kind).toBe('base')
  })

  it('Job type has finalResumeId and finalCoverLetterId', () => {
    const j: Partial<Job> = { finalResumeId: 'r1', finalCoverLetterId: 'cl1' }
    expect(j.finalResumeId).toBe('r1')
  })
})
