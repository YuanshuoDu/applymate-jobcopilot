'use client'

import React from 'react'
import type { Lang } from '@/lib/i18n'
import { useI18n } from '@/lib/i18n'

export type SubmissionStopOutcome = 'stop_requested' | 'too_late' | 'submitted' | 'uncertain'
type Feedback = Readonly<{ target: string; outcome: SubmissionStopOutcome }>
type Labels = Readonly<{ button: string; pending: string; previous: string; outcomes: Record<SubmissionStopOutcome, string> }>

const TARGET_PATTERN = /^ast1_[a-f0-9]{64}$/
const LABELS: Record<Lang, Labels> = {
  en: { button: 'Stop submission', pending: 'Recording Stop…', previous: 'Previous attempt', outcomes: {
    stop_requested: 'Stop recorded', too_late: 'Too late to stop', submitted: 'Already submitted (confirmed evidence)', uncertain: 'Outcome uncertain; refresh to check',
  } },
  de: { button: 'Einreichung stoppen', pending: 'Stopp wird erfasst…', previous: 'Vorheriger Versuch', outcomes: {
    stop_requested: 'Stopp erfasst', too_late: 'Zu spät zum Stoppen', submitted: 'Bereits eingereicht (bestätigter Nachweis)', uncertain: 'Ergebnis ungewiss; bitte aktualisieren',
  } },
  fr: { button: 'Arrêter l’envoi', pending: 'Arrêt en cours…', previous: 'Tentative précédente', outcomes: {
    stop_requested: 'Arrêt enregistré', too_late: 'Trop tard pour arrêter', submitted: 'Déjà envoyé (preuve confirmée)', uncertain: 'Résultat incertain ; actualisez pour vérifier',
  } },
  es: { button: 'Detener el envío', pending: 'Registrando la detención…', previous: 'Intento anterior', outcomes: {
    stop_requested: 'Detención registrada', too_late: 'Es demasiado tarde para detenerlo', submitted: 'Ya enviado (evidencia confirmada)', uncertain: 'Resultado incierto; actualiza para comprobarlo',
  } },
  nl: { button: 'Verzending stoppen', pending: 'Stop wordt vastgelegd…', previous: 'Vorige poging', outcomes: {
    stop_requested: 'Stop vastgelegd', too_late: 'Te laat om te stoppen', submitted: 'Al verzonden (bevestigd bewijs)', uncertain: 'Uitkomst onzeker; vernieuw om dit te controleren',
  } },
  zh: { button: '停止提交', pending: '正在记录停止请求…', previous: '上一次尝试', outcomes: {
    stop_requested: '已记录停止请求', too_late: '已错过停止时机', submitted: '已提交（有确认凭据）', uncertain: '结果不确定；请刷新查看',
  } },
}

export function isSubmissionStopTarget(value: unknown): value is string {
  return typeof value === 'string' && TARGET_PATTERN.test(value)
}

export function parseSubmissionStopOutcome(value: unknown): SubmissionStopOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 1 || !Object.hasOwn(row, 'outcome')) return null
  return row.outcome === 'stop_requested' || row.outcome === 'too_late' || row.outcome === 'submitted' || row.outcome === 'uncertain'
    ? row.outcome : null
}

export function submissionStopFeedback(feedback: Feedback | null, currentTarget: unknown) {
  const hasDifferentAttempt = isSubmissionStopTarget(currentTarget) && feedback?.target !== currentTarget
  return feedback ? { outcome: feedback.outcome, previous: hasDifferentAttempt } : null
}

export function submissionStopMessage(outcome: SubmissionStopOutcome, lang: Lang, previous = false): string {
  const labels = LABELS[lang] ?? LABELS.en
  const message = labels.outcomes[outcome]
  return previous ? `${labels.previous}: ${message}` : message
}

export async function postSubmissionStop(
  sessionId: string, applicationTaskId: string, target: unknown, fetcher: typeof fetch = fetch,
): Promise<SubmissionStopOutcome | null> {
  if (!isSubmissionStopTarget(target)) return null
  try {
    const response = await fetcher('/api/agent/application-tasks/submission-stop', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, applicationTaskId, expectedAttemptTarget: target }),
    })
    const body: unknown = await response.json().catch(() => null)
    return response.ok ? parseSubmissionStopOutcome(body) ?? 'uncertain' : 'uncertain'
  } catch { return 'uncertain' }
}

export async function postSubmissionStopAndRefresh(
  sessionId: string, applicationTaskId: string, target: unknown, onOutcome: (outcome: SubmissionStopOutcome) => void,
  onRefresh?: () => void | Promise<unknown>, fetcher: typeof fetch = fetch,
): Promise<SubmissionStopOutcome | null> {
  const outcome = await postSubmissionStop(sessionId, applicationTaskId, target, fetcher)
  if (!outcome) return null
  onOutcome(outcome)
  try { await onRefresh?.() } catch { /* Keep the command result visible if the refresh fails. */ }
  return outcome
}

export function SubmissionStopControl({
  sessionId, applicationTaskId, eligible, target, onRefresh,
}: {
  sessionId: string; applicationTaskId: string; eligible: boolean; target?: string | null; onRefresh?: () => void | Promise<unknown>
}) {
  const { lang } = useI18n()
  const [feedback, setFeedback] = React.useState<Feedback | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const inFlight = React.useRef(false)
  const lastAttemptedTarget = React.useRef<string | null>(null)
  const currentTarget = isSubmissionStopTarget(target) ? target : null
  const currentFeedback = submissionStopFeedback(feedback, currentTarget)
  const canStop = eligible && currentTarget !== null
  if (!canStop && !currentFeedback) return null

  async function requestStop() {
    if (!canStop || !currentTarget || inFlight.current || lastAttemptedTarget.current === currentTarget) return
    const attemptedTarget = currentTarget
    inFlight.current = true
    lastAttemptedTarget.current = attemptedTarget
    setSubmitting(true)
    await postSubmissionStopAndRefresh(sessionId, applicationTaskId, attemptedTarget,
      outcome => setFeedback({ target: attemptedTarget, outcome }), onRefresh)
    inFlight.current = false
    setSubmitting(false)
  }

  const labels = LABELS[lang] ?? LABELS.en
  return <div style={controlStyle}>
    {canStop && <button type="button" disabled={submitting || feedback?.target === currentTarget}
      onClick={() => { void requestStop() }} style={buttonStyle}>
      {submitting ? labels.pending : labels.button}
    </button>}
    {currentFeedback && <div role="status" aria-live="polite" style={statusStyle}>
      {submissionStopMessage(currentFeedback.outcome, lang, currentFeedback.previous)}
    </div>}
  </div>
}

const controlStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, flexShrink: 0 }
const buttonStyle: React.CSSProperties = { fontSize: 9, color: '#b91c1c', border: '1px solid var(--border)', background: 'transparent', borderRadius: 5, padding: '4px 6px', cursor: 'pointer' }
const statusStyle: React.CSSProperties = { maxWidth: 230, fontSize: 9, color: 'var(--text-muted)', overflowWrap: 'anywhere' }
