import { extractHtml, extractPlainText } from '@/lib/gmail-helpers'

export interface GmailRemoteMessage {
  id: string
  threadId: string | null
  senderEmail: string | null
  senderName: string | null
  subject: string
  snippet: string
  text: string
  html: string
  receivedAt: Date
}

export class GmailApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GmailApiError'
  }
}

export async function fetchRecentGmailMessages(
  accessToken: string,
  since: Date | null,
): Promise<GmailRemoteMessage[]> {
  const query = buildSearchQuery(since)
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  listUrl.searchParams.set('maxResults', '100')
  listUrl.searchParams.set('q', query)

  const listResponse = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(12_000),
  })
  if (!listResponse.ok) throw new GmailApiError('Could not list Gmail messages', listResponse.status)

  const listPayload = await listResponse.json() as unknown
  const ids = messageIds(listPayload)
  const settled = await Promise.allSettled(ids.map((id) => fetchMessage(accessToken, id)))
  return settled.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : [])
}

function buildSearchQuery(since: Date | null): string {
  const sinceTerm = since
    ? `after:${formatGmailDate(since)}`
    : 'newer_than:60d'
  return `-from:me ${sinceTerm} (application OR interview OR offer OR rejection OR "job alert" OR "recommended jobs" OR "new jobs")`
}

function formatGmailDate(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

function messageIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return []
  return payload.messages.flatMap((message) => {
    if (!isRecord(message) || typeof message.id !== 'string') return []
    return [message.id]
  })
}

async function fetchMessage(accessToken: string, id: string): Promise<GmailRemoteMessage | null> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8_000) },
  )
  if (!response.ok) return null
  return parseMessage(await response.json() as unknown)
}

function parseMessage(value: unknown): GmailRemoteMessage | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  const payload = isRecord(value.payload) ? value.payload : {}
  const headers = headerMap(payload.headers)
  const sender = parseSender(headers.get('from') ?? '')
  const internalDate = typeof value.internalDate === 'string' ? Number(value.internalDate) : Number.NaN
  const headerDate = new Date(headers.get('date') ?? '')
  const receivedAt = Number.isFinite(internalDate)
    ? new Date(internalDate)
    : Number.isNaN(headerDate.getTime()) ? new Date() : headerDate

  return {
    id: value.id,
    threadId: typeof value.threadId === 'string' ? value.threadId : null,
    senderEmail: sender.email,
    senderName: sender.name,
    subject: headers.get('subject') ?? '',
    snippet: typeof value.snippet === 'string' ? value.snippet : '',
    text: extractPlainText(payload),
    html: extractHtml(payload),
    receivedAt,
  }
}

function headerMap(value: unknown): Map<string, string> {
  const headers = new Map<string, string>()
  if (!Array.isArray(value)) return headers
  for (const header of value) {
    if (!isRecord(header) || typeof header.name !== 'string' || typeof header.value !== 'string') continue
    headers.set(header.name.toLowerCase(), header.value)
  }
  return headers
}

function parseSender(value: string): { email: string | null; name: string | null } {
  const match = value.match(/^(.*?)\s*<([^>]+)>$/)
  if (!match) return { email: value || null, name: value || null }
  const name = match[1].replace(/^"|"$/g, '').trim()
  return { email: match[2].trim() || null, name: name || null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
