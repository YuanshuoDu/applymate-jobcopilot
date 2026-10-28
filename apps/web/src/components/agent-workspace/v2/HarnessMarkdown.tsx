'use client'

import React from 'react'
import type { AnswerEvidence, AnswerEvidenceSource } from '@jobcopilot/agent-protocol'
import type { Lang } from '@/lib/i18n'

interface HarnessMarkdownProps {
  markdown: string
  className?: string
  style?: React.CSSProperties
  answerEvidence?: AnswerEvidence | null
  sourceDisclosureId?: string
  sourceDisclosureOpen?: boolean
  onSourceSelect?: (key: AnswerEvidenceSource['key']) => void
  lang?: Lang
}

/** Small, deliberately allow-listed Markdown renderer for model-authored text. */
export function HarnessMarkdown({ markdown, className, style, answerEvidence, sourceDisclosureId, sourceDisclosureOpen = false, onSourceSelect, lang = 'en' }: HarnessMarkdownProps) {
  const lines = markdown.split(/\r?\n/)
  const sources = answerEvidence?.sources ?? []
  return (
    <div className={className} data-markdown-safe="true" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65, ...style }}>
      {lines.map((line, index) => <MarkdownLine key={index} line={line} sources={sources} sourceDisclosureId={sourceDisclosureId} sourceDisclosureOpen={sourceDisclosureOpen} onSourceSelect={onSourceSelect} lang={lang} />)}
    </div>
  )
}

interface InlineSourceProps {
  sources: AnswerEvidenceSource[]
  sourceDisclosureId?: string
  sourceDisclosureOpen: boolean
  onSourceSelect?: (key: AnswerEvidenceSource['key']) => void
  lang: Lang
}

function MarkdownLine({ line, ...sourceProps }: { line: string } & InlineSourceProps) {
  const trimmed = line.trim()
  if (!trimmed) return <div aria-hidden="true" style={{ height: 6 }} />

  const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed)
  if (heading) {
    const Heading = heading[1].length === 1 ? 'strong' : 'span'
    return <div style={{ marginTop: 4, fontWeight: 700 }}><Heading>{renderInline(heading[2], sourceProps)}</Heading></div>
  }

  const bullet = /^(?:[-*•·])\s+(.+)$/.exec(trimmed)
  if (bullet) return <div style={{ display: 'flex', gap: 7 }}><span aria-hidden="true">•</span><span>{renderInline(bullet[1], sourceProps)}</span></div>

  const numbered = /^(\d+)\.\s+(.+)$/.exec(trimmed)
  if (numbered) return <div style={{ display: 'flex', gap: 7 }}><span aria-hidden="true">{numbered[1]}.</span><span>{renderInline(numbered[2], sourceProps)}</span></div>

  return <div>{renderInline(line, sourceProps)}</div>
}

function renderInline(value: string, sourceProps: InlineSourceProps): React.ReactNode[] {
  const tokens = /(\[\[source:[^\r\n]*?\]\]|\[\[source:[^\]\r\n]*\](?!\])|\[\[source:[^\s\]\r\n]*(?=\s|$)|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\))/g
  const result: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = tokens.exec(value))) {
    if (match.index > lastIndex) result.push(value.slice(lastIndex, match.index))
    const token = match[0]
    if (token.startsWith('[[source:')) {
      const marker = /^\[\[source:(S[1-8])\]\]$/.exec(token)
      const source = marker && sourceProps.sources.find(entry => entry.key === marker[1])
      if (sourceProps.sources.length === 0) result.push(token)
      else if (source && sourceProps.onSourceSelect && sourceProps.sourceDisclosureId) {
        result.push(<button key={`${match.index}-source`} type="button" data-agent-source-marker={source.key}
          aria-label={sourceButtonLabel(sourceProps.lang, source.key)} aria-controls={sourceProps.sourceDisclosureId}
          aria-expanded={sourceProps.sourceDisclosureOpen}
          onClick={() => sourceProps.onSourceSelect?.(source.key)}
          style={{ border: 0, padding: 0, margin: '0 2px', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 }}>
          [{source.key}]
        </button>)
      }
    } else if (token.startsWith('**')) {
      result.push(<strong key={`${match.index}-bold`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      result.push(<code key={`${match.index}-code`} style={{ padding: '1px 4px', borderRadius: 3, background: 'var(--bg-secondary)' }}>{token.slice(1, -1)}</code>)
    } else {
      const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(token)
      const href = link ? safeHref(link[2]) : null
      result.push(href && link
        ? <a key={`${match.index}-link`} href={href} target="_blank" rel="noreferrer">{link[1]}</a>
        : token)
    }
    lastIndex = match.index + token.length
  }
  if (lastIndex < value.length) result.push(value.slice(lastIndex))
  return result
}

function sourceButtonLabel(lang: Lang, key: string): string {
  const labels: Record<Lang, string> = {
    en: `Show source preview ${key}`, de: `Quellvorschau ${key} anzeigen`,
    fr: `Afficher l’aperçu de la source ${key}`, es: `Mostrar vista previa de la fuente ${key}`,
    nl: `Bronvoorbeeld ${key} tonen`, zh: `显示来源预览 ${key}`,
  }
  return labels[lang]
}

function safeHref(value: string): string | null {
  try {
    if (!/^https?:\/\//i.test(value)) return null
    const url = new URL(value, 'https://applymate.invalid')
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}
