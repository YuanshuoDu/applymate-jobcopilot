import React from 'react'
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA, type ObjectiveTailorFinalOutcomeSidecarStatus, type ObjectiveTailorFinalOutcomeSidecarV2 } from '@jobcopilot/agent-protocol'
import { parseObjectiveTailorFinalOutcomesFromContent } from '@/lib/agent/session/objective-tailor-final-content'
import type { Lang } from '@/lib/i18n'

const LABELS: Record<ObjectiveTailorFinalOutcomeSidecarStatus, Readonly<{ en: string; zh: string }>> = {
  ready: { en: 'Ready', zh: '已就绪' },
  needs_revision: { en: 'Needs revision', zh: '需要修改' },
  rejected: { en: 'Rejected', zh: '未通过' },
  stale: { en: 'Out of date', zh: '已过期' },
  failed: { en: 'Failed', zh: '失败' },
}

function sourceCountLabel(count: ObjectiveTailorFinalOutcomeSidecarV2['sourceCounts']['discoveredJobs'], lang: Lang) {
  if (count.coverage === 'unavailable') return lang === 'zh' ? '不可用' : 'Unavailable'
  if (count.coverage === 'not_requested') return lang === 'zh' ? '未请求' : 'Not requested'
  if (count.coverage === 'partial') return lang === 'zh'
    ? `至少 ${count.knownCount}（部分覆盖）`
    : `At least ${count.knownCount} (partial coverage)`
  return lang === 'zh' ? `${count.knownCount}（完整覆盖）` : `${count.knownCount} (complete coverage)`
}

export function ObjectiveTailorFinalOutcomes({ content, lang }: { content: unknown; lang: Lang }) {
  const sidecar = parseObjectiveTailorFinalOutcomesFromContent(content)
  if (!sidecar) return null
  const heading = lang === 'zh' ? '职位定制结果' : 'Tailoring outcomes'
  const job = lang === 'zh' ? '职位' : 'Job'
  const sourceCounts = sidecar.schemaVersion === OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V2_SCHEMA
    ? sidecar.sourceCounts : undefined
  return <details aria-label={heading} data-agent-objective-tailor-final-outcomes="true">
    <summary>{heading}</summary>
    {sourceCounts && <section aria-label={lang === 'zh' ? '来源统计' : 'Source counts'} data-objective-source-counts="true">
      <h3>{lang === 'zh' ? '来源统计' : 'Source counts'}</h3>
      <dl>
        <div><dt>{lang === 'zh' ? '已发现职位' : 'Found jobs'}</dt><dd>{sourceCountLabel(sourceCounts.discoveredJobs, lang)}</dd></div>
        <div><dt>{lang === 'zh' ? '已分析职位' : 'Analyzed jobs'}</dt><dd>{sourceCountLabel(sourceCounts.analyzedJobs, lang)}</dd></div>
      </dl>
    </section>}
    <ul>{sidecar.slots.map(slot => <li key={slot.ordinal} data-tailor-outcome={slot.status}>
      {job} {slot.ordinal}: {LABELS[slot.status][lang === 'zh' ? 'zh' : 'en']}
    </li>)}</ul>
  </details>
}
