'use client'

import { AlertTriangle, CalendarDays, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'

export type TableItem = { id: string | number; [key: string]: unknown }
export type TableControls = { refresh: () => Promise<void> }
type Column = { label: string; value: (item: TableItem, controls: TableControls) => ReactNode; sortKey?: string }
type Filter = { label: string; param: string; options: Array<{ label: string; value: string }> }
export type BulkAction = { label: string; onRun: (ids: string[]) => void | Promise<void> }

function dateValue(value: unknown) {
  return value ? new Date(String(value)).toLocaleString() : '-'
}

export const values = {
  text: (key: string) => (item: TableItem) => String(item[key] ?? '-'),
  date: (key: string) => (item: TableItem) => dateValue(item[key]),
  duration: (key: string) => (item: TableItem) => item[key] == null ? '-' : `${Math.round(Number(item[key]) / 1000)}s`,
}

export function AdminDataTable({ title, subtitle, endpoint, columns, searchable = false, searchLabel, searchPlaceholder, filters = [], exportEndpoint, refreshMs = 30_000, bulkActions = [], defaultSort = '', defaultDirection = 'asc', statusMessage = '', renderSummary, emptyTitle, emptyDescription, emptyMessage }: { title: string; subtitle: string; endpoint: string; columns: Column[]; searchable?: boolean; searchLabel?: string; searchPlaceholder?: string; filters?: Filter[]; exportEndpoint?: string; refreshMs?: number; bulkActions?: BulkAction[]; defaultSort?: string; defaultDirection?: 'asc' | 'desc'; statusMessage?: string; renderSummary?: (summary: Record<string, number>) => ReactNode; emptyTitle?: string; emptyDescription?: string; emptyMessage?: string }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [sort, setSort] = useState(defaultSort)
  const [direction, setDirection] = useState<'asc' | 'desc'>(defaultDirection)
  const [mounted, setMounted] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    const url = new URL(window.location.href)
    setQuery(url.searchParams.get('q') ?? '')
    const nextFilters: Record<string, string> = {}
    filters.forEach((filter) => { nextFilters[filter.param] = url.searchParams.get(filter.param) ?? '' })
    setFilterValues(nextFilters)
    setSort(url.searchParams.get('sort') ?? defaultSort)
    setDirection(url.searchParams.has('direction') ? (url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc') : defaultDirection)
    setCursor(url.searchParams.get('cursor'))
    setCursorStack((url.searchParams.get('cursorStack') ?? '').split('|').filter(Boolean))
    setMounted(true)
  }, [defaultDirection, defaultSort, filters])
  const params = new URLSearchParams()
  if (searchable && query.trim()) params.set('q', query.trim())
  Object.entries(filterValues).forEach(([key, value]) => { if (value) params.set(key, value) })
  if (sort) { params.set('sort', sort); params.set('direction', direction) }
  if (refreshKey) params.set('_refresh', String(refreshKey))
  if (cursor) params.set('cursor', cursor)
  params.set('limit', '25')
  const url = `${endpoint}?${params.toString()}`
  const { data, loading, error, refetch } = useApi<{ items: TableItem[]; nextCursor: string | null; summary?: Record<string, number> }>(url, { timeoutMs: 10_000 })
  const rows = data?.items ?? []
  function resetPage() {
    setCursor(null)
    setCursorStack([])
  }
  function replaceUrl(nextQuery: string, nextFilters: Record<string, string>, nextSort: string, nextDirection: 'asc' | 'desc') {
    const nextUrl = new URL(window.location.href)
    if (nextQuery.trim()) nextUrl.searchParams.set('q', nextQuery.trim()); else nextUrl.searchParams.delete('q')
    filters.forEach((filter) => { const value = nextFilters[filter.param] ?? ''; if (value) nextUrl.searchParams.set(filter.param, value); else nextUrl.searchParams.delete(filter.param) })
    if (nextSort) nextUrl.searchParams.set('sort', nextSort); else nextUrl.searchParams.delete('sort')
    if (nextSort || nextDirection !== 'asc') nextUrl.searchParams.set('direction', nextDirection); else nextUrl.searchParams.delete('direction')
    nextUrl.searchParams.delete('cursor')
    nextUrl.searchParams.delete('cursorStack')
    window.history.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}`)
  }
  function setFilter(param: string, value: string) { const nextFilters = { ...filterValues, [param]: value }; setFilterValues(nextFilters); replaceUrl(query, nextFilters, sort, direction); resetPage() }
  function setCursorInUrl(value: string | null, stack: string[]) {
    const nextUrl = new URL(window.location.href)
    if (value) nextUrl.searchParams.set('cursor', value); else nextUrl.searchParams.delete('cursor')
    if (stack.length) nextUrl.searchParams.set('cursorStack', stack.join('|')); else nextUrl.searchParams.delete('cursorStack')
    window.history.replaceState(null, '', `${nextUrl.pathname}${nextUrl.search}`)
  }
  function nextPage() {
    if (!data?.nextCursor) return
    const nextStack = [...cursorStack, cursor ?? '']
    setCursorStack(nextStack)
    setCursor(data.nextCursor)
    setCursorInUrl(data.nextCursor, nextStack)
  }
  function previousPage() {
    const previous = cursorStack[cursorStack.length - 1]
    const nextStack = cursorStack.slice(0, -1)
    setCursorStack(nextStack)
    setCursor(previous || null)
    setCursorInUrl(previous || null, nextStack)
  }
  function setSortValue(value: string) { setSort(value); replaceUrl(query, filterValues, value, direction); resetPage() }
  function toggleDirection() { const next = direction === 'asc' ? 'desc' : 'asc'; setDirection(next); replaceUrl(query, filterValues, sort, next); resetPage() }
  useEffect(() => { if (!mounted || refreshMs <= 0) return; const timer = window.setInterval(() => setRefreshKey(current => current + 1), refreshMs); return () => window.clearInterval(timer) }, [mounted, refreshMs])
  const selectionScope = `${endpoint}|${query}|${JSON.stringify(filterValues)}|${cursor ?? ''}|${sort}|${direction}`
  useEffect(() => { setSelectedIds(new Set()) }, [selectionScope])
  const exportParams = new URLSearchParams(params)
  exportParams.delete('limit'); exportParams.delete('cursor'); exportParams.delete('_refresh')
  const exportHref = exportEndpoint ? `${exportEndpoint}${exportEndpoint.includes('?') ? '&' : '?'}${exportParams.toString()}` : ''
  const exportSelectedAction: BulkAction[] = exportEndpoint ? [{ label: t('admin.exportSelected'), onRun: async (ids) => { const target = new URL(exportEndpoint, window.location.origin); target.searchParams.set('ids', ids.join(',')); window.location.assign(target.toString()) } }] : []
  const effectiveBulkActions: BulkAction[] = [...bulkActions, ...exportSelectedAction]
  const hasOperationalActions = effectiveBulkActions.length > 0
  const allSelected = rows.length > 0 && rows.every(row => selectedIds.has(String(row.id)))
  async function runBulk(action: BulkAction) { await action.onRun([...selectedIds]); setSelectedIds(new Set()); await refetch() }
  const controls: TableControls = { refresh: refetch }
  return <div className="admin-page">
    <header className="admin-header"><div><h1>{title}</h1><p>{subtitle}</p></div><div className="admin-header-time"><CalendarDays size={18} /> {hasOperationalActions ? t('admin.operationalControls') : t('admin.readOnlyView')}</div></header>
    <section className="admin-list-page">
      {statusMessage && <div className="admin-operation-status" role="status">{statusMessage}</div>}
      {renderSummary && data?.summary && renderSummary(data.summary)}
      <div className="admin-table-toolbar">{searchable && <label className="admin-search"><Search size={17} /><span className="sr-only">{searchLabel ?? `${t('admin.search')} ${title.toLowerCase()}`}</span><input value={query} onChange={(event) => { const value = event.target.value; setQuery(value); replaceUrl(value, filterValues, sort, direction); resetPage() }} placeholder={searchPlaceholder ?? `${t('admin.search')} ${title.toLowerCase()}`} /></label>}{filters.map(filter => <label className="admin-table-filter" key={filter.param}>{filter.label}<select value={filterValues[filter.param] ?? ''} onChange={event => setFilter(filter.param, event.target.value)}><option value="">{t('admin.all')}</option>{filter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}{columns.some(column => column.sortKey) && <label className="admin-table-filter">{t('admin.sort')}<select value={sort} onChange={event => setSortValue(event.target.value)}><option value="">{t('admin.default')}</option>{columns.filter(column => column.sortKey).map(column => <option key={column.sortKey} value={column.sortKey}>{column.label}</option>)}</select><button className="admin-secondary" type="button" onClick={toggleDirection}>{direction === 'asc' ? t('admin.ascending') : t('admin.descending')}</button></label>}{exportEndpoint && <a className="admin-secondary" href={exportHref} download>{t('admin.exportFilteredCsv')}</a>}{hasOperationalActions && <div className="admin-action-group">{effectiveBulkActions.map(action => <button key={action.label} className="admin-secondary" type="button" disabled={!selectedIds.size} onClick={() => void runBulk(action)}>{action.label} ({selectedIds.size})</button>)}</div>}</div>
      {error && <div className="admin-alert"><AlertTriangle size={18} />{error}</div>}
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{effectiveBulkActions.length > 0 && <th><input type="checkbox" aria-label={t('admin.selectAllVisibleRows')} checked={allSelected} onChange={() => setSelectedIds(allSelected ? new Set() : new Set(rows.map(row => String(row.id))))} /></th>}{columns.map((column) => <th key={column.label}>{column.label}</th>)}</tr></thead><tbody>
        {loading ? <tr><td colSpan={columns.length + (effectiveBulkActions.length > 0 ? 1 : 0)}>{t('admin.loadingSafeData')}</td></tr> : rows.length === 0 ? <tr><td colSpan={columns.length + (effectiveBulkActions.length > 0 ? 1 : 0)}>{emptyTitle ? <span className="admin-empty-table"><strong>{emptyTitle}</strong>{emptyDescription && <small>{emptyDescription}</small>}</span> : emptyMessage ?? t('admin.noRecordsMatch')}</td></tr> : rows.map((row) => <tr key={row.id}>{effectiveBulkActions.length > 0 && <td><input type="checkbox" aria-label={`${t('admin.select')} ${String(row.id)}`} checked={selectedIds.has(String(row.id))} onChange={() => setSelectedIds(current => { const next = new Set(current); const id = String(row.id); if (next.has(id)) next.delete(id); else next.add(id); return next })} /></td>}{columns.map((column) => <td key={column.label} data-label={column.label}>{column.value(row, controls)}</td>)}</tr>)}
      </tbody></table></div><div className="admin-pagination"><button className="admin-secondary" disabled={cursorStack.length === 0 || loading} onClick={previousPage}>{t('admin.previous')}</button><span>{loading ? t('common.loading') : rows.length ? `${rows.length} ${t('admin.records')}` : t('admin.noRecords')}</span><button className="admin-secondary" disabled={!data?.nextCursor || loading} onClick={nextPage}>{t('admin.next')}</button></div>
    </section>
  </div>
}
