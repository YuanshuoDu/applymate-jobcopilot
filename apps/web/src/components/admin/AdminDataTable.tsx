'use client'

import { AlertTriangle, CalendarDays, Search } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useApi } from '@/lib/hooks'

type TableItem = { id: string | number; [key: string]: unknown }
type Column = { label: string; value: (item: TableItem) => ReactNode }
type Filter = { label: string; param: string; options: Array<{ label: string; value: string }> }

function dateValue(value: unknown) {
  return value ? new Date(String(value)).toLocaleString() : '-'
}

export const values = {
  text: (key: string) => (item: TableItem) => String(item[key] ?? '-'),
  date: (key: string) => (item: TableItem) => dateValue(item[key]),
  duration: (key: string) => (item: TableItem) => item[key] == null ? '-' : `${Math.round(Number(item[key]) / 1000)}s`,
}

export function AdminDataTable({ title, subtitle, endpoint, columns, searchable = false, filters = [] }: { title: string; subtitle: string; endpoint: string; columns: Column[]; searchable?: boolean; filters?: Filter[] }) {
  const [query, setQuery] = useState('')
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const params = new URLSearchParams()
  if (searchable && query.trim()) params.set('q', query.trim())
  Object.entries(filterValues).forEach(([key, value]) => { if (value) params.set(key, value) })
  if (cursor) params.set('cursor', cursor)
  params.set('limit', '25')
  const url = `${endpoint}?${params.toString()}`
  const { data, loading, error } = useApi<{ items: TableItem[]; nextCursor: string | null }>(url)
  const rows = data?.items ?? []
  function resetPage() { setCursor(null); setCursorStack([]) }
  function setFilter(param: string, value: string) { setFilterValues(current => ({ ...current, [param]: value })); resetPage() }
  function nextPage() { if (data?.nextCursor) { setCursorStack(current => [...current, cursor ?? '']); setCursor(data.nextCursor) } }
  function previousPage() { const previous = cursorStack[cursorStack.length - 1]; setCursorStack(current => current.slice(0, -1)); setCursor(previous || null) }
  return <div className="admin-page">
    <header className="admin-header"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="admin-header-time"><CalendarDays size={18} /> Read-only view</div></header>
    <section className="admin-list-page">
      {(searchable || filters.length > 0) && <div className="admin-table-toolbar">{searchable && <label className="admin-search"><Search size={17} /><span className="sr-only">Search users</span><input value={query} onChange={(event) => { setQuery(event.target.value); resetPage() }} placeholder="Search name or email" /></label>}{filters.map(filter => <label className="admin-table-filter" key={filter.param}>{filter.label}<select value={filterValues[filter.param] ?? ''} onChange={event => setFilter(filter.param, event.target.value)}><option value="">All</option>{filter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}</div>}
      {error && <div className="admin-alert"><AlertTriangle size={18} />{error}</div>}
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{columns.map((column) => <th key={column.label}>{column.label}</th>)}</tr></thead><tbody>
        {loading ? <tr><td colSpan={columns.length}>Loading safe operational data...</td></tr> : rows.length === 0 ? <tr><td colSpan={columns.length}>No records match this view.</td></tr> : rows.map((row) => <tr key={row.id}>{columns.map((column) => <td key={column.label} data-label={column.label}>{column.value(row)}</td>)}</tr>)}
      </tbody></table></div><div className="admin-pagination"><button className="admin-secondary" disabled={cursorStack.length === 0 || loading} onClick={previousPage}>Previous</button><span>{loading ? 'Loading...' : rows.length ? `${rows.length} records` : 'No records'}</span><button className="admin-secondary" disabled={!data?.nextCursor || loading} onClick={nextPage}>Next</button></div>
    </section>
  </div>
}
