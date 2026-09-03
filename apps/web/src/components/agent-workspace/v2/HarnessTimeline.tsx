'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'
import { compareItems } from './timeline-reducer-utils'
import { HarnessItem } from './HarnessItem'
import type { SuggestedActionCommand } from './harness-item-types'
import type { TimelineItem } from './timeline-reducer'

export interface HarnessTimelineProps {
  items: TimelineItem[]
  onSuggestedAction?: (command: SuggestedActionCommand) => void
}

/** Groups the normalized reducer projection into stable Turn sections. */
export function HarnessTimeline({ items, onSuggestedAction }: HarnessTimelineProps) {
  const { t } = useI18n()
  const turns = groupTurns(items)
  return (
    <div data-agent-harness-timeline="true" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {turns.map((turn, index) => {
        const finalIds = highlightedFinalItemIds(turn.items)
        return (
          <section key={turn.id} data-agent-turn-id={turn.id} style={{ display: 'grid', gap: 9 }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase' }}>{t('agent.turn')} {index + 1}</div>
            {turn.items.map(item => <HarnessItem key={item.id} item={item} highlightedFinal={finalIds.has(item.id)} onSuggestedAction={onSuggestedAction} />)}
          </section>
        )
      })}
    </div>
  )
}

export function highlightedFinalItemIds(items: TimelineItem[]): Set<string> {
  const latestByTurn = new Map<string, TimelineItem>()
  for (const item of items) {
    if (item.phase !== 'final_answer') continue
    const current = latestByTurn.get(item.turnId)
    if (!current || current.updatedAt.localeCompare(item.updatedAt) < 0 || (current.updatedAt === item.updatedAt && current.id.localeCompare(item.id) < 0)) latestByTurn.set(item.turnId, item)
  }
  return new Set([...latestByTurn.values()].map(item => item.id))
}

function groupTurns(items: TimelineItem[]): Array<{ id: string; items: TimelineItem[] }> {
  const grouped = new Map<string, TimelineItem[]>()
  for (const item of [...items].sort(compareItems)) grouped.set(item.turnId, [...(grouped.get(item.turnId) ?? []), item])
  return [...grouped].map(([id, turnItems]) => ({ id, items: turnItems }))
}
