import type { ExtensionSettings, SavedJob, ScrapedJob } from '../src/lib/types'
import type { DashboardSnapshot, PersonaField, PersonaProfile } from '../src/lib/api'

// Fictional, in-memory data only. This is not an account or an authentication token.
export const sampleSettings: ExtensionSettings = {
  apiBaseUrl: 'https://applymate.site', apiToken: 'preview-only-invalid-token',
  userEmail: 'alex@example.invalid', userName: 'Alex Morgan', autoSave: false,
}

export const sampleJob: ScrapedJob = {
  title: 'Frontend Engineer', company: 'Example Studio', location: 'Remote',
  description: 'Build accessible web interfaces with React and TypeScript. Collaborate with product and design, review code, and improve the experience of a small, fictional application.',
  salary: null, source: 'unknown', url: 'https://example.invalid/careers/frontend-engineer',
}

export const sampleJobs: SavedJob[] = [
  ['sample-1', 'Example Studio', 'Frontend Engineer', 'saved', 88],
  ['sample-2', 'Demo Research', 'Product Engineer', 'applied', 82],
  ['sample-3', 'Sample Works', 'UI Engineer', 'interview', 91],
  ['sample-4', 'Example Systems', 'Software Engineer', 'saved', null],
].map(([id, company, role, status, score], index) => ({
  id: String(id), company: String(company), role: String(role),
  status: status as SavedJob['status'], score: score as number | null,
  location: 'Remote', salary: null, notes: null, source: 'unknown',
  createdAt: new Date(Date.UTC(2026, 10, 2 - index, 10)).toISOString(),
  url: index === 0 ? sampleJob.url : `https://example.invalid/careers/sample-${index}`,
  finalResumeId: null, finalCoverLetterId: null,
}))

export const sampleDashboard: DashboardSnapshot = {
  stats: { total: 4, saved: 2, applied: 1, interviews: 1, offers: 0, rejected: 0, thisWeek: 2 },
  minMatchScore: 75, hasResume: true, followUpsDue: [],
}

export const sampleProfile: PersonaProfile = {
  identity: ['Alex Morgan', 'alex@example.invalid', 'Remote'],
  preferences: ['Frontend or product engineering', 'Remote roles'],
  summaries: ['Frontend engineer working with accessible web interfaces.'],
  experience: ['Frontend Engineer · Example Studio · 2023–2026'],
  skills: ['React', 'TypeScript', 'Accessibility', 'CSS'],
  languages: ['English'], education: ['BSc Computer Science · Example University'],
  certifications: [], projects: [], sourceResumeCount: 1,
}

export const sampleFields: PersonaField[] = [
  { key: 'full_name', category: 'personal', label: 'Full name', value: 'Alex Morgan' },
  { key: 'email', category: 'contact', label: 'Email', value: 'alex@example.invalid' },
  { key: 'preferred_role', category: 'preferences', label: 'Preferred role', value: 'Frontend Engineer' },
].map(field => ({ ...field, confidence: 1, source: 'manual', updatedAt: '2026-11-02T10:00:00Z', consentAt: '2026-11-02T10:00:00Z' }))

export function previewMessage(type: string): unknown {
  if (type === 'GET_RECENT_JOBS') return { jobs: sampleJobs }
  if (type === 'GET_STATS') return { stats: sampleDashboard.stats }
  if (type === 'GET_CURRENT_JOB') return { type: 'CURRENT_JOB_RESULT', job: sampleJob }
  return { success: false, error: 'Component preview only. Install ApplyMate to use this action.' }
}
