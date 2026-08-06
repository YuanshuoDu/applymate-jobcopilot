'use client'

import { AlertTriangle, CalendarDays, Search } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useApi } from '@/lib/hooks'

type TableItem = { id: string | number; [key: string]: unknown }
type Column = { label: string; value: (item: TableItem) => ReactNode }

function dateValue(value: unknown) {
  return value ? new Date(String(value)).toLocaleString() : '-'
}

export const values = {
  text: (key: string) => (item: TableItem) => String(item[key] ?? '-'),
  date: (key: string) => (item: TableItem) => dateValue(item[key]),
  duration: (key: string) => (item: TableItem) => item[key] == null ? '-' : `${Math.round(Number(item[key]) / 1000)}s`,
}

export function AdminDataTable({ title, subtitle, endpoint, columns, searchable = false }: { title: string; subtitle: string; endpoint: string; columns: Column[]; searchable?: boolean }) {
  const [query, setQuery] = useState('')
  const url = searchable && query.trim() ? `${endpoint}?q=${encodeURIComponent(query.trim())}` : endpoint
  const { data, loading, error } = useApi<{ items: TableItem[] }>(url)
  const rows = data?.items ?? []
  return <div className="admin-page">
    <header className="admin-header"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="admin-header-time"><CalendarDays size={18} /> Read-only view</div></header>
    <section className="admin-list-page">
      {searchable && <label className="admin-search"><Search size={17} /><span className="sr-only">Search users</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or email" /></label>}
      {error && <div className="admin-alert"><AlertTriangle size={18} />{error}</div>}
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{columns.map((column) => <th key={column.label}>{column.label}</th>)}</tr></thead><tbody>
        {loading ? <tr><td colSpan={columns.length}>Loading safe operational data...</td></tr> : rows.length === 0 ? <tr><td colSpan={columns.length}>No records match this view.</td></tr> : rows.map((row) => <tr key={row.id}>{columns.map((column) => <td key={column.label} data-label={column.label}>{column.value(row)}</td>)}</tr>)}
      </tbody></table></div>
    </section>
  </div>
}
