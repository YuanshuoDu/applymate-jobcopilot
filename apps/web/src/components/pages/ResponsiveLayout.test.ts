import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const globalCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8')
const resumeCss = readFileSync(new URL('./ResumePage.css', import.meta.url), 'utf8')
const resumePageSource = readFileSync(new URL('./ResumePage.tsx', import.meta.url), 'utf8')

describe('tablet and phone layout safeguards', () => {
  it('stacks settings controls while the desktop sidebar is still present', () => {
    expect(globalCss).toMatch(/@media \(max-width: 900px\)[\s\S]*\.settings-workspace[\s\S]*\.settings-profile-grid/)
  })

  it('wraps resume actions instead of hiding them in a horizontal strip', () => {
    expect(resumeCss).toMatch(/@media \(max-width: 680px\)[\s\S]*\.resume-library-toolbar[\s\S]*flex-wrap:\s*wrap/)
  })

  it('keeps the global navigation collapsible on desktop', () => {
    expect(globalCss).toMatch(/\.app-sidebar\.is-collapsed\s*\{[\s\S]*width:\s*64px/)
    expect(globalCss).toMatch(/\.app-sidebar\.is-collapsed \.app-nav-label[\s\S]*display:\s*none/)
  })

  it('exposes a draggable AI panel divider while keeping it hidden on narrow layouts', () => {
    expect(resumeCss).toMatch(/grid-template-columns:[^;]*var\(--resume-ai-width, 340px\)/)
    expect(resumeCss).toMatch(/\.resume-ai-resize-handle[\s\S]*cursor:\s*col-resize/)
    expect(resumeCss).toMatch(/@media \(max-width: 960px\)[\s\S]*\.resume-ai-resize-handle\s*\{\s*display:\s*none/)
  })

  it('uses a nested draggable resume-list divider and removes the old hide button', () => {
    expect(resumeCss).toMatch(/grid-template-columns:[^;]*var\(--resume-library-width, 230px\)/)
    expect(resumeCss).toMatch(/\.resume-library-resize-handle[\s\S]*cursor:\s*col-resize/)
    expect(resumeCss).toMatch(/@media \(max-width: 960px\)[\s\S]*\.resume-library-resize-handle\s*\{\s*display:\s*none/)
    expect(resumePageSource).toContain('onToggleSidebar')
    expect(resumePageSource).toContain("t('resume.resizeLibrary')")
    expect(resumePageSource).not.toContain('className="resume-library-collapse"')
  })

  it('places the main navigation toggle on the sidebar edge', () => {
    expect(globalCss).toMatch(/\.app-sidebar-toggle\s*\{[\s\S]*position:\s*absolute[\s\S]*right:\s*-14px/)
  })

  it('uses a stable one-pixel selected resume border', () => {
    expect(resumeCss).toMatch(/\.resume-library-item\s*\{[\s\S]*border:\s*1px solid var\(--border\)/)
    expect(resumeCss).toMatch(/\.resume-library-item\.is-selected\s*\{[\s\S]*border-width:\s*1px !important/)
  })
})
