import type { PoolClient } from "pg"
import {
  canonicalJson, parseObjectiveApplicationSubmissionManifest, parseObjectiveReviewedFillSource,
  type ObjectiveApplicationSubmissionManifest,
} from "@jobcopilot/shared"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"

type Client = Pick<PoolClient, "query">
export type ObjectiveSubmissionManifestScope = Readonly<{
  userId: string; sessionId: string; applicationTaskId: string; jobId: string; fillTurnId: string
}>
type Row = Record<string, unknown>
type CurrentTask = Row & { id: string; userId: string; jobId: string; sessionId: string; fillTurnId: string;
  fillTurnSessionId: string; fillTurnUserId: string; resumeId: string | null; coverLetterId: string | null; fillInput: unknown }
type StoredManifestEvent = Readonly<{
  schemaVersion: "agent-harness.v2.objective-submission-manifest-event.v1"
  scope: ObjectiveSubmissionManifestScope; manifest: ObjectiveApplicationSubmissionManifest; hash: string
}>
type StoredResult = Readonly<{ manifest: ObjectiveApplicationSubmissionManifest; hash: string }>

const EVENT_SCHEMA = "agent-harness.v2.objective-submission-manifest-event.v1" as const
const EVENT_TYPE = "objective_submission_manifest_recorded"
const EVENT_ACTOR = "worker"
const EVENT_BODY = "Objective submission manifest recorded for this fill attempt."
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const HASH = /^sha256:[a-f0-9]{64}$/

/** Records an immutable Objective-only manifest on the caller's current Fill attempt. */
export async function recordObjectiveSubmissionManifestWithClient(
  client: Client, scope: ObjectiveSubmissionManifestScope, value: unknown,
): Promise<StoredResult | null> {
  const checked = await checkCurrent(client, scope, "UPDATE")
  const manifest = parseObjectiveApplicationSubmissionManifest(value)
  if (!checked || !manifest || !manifestMatches(manifest, checked)) return null
  let hash: string
  try { hash = hashArtifactContent(manifest) } catch { return null }
  const id = eventId(scope)
  if (!HASH.test(hash) || !id) return null
  const data: StoredManifestEvent = { schemaVersion: EVENT_SCHEMA, scope: { ...scope }, manifest, hash }
  await client.query(`INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data")
    VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT ("id") DO NOTHING`,
  [id, scope.applicationTaskId, EVENT_TYPE, EVENT_ACTOR, EVENT_BODY, JSON.stringify(data)])
  const stored = await readObjectiveSubmissionManifestWithClient(client, scope)
  return stored && stored.hash === hash && canonicalJson(stored.manifest) === canonicalJson(manifest) ? stored : null
}

/** Reads only a manifest bound to the exact current Task/Turn pointer and its immutable event. */
export async function readObjectiveSubmissionManifestWithClient(
  client: Client, scope: ObjectiveSubmissionManifestScope,
): Promise<StoredResult | null> {
  const checked = await checkCurrent(client, scope, "SHARE"), id = eventId(scope)
  if (!checked || !id) return null
  const result = await client.query<Row>(`SELECT "id", "taskId", "type", "actor", "body", "data"
    FROM "application_task_events" WHERE "taskId" = $2 AND ("id" = $1
      OR ("type" = $3 AND "data" #>> '{scope,fillTurnId}' = $4)) LIMIT 2`,
  [id, scope.applicationTaskId, EVENT_TYPE, scope.fillTurnId])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]
  if (!row || row.id !== id || row.taskId !== scope.applicationTaskId || row.type !== EVENT_TYPE
    || row.actor !== EVENT_ACTOR || row.body !== EVENT_BODY) return null
  const packet = parseEvent(row.data)
  if (!packet || canonicalJson(packet.scope) !== canonicalJson(scope) || !manifestMatches(packet.manifest, checked)) return null
  return { manifest: packet.manifest, hash: packet.hash }
}

