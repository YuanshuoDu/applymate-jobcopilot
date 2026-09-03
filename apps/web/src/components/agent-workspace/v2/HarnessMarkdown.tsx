'use client'

import React from 'react'

interface HarnessMarkdownProps {
  markdown: string
  className?: string
  style?: React.CSSProperties
}

/** Small, deliberately allow-listed Markdown renderer for model-authored text. */
export function HarnessMarkdown({ markdown, className, style }: HarnessMarkdownProps) {
  const lines = markdown.split(/\r?\n/)
  return (
    <div className={className} data-markdown-safe="true" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65, ...style }}>
      {lines.map((line, index) => <MarkdownLine key={index} line={line} />)}
    </div>
  )
}

function MarkdownLine({ line }: { line: string }) {
  const trimmed = line.trim()
  if (!trimmed) return <div aria-hidden="true" style={{ height: 6 }} />

  const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed)
  if (heading) {
    const Heading = heading[1].length === 1 ? 'strong' : 'span'
    return <div style={{ marginTop: 4, fontWeight: 700 }}><Heading>{renderInline(heading[2])}</Heading></div>
  }

  const bullet = /^(?:[-*•·])\s+(.+)$/.exec(trimmed)
  if (bullet) return <div style={{ display: 'flex', gap: 7 }}><span aria-hidden="true">•</span><span>{renderInline(bullet[1])}</span></div>

  const numbered = /^(\d+)\.\s+(.+)$/.exec(trimmed)
  if (numbered) return <div style={{ display: 'flex', gap: 7 }}><span aria-hidden="true">{numbered[1]}.</span><span>{renderInline(numbered[2])}</span></div>

  return <div>{renderInline(line)}</div>
}

function renderInline(value: string): React.ReactNode[] {
  const tokens = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\))/g
  const result: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = tokens.exec(value))) {
    if (match.index > lastIndex) result.push(value.slice(lastIndex, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
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

function safeHref(value: string): string | null {
  try {
    if (!/^https?:\/\//i.test(value)) return null
    const url = new URL(value, 'https://applymate.invalid')
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}
