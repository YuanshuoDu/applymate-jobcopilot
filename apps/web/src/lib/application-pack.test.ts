import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { hasCurrentApplicationPackAudit, renderApplicationPack } from './application-pack'
import type { StoredApplicationAudit } from './application-audit'
import type { CoverLetter, Resume } from './types'

const revision = '2026-11-02T09:00:00.000Z'
const audit: StoredApplicationAudit = {
  resumeId: 'resume_1', coverLetterId: 'letter_1', resumeUpdatedAt: revision, coverLetterUpdatedAt: revision,
  audit: {
    verdict: 'pass', matchScore: 90, source: 'parent_resume', summary: 'Supported.', auditedAt: revision,
    findings: [
      { area: 'resume', severity: 'pass', title: 'Supported', evidence: 'Source facts', action: 'None' },
      { area: 'cover_letter', severity: 'pass', title: 'Supported', evidence: 'Source facts', action: 'None' },
    ],
  },
}
const resume = {
  id: 'resume_1', name: 'Sample Candidate', updatedAt: revision, createdAt: revision, templateId: 'clean', templateOptions: {},
  isDefault: true, directionId: null, kind: 'base', parentResumeId: null, targetJobId: 'job_1', origin: 'manual', basicsDetached: false,
  content: { contact: { name: 'Sample Candidate', email: 'sample@example.test', location: 'Dublin' }, summary: 'Builds useful software.', experience: [], education: [], skills: ['TypeScript'] },
} as Resume
const letter = { id: 'letter_1', updatedAt: revision, content: 'Dear Hiring Team,\n\nI build useful software.' } as CoverLetter
const job = { id: 'job_1', company: 'Example / Company', role: 'Engineer', url: 'https://example.test/job', finalResumeId: 'resume_1', finalCoverLetterId: 'letter_1' }

describe('application pack audit revisions', () => {
  it('accepts equivalent ISO and database Date revisions', () => {
    expect(hasCurrentApplicationPackAudit(audit, job, { ...resume, updatedAt: new Date(revision) }, letter)).toBe(true)
  })

  it('rejects invalid or missing revision timestamps', () => {
    expect(hasCurrentApplicationPackAudit({ ...audit, resumeUpdatedAt: 'invalid' }, job, resume, letter)).toBe(false)
    expect(hasCurrentApplicationPackAudit({ ...audit, coverLetterUpdatedAt: undefined }, job, resume, letter)).toBe(false)
  })

  it('requires factual findings for every selected document', () => {
    expect(hasCurrentApplicationPackAudit({ ...audit, audit: { ...audit.audit, findings: [] } }, job, resume, letter)).toBe(false)
    expect(hasCurrentApplicationPackAudit({ ...audit, audit: { ...audit.audit, findings: audit.audit.findings.slice(0, 1) } }, job, resume, letter)).toBe(false)
  })

  it('rejects factual warnings even if a malformed audit claims pass', () => {
    const findings = [...audit.audit.findings, { area: 'resume' as const, severity: 'warning' as const, title: 'Unsupported', evidence: 'Missing', action: 'Review' }]
    expect(hasCurrentApplicationPackAudit({ ...audit, audit: { ...audit.audit, findings } }, job, resume, letter)).toBe(false)
  })

  it('does not treat a job-fit warning as an unsupported document claim', () => {
    const findings = [...audit.audit.findings, { area: 'job_match' as const, severity: 'warning' as const, title: 'Skill gap', evidence: 'Not in profile', action: 'Consider fit' }]
    expect(hasCurrentApplicationPackAudit({ ...audit, audit: { ...audit.audit, findings } }, job, resume, letter)).toBe(true)
  })
})

describe('application ZIP rendering', () => {
  it('generates real PDF files and revision metadata without a host browser or local folder', async () => {
    const pack = await renderApplicationPack(job, resume, letter, audit)
    const zip = await JSZip.loadAsync(pack.bytes)
    expect(Object.keys(zip.files).sort()).toEqual(['CoverLetter.pdf', 'Resume.pdf', 'meta.json'])
    for (const filename of ['Resume.pdf', 'CoverLetter.pdf']) {
      const bytes = await zip.file(filename)!.async('nodebuffer')
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
      expect(bytes.length).toBeGreaterThan(1_000)
    }
    const meta = JSON.parse(await zip.file('meta.json')!.async('string'))
    expect(meta.resume).toEqual({ id: 'resume_1', updatedAt: revision })
    expect(meta.coverLetter).toEqual({ id: 'letter_1', updatedAt: revision })
    expect(pack.filename).toBe('Example - Company_Engineer_application-pack.zip')
  }, 30_000)

  it('creates an explicitly resume-only ZIP without a fabricated cover letter', async () => {
    const pack = await renderApplicationPack(job, resume, null, { ...audit, coverLetterId: null })
    const zip = await JSZip.loadAsync(pack.bytes)
    expect(Object.keys(zip.files).sort()).toEqual(['Resume.pdf', 'meta.json'])
    expect(JSON.parse(await zip.file('meta.json')!.async('string')).coverLetter).toBeNull()
  }, 30_000)
})
