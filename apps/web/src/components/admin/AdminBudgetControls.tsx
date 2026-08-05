'use client'

import { Save } from 'lucide-react'
import { useState } from 'react'

export function AdminBudgetControls({ canUpdate }: { canUpdate: boolean }) {
  const [userId, setUserId] = useState('')
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [limit, setLimit] = useState(30)
  const [version, setVersion] = useState(1)
  const [notice, setNotice] = useState('')
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const reason = window.prompt('Enter the budget override reason')
    if (!reason) return
    const response = await fetch(`/api/admin/v1/ai/budgets/${encodeURIComponent(userId)}/${month}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ limit, version, reason, confirmBelowUsed: true }) })
    const payload = await response.json().catch(() => null) as { error?: string; version?: number } | null
    if (!response.ok) { setNotice(payload?.error ?? 'Budget override failed.'); return }
    setVersion(payload?.version ?? version + 1)
    setNotice('Budget override saved.')
  }
  return <section className="admin-controls"><div className="admin-controls-title"><div><h2>Budget override</h2><p>Use the current version shown in the budget table.</p></div><span role="status">{notice}</span></div><form className="budget-control-form" onSubmit={(event) => void submit(event)}><label>User ID<input value={userId} onChange={(event) => setUserId(event.target.value)} required /></label><label>Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} required /></label><label>Credit limit<input type="number" min="0" max="10000" value={limit} onChange={(event) => setLimit(Number(event.target.value))} required /></label><label>Version<input type="number" min="1" value={version} onChange={(event) => setVersion(Number(event.target.value))} required /></label><button className="admin-secondary" type="submit" disabled={!canUpdate}><Save size={15} /> Save override</button></form></section>
}
