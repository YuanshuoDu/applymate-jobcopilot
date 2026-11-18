import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ScheduledSourceChangeRecoveryNotice } from './ScheduledSourceChangeRecoveryNotice'

const mocks = vi.hoisted(() => ({ lang: 'en' as 'en' | 'de' | 'fr' | 'es' | 'nl' | 'zh' }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: mocks.lang }) }))

describe('scheduled source-change recovery notice', () => {
  it('explains the explicit next step while waiting and after Stop', () => {
    mocks.lang = 'en'
    const waiting = renderToStaticMarkup(<ScheduledSourceChangeRecoveryNotice
      reason="scheduled_pipeline_source_changed" turnStatus="waiting_for_dependency" />)
    const stopped = renderToStaticMarkup(<ScheduledSourceChangeRecoveryNotice
      reason="scheduled_pipeline_source_changed" turnStatus={undefined} />)

    expect(waiting).toContain('Stop this run')
    expect(waiting).toContain('Run Now')
    expect(waiting).toContain('current settings')
    expect(waiting).not.toMatch(/<button|<a\b|<form/)
    expect(stopped).not.toContain('Stop this run')
    expect(stopped).toContain('Run Now')
    expect(stopped).toContain('current settings')
    expect(stopped).not.toMatch(/<button|<a\b|<form/)
  })

  it('localizes the fixed guidance in every supported language', () => {
    const expected = new Map([
      ['en', 'source material changed'], ['de', 'Quelldaten geändert'], ['fr', 'données source ont changé'],
      ['es', 'datos de origen'], ['nl', 'bronmateriaal is gewijzigd'], ['zh', '来源材料发生变化'],
    ] as const)
    for (const [lang, phrase] of expected) {
      mocks.lang = lang
      const markup = renderToStaticMarkup(<ScheduledSourceChangeRecoveryNotice
        reason="scheduled_pipeline_source_changed" turnStatus={undefined} />)
      expect(markup).toContain(phrase)
      expect(markup).toContain('role="status"')
      expect(markup).not.toContain('scheduled_pipeline_source_changed')
    }
  })

  it('explains fresh preparation and current auto-apply and approval settings for material drift', () => {
    const expected = new Map([
      ['en', 'new Turn in this session'], ['de', 'neuen Turn'], ['fr', 'nouveau Turn'],
      ['es', 'Turn nuevo'], ['nl', 'nieuwe Turn'], ['zh', '同一会话中新建一个 Turn'],
    ] as const)
    const settings = new Map([
      ['en', 'auto-apply and approval settings'], ['de', 'automatische Bewerbungen und Genehmigungen'],
      ['fr', 'candidatures automatiques et les validations'], ['es', 'solicitudes automáticas y aprobaciones'],
      ['nl', 'automatisch solliciteren en goedkeuring'], ['zh', '自动申请和审批设置'],
    ] as const)
    for (const [lang, phrase] of expected) {
      mocks.lang = lang
      const waiting = renderToStaticMarkup(<ScheduledSourceChangeRecoveryNotice
        reason="scheduled_prepare_material_source_changed" turnStatus="waiting_for_dependency" />)
      const stopped = renderToStaticMarkup(<ScheduledSourceChangeRecoveryNotice
        reason="scheduled_prepare_material_source_changed" turnStatus={undefined} />)
      for (const markup of [waiting, stopped]) {
        expect(markup).toContain(phrase)
        expect(markup).toContain(settings.get(lang))
        expect(markup).not.toMatch(/<button|<a\b|<form/)
        expect(markup).not.toContain('scheduled_prepare_material_source_changed')
      }
      expect(waiting).toContain('role="status"')
      expect(stopped).toContain('role="status"')
    }
    mocks.lang = 'en'
    const waiting = renderToStaticMarkup(<ScheduledSourceChangeRecoveryNotice
      reason="scheduled_prepare_material_source_changed" turnStatus="waiting_for_dependency" />)
    expect(waiting).toContain('Stop this run')
    expect(waiting).toContain('prepares the material again')
  })

  it('renders no action or notice for other reasons', () => {
    mocks.lang = 'en'
    const markup = renderToStaticMarkup(<ScheduledSourceChangeRecoveryNotice
      reason={null} turnStatus="waiting_for_dependency" />)
    expect(markup).toBe('')
    expect(markup).not.toMatch(/<button|<a\b|<form/)
  })
})
