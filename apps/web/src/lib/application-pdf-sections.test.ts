import { describe, expect, it } from 'vitest'
import { applicationPdfSectionOrder } from './application-pdf-sections'
import type { ResumeContent } from './types'

const base: ResumeContent = { contact: { name: '', email: '', location: '' }, summary: '', experience: [], education: [], skills: [] }
describe('PDF section order', () => {
  it('uses the preview default and appends custom sections', () => {
    expect(applicationPdfSectionOrder({ ...base, custom: [{ id: 'custom_a', title: 'Awards', items: [] }] })).toEqual(['summary', 'experience', 'projects', 'skills', 'certifications', 'education', 'languages', 'custom_a'])
  })
  it('respects omitted built-in sections and does not duplicate custom IDs', () => {
    expect(applicationPdfSectionOrder({ ...base, sectionOrder: ['skills', 'custom_a'], custom: [{ id: 'custom_a', title: 'Awards', items: [] }, { id: 'custom_b', title: 'Other', items: [] }] })).toEqual(['skills', 'custom_a', 'custom_b'])
  })
})
