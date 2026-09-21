import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const globalCss = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8')
const resumeCss = readFileSync(new URL('./ResumePage.css', import.meta.url), 'utf8')
const resumePageSource = readFileSync(new URL('./ResumePage.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8')

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
    expect(resumeCss).toMatch(/grid-template-columns:[^;]*var\(--resume-ai-width, 380px\)/)
    expect(resumeCss).toMatch(/\.resume-ai-resize-handle[\s\S]*cursor:\s*col-resize/)
    expect(resumeCss).toMatch(/@media \(max-width: 960px\)[\s\S]*\.resume-ai-resize-handle\s*\{\s*display:\s*none/)
  })

  it('uses an A4 editor paper on desktop and releases the fixed page shape responsively', () => {
    expect(resumeCss).toMatch(/\.resume-paper\s*\{[\s\S]*width:\s*100%[\s\S]*max-width:\s*794px[\s\S]*min-height:\s*1123px[\s\S]*aspect-ratio:\s*794\s*\/\s*1123/)
    expect(resumeCss).toMatch(/@media \(max-width: 960px\)[\s\S]*\.resume-paper\s*\{[\s\S]*min-height:\s*0[\s\S]*aspect-ratio:\s*auto/)
    expect(resumePageSource).toContain('const A4_W = 794')
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

  it('floats the collapsed account menu without expanding the sidebar', () => {
    expect(sidebarSource).toContain('className="app-sidebar-account-menu"')
    expect(sidebarSource).toContain("' is-account-menu-open'")
    expect(globalCss).toMatch(/\.app-sidebar\.is-collapsed\.is-account-menu-open\s*\{[\s\S]*z-index:\s*120/)
    expect(globalCss).toMatch(/\.app-sidebar\.is-collapsed\.is-account-menu-open \.app-sidebar-account-menu\s*\{[\s\S]*left:\s*0[\s\S]*right:\s*auto[\s\S]*width:\s*300px[\s\S]*max-width:\s*calc\(100vw - 24px\)/)
    expect(globalCss).not.toMatch(/\.app-sidebar\.is-collapsed\.is-account-menu-open\s*\{[\s\S]*width:\s*var\(--sidebar-w\)/)
    expect(globalCss).toMatch(/\.app-sidebar-account-menu-item\s*\{[\s\S]*white-space:\s*nowrap/)
  })

  it('uses a stable one-pixel selected resume border', () => {
    expect(resumeCss).toMatch(/\.resume-library-item\s*\{[\s\S]*border:\s*1px solid var\(--border\)/)
    expect(resumeCss).toMatch(/\.resume-library-item\.is-selected\s*\{[\s\S]*border-width:\s*1px !important/)
  })

  it('gives the resume editor title and formatting toolkit a clear hierarchy', () => {
    expect(resumePageSource).toContain('className="resume-workspace-title-copy"')
    expect(resumePageSource).toContain('className="resume-format-toolbar"')
    expect(resumePageSource).toContain('role="toolbar"')
    expect(resumePageSource).toContain('aria-label={tool.title}')
    expect(resumeCss).toMatch(/\.resume-workspace-title-copy\s*\{[\s\S]*display:\s*grid/)
    expect(resumeCss).toMatch(/\.resume-format-toolbar\s*\{[\s\S]*display:\s*flex/)
    expect(resumeCss).toMatch(/\.resume-format-group\s*\{[\s\S]*border:/)
  })

  it('aligns editor chrome to the A4 paper and stages the left-collapse motion', () => {
    expect(resumePageSource).toContain('className="resume-editor-content"')
    expect(resumePageSource).toContain('className="resume-completeness"')
    expect(resumePageSource).toContain('className="resume-workspace-preview-icon"')
    expect(resumeCss).toMatch(/\.resume-editor-content\s*\{[\s\S]*width:\s*100%[\s\S]*max-width:\s*794px/)
    expect(resumeCss).toMatch(/\.resume-completeness\s*\{[\s\S]*width:\s*100%/)
    expect(resumeCss).toMatch(/\.resume-workspace-preview-button\s*\{[\s\S]*min-width:\s*108px[\s\S]*min-height:\s*40px/)
    expect(resumeCss).toMatch(/\.resume-library-layout\.is-library-collapsing\s*\{[\s\S]*transition:\s*grid-template-columns/)
    expect(resumePageSource).toContain('RESUME_LIBRARY_COLLAPSE_ANIMATION_MS')
    expect(resumePageSource).toContain('MAIN_NAV_COLLAPSE_DELAY_MS')
    expect(resumePageSource).toContain('scheduleSidebarCollapse')
  })
})
