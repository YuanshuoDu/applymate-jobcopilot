import React from 'react'
import type { ObjectiveTailorFinalOutcomeSidecarStatus } from '@jobcopilot/agent-protocol'
import { parseObjectiveTailorFinalOutcomesFromContent } from '@/lib/agent/session/objective-tailor-final-content'
import type { Lang } from '@/lib/i18n'

const LABELS: Record<ObjectiveTailorFinalOutcomeSidecarStatus, Readonly<{ en: string; zh: string }>> = {
  ready: { en: 'Ready', zh: '已就绪' },
  needs_revision: { en: 'Needs revision', zh: '需要修改' },
  rejected: { en: 'Rejected', zh: '未通过' },
  stale: { en: 'Out of date', zh: '已过期' },
  failed: { en: 'Failed', zh: '失败' },
}

export function ObjectiveTailorFinalOutcomes({ content, lang }: { content: unknown; lang: Lang }) {
  const sidecar = parseObjectiveTailorFinalOutcomesFromContent(content)
  if (!sidecar) return null
  const heading = lang === 'zh' ? '职位定制结果' : 'Tailoring outcomes'
  const job = lang === 'zh' ? '职位' : 'Job'
  return <details aria-label={heading} data-agent-objective-tailor-final-outcomes="true">
    <summary>{heading}</summary>
    <ul>{sidecar.slots.map(slot => <li key={slot.ordinal} data-tailor-outcome={slot.status}>
      {job} {slot.ordinal}: {LABELS[slot.status][lang === 'zh' ? 'zh' : 'en']}
    </li>)}</ul>
  </details>
}
