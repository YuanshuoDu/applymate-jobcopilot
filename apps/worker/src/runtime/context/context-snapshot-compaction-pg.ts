import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { snapshotChecksum, parseSnapshotContent } from "./context-snapshot-canonical.js"
import { canonicalJson } from "./context-snapshot-json.js"
import { canonicalJson as compactionJson } from "./context-compaction-canonical.js"
import { COMPACTION_ITEM_TYPE, type CompactionItemRecord, type CompactionSnapshotDraft } from "./context-compaction-types.js"
import type { CompactionSnapshotRef, ContextSnapshotCompactionPort } from "./context-snapshot-compaction-seam.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { toRepositoryJson } from "../turns/turn-engine-types.js"
import {
  appendCompactionEvent, assertCompactionScope, compactionConflict, jsonEqual, jsonText, latestCompactionSnapshot,
  withCompactionOwner, type CompactionPgClient, type CompactionPgPool, type CompactionPgRow,
} from "./context-compaction-pg-store.js"

type CompactionMarker = { readonly itemId: string; readonly digest: string }
type StoredContent = Record<string, unknown> & { readonly compaction?: CompactionMarker }

function itemContent(item: CompactionItemRecord): RepositoryJsonValue {
  return toRepositoryJson({ body: item.body, data: item.data })
}
function itemEnvelope(value: CompactionItemRecord): RepositoryJsonValue {
  return itemContent(value)
}
function ref(row: { id: string; sessionId: string; throughSequence: bigint | string; version: number | string } | null): CompactionSnapshotRef | null {
  return row ? { id: row.id, sessionId: row.sessionId, throughSequence: BigInt(row.throughSequence), version: Number(row.version) } : null
}
function sameRef(left: CompactionSnapshotRef | null, right: CompactionSnapshotRef | null): boolean {
  return left === null ? right === null : right !== null && left.id === right.id && left.sessionId === right.sessionId
    && left.throughSequence === right.throughSequence && left.version === right.version
}
function draftDigest(draft: CompactionSnapshotDraft, item: CompactionItemRecord): string {
  return createHash("sha256").update(compactionJson({ state: draft.state, summary: draft.narrativeSummary, measurement: draft.tokenMeasurement, sourceItemIds: [...draft.sourceItemIds], itemId: item.id }), "utf8").digest("hex")
}
function contentFor(draft: CompactionSnapshotDraft, marker: CompactionMarker, previous: unknown): Record<string, unknown> {
  const old = previous === null ? null : parseSnapshotContent(previous)
  const oldContext = old?.context ?? { system: [], profile: [], steerHistory: [], toolObservations: [] }
  const content: Record<string, unknown> = {
    ...(old ?? {}), schemaVersion: "agent-harness.context.v1", ownerId: draft.scope.userId, sessionId: draft.state.sessionId,
    throughSequence: draft.state.throughSequence.toString(), goal: draft.state.goal, userConstraints: [...draft.state.userConstraints],
    confirmedDecisions: old?.confirmedDecisions ?? [], completedWork: old?.completedWork ?? [],
    openWork: draft.state.openTasks.map(task => ({ taskId: task.taskId, status: task.status, blocker: task.blocker })),
    pendingApprovals: draft.state.approvals.map(value => JSON.stringify(value)).sort(), artifacts: [...draft.state.artifacts], facts: [...draft.state.facts],
    failedAttempts: old?.failedAttempts ?? [], references: old?.references ?? [], consumedInputIds: old?.consumedInputIds ?? [],
    context: { ...oldContext, toolObservations: [{ id: `compaction:${marker.itemId}`, content: { summary: draft.narrativeSummary, throughSequence: draft.state.throughSequence.toString() } }] },
    tokenAccounting: old?.tokenAccounting ?? { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    compaction: { ...marker, state: draft.state, narrativeSummary: draft.narrativeSummary, tokenMeasurement: draft.tokenMeasurement,
      sourceItemIds: [...draft.sourceItemIds] },
  }
  return content
}
function summary(draft: CompactionSnapshotDraft): string { return draft.narrativeSummary.trim() || `Goal: ${draft.state.goal}` }
function assertTurnUnpinned(turn: CompactionPgRow): void {
  if (turn.contextSnapshotId !== null) throw compactionConflict("turn has an explicit context snapshot pin")
}
function validateItems(started: CompactionItemRecord, completed: CompactionItemRecord, draft: CompactionSnapshotDraft, owner: TurnExecutionOwnerFence): void {
  assertCompactionScope(draft.scope, owner, started.sessionId, started.turnId)
  if (completed.id !== started.id || started.sessionId !== owner.sessionId || started.turnId !== owner.turnId || completed.status !== "completed"
    || started.status !== "started" || started.type !== COMPACTION_ITEM_TYPE || completed.type !== COMPACTION_ITEM_TYPE
    || draft.state.ownerId !== owner.userId || draft.state.sessionId !== owner.sessionId || draft.state.throughSequence < 0n
    || draft.sourceItemIds.some(id => !id.trim()) || new Set(draft.sourceItemIds).size !== draft.sourceItemIds.length) throw compactionConflict("compaction input identity")
}
async function ensureStartedItem(client: CompactionPgClient, owner: TurnExecutionOwnerFence, item: CompactionItemRecord): Promise<void> {
  const content = itemContent(item)
  const inserted = await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, $4, $5, 'started', NULL, 0, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING`,
  [item.id, item.sessionId, item.turnId, owner.taskId, COMPACTION_ITEM_TYPE, jsonText(content)])
  if (inserted.rowCount === 1) return
  const existing = await client.query<CompactionPgRow>(`SELECT "sessionId", "turnId", "taskId", "type", "status", "content" FROM "agent_items" WHERE "id" = $1 FOR UPDATE`, [item.id])
  const row = existing.rows[0]
  const storedData = (row?.content as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined
  if (!row || row.sessionId !== item.sessionId || row.turnId !== item.turnId || row.taskId !== owner.taskId || row.type !== COMPACTION_ITEM_TYPE
    || !["started", "completed", "failed"].includes(String(row.status)) || storedData?.reason !== item.data.reason
    || storedData.throughSequence !== item.data.throughSequence || storedData.sourceItemCount !== item.data.sourceItemCount) {
    throw compactionConflict(`item ${item.id} identity`)
  }
}
async function transitionItem(client: CompactionPgClient, owner: TurnExecutionOwnerFence, item: CompactionItemRecord, status: "completed" | "failed"): Promise<void> {
  const content = itemContent(item)
  const changed = await client.query(`UPDATE "agent_items" SET "status" = $1, "content" = $2::jsonb, "revision" = "revision" + 1,
    "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "taskId" = $6
      AND "type" = $7 AND "status" = 'started' AND "revision" = 0`, [status, jsonText(content), item.id, item.sessionId, item.turnId, owner.taskId, COMPACTION_ITEM_TYPE])
  if (changed.rowCount === 1) return
  const existing = await client.query<CompactionPgRow>(`SELECT "status", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 FOR UPDATE`, [item.id, item.sessionId, item.turnId, owner.taskId])
  if (existing.rows[0]?.status !== status || !jsonEqual(existing.rows[0].content, content)) throw compactionConflict(`item ${item.id} ${status} CAS`)
}
async function ensureSnapshot(client: CompactionPgClient, owner: TurnExecutionOwnerFence, draft: CompactionSnapshotDraft, content: Record<string, unknown>, version: number, itemId: string): Promise<CompactionSnapshotRef> {
  const base = { sessionId: draft.state.sessionId, throughSequence: draft.state.throughSequence, version, content: content as never }
  const checksum = snapshotChecksum(base)
  const rowId = `context-compaction:${owner.sessionId}:${draft.state.throughSequence}`
  const tokenAccounting = content.tokenAccounting as { totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number }
  const summaryText = summary(draft)
  const inserted = await client.query<{ id: string; sessionId: string; throughSequence: bigint | string; version: number | string }>(`INSERT INTO "agent_context_snapshots"
    ("id", "sessionId", "throughSequence", "version", "schemaVersion", "content", "summary", "checksum", "inputTokens", "outputTokens", "estimatedCostUsd", "tokenAccounting")
    VALUES ($1, $2, $3, $4, 'agent-harness.context.v1', $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb) ON CONFLICT DO NOTHING
    RETURNING "id", "sessionId", "throughSequence", "version"`, [rowId, owner.sessionId, draft.state.throughSequence.toString(), version, canonicalJsonText(content), summaryText, checksum,
    tokenAccounting.totalInputTokens, tokenAccounting.totalOutputTokens, Number(tokenAccounting.totalCostUsd).toFixed(8), canonicalJsonText(tokenAccounting)])
  const saved = inserted.rows[0] ?? (await client.query<{ id: string; sessionId: string; throughSequence: bigint | string; version: number | string; checksum: string }>(`SELECT "id", "sessionId", "throughSequence", "version", "checksum" FROM "agent_context_snapshots"
      WHERE "sessionId" = $1 AND ("throughSequence" = $2 OR "version" = $3) FOR UPDATE`, [owner.sessionId, draft.state.throughSequence.toString(), version])).rows[0]
  if (!saved || saved.sessionId !== owner.sessionId || String(saved.throughSequence) !== draft.state.throughSequence.toString() || Number(saved.version) !== version
    || ("checksum" in saved && saved.checksum !== checksum)) throw compactionConflict(`snapshot ${itemId} CAS`)
  return { id: saved.id, sessionId: saved.sessionId, throughSequence: BigInt(saved.throughSequence), version: Number(saved.version) }
}
function canonicalJsonText(value: unknown): string { return canonicalJson(value) }

export function createPgContextSnapshotCompactionPort(pool: CompactionPgPool, owner: TurnExecutionOwnerFence): ContextSnapshotCompactionPort {
  return {
    async loadLatest(input): Promise<CompactionSnapshotRef | null> {
      assertCompactionScope(input.scope, owner, input.sessionId, owner.turnId)
      return withCompactionOwner(pool, input.scope, owner, async client => ref(await latestCompactionSnapshot(client, input.sessionId)))
    },
    async recordStarted(item, scope): Promise<void> {
      assertCompactionScope(scope, owner, item.sessionId, item.turnId)
      await withCompactionOwner(pool, scope, owner, async (client, turn) => {
        assertTurnUnpinned(turn)
        await ensureStartedItem(client, owner, item)
        await appendCompactionEvent(client, { owner, id: `${item.id}:started`, itemId: item.id, type: "item.started", idempotencyKey: `context-compaction:${item.id}:started`, causationId: null,
          payload: { itemId: item.id, type: COMPACTION_ITEM_TYPE, phase: null } })
      })
    },
    async publishAtomically(input): Promise<CompactionSnapshotRef> {
      const { scope, draft, startedItem, completedItem, previousSnapshot } = input
      validateItems(startedItem, completedItem, draft, owner)
      return withCompactionOwner(pool, scope, owner, async (client, turn) => {
        assertTurnUnpinned(turn)
        const latest = await latestCompactionSnapshot(client, owner.sessionId, true)
        const current = ref(latest)
        const digest = draftDigest(draft, startedItem)
        const currentContent = latest?.content as StoredContent | undefined
        if (current && currentContent?.compaction?.itemId === startedItem.id && currentContent.compaction.digest === digest) {
          await transitionItem(client, owner, completedItem, "completed")
          await appendCompactionEvent(client, { owner, id: `${startedItem.id}:completed`, itemId: startedItem.id, type: "item.completed", idempotencyKey: `context-compaction:${startedItem.id}:completed`, causationId: `${startedItem.id}:started`,
            payload: { itemId: startedItem.id, status: "completed", content: itemEnvelope(completedItem) } })
          return current
        }
        if (!sameRef(current, previousSnapshot)) throw compactionConflict("snapshot latest-version CAS")
        const nextVersion = (current?.version ?? 0) + 1
        const content = contentFor(draft, { itemId: startedItem.id, digest }, latest?.content ?? null)
        const snapshot = await ensureSnapshot(client, owner, draft, content, nextVersion, startedItem.id)
        await transitionItem(client, owner, completedItem, "completed")
        await appendCompactionEvent(client, { owner, id: `${startedItem.id}:completed`, itemId: startedItem.id, type: "item.completed", idempotencyKey: `context-compaction:${startedItem.id}:completed`, causationId: `${startedItem.id}:started`,
          payload: { itemId: startedItem.id, status: "completed", content: itemEnvelope(completedItem) } })
        return snapshot
      })
    },
    async recordFailed(item, scope): Promise<void> {
      assertCompactionScope(scope, owner, item.sessionId, item.turnId)
      await withCompactionOwner(pool, scope, owner, async (client, turn) => {
        assertTurnUnpinned(turn)
        await transitionItem(client, owner, item, "failed")
        await appendCompactionEvent(client, { owner, id: `${item.id}:failed`, itemId: item.id, type: "item.failed", idempotencyKey: `context-compaction:${item.id}:failed`, causationId: `${item.id}:started`,
          payload: { itemId: item.id, errorCode: item.data.errorCode ?? "publish_failed", content: itemEnvelope(item) } })
      })
    },
  }
}