async function checkCurrent(client: Client, scope: ObjectiveSubmissionManifestScope, lock: "UPDATE" | "SHARE"): Promise<CurrentTask | null> {
  if (!validScope(scope)) return null
  const result = await client.query<CurrentTask>(`SELECT task."id", task."userId", task."jobId", task."sessionId",
      task."fillTurnId", task."fillTurnSessionId", task."fillTurnUserId", task."resumeId", task."coverLetterId",
      turn."input" AS "fillInput"
    FROM "application_tasks" AS task
    JOIN "agent_turns" AS turn ON turn."id" = task."fillTurnId"
      AND turn."sessionId" = task."fillTurnSessionId" AND turn."userId" = task."fillTurnUserId"
    WHERE task."id" = $1 AND task."userId" = $2 AND task."jobId" = $3 AND task."sessionId" = $4
      AND task."fillTurnId" = $5 AND task."fillTurnSessionId" = $4 AND task."fillTurnUserId" = $2
      AND turn."id" = $5 AND turn."sessionId" = $4 AND turn."userId" = $2
    LIMIT 2 FOR ${lock} OF task`, [scope.applicationTaskId, scope.userId, scope.jobId, scope.sessionId, scope.fillTurnId])
  const task = result.rows[0]
  if (result.rows.length !== 1 || !task || task.id !== scope.applicationTaskId || task.userId !== scope.userId
    || task.jobId !== scope.jobId || task.sessionId !== scope.sessionId || task.fillTurnId !== scope.fillTurnId
    || task.fillTurnSessionId !== scope.sessionId || task.fillTurnUserId !== scope.userId) return null
  return task
}

function manifestMatches(manifest: ObjectiveApplicationSubmissionManifest, task: CurrentTask): boolean {
  const source = parseObjectiveReviewedFillSource(task.fillInput)
  return manifest.material.applicationTaskId === task.id && manifest.material.jobId === task.jobId
    && manifest.material.resumeId === task.resumeId && manifest.material.coverLetterId === task.coverLetterId
    && !!source && canonicalJson(source) === canonicalJson(manifest.material.objectiveSource)
}

function parseEvent(value: unknown): StoredManifestEvent | null {
  const row = record(value), scope = row && parseScope(row.scope)
  const manifest = row && parseObjectiveApplicationSubmissionManifest(row.manifest)
  if (!row || !scope || !manifest || !exactKeys(row, ["schemaVersion", "scope", "manifest", "hash"])
    || row.schemaVersion !== EVENT_SCHEMA || typeof row.hash !== "string" || !HASH.test(row.hash)) return null
  let hash: string
  try { hash = hashArtifactContent(manifest) } catch { return null }
  return hash === row.hash ? { schemaVersion: EVENT_SCHEMA, scope, manifest, hash } : null
}

function parseScope(value: unknown): ObjectiveSubmissionManifestScope | null {
  const row = record(value)
  if (!row || !exactKeys(row, ["userId", "sessionId", "applicationTaskId", "jobId", "fillTurnId"])) return null
  const scope = { userId: row.userId, sessionId: row.sessionId, applicationTaskId: row.applicationTaskId,
    jobId: row.jobId, fillTurnId: row.fillTurnId }
  return validScope(scope) ? scope : null
}

function eventId(value: unknown): string | null {
  if (!validScope(value)) return null
  const scope = value
  try { return `objective-submission-manifest:${hashArtifactContent([scope.applicationTaskId, scope.fillTurnId]).slice(7)}` }
  catch { return null }
}
function validScope(value: unknown): value is ObjectiveSubmissionManifestScope {
  const row = record(value)
  return !!row && exactKeys(row, ["userId", "sessionId", "applicationTaskId", "jobId", "fillTurnId"])
    && [row.userId, row.sessionId, row.applicationTaskId, row.jobId, row.fillTurnId]
      .every(entry => typeof entry === "string" && ID.test(entry))
}
function exactKeys(value: Row, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Object.keys(value).sort().join(",") === [...keys].sort().join(",")
}
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null
    const keys = Reflect.ownKeys(value)
    return keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) ? value as Row : null
  } catch { return null }
}
