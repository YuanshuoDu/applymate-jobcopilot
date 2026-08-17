'use client'

import { Pause, Play, RefreshCw, ServerCog } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type Queue = { name: string; counts: Record<string, number>; paused: boolean; stuckActiveCount?: number }
type FailedJob = { id?: string; name?: string; sourceQueue?: string; sourceJobId?: string; failedReason?: string; attemptsMade?: number; failedAt?: number; finishedOn?: number }
type WorkerHealth = { status: string; state: 'running' | 'paused'; workerId: string; version: string; startedAt: string; uptimeSeconds: number; pid: number }

export function AdminQueuesPage({ permissions }: { permissions: readonly string[] }) {
  const [queues, setQueues] = useState<Queue[]>([])
  const [notice, setNotice] = useState('')
  const [failedQueue, setFailedQueue] = useState('')
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([])
  const [worker, setWorker] = useState<WorkerHealth | null>(null)
  const [workerBusy, setWorkerBusy] = useState(false)
  const { request, dialog } = useAdminPrompt()
  const { t } = useI18n()
  const canPause = permissions.includes('queues.pause')
  const canResume = permissions.includes('queues.resume')
  async function load() {
    const response = await fetch('/api/admin/v1/queues', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { queues?: Queue[]; worker?: WorkerHealth | null; error?: string } | null
    setQueues(payload?.queues ?? [])
    setWorker(payload?.worker ?? null)
    if (!response.ok) setNotice(payload?.error ?? t('admin.queues.unableLoad'))
  }
  useEffect(() => { void load() }, [])
  async function loadFailed(queue: string) {
    const response = await fetch(`/api/admin/v1/queues/${queue}/failed`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { jobs?: FailedJob[]; error?: string } | null
    setFailedQueue(queue)
    setFailedJobs(payload?.jobs ?? [])
    if (!response.ok) setNotice(payload?.error ?? t('admin.queues.unableLoadFailed'))
  }
  async function retry(queue: string, job: FailedJob) {
    if (!job.id) return
    const reason = await request({ title: `${t('admin.queues.retry')} ${job.id}`, label: t('admin.queues.operationalReason'), kind: 'reason' })
    if (!reason) return
    const response = await fetch(`/api/admin/v1/queues/${queue}/retry`, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ jobId: job.id, reason }) })
    const result = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? `${job.id} ${t('admin.queues.retryAccepted')}` : result?.error ?? t('admin.queues.retryFailed'))
    if (response.ok) await loadFailed(queue)
  }
  async function change(queue: Queue, action: 'pause' | 'resume') {
    const reason = await request({ title: `${action === 'pause' ? t('admin.queues.pause') : t('admin.queues.resume')} ${queue.name}`, label: t('admin.queues.operationalReason'), kind: 'reason' })
    if (!reason) return
    const response = await fetch(`/api/admin/v1/queues/${queue.name}/${action}`, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ reason }) })
    const result = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? `${queue.name} ${action === 'pause' ? t('admin.queues.pauseAccepted') : t('admin.queues.resumeAccepted')}` : result?.error ?? t('admin.queues.actionFailed'))
    if (response.ok) await load()
  }
  async function changeWorker(action: 'pause' | 'resume') {
    const reason = await request({ title: `${action === 'pause' ? t('admin.queues.pause') : t('admin.queues.resume')} Worker`, label: t('admin.queues.operationalReason'), kind: 'reason', description: t('admin.queues.workerDescription') })
    if (!reason) return
    setWorkerBusy(true)
    const response = await fetch('/api/admin/v1/queues', { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ action, reason }) })
    const result = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? `Worker ${action === 'pause' ? t('admin.queues.pauseAccepted') : t('admin.queues.resumeAccepted')}` : result?.error ?? t('admin.queues.workerActionFailed'))
    setWorkerBusy(false)
    if (response.ok) await load()
  }
  const deadLetter = queues.find(queue => queue.name === 'dead-letter')
  return <><div className="admin-page"><header className="admin-header"><div><h1>{t('admin.queues.title')}</h1><p>{t('admin.queues.description')}</p></div><ServerCog size={22} aria-hidden="true" /></header><section className="admin-list-page"><div className="admin-queue-title"><span>{notice}</span><button className="admin-row-action" title={t('admin.queues.refresh')} onClick={() => void load()}><RefreshCw size={16} /></button></div>{worker && <section className="admin-status-panel"><strong>Worker {worker.state === 'paused' ? t('admin.queues.paused') : worker.status === 'ok' ? t('admin.queues.healthy') : t('admin.queues.unavailable')}</strong><span>{worker.workerId} · release {worker.version} · uptime {Math.floor(worker.uptimeSeconds / 3600)}h {Math.floor(worker.uptimeSeconds / 60) % 60}m</span><div className="admin-inline-actions"><button className="admin-row-action" title={t('admin.queues.resumeAll')} disabled={workerBusy || !canResume || worker.state !== 'paused'} onClick={() => void changeWorker('resume')}><Play size={15} /> {t('admin.queues.resumeWorker')}</button><button className="admin-row-action" title={t('admin.queues.pauseAll')} disabled={workerBusy || !canPause || worker.state === 'paused'} onClick={() => void changeWorker('pause')}><Pause size={15} /> {t('admin.queues.pauseWorker')}</button></div></section>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('admin.queues.queue')}</th><th>{t('admin.queues.waiting')}</th><th>{t('admin.queues.active')}</th><th>{t('admin.queues.delayed')}</th><th>{t('admin.queues.failed')}</th><th>{t('admin.queues.stuck')}</th><th>{t('admin.queues.state')}</th><th aria-label={t('admin.queues.actions')} /></tr></thead><tbody>{queues.filter(queue => queue.name !== 'dead-letter').map((queue) => <tr key={queue.name}><td>{queue.name}</td><td>{queue.counts.waiting ?? 0}</td><td>{queue.counts.active ?? 0}</td><td>{queue.counts.delayed ?? 0}</td><td>{queue.counts.failed ?? 0}</td><td>{queue.stuckActiveCount ?? 0}</td><td>{queue.paused ? t('admin.queues.paused') : t('admin.queues.running')}</td><td><button className="admin-row-action" title={t('admin.queues.viewFailed')} disabled={!permissions.includes('queues.read')} onClick={() => void loadFailed(queue.name)}>{t('admin.queues.failed')}</button>{queue.paused ? <button className="admin-row-action" title={t('admin.queues.resumeQueue')} disabled={!canResume || worker?.state === 'paused'} onClick={() => void change(queue, 'resume')}><Play size={15} /></button> : <button className="admin-row-action" title={t('admin.queues.pauseQueue')} disabled={!canPause} onClick={() => void change(queue, 'pause')}><Pause size={15} /></button>}</td></tr>)}</tbody></table></div>{deadLetter && <section className="admin-status-panel"><strong>{t('admin.queues.deadLetterQueue')} · {deadLetter.counts.waiting ?? 0} {t('admin.queues.waiting')}</strong><span>{t('admin.queues.deadLetterDescription')}</span><div className="admin-inline-actions"><button className="admin-row-action" disabled={!permissions.includes('queues.read')} onClick={() => void loadFailed('dead-letter')}>{t('admin.queues.viewDeadLetter')}</button></div></section>}{failedQueue && <section className="admin-subsection"><h2>{failedQueue === 'dead-letter' ? t('admin.queues.deadLetterJobs') : `${t('admin.queues.failedJobs')} · ${failedQueue}`}</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('admin.queues.job')}</th><th>{t('admin.queues.source')}</th><th>{t('admin.queues.attempts')}</th><th>{t('admin.queues.reason')}</th><th>{t('admin.queues.finished')}</th><th aria-label={t('admin.queues.actions')} /></tr></thead><tbody>{failedJobs.length === 0 ? <tr><td colSpan={6}>{t('admin.queues.noFailedJobs')}</td></tr> : failedJobs.map((job) => <tr key={job.id}><td>{job.id}</td><td>{job.sourceQueue ? `${job.sourceQueue} · ${job.sourceJobId}` : job.name}</td><td>{job.attemptsMade ?? 0}</td><td>{job.failedReason ?? t('admin.queues.unknownFailure')}</td><td>{job.failedAt ? new Date(job.failedAt).toLocaleString() : job.finishedOn ? new Date(job.finishedOn).toLocaleString() : '—'}</td><td><button className="admin-row-action" disabled={!permissions.includes('queues.retry')} onClick={() => void retry(failedQueue, job)}>{t('admin.queues.retry')}</button></td></tr>)}</tbody></table></div></section>}</section></div>{dialog}</>
}
