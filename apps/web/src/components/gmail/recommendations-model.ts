import type { GmailRecommendation } from './types'

export type RecommendationStatusFilter = 'all' | GmailRecommendation['status']

export interface RecommendationFilters {
  search: string
  platform: string
  status: RecommendationStatusFilter
  location: string
}

export const DEFAULT_RECOMMENDATION_FILTERS: RecommendationFilters = {
  search: '', platform: 'all', status: 'pending', location: 'all',
}

export function filterRecommendations(items: GmailRecommendation[], filters: RecommendationFilters) {
  const query = filters.search.trim().toLocaleLowerCase()
  return items.filter(item => {
    const searchable = [item.role, item.company, item.platform, item.location, item.sourceMessage.subject].join(' ').toLocaleLowerCase()
    return (!query || searchable.includes(query))
      && (filters.platform === 'all' || item.platform === filters.platform)
      && (filters.status === 'all' || item.status === filters.status)
      && (filters.location === 'all' || item.location === filters.location)
  })
}

export function groupRecommendations(items: GmailRecommendation[], now = new Date()) {
  const groups = new Map<string, GmailRecommendation[]>()
  for (const item of items) {
    const date = new Date(item.sourceMessage.receivedAt || item.createdAt)
    const key = date.toDateString()
    const existing = groups.get(key)
    if (existing) existing.push(item)
    else groups.set(key, [item])
  }
  return [...groups.entries()].map(([key, recommendations]) => ({
    id: key,
    label: recommendationGroupLabel(new Date(key), now),
    recommendations,
  }))
}

export function displayPlatform(platform: string | null) {
  return platform?.trim() || 'Email alert'
}

export function displayRecommendationStatus(status: GmailRecommendation['status']) {
  return status === 'pending' ? 'New' : status === 'saved' ? 'Saved' : 'Dismissed'
}

function recommendationGroupLabel(date: Date, now: Date) {
  const today = startOfDay(now)
  const target = startOfDay(date)
  const difference = Math.round((today.getTime() - target.getTime()) / 86_400_000)
  const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (difference === 0) return `Today — ${formatted}`
  if (difference === 1) return `Yesterday — ${formatted}`
  if (difference <= 6) return 'Earlier this week'
  return formatted
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}
