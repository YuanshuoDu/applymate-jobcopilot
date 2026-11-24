import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildObjectiveApplicationResumeWitness } from '@jobcopilot/shared'
import { readObjectiveApplicationResumeWitness } from './objective-application-resume-witness'

const state = vi.hoisted(() => ({ events: [] as string[], query: vi.fn() }))
const tx = { $queryRaw: state.query } as unknown as Parameters<typeof readObjectiveApplicationResumeWitness>[0]

const material = {
  name: 'Tailored resume',
  content: { basics: { name: 'Candidate' }, experience: [{ company: 'A' }] },
  templateId: 'modern',
  templateOptions: { accentColor: 'blue' },
  kind: 'adapted',
  targetJobId: 'job-1',
  parentResumeId: 'base-1',
  basicsDetached: false,
}
const row = {
  jobId: 'job-1', userId: 'user-1', finalResumeId: 'resume-1', finalResumeAssignmentRevision: 3,
  resumeId: 'resume-1', resumeUserId: 'user-1', ...material, materialRevision: 2,
}

describe('objective application Resume witness reader', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    state.events.length = 0
    state.query.mockImplementation(async () => { state.events.push('locked-read'); return [row] })
  })

  it('locks one owner-scoped Job-to-Resume snapshot and builds a closed witness', async () => {
    const result = await readObjectiveApplicationResumeWitness(tx, { userId: 'user-1', jobId: 'job-1' })
    expect(result).toEqual(buildObjectiveApplicationResumeWitness({
      userId: 'user-1', jobId: 'job-1', resumeId: 'resume-1',
      finalResumeAssignmentRevision: 3, materialRevision: 2, material,
    }))
    expect(result).not.toHaveProperty('content')
    expect(state.events).toEqual(['locked-read'])
    expect(state.query).toHaveBeenCalledOnce()
    const sql = state.query.mock.calls[0][0].join('?') as string
    expect(sql).toContain('INNER JOIN "Resume"')
    expect(sql).toContain('resume."userId" = job."userId"')
    expect(sql).toContain('resume."targetJobId" = job."id"')
    expect(sql).toContain("resume.\"kind\" = 'adapted'")
    expect(sql).toContain('WHERE job."id" = ? AND job."userId" = ?')
    expect(sql).toContain('FOR SHARE OF job, resume')
    expect(state.query.mock.calls[0].slice(1)).toEqual(['job-1', 'user-1'])
  })

  it('returns null for missing rows and invalid scope without leaking a broader read', async () => {
    state.query.mockResolvedValueOnce([])
    await expect(readObjectiveApplicationResumeWitness(tx, { userId: 'user-1', jobId: 'job-1' })).resolves.toBeNull()
    await expect(readObjectiveApplicationResumeWitness(tx, { userId: '', jobId: 'job-1' })).resolves.toBeNull()
    expect(state.query).toHaveBeenCalledOnce()
  })

  it('rejects noncanonical scope identifiers before reading', async () => {
    await expect(readObjectiveApplicationResumeWitness(tx, { userId: ' user-1 ', jobId: 'job-1' })).resolves.toBeNull()
    expect(state.query).not.toHaveBeenCalled()
  })

  it('fails closed for inconsistent owner, target, pointer, role, or revision fields', async () => {
    for (const invalid of [
      { ...row, jobId: 'job-2' },
      { ...row, userId: 'user-2' },
      { ...row, resumeUserId: 'user-2' },
      { ...row, resumeId: 'resume-2' },
      { ...row, targetJobId: 'job-2' },
      { ...row, kind: 'base' },
      { ...row, finalResumeAssignmentRevision: -1 },
      { ...row, materialRevision: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      state.query.mockResolvedValueOnce([invalid])
      await expect(readObjectiveApplicationResumeWitness(tx, { userId: 'user-1', jobId: 'job-1' })).resolves.toBeNull()
    }
  })
})
