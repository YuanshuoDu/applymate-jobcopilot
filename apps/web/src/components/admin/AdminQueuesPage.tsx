'use client'

import { Pause, Play, RefreshCw, ServerCog } from 'lucide-react'
import { useEffect, useState } from 'react'

type Queue = { name: string; counts: Record<string, number>; paused: boolean }

export function AdminQueuesPage({ permissions }: { permissions: readonly string[] }) {
  const [queues, setQueues] = useState<Queue[]>([])
  const [notice, setNotice] = useState('')
  const canPause = permissions.includes('queues.pause')
  const canResume = permissions.includes('queues.resume')
  async function load() {
    const response = await fetch('/api/admin/v1/queues', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { queues?: Queue[]; error?: string } | null
    setQueues(payload?.queues ?? [])
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load queues.')
  }
  useEffect(() => { void load() }, [])
  async function change(queue: Queue, action: 'pause' | 'resume') {
    const reason = window.prompt(`${action === 'pause' ? 'Pause' : 'Resume'} ${queue.name}: enter operational reason`)
    if (!reason) return
    const response = await fetch(`/api/admin/v1/queues/${queue.name}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ reason }) })
    const result = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? `${queue.name} ${action} request accepted.` : result?.error ?? 'Queue action failed.')
    if (response.ok) await load()
  }
  return <div className="admin-page"><header className="admin-header"><div><h1>Queues</h1><p>Safe queue controls without task payload access</p></div><ServerCog size={22} aria-hidden="true" /></header><section className="admin-list-page"><div className="admin-queue-title"><span>{notice}</span><button className="admin-row-action" title="Refresh queue summary" onClick={() => void load()}><RefreshCw size={16} /></button></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Failed</th><th>State</th><th aria-label="Actions" /></tr></thead><tbody>{queues.map((queue) => <tr key={queue.name}><td>{queue.name}</td><td>{queue.counts.waiting ?? 0}</td><td>{queue.counts.active ?? 0}</td><td>{queue.counts.delayed ?? 0}</td><td>{queue.counts.failed ?? 0}</td><td>{queue.paused ? 'Paused' : 'Running'}</td><td>{queue.paused ? <button className="admin-row-action" title="Resume queue" disabled={!canResume} onClick={() => void change(queue, 'resume')}><Play size={15} /></button> : <button className="admin-row-action" title="Pause queue" disabled={!canPause} onClick={() => void change(queue, 'pause')}><Pause size={15} /></button>}</td></tr>)}</tbody></table></div></section></div>
}
