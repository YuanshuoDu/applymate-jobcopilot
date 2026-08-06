import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const globalCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8')
const resumeCss = readFileSync(new URL('./ResumePage.css', import.meta.url), 'utf8')

describe('tablet and phone layout safeguards', () => {
  it('stacks settings controls while the desktop sidebar is still present', () => {
    expect(globalCss).toMatch(/@media \(max-width: 900px\)[\s\S]*\.settings-workspace[\s\S]*\.settings-profile-grid/)
  })

  it('wraps resume actions instead of hiding them in a horizontal strip', () => {
    expect(resumeCss).toMatch(/@media \(max-width: 680px\)[\s\S]*\.resume-library-toolbar[\s\S]*flex-wrap:\s*wrap/)
  })
})
