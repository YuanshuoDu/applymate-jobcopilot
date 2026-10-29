import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { getAuthSecret } from "@/lib/auth-secret"

const PUBLIC_ID_VERSION = "applymate:agent-public-id:v1"
const CURSOR_PREFIX = "ptc1."
const CURSOR_AAD_VERSION = "applymate:timeline-cursor:v1"
const CURSOR_NONCE_BYTES = 12
const CURSOR_TAG_BYTES = 16
const MAX_INTERNAL_CURSOR_LENGTH = 512
const MAX_PUBLIC_CURSOR_LENGTH = 1_024

export type PublicToolItemKind = "tool_call" | "tool_result" | "unknown"

const knownNonToolItemTypes = new Set([
  "agent_message", "user_message", "plan", "reasoning_summary", "subagent_activity",
  "approval_request", "approval_response", "question", "artifact", "context_compaction", "error", "task_graph",
])

/** Classifies persisted item types; unknown future types fail closed at public projection. */
export function classifyPublicItemType(type: string | undefined): PublicToolItemKind | null {
  if (type === "tool_call" || type === "tool_result") return type
  return type && knownNonToolItemTypes.has(type) ? null : "unknown"
}

export interface PublicEventEnvelope {
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  type: string
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  payload: unknown
}

/** Reads bounded item types for events whose payload does not identify its item kind. */
export async function readPublicItemTypes(
  db: Pick<PrismaClient, "agentItem">,
  sessionId: string,
  itemIds: readonly string[],
): Promise<ReadonlyMap<string, string> | null> {
  if (!sessionId || sessionId.length > 256 || itemIds.length > 100) return new Map()
  const ids = [...new Set(itemIds.filter(id => typeof id === "string" && id.length > 0 && id.length <= 2_048))]
  if (ids.length === 0) return new Map()
  try {
    const rows = await db.agentItem.findMany({ where: { sessionId, id: { in: ids } }, select: { id: true, type: true } })
    return new Map(rows.map(row => [row.id, row.type]))
  } catch {
    return null
  }
}

function domainKey(domain: string): Buffer {
  return createHmac("sha256", getAuthSecret()).update(PUBLIC_ID_VERSION + ":" + domain, "utf8").digest()
}

function publicAlias(prefix: string, domain: string, sessionId: string, turnId: string | null, rawId: string): string {
  const message = JSON.stringify([PUBLIC_ID_VERSION, sessionId, turnId, rawId])
  const digest = createHmac("sha256", domainKey(domain)).update(message, "utf8").digest("hex")
  return prefix + "_" + digest
}

/** Opaque, stable per-session-and-Turn alias for provider-controlled tool call IDs. */
export function publicToolCallId(sessionId: string, turnId: string, rawId: string): string {
  return publicAlias("tc", "tool-call", sessionId, turnId, rawId)
}

export function publicToolCallIdOrNull(sessionId: string, turnId: string, value: unknown): string | null {
  return typeof value === "string" ? publicToolCallId(sessionId, turnId, value) : null
}

/** Opaque, stable per-session-and-Turn alias for canonical tool item IDs. */
export function publicToolItemId(sessionId: string, turnId: string, rawId: string): string {
  return publicAlias("ti", "tool-item", sessionId, turnId, rawId)
}

/** Opaque event identifier; use this same function for an event ID and its causation reference. */
export function publicAgentEventId(sessionId: string, rawId: string): string {
  return publicAlias("evt", "event", sessionId, null, rawId)
}

/** Opaque public idempotency metadata. Null remains null. */
export function publicIdempotencyKey(sessionId: string, rawKey: string | null): string | null {
  return rawKey === null ? null : publicAlias("ik", "idempotency", sessionId, null, rawKey)
}

