'use client'

import { AlertTriangle, CalendarDays, ShieldCheck } from 'lucide-react'
import { DeploymentReadinessPanel } from '@/components/admin/DeploymentReadinessPanel'
import type { DeploymentReadiness } from '@/lib/admin/deployment-readiness'
import { useApi } from '@/lib/hooks'
import type { PlatformIntegrationStatus } from '@/lib/admin/integration-status'
import { AdminAlertRulesPanel } from './AdminAlertRulesPanel'
import { useI18n } from '@/lib/i18n'

type Metrics = { overall: { total: number; successRate: number; avgDurationMs: number; captchaRate: number; last24h: { count: number; successRate: number } }; trend: Array<{ day: string; count: number; successRate: number; captchaRate: number }>; ai?: { available?: boolean; calls: number; errors: number; errorRate: number; estimatedCostUsd: number; avgLatencyMs: number }; platform: { registeredUsers: number; registrationsLast7d: number; plans: Record<string, number>; sources: { employers: number; jobs: number }; overdueSupportCases: number } }
type AlertData = { events: Array<{ id: string; ruleKey: string; metric: string; value: number; threshold: number; severity: string; status: string; createdAt: string }> }
type QueueData = { queues: { counts: Record<string, number> }[] }
type PlatformData = { integrations: PlatformIntegrationStatus; readiness?: DeploymentReadiness }
type AdminOverviewProps = { permissions: readonly string[] }

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <section className="admin-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></section>
}

export function AdminOverview({ permissions }: AdminOverviewProps) {
  const { t } = useI18n()
  const { data, loading, error } = useApi<Metrics>('/api/admin/v1/observability')
  const canReadQueues = permissions.includes('queues.read')
  const queueSummary = useApi<QueueData>('/api/admin/v1/queues', { enabled: canReadQueues })
  const platformSummary = useApi<PlatformData>('/api/admin/v1/platform', { cache: false })
  const alertSummary = useApi<AlertData>('/api/admin/v1/observability/alerts')
  const metrics = data?.overall
  const platform = data?.platform
  const integrations = platformSummary.data?.integrations
  const readiness = platformSummary.data?.readiness
  const integrationChecks = integrations ? [
    ['MiniMax', integrations.ai.providers.minimax],
    ['Adzuna', integrations.discovery.adzuna],
    ['RapidAPI', integrations.discovery.rapidapi],
    ['Google OAuth', integrations.oauth.google],
    ['GitHub OAuth', integrations.oauth.github],
    ['Resend', integrations.messaging.resend],
    ['Database', integrations.infrastructure.database],
    ['Redis', integrations.infrastructure.redis],
    ['Worker control', integrations.infrastructure.workerControl],
  ] as const : []
  const readyIntegrations = integrationChecks.filter(([, ready]) => ready).length
  const queued = queueSummary.data?.queues.reduce((sum, queue) => sum + (queue.counts.waiting ?? 0) + (queue.counts.active ?? 0), 0) ?? 0
  const planSummary = platform ? Object.entries(platform.plans).map(([plan, count]) => `${plan}: ${count}`).join(' · ') || t('admin.noAccounts') : t('admin.loadingPlanMix')
  return <div className="admin-page">
    <header className="admin-header"><div><h1>{t('admin.platformOverview')}</h1><p>{t('admin.operationalHealthAlerts')}</p></div><div className="admin-header-time"><CalendarDays size={18} /> {t('admin.internalConsole')}</div></header>
    <div className="admin-overview">
      {error && <div className="admin-alert"><AlertTriangle size={18} />{t('admin.metricsUnavailable')}</div>}
      <div className="admin-metric-grid admin-metric-grid-wide">
        <Metric label={t('admin.applications')} value={loading ? '...' : String(metrics?.total ?? 0)} detail={t('admin.allTime')} />
        <Metric label={t('admin.registeredUsers')} value={loading ? '...' : String(platform?.registeredUsers ?? 0)} detail={`${platform?.registrationsLast7d ?? 0} ${t('admin.inLast7Days')}`} />
        <Metric label={t('admin.successRate')} value={loading ? '...' : `${metrics?.successRate ?? 0}%`} detail={t('admin.submittedApplications')} />
        <Metric label={t('admin.last24Hours')} value={loading ? '...' : String(metrics?.last24h.count ?? 0)} detail={`${metrics?.last24h.successRate ?? 0}% ${t('admin.success')}`} />
        <Metric label={t('admin.captchaRate')} value={loading ? '...' : `${metrics?.captchaRate ?? 0}%`} detail={t('admin.autoApplyRuns')} />
        <Metric label={t('admin.discoverySources')} value={loading ? '...' : String(platform?.sources.employers ?? 0)} detail={`${platform?.sources.jobs ?? 0} ${t('admin.indexedJobs')}`} />
        <Metric label={t('admin.queueWorkload')} value={!canReadQueues ? '—' : queueSummary.loading ? '...' : String(queued)} detail={!canReadQueues ? t('admin.notAvailableRole') : queueSummary.error ? t('admin.controlPlaneUnavailable') : t('admin.waitingActiveJobs')} />
        <Metric label={t('admin.overdueSupport')} value={loading ? '...' : String(platform?.overdueSupportCases ?? 0)} detail={t('admin.casesBeyondSla')} />
        <Metric label={t('admin.aiCost')} value={loading ? '...' : `$${data?.ai?.estimatedCostUsd?.toFixed(4) ?? '0.0000'}`} detail={data?.ai?.available === false ? t('admin.unavailableMigration') : `${data?.ai?.calls ?? 0} ${t('admin.calls')} · ${data?.ai?.avgLatencyMs ?? 0}ms ${t('admin.average')}`} />
      </div>
      <section className="admin-status-panel"><ShieldCheck size={19} /><div><strong>{t('admin.privacyControlsActive')}</strong><p>{planSummary}. {t('admin.allowListedMetadata')}</p></div></section>
      <section className="admin-status-panel"><div><strong>{t('admin.operationalTrend')}</strong><div className="admin-trend-grid">{(data?.trend ?? []).slice(-3).map((point) => <div className="admin-trend-row" key={point.day}><span>{new Date(point.day).toLocaleDateString()}</span><div className="admin-trend-bar"><i style={{ width: `${Math.min(100, Math.max(0, point.successRate))}%` }} /></div><strong>{point.count} {t('admin.runs')} · {point.successRate}%</strong></div>)}</div><p>{(alertSummary.data?.events ?? []).filter(event => event.status === 'open').length} {t('admin.openAlertEvents')}</p></div></section>
      <section className="admin-status-panel admin-integration-panel" aria-label={t('admin.platformIntegrations')}><div><strong>{t('admin.platformIntegrations')}</strong><p>{platformSummary.error ? t('admin.integrationUnavailable') : platformSummary.loading && !integrations ? t('admin.loadingIntegration') : `${readyIntegrations}/${integrationChecks.length} ${t('admin.ready')}`}</p>{integrationChecks.length > 0 && <div className="admin-integration-grid">{integrationChecks.map(([label, ready]) => <span key={label} className="admin-integration-chip" data-ready={ready}>{label}: {ready ? t('admin.ready') : t('admin.missing')}</span>)}</div>}</div></section>
      {data?.ai?.available === false && <div className="admin-alert"><AlertTriangle size={18} />{t('admin.aiMetricsUnavailable')}</div>}
      <DeploymentReadinessPanel readiness={readiness} />
      {(permissions.includes('observability.read')) && <AdminAlertRulesPanel canManage={permissions.includes('observability.alerts.manage')} />}
    </div>
  </div>
}
