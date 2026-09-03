import type pg from "pg"
import { credentialContext, decryptSecret, encryptSecret } from "@jobcopilot/shared"

import type {
  GmailClientPort, GmailCreateDraftInput, GmailCredential, GmailCredentialPort,
  GmailGetThreadInput, GmailThreadOutput,
} from "./gmail-types.js"

const API = "https://gmail.googleapis.com/gmail/v1/users/me"

export class GmailClientError extends Error {
  constructor(readonly code: "gmail_http_error" | "gmail_scope_denied" | "gmail_reauthorization_required", message: string) {
    super(message)
    this.name = "GmailClientError"
  }
}

export function createGmailClient(fetcher: typeof fetch = fetch): GmailClientPort {
  return {
    async getThread(accessToken, input, signal) {
      const path = input.threadId ? `threads/${encodeURIComponent(input.threadId)}?format=full` : `messages/${encodeURIComponent(input.messageId as string)}?format=full`
      const response = await fetcher(`${API}/${path}`, { headers: auth(accessToken), signal })
      if (!response.ok) throw new GmailClientError("gmail_http_error", "Gmail could not read the requested thread")
      return parseThread(await response.json() as unknown, Boolean(input.threadId))
    },
    async createDraft(accessToken, input, signal) {
      const raw = encodeMessage(input.to, input.subject, input.body)
      const response = await fetcher(`${API}/drafts`, {
        method: "POST", headers: { ...auth(accessToken), "Content-Type": "application/json" }, signal,
        body: JSON.stringify({ message: { raw, ...(input.threadId ? { threadId: input.threadId } : {}) } }),
      })
      if (!response.ok) throw new GmailClientError("gmail_http_error", "Gmail could not create the draft")
      const value = await response.json() as Record<string, unknown>
      const message = record(value.message)
      const draftId = text(value.id)
      if (!draftId) throw new GmailClientError("gmail_http_error", "Gmail returned no draft evidence")
      return { draftId, messageId: text(message?.id), threadId: text(message?.threadId) ?? text(value.threadId) ?? input.threadId ?? null }
    },
    async sendDraft(accessToken, draftId, signal) {
      const response = await fetcher(`${API}/drafts/send`, {
        method: "POST", headers: { ...auth(accessToken), "Content-Type": "application/json" }, signal,
        body: JSON.stringify({ id: draftId }),
      })
      if (!response.ok) throw new GmailClientError("gmail_http_error", "Gmail could not send the approved draft")
      const value = await response.json() as Record<string, unknown>
      const messageId = text(value.id)
      if (!messageId) throw new GmailClientError("gmail_http_error", "Gmail returned no sent message evidence")
      return { messageId, threadId: text(value.threadId) }
    },
  }
}

export function createPgGmailCredentialPort(pool: Pick<pg.Pool, "query">): GmailCredentialPort {
  return {
    async getAccessToken(userId): Promise<GmailCredential | null> {
      const row = await findAccount(pool, userId)
      if (!row) return null
      const accessToken = await decryptToken(row, "access")
      if (accessToken && !expired(row.expiresAt)) return { accessToken, scope: row.scope }
      const refreshToken = await decryptToken(row, "refresh")
      if (!refreshToken) return null
      const clientId = process.env.AUTH_GOOGLE_ID
      const clientSecret = process.env.AUTH_GOOGLE_SECRET
      if (!clientId || !clientSecret) return null
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
      })
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null
      const refreshed = text(payload?.access_token)
      if (!response.ok || !refreshed) return null
      const provider = row.provider
      const context = credentialContext(`account:${provider}:${row.providerAccountId}:access`)
      await pool.query(`UPDATE "Account" SET "access_token" = NULL, "accessTokenEnc" = $1, "expires_at" = $2 WHERE "id" = $3 AND "userId" = $4`, [await encryptSecret(refreshed, context), Math.floor(Date.now() / 1000) + number(payload?.expires_in, 3600), row.id, userId])
      return { accessToken: refreshed, scope: row.scope }
    },
  }
}

interface AccountRow { id: string; provider: string; providerAccountId: string; accessToken: string | null; accessTokenEnc: string | null; refreshToken: string | null; refreshTokenEnc: string | null; expiresAt: number | null; scope: string | null }

async function findAccount(pool: Pick<pg.Pool, "query">, userId: string): Promise<AccountRow | null> {
  const result = await pool.query<AccountRow>(`SELECT "id", "provider", "providerAccountId", "access_token" AS "accessToken", "accessTokenEnc", "refresh_token" AS "refreshToken", "refreshTokenEnc", "expires_at" AS "expiresAt", "scope" FROM "Account" WHERE "userId" = $1 AND ("provider" = 'gmail' OR ("provider" = 'google' AND "scope" LIKE '%gmail%')) ORDER BY CASE WHEN "provider" = 'gmail' THEN 0 ELSE 1 END LIMIT 1`, [userId])
  return result.rows[0] ?? null
}

async function decryptToken(row: AccountRow, field: "access" | "refresh"): Promise<string | null> {
  const encrypted = field === "access" ? row.accessTokenEnc : row.refreshTokenEnc
  const legacy = field === "access" ? row.accessToken : row.refreshToken
  return decryptSecret(encrypted ?? legacy, credentialContext(`account:${row.provider}:${row.providerAccountId}:${field}`))
}

function expired(value: number | null): boolean { return value !== null && value * 1000 < Date.now() + 60_000 }
function auth(token: string): Record<string, string> { return { Authorization: `Bearer ${token}` } }
function encodeMessage(to: string, subject: string, body: string): string { return Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\nMIME-Version: 1.0\r\n\r\n${body}`).toString("base64url") }
function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null }
function number(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null }

function parseThread(value: unknown, isThread: boolean): GmailThreadOutput {
  const root = record(value) ?? {}
  const messages = isThread && Array.isArray(root.messages) ? root.messages : [root]
  return { threadId: text(root.threadId), messages: messages.flatMap((entry) => parseMessage(entry)) }
}

function parseMessage(value: unknown): GmailThreadOutput["messages"] {
  const row = record(value)
  if (!row || !text(row.id)) return []
  const payload = record(row.payload) ?? {}
  const headers = new Map<string, string>()
  if (Array.isArray(payload.headers)) for (const header of payload.headers) {
    const item = record(header)
    if (text(item?.name) && text(item?.value)) headers.set(text(item?.name)!.toLowerCase(), text(item?.value)!)
  }
  return [{ messageId: text(row.id)!, threadId: text(row.threadId), subject: headers.get("subject") ?? "", senderEmail: parseEmail(headers.get("from")), snippet: text(row.snippet) ?? "", body: extractBody(payload), receivedAt: text(row.internalDate) ? new Date(Number(row.internalDate)).toISOString() : null }]
}

function parseEmail(value: string | undefined): string | null { const match = value?.match(/<([^>]+)>/); return match?.[1] ?? value ?? null }
function extractBody(payload: Record<string, unknown>): string { const body = record(payload.body); if (text(body?.data)) return decode(text(body?.data)!); if (Array.isArray(payload.parts)) for (const part of payload.parts) { const found = extractBody(record(part) ?? {}); if (found) return found } return "" }
function decode(value: string): string { try { return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") } catch { return "" } }