/** Projects identity metadata without changing canonical database rows or worker replay IDs. */
export function projectPublicEventEnvelope<T extends PublicEventEnvelope>(
  event: T,
  itemKind: PublicToolItemKind | null = null,
): T {
  const toolCallEvent = event.type.startsWith("tool_call.")
  const isToolItem = itemKind === "tool_call" || itemKind === "tool_result"
  const itemAlias = itemKind === "unknown"
    ? null
    : isToolItem && event.itemId !== null
    ? publicToolItemId(event.sessionId, event.turnId, event.itemId)
    : event.itemId
  const correlationId = toolCallEvent
    ? publicToolCallId(event.sessionId, event.turnId, event.correlationId)
    : itemKind === "unknown"
      ? publicAlias("cid", "unknown-correlation", event.sessionId, event.turnId, event.correlationId)
      : isToolItem && event.itemId !== null && event.correlationId === event.itemId
      ? publicToolItemId(event.sessionId, event.turnId, event.correlationId)
      : event.correlationId
  return {
    ...event,
    id: publicAgentEventId(event.sessionId, event.id),
    itemId: itemAlias,
    correlationId,
    causationId: event.causationId === null ? null : publicAgentEventId(event.sessionId, event.causationId),
    idempotencyKey: publicIdempotencyKey(event.sessionId, event.idempotencyKey),
    payload: itemKind === "unknown" ? null : projectPayloadIds(event.payload, event.sessionId, event.turnId, itemKind, event.itemId, event.type.startsWith("item.")),
  }
}

/** Restores only internally generated call aliases after the generic payload redactor hides content. */
export function preservePublicToolCallId(redactedPayload: unknown, projectedPayload: unknown, itemKind: PublicToolItemKind | null): unknown {
  if (itemKind !== "tool_call" && itemKind !== "tool_result") return redactedPayload
  const redacted = isRecord(redactedPayload) ? redactedPayload : null
  const projected = isRecord(projectedPayload) ? projectedPayload : null
  if (!redacted || !projected) return redactedPayload
  const output: Record<string, unknown> = { ...redacted }
  const topLevelAlias = publicCallAlias(projected.toolCallId)
  if (topLevelAlias) output.toolCallId = topLevelAlias
  const projectedContent = isRecord(projected.content) ? projected.content : null
  const contentAlias = publicCallAlias(projectedContent?.toolCallId)
  if (contentAlias) output.content = contentWithPublicCallAlias(redacted.content, contentAlias)

  const publicItem = isRecord(projected.item) ? projected.item : null
  const redactedItem = isRecord(redacted.item) ? redacted.item : null
  const publicItemContent = isRecord(publicItem?.content) ? publicItem.content : null
  const itemCallAlias = publicCallAlias(publicItemContent?.toolCallId)
  if (publicItem && redactedItem && itemCallAlias && publicItem.type === itemKind && redactedItem.type === itemKind
    && typeof publicItem.id === "string" && /^ti_[a-f0-9]{64}$/.test(publicItem.id) && redactedItem.id === publicItem.id) {
    output.item = { ...redactedItem, content: contentWithPublicCallAlias(redactedItem.content, itemCallAlias) }
  }
  return output
}

function publicCallAlias(value: unknown): string | null {
  return typeof value === "string" && /^tc_[a-f0-9]{64}$/.test(value) ? value : null
}

function contentWithPublicCallAlias(redactedContent: unknown, alias: string): Record<string, unknown> {
  return { ...(isRecord(redactedContent) ? redactedContent : {}), toolCallId: alias }
}

function projectPayloadIds(
  value: unknown,
  sessionId: string,
  turnId: string,
  itemKind: PublicToolItemKind | null,
  rawItemId: string | null,
  toolItemSnapshotEvent: boolean,
  depth = 0,
): unknown {
  if (depth > 12) return "[REDACTED]"
  if (Array.isArray(value)) return value.map(entry => projectPayloadIds(entry, sessionId, turnId, itemKind, rawItemId, toolItemSnapshotEvent, depth + 1))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "toolCallId" && typeof entry === "string") return [key, publicToolCallId(sessionId, turnId, entry)]
    if (key === "itemId" && (itemKind === "tool_call" || itemKind === "tool_result") && typeof entry === "string" && entry === rawItemId) {
      return [key, publicToolItemId(sessionId, turnId, entry)]
    }
    if (key === "item" && toolItemSnapshotEvent && (itemKind === "tool_call" || itemKind === "tool_result")) {
      return [key, isMatchingToolItem(entry, sessionId, turnId, itemKind, rawItemId)
        ? projectToolItem(entry, sessionId, turnId, itemKind, rawItemId, depth + 1)
        : "[REDACTED]"]
    }
    return [key, projectPayloadIds(entry, sessionId, turnId, itemKind, rawItemId, toolItemSnapshotEvent, depth + 1)]
  }))
}

