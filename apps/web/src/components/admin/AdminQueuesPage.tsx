'use client'

import { Pause, Play, RefreshCw, ServerCog } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'

type Queue = { name: string; counts: Record<string, number>; paused: boolean; stuckActiveCount?: number }
type FailedJob = { id?: string; name?: string; failedReason?: string; attemptsMade?: number; finishedOn?: number }
type WorkerHealth = { status: string; workerId: string; version: string; startedAt: string; uptimeSeconds: number; pid: number }

export function AdminQueuesPage({ permissions }: { permissions: readonly string[] }) {
  const [queues, setQueues] = useState<Queue[]>([])
  const [notice, setNotice] = useState('')
  const [failedQueue, setFailedQueue] = useState('')
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([])
  const [worker, setWorker] = useState<WorkerHealth | null>(null)
  const { request, dialog } = useAdminPrompt()
  const canPause = permissions.includes('queues.pause')
  const canResume = permissions.includes('queues.resume')
  async function load() {
    const response = await fetch('/api/admin/v1/queues', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { queues?: Queue[]; worker?: WorkerHealth | null; error?: string } | null
    setQueues(payload?.queues ?? [])
    setWorker(payload?.worker ?? null)
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load queues.')
  }
  useEffect(() => { void load() }, [])
  async function loadFailed(queue: string) {
    const response = await fetch(`/api/admin/v1/queues/${queue}/failed`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { jobs?: FailedJob[]; error?: string } | null
    setFailedQueue(queue)
    setFailedJobs(payload?.jobs ?? [])
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load failed jobs.')
  }
  async function retry(queue: string, job: FailedJob) {
    if (!job.id) return
    const reason = await request({ title: `Retry ${job.id}`, label: 'Operational reason', kind: 'reason' })
    if (!reason) return
    const response = await fetch(`/api/admin/v1/queues/${queue}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ jobId: job.id, reason }) })
    const result = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? `${job.id} retry request accepted.` : result?.error ?? 'Retry failed.')
    if (response.ok) await loadFailed(queue)
  }
  async function change(queue: Queue, action: 'pause' | 'resume') {
    const reason = await request({ title: `${action === 'pause' ? 'Pause' : 'Resume'} ${queue.name}`, label: 'Operational reason', kind: 'reason' })
    if (!reason) return
    const response = await fetch(`/api/admin/v1/queues/${queue.name}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ reason }) })
    const result = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? `${queue.name} ${action} request accepted.` : result?.error ?? 'Queue action failed.')
    if (response.ok) await load()
  }
  return <><div className="admin-page"><header className="admin-header"><div><h1>Queues</h1><p>Safe queue controls without task payload access</p></div><ServerCog size={22} aria-hidden="true" /></header><section className="admin-list-page"><div className="admin-queue-title"><span>{notice}</span><button className="admin-row-action" title="Refresh queue summary" onClick={() => void load()}><RefreshCw size={16} /></button></div>{worker && <section className="admin-status-panel"><strong>Worker {worker.status === 'ok' ? 'healthy' : 'unavailable'}</strong><span>{worker.workerId} · release {worker.version} · uptime {Math.floor(worker.uptimeSeconds / 3600)}h {Math.floor(worker.uptimeSeconds / 60) % 60}m</span></section>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Failed</th><th>Stuck</th><th>State</th><th aria-label="Actions" /></tr></thead><tbody>{queues.map((queue) => <tr key={queue.name}><td>{queue.name}</td><td>{queue.counts.waiting ?? 0}</td><td>{queue.counts.active ?? 0}</td><td>{queue.counts.delayed ?? 0}</td><td>{queue.counts.failed ?? 0}</td><td>{queue.stuckActiveCount ?? 0}</td><td>{queue.paused ? 'Paused' : 'Running'}</td><td><button className="admin-row-action" title="View failed jobs" disabled={!permissions.includes('queues.read')} onClick={() => void loadFailed(queue.name)}>Failed</button>{queue.paused ? <button className="admin-row-action" title="Resume queue" disabled={!canResume} onClick={() => void change(queue, 'resume')}><Play size={15} /></button> : <button className="admin-row-action" title="Pause queue" disabled={!canPause} onClick={() => void change(queue, 'pause')}><Pause size={15} /></button>}</td></tr>)}</tbody></table></div>{failedQueue && <section className="admin-subsection"><h2>Failed jobs · {failedQueue}</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Job</th><th>Name</th><th>Attempts</th><th>Reason</th><th>Finished</th><th aria-label="Actions" /></tr></thead><tbody>{failedJobs.length === 0 ? <tr><td colSpan={6}>No failed jobs.</td></tr> : failedJobs.map((job) => <tr key={job.id}><td>{job.id}</td><td>{job.name}</td><td>{job.attemptsMade ?? 0}</td><td>{job.failedReason ?? 'Unknown failure'}</td><td>{job.finishedOn ? new Date(job.finishedOn).toLocaleString() : '—'}</td><td><button className="admin-row-action" disabled={!permissions.includes('queues.retry')} onClick={() => void retry(failedQueue, job)}>Retry</button></td></tr>)}</tbody></table></div></section>}</section></div>{dialog}</>
}
