import { describe, expect, it } from 'vitest'
import { createCoverLetterRequestGate, parseSelectedCoverLetter } from './useApplicationCoverLetters'

const letter = {
  id: 'letter_1', userId: 'user_1', jobId: 'job_1', resumeId: 'resume_1',
  content: 'Dear hiring team,', tone: 'professional', templateId: null, templateOptions: null,
  origin: 'manual', isFinal: true, createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:01:00.000Z',
}
const parse = (value: unknown, selectedId = 'letter_1') => parseSelectedCoverLetter(value, 'user_1', 'job_1', selectedId)

describe('selected cover-letter validation', () => {
  it('selects the exact owner and job without replacing it with another draft', () => {
    const other = { ...letter, id: 'other', content: 'Other draft' }
    expect(parse([other, letter])).toEqual(letter)
    expect(parse([other])).toBeNull()
  })

  it('does not reject legacy rows merely because optional metadata is absent', () => {
    const minimal = { id: 'letter_1', userId: 'user_1', jobId: 'job_1', content: '', updatedAt: '2026-10-30T10:01:00.000Z' }
    expect(parse([minimal])).toEqual(minimal)
  })

  it('accepts an empty saved body as selected, rather than substituting another document', () => {
    const empty = { ...letter, content: '' }
    expect(parse([empty])).toEqual(empty)
  })

  it.each([
    ['not an array', {}],
    ['missing selected item', []],
    ['non-object list entry', [letter, null]],
    ['entry without an id', [letter, { userId: 'user_1', jobId: 'job_1' }]],
    ['selected entry has another owner', [{ ...letter, userId: 'user_2' }]],
    ['selected entry has another job', [{ ...letter, jobId: 'job_2' }]],
    ['selected body is missing', [{ ...letter, content: undefined }]],
    ['selected body is not text', [{ ...letter, content: { text: 'value' } }]],
    ['selected version is absent', [{ ...letter, updatedAt: undefined }]],
    ['selected version is invalid', [{ ...letter, updatedAt: 'not-a-date' }]],
    ['same id appears twice', [letter, { ...letter, content: 'another value' }]],
    ['same id has an additional foreign entry', [letter, { ...letter, userId: 'user_2' }]],
  ])('rejects %s', (_reason, payload) => {
    expect(parse(payload)).toBeNull()
  })

  it('rejects an empty selected id even if the response contains a similarly malformed id', () => {
    expect(parse([{ ...letter, id: '' }], '')).toBeNull()
  })
})

describe('cover-letter request ordering', () => {
  it('cancels the first request when a new one starts and rejects a late first response', async () => {
    const gate = createCoverLetterRequestGate()
    const first = gate.start()
    let releaseOld!: () => void
    const oldResponse = new Promise<void>(resolve => { releaseOld = resolve })
    const published: string[] = []
    const oldCompletion = oldResponse.then(() => { if (first.current()) published.push('old') })
    const second = gate.start()
    await first.cancelled
    expect(first.signal.aborted).toBe(true)
    expect(first.current()).toBe(false)
    expect(second.current()).toBe(true)
    if (second.current()) published.push('new')
    releaseOld()
    await oldCompletion
    expect(published).toEqual(['new'])
    gate.cancel()
  })

  it('cancels the current request on scope change or unmount', async () => {
    const gate = createCoverLetterRequestGate()
    const request = gate.start()
    gate.cancel()
    await request.cancelled
    expect(request.signal.aborted).toBe(true)
    expect(request.current()).toBe(false)
    const next = gate.start()
    expect(next.current()).toBe(true)
    gate.cancel()
    await next.cancelled
    expect(next.current()).toBe(false)
  })
})
