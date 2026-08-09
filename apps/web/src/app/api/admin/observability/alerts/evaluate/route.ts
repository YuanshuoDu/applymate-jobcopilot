import { AdminIncidentSeverity } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { getObservabilitySnapshot } from '@/lib/admin/observability'
import { writeAdminAudit } from '@/lib/admin/audit'
import { db } from '@/lib/db'

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  return Boolean(secret && request.headers.get('authorization') === `Bearer ${secret}`)
}

function metricValue(metric: string, snapshot: Awaited<ReturnType<typeof getObservabilitySnapshot>>) {
  if (metric === 'success_rate') return snapshot.overall.successRate
  if (metric === 'captcha_rate') return snapshot.overall.captchaRate
  if (metric === 'avg_duration_ms') return snapshot.overall.avgDurationMs
  return null
}

function breached(value: number, operator: string, threshold: number) {
  if (operator === 'gt') return value > threshold
  if (operator === 'gte') return value >= threshold
  if (operator === 'lt') return value < threshold
  return value <= threshold
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rules = await db.adminAlertRule.findMany({ where: { enabled: true } })
  const snapshot = await getObservabilitySnapshot({ days: 1 })
  const fired: string[] = []
  for (const rule of rules) {
    const value = metricValue(rule.metric, snapshot)
    if (value === null || !breached(value, rule.operator, rule.threshold)) continue
    const since = new Date(Date.now() - rule.windowMin * 60_000)
    const existing = await db.adminAlertEvent.findFirst({ where: { ruleKey: rule.key, status: 'open', createdAt: { gte: since } }, select: { id: true } })
    if (existing) continue
    const event = await db.adminAlertEvent.create({ data: { ruleKey: rule.key, metric: rule.metric, value, threshold: rule.threshold, severity: rule.severity } })
    const incident = await db.adminIncident.create({ data: { title: `Alert: ${rule.name}`, summary: `${rule.metric} is ${value}; threshold ${rule.operator} ${rule.threshold}.`, service: 'observability', severity: rule.severity as AdminIncidentSeverity, createdById: 'system', updatedById: 'system' } })
    await db.adminAlertEvent.update({ where: { id: event.id }, data: { incidentId: incident.id } })
    await db.adminAlertRule.update({ where: { id: rule.id }, data: { lastFiredAt: new Date() } })
    fired.push(rule.key)
  }
  await writeAdminAudit({ requestId: 'observability-alert-cron', action: 'observability.alerts_evaluated', outcome: 'success', after: { checked: rules.length, fired } }).catch(() => undefined)
  return NextResponse.json({ checked: rules.length, fired })
}
