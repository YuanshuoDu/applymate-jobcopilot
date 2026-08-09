'use client'

import { AlertTriangle, CalendarDays, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useApi } from '@/lib/hooks'

type TableItem = { id: string | number; [key: string]: unknown }
type Column = { label: string; value: (item: TableItem) => ReactNode; sortKey?: string }
type Filter = { label: string; param: string; options: Array<{ label: string; value: string }> }

function dateValue(value: unknown) {
  return value ? new Date(String(value)).toLocaleString() : '-'
}

export const values = {
  text: (key: string) => (item: TableItem) => String(item[key] ?? '-'),
  date: (key: string) => (item: TableItem) => dateValue(item[key]),
  duration: (key: string) => (item: TableItem) => item[key] == null ? '-' : `${Math.round(Number(item[key]) / 1000)}s`,
}

export function AdminDataTable({ title, subtitle, endpoint, columns, searchable = false, filters = [], exportEndpoint, refreshMs = 30_000 }: { title: string; subtitle: string; endpoint: string; columns: Column[]; searchable?: boolean; filters?: Filter[]; exportEndpoint?: string; refreshMs?: number }) {
  const [query, setQuery] = useState('')
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [sort, setSort] = useState('')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [mounted, setMounted] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    const url = new URL(window.location.href)
    setQuery(url.searchParams.get('q') ?? '')
    const nextFilters: Record<string, string> = {}
    filters.forEach((filter) => { nextFilters[filter.param] = url.searchParams.get(filter.param) ?? '' })
    setFilterValues(nextFilters)
    setSort(url.searchParams.get('sort') ?? '')
    setDirection(url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc')
    setMounted(true)
  }, [filters])
  const params = new URLSearchParams()
  if (searchable && query.trim()) params.set('q', query.trim())
  Object.entries(filterValues).forEach(([key, value]) => { if (value) params.set(key, value) })
  if (sort) { params.set('sort', sort); params.set('direction', direction) }
  if (refreshKey) params.set('_refresh', String(refreshKey))
  if (cursor) params.set('cursor', cursor)
  params.set('limit', '25')
  const url = `${endpoint}?${params.toString()}`
  const { data, loading, error } = useApi<{ items: TableItem[]; nextCursor: string | null }>(url)
  const rows = data?.items ?? []
  function resetPage() { setCursor(null); setCursorStack([]) }
  function replaceUrl(nextQuery: string, nextFilters: Record<string, string>, nextSort: string, nextDirection: 'asc' | 'desc') {
    const nextUrl = new URL(window.location.href)
    if (nextQuery.trim()) nextUrl.searchParams.set('q', nextQuery.trim()); else nextUrl.searchParams.delete('q')
    filters.forEach((filter) => { const value = nextFilters[filter.param] ?? ''; if (value) nextUrl.searchParams.set(filter.param, value); else nextUrl.searchParams.delete(filter.param) })
    if (nextSort) nextUrl.searchParams.set('sort', nextSort); else nextUrl.searchParams.delete('sort')
    if (nextSort || nextDirection !== 'asc') nextUrl.searchParams.set('direction', nextDirection); else nextUrl.searchParams.delete('direction')
    nextUrl.searchParams.delete('cursor')
    window.history.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}`)
  }
  function setFilter(param: string, value: string) { const nextFilters = { ...filterValues, [param]: value }; setFilterValues(nextFilters); replaceUrl(query, nextFilters, sort, direction); resetPage() }
  function nextPage() { if (data?.nextCursor) { setCursorStack(current => [...current, cursor ?? '']); setCursor(data.nextCursor) } }
  function previousPage() { const previous = cursorStack[cursorStack.length - 1]; setCursorStack(current => current.slice(0, -1)); setCursor(previous || null) }
  function setSortValue(value: string) { setSort(value); replaceUrl(query, filterValues, value, direction); resetPage() }
  function toggleDirection() { const next = direction === 'asc' ? 'desc' : 'asc'; setDirection(next); replaceUrl(query, filterValues, sort, next); resetPage() }
  useEffect(() => { if (!mounted || refreshMs <= 0) return; const timer = window.setInterval(() => setRefreshKey(current => current + 1), refreshMs); return () => window.clearInterval(timer) }, [mounted, refreshMs])
  return <div className="admin-page">
    <header className="admin-header"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="admin-header-time"><CalendarDays size={18} /> Read-only view</div></header>
    <section className="admin-list-page">
      <div className="admin-table-toolbar">{searchable && <label className="admin-search"><Search size={17} /><span className="sr-only">Search users</span><input value={query} onChange={(event) => { const value = event.target.value; setQuery(value); replaceUrl(value, filterValues, sort, direction); resetPage() }} placeholder="Search name or email" /></label>}{filters.map(filter => <label className="admin-table-filter" key={filter.param}>{filter.label}<select value={filterValues[filter.param] ?? ''} onChange={event => setFilter(filter.param, event.target.value)}><option value="">All</option>{filter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}{columns.some(column => column.sortKey) && <label className="admin-table-filter">Sort<select value={sort} onChange={event => setSortValue(event.target.value)}><option value="">Default</option>{columns.filter(column => column.sortKey).map(column => <option key={column.sortKey} value={column.sortKey}>{column.label}</option>)}</select><button className="admin-secondary" type="button" onClick={toggleDirection}>{direction === 'asc' ? 'Ascending' : 'Descending'}</button></label>}{exportEndpoint && <a className="admin-secondary" href={exportEndpoint}>Export safe CSV</a>}</div>
      {error && <div className="admin-alert"><AlertTriangle size={18} />{error}</div>}
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{columns.map((column) => <th key={column.label}>{column.label}</th>)}</tr></thead><tbody>
        {loading ? <tr><td colSpan={columns.length}>Loading safe operational data...</td></tr> : rows.length === 0 ? <tr><td colSpan={columns.length}>No records match this view.</td></tr> : rows.map((row) => <tr key={row.id}>{columns.map((column) => <td key={column.label} data-label={column.label}>{column.value(row)}</td>)}</tr>)}
      </tbody></table></div><div className="admin-pagination"><button className="admin-secondary" disabled={cursorStack.length === 0 || loading} onClick={previousPage}>Previous</button><span>{loading ? 'Loading...' : rows.length ? `${rows.length} records` : 'No records'}</span><button className="admin-secondary" disabled={!data?.nextCursor || loading} onClick={nextPage}>Next</button></div>
    </section>
  </div>
}
