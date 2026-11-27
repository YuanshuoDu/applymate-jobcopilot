import type { Lang } from '@/lib/i18n'
import type { ComposerMessage } from './agent-turn-commands'
import type { TimelineSteeringMarkerState } from './v2/timeline-steering-markers'

const LABELS: Record<Lang, string> = {
  en: 'Applied to plan · revision {revision}',
  de: 'Auf den Plan angewendet · Revision {revision}',
  fr: 'Appliqué au plan · révision {revision}',
  es: 'Aplicado al plan · revisión {revision}',
  nl: 'Toegepast op het plan · revisie {revision}',
  zh: '已应用到计划 · 版本 {revision}',
}

export function appliedPlanRevisionForMessage(
  message: ComposerMessage,
  sessionId: string,
  markers: TimelineSteeringMarkerState['applied'] | undefined,
): number | null {
  if (message.delivery !== 'steer' || !message.inputId || !message.turnId) return null
  const matches = markers?.filter(marker =>
    marker.kind === 'applied' && marker.status === 'applied'
    && marker.sessionId === sessionId && marker.turnId === message.turnId && marker.inputId === message.inputId
    && marker.planRevision !== null && Number.isSafeInteger(marker.planRevision) && marker.planRevision > 0,
  ) ?? []
  return matches.length === 1 ? matches[0]!.planRevision : null
}

export function selectedSessionAppliedSteeringMarkers(options: {
  readonly selectedSessionId: string | null
  readonly composerSessionId: string | null
  readonly timelineSessionId: string | null
  readonly restoring: boolean
  readonly applied: TimelineSteeringMarkerState['applied'] | undefined
}): TimelineSteeringMarkerState['applied'] | undefined {
  if (!options.selectedSessionId || options.restoring
    || options.selectedSessionId !== options.composerSessionId
    || options.selectedSessionId !== options.timelineSessionId) return undefined
  return options.applied
}

export function appliedSteerStatusLabel(revision: number, lang: Lang): string | null {
  if (!Number.isSafeInteger(revision) || revision < 1) return null
  return LABELS[lang].replace('{revision}', String(revision))
}
