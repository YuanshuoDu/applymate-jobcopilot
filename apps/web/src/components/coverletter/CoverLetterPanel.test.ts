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
})
