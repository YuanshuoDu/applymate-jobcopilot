import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./CoverLetterPanel.tsx', import.meta.url), 'utf8')

describe('CoverLetterPanel autosave contract', () => {
  it('does not expose manual save or set-final actions', () => {
    expect(source).not.toContain('onClick={handleSave}')
    expect(source).not.toContain('handleSetFinal')
    expect(source).not.toContain('onFinalized')
  })

  it('debounces edits and associates generated letters with the active resume', () => {
    expect(source).toContain('}, 900)')
    expect(source).toContain('...(resumeId ? { resumeId } : {})')
    expect(source).toContain('coverLetter.panel.autosaveFailed')
  })

  it('keeps the selected letter scope when reloading cannot read that draft', () => {
    const selectedLetterGuard = "if (job.finalCoverLetterId && !list.some(cl => cl.id === job.finalCoverLetterId)) throw new Error('Unavailable')"
    const retainedLetterGuard = "if (retainedId && !list.some(cl => cl.id === retainedId)) throw new Error('Unavailable')"
    const selectedGuardIndex = source.indexOf(selectedLetterGuard)
    const retainedGuardIndex = source.indexOf(retainedLetterGuard)
    const applyLoadedListIndex = source.indexOf('setCoverLetters(list)')

    expect(selectedGuardIndex).toBeGreaterThanOrEqual(0)
    expect(retainedGuardIndex).toBeGreaterThan(selectedGuardIndex)
    expect(applyLoadedListIndex).toBeGreaterThan(retainedGuardIndex)

    const failureStart = source.indexOf('      .catch(() => {', applyLoadedListIndex)
    const failureEnd = source.indexOf('      .finally(() => {', failureStart)
    const failureState = source.slice(failureStart, failureEnd)
    expect(failureState).toContain('showUnavailable()')
    expect(failureState).not.toContain('list[0]')
    expect(source).toContain("t(job.finalCoverLetterId ? 'application.selectedLetterUnavailable' : 'toast.requestFailed')")
    expect(source).toContain('onClick={() => setReload(value => value + 1)}')
  })
})