function isMatchingToolItem(value: unknown, sessionId: string, turnId: string, itemKind: PublicToolItemKind | null, rawItemId: string | null): value is Record<string, unknown> {
  return (itemKind === "tool_call" || itemKind === "tool_result") && rawItemId !== null && isRecord(value)
    && value.id === rawItemId && value.sessionId === sessionId && value.turnId === turnId && value.type === itemKind
    && typeof value.status === "string" && Number.isSafeInteger(value.revision) && Object.hasOwn(value, "content")
}

function projectToolItem(
  item: Record<string, unknown>, sessionId: string, turnId: string,
  itemKind: PublicToolItemKind | null, rawItemId: string | null, depth: number,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [
    key,
    key === "id" && typeof value === "string" && value === rawItemId
      ? publicToolItemId(sessionId, turnId, value)
      : projectPayloadIds(value, sessionId, turnId, itemKind, rawItemId, false, depth + 1),
  ]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Seals the existing keyset cursor without changing its internal format. Auth-secret rotation
 * changes aliases and cursor seals; clients must rehydrate after reauthentication. Seals are
 * computed at request time and are never persisted.
 */
export function sealPublicTimelineCursor(sessionId: string, internalCursor: string): string {
  if (!sessionId || sessionId.length > 256 || !internalCursor || internalCursor.length > MAX_INTERNAL_CURSOR_LENGTH) {
    throw new TypeError("invalid_public_timeline_cursor")
  }
  const nonce = randomBytes(CURSOR_NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", domainKey("timeline-cursor"), nonce)
  cipher.setAAD(Buffer.from(JSON.stringify([CURSOR_AAD_VERSION, sessionId]), "utf8"))
  const ciphertext = Buffer.concat([cipher.update(internalCursor, "utf8"), cipher.final()])
  const packed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")
  return CURSOR_PREFIX + packed
}

/** Opens a sealed cursor for the existing parser. Legacy cursors pass through only for
 * compatibility; parsePageRequest remains responsible for validating their contents.
 */
export function openPublicTimelineCursor(sessionId: string, publicOrLegacyCursor: string): string | null {
  if (!sessionId || sessionId.length > 256 || !publicOrLegacyCursor || publicOrLegacyCursor.length > MAX_PUBLIC_CURSOR_LENGTH) return null
  if (!publicOrLegacyCursor.startsWith(CURSOR_PREFIX)) {
    return publicOrLegacyCursor.length <= MAX_INTERNAL_CURSOR_LENGTH ? publicOrLegacyCursor : null
  }
  const encoded = publicOrLegacyCursor.slice(CURSOR_PREFIX.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    const packed = Buffer.from(encoded, "base64url")
    if (packed.toString("base64url") !== encoded || packed.length < CURSOR_NONCE_BYTES + CURSOR_TAG_BYTES) return null
    const nonce = packed.subarray(0, CURSOR_NONCE_BYTES)
    const tag = packed.subarray(CURSOR_NONCE_BYTES, CURSOR_NONCE_BYTES + CURSOR_TAG_BYTES)
    const ciphertext = packed.subarray(CURSOR_NONCE_BYTES + CURSOR_TAG_BYTES)
    const decipher = createDecipheriv("aes-256-gcm", domainKey("timeline-cursor"), nonce)
    decipher.setAAD(Buffer.from(JSON.stringify([CURSOR_AAD_VERSION, sessionId]), "utf8"))
    decipher.setAuthTag(tag)
    const cursor = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
    return cursor.length > 0 && cursor.length <= MAX_INTERNAL_CURSOR_LENGTH ? cursor : null
  } catch {
    return null
  }
}
