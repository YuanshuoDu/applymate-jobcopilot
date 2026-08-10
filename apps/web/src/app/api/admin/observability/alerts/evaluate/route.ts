import { AdminIncidentSeverity } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { getObservabilitySnapshot } from '@/lib/admin/observability'
import { writeAdminAudit } from '@/lib/admin/audit'
import { notifyAdministrators } from '@/lib/admin/admin-notifications'
import { db } from '@/lib/db'
import { getQueueSloSnapshot } from '@/lib/admin/queue-slo'

function authorized(request: NextRequest) {
  const authorization = request.headers.get('authorization')
  const secrets = [process.env.WEB_MAINTENANCE_CRON_SECRET, process.env.CRON_SECRET, process.env.AGENT_AUTOMATION_CRON_SECRET].filter((value): value is string => Boolean(value?.trim()))
  return secrets.some(secret => authorization === `Bearer ${secret}`)
}

function metricValue(metric: string, snapshot: Awaited<ReturnType<typeof getObservabilitySnapshot>>, queue: Awaited<ReturnType<typeof getQueueSloSnapshot>>) {
  if (metric === 'success_rate') return snapshot.overall.successRate
  if (metric === 'captcha_rate') return snapshot.overall.captchaRate
  if (metric === 'avg_duration_ms') return snapshot.overall.avgDurationMs
  if (metric === 'ai_error_rate') return snapshot.ai.errorRate
  if (metric === 'ai_cost_usd') return snapshot.ai.estimatedCostUsd
  if (metric.startsWith('queue_') && !queue.available) return null
  if (metric === 'queue_stuck_jobs') return queue.stuck
  if (metric === 'queue_failed_jobs') return queue.failed
  if (metric === 'queue_dead_letter_jobs') return queue.deadLetter
  return null
}

function breached(value: number, operator: string, threshold: number) {
  if (operator === 'gt') return value > threshold
  if (operator === 'gte') return value >= threshold
  if (operator === 'lt') return value < threshold
  return value <= threshold
}

async function evaluate(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rules = await db.adminAlertRule.findMany({ where: { enabled: true } })
  const [snapshot, queue] = await Promise.all([getObservabilitySnapshot({ days: 1 }), getQueueSloSnapshot()])
  const fired: string[] = []
  for (const rule of rules) {
    const value = metricValue(rule.metric, snapshot, queue)
    if (value === null || !breached(value, rule.operator, rule.threshold)) continue
    const since = new Date(Date.now() - rule.windowMin * 60_000)
    const existing = await db.adminAlertEvent.findFirst({ where: { ruleKey: rule.key, status: 'open', createdAt: { gte: since } }, select: { id: true } })
    if (existing) continue
    const event = await db.adminAlertEvent.create({ data: { ruleKey: rule.key, metric: rule.metric, value, threshold: rule.threshold, severity: rule.severity } })
    const incident = await db.adminIncident.create({ data: { title: `Alert: ${rule.name}`, summary: `${rule.metric} is ${value}; threshold ${rule.operator} ${rule.threshold}.`, service: 'observability', severity: rule.severity as AdminIncidentSeverity, createdById: 'system', updatedById: 'system' } })
    await db.adminAlertEvent.update({ where: { id: event.id }, data: { incidentId: incident.id } })
    await db.adminAlertRule.update({ where: { id: rule.id }, data: { lastFiredAt: new Date() } })
    await notifyAdministrators({ permission: 'observability.read', type: 'observability_alert_fired', title: `Alert fired: ${rule.name}`, body: `${rule.metric} is ${value}; threshold ${rule.operator} ${rule.threshold}.`, entityType: 'incident', entityId: incident.id, dedupeKey: `alert:${event.id}` }).catch(() => undefined)
    fired.push(rule.key)
  }
  await writeAdminAudit({ requestId: 'observability-alert-cron', action: 'observability.alerts_evaluated', outcome: 'success', after: { checked: rules.length, fired } }).catch(() => undefined)
  return NextResponse.json({ checked: rules.length, fired })
}

export async function GET(request: NextRequest) {
  return evaluate(request)
}

export async function POST(request: NextRequest) {
  return evaluate(request)
}
