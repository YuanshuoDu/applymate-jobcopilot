import { Buffer } from "node:buffer"; import { createHash } from "node:crypto"; import type pg from "pg"
import type { TaskGraphNodeProposal } from "../planning/task-graph.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"; import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { TaskGraphVerificationDependencyBinding } from "./task-graph-verification-report.js"; import type { AnalystResult } from "./role-results.js"
import { readScheduledDraftAnalystProof } from "./scheduled-draft-candidate-analyst-proof.js"
import type { TaskGraphTaskTemplate } from "./task-graph-command-port.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const BINDING_VERSION = "agent-harness.v2.scheduled-draft-candidate-binding.v1" as const
const CANONICAL_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_FINDINGS = 512
const MAX_ANALYSTS = 8
export type ScheduledDraftCandidate = Readonly<{ jobId: string; score: number }>
export type ScheduledDraftCandidateWitness = Readonly<{ bindingVersion: typeof BINDING_VERSION; graphRevision: number; graphDigest: string; stableStatusDigest: string; lifecycleStatuses?: Readonly<{ writer: string; reviewer: string }>; newlyProposedNodeKeys: readonly string[]; candidate: ScheduledDraftCandidate; sourceAnalystKeys: readonly string[]; analysts: readonly Readonly<{ nodeKey: string; taskId: string; attemptCount: number; resultDigest: string; evidenceDigest: string; reportDigest: string; scouts: readonly TaskGraphVerificationDependencyBinding[] }>[] }>
export type ScheduledDraftCandidateBinding = Readonly<{ candidate: ScheduledDraftCandidate; witness: ScheduledDraftCandidateWitness }>
export type ScheduledDraftCandidateSelection = ScheduledDraftCandidateBinding & Readonly<{ sourceAnalystKeys: readonly string[] }>
export type LoadedScheduledDraftCandidateBinding = Readonly<{
  status: "bound"; jobId: string; graphRevision: number; witness: ScheduledDraftCandidateWitness; snapshot: TaskGraphSnapshot
}> | Readonly<{ status: "absent" }>
/** Select only canonical job IDs and numeric scores; all other data is intentionally outside this lane. */
export function selectTopScheduledDraftCandidate(values: readonly unknown[]): ScheduledDraftCandidate | undefined {
  if (!dense(values, MAX_FINDINGS)) return undefined
  const best = new Map<string, number>()
  for (const value of values) {
    const row = exactRecord(value, "jobId,score")
    if (!row || !canonicalJobId(row.jobId) || typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 10) return undefined
    best.set(row.jobId, Math.max(best.get(row.jobId) ?? -1, row.score))
  }
  const ordered = [...best].sort(([left], [right]) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
  const winner = ordered.reduce<[string, number] | undefined>((current, item) => !current || item[1] > current[1] ? item : current, undefined)
  return winner ? { jobId: winner[0], score: winner[1] } : undefined
}
export function isScheduledDraftTemplate(templates: Readonly<Record<string, TaskGraphTaskTemplate>>): boolean {
  const markers = Object.entries(templates).filter(([, template]) => { const context = plainRecord(template.context); return context && Object.hasOwn(context, "scheduledDraftMode") })
  if (!markers.length) return false
  const writer = templates.cover_letter_writer, reviewer = templates.cover_letter_reviewer
  if (markers.length !== 2 || writer?.role !== "writer" || reviewer?.role !== "reviewer"
    || plainRecord(writer.context)?.scheduledDraftMode !== true || plainRecord(reviewer.context)?.scheduledDraftMode !== true) throw new Error("scheduled_draft_template_marker_invalid")
  return true
}
export function scheduledDraftPair(nodes: readonly TaskGraphNodeProposal[], currentKeys: ReadonlySet<string>) {
  const writers = nodes.filter(node => node.templateId === "cover_letter_writer"), reviewers = nodes.filter(node => node.templateId === "cover_letter_reviewer")
  if (!writers.length && !reviewers.length) return undefined
  if (writers.length !== 1 || reviewers.length !== 1) throw Object.assign(new Error("Scheduled draft requires exactly one Writer and Reviewer"), { code: "task_graph_scheduled_draft_pair_invalid" })
  const [writer] = writers, [reviewer] = reviewers
  if (reviewer!.dependsOn.length !== 1 || reviewer!.dependsOn[0] !== writer!.key || currentKeys.has(writer!.key) !== currentKeys.has(reviewer!.key)) throw Object.assign(new Error("Scheduled Reviewer must depend only on the same Turn Writer"), { code: "task_graph_scheduled_draft_pair_invalid" })
  return currentKeys.has(writer!.key) ? undefined : { writer: writer!, reviewer: reviewer! }
}
export function scheduledDraftTaskContext(template: TaskGraphTaskTemplate, binding?: ScheduledDraftCandidateBinding): unknown {
  const { scheduledDraftMode: _marker, ...context } = plainRecord(template.context) ?? {}
  return binding ? { ...context, scheduledDraftCandidateMode: true, selectedJobPreparation: { jobId: binding.candidate.jobId }, scheduledDraftCandidateWitness: binding.witness } : context
}

/** Verify the complete server-supplied completed Analyst pool and bind its winner with exact source keys. */
export async function selectVerifiedScheduledDraftCandidate(
  client: Queryable, scope: GraphIdentityScope, currentSnapshot: TaskGraphSnapshot, graphRevision: number, completedAnalystKeys: readonly string[], statusByKey: ReadonlyMap<string, string>, newlyProposedNodeKeys: readonly string[] = [],
): Promise<ScheduledDraftCandidateSelection | undefined> {
  const snapshot = parseSnapshot(currentSnapshot), keys = validAnalystKeys(completedAnalystKeys), addedKeys = snapshot && validNewNodeKeys(newlyProposedNodeKeys, snapshot), stableStatusDigest = statusDigest(snapshot, statusByKey, addedKeys ?? [])
  const expectedKeys = snapshot?.nodes.filter(node => node.templateId === "analyst" && node.verificationDisposition === "typed" && statusByKey.get(node.key) === "completed").map(node => node.key).sort(compareBytesText)
  if (!snapshot || !validRevision(graphRevision) || !validScope(scope) || !keys || !addedKeys || !stableStatusDigest
    || canonicalTaskGraphJson(keys.sort(compareBytesText)) !== canonicalTaskGraphJson(expectedKeys)) return undefined
  const verified = [] as Array<{ result: AnalystResult; binding: ScheduledDraftCandidateWitness["analysts"][number] }>
  for (const key of [...keys].sort(compareBytesText)) {
    const node = snapshot.nodes.find(item => item.key === key)
    const current = node && await readScheduledDraftAnalystProof(client, scope, snapshot, node)
    if (!current) return undefined
    verified.push(current)
  }
  const candidate = selectTopScheduledDraftCandidate(verified.flatMap(item => item.result.findings.map(({ jobId, score }) => ({ jobId, score }))))
  if (!candidate) return undefined
  const sourceAnalystKeys = verified.filter(item => item.result.findings.some(finding => finding.jobId === candidate.jobId && finding.score === candidate.score)).map(item => item.binding.nodeKey).sort(compareBytesText)
  const lifecycle = lifecycleStatuses(snapshot, statusByKey)
  if (snapshot.nodes.some(node => isWriterNode(node) || isReviewerNode(node)) && (!lifecycle || !validStatus(lifecycle.writer) || !validStatus(lifecycle.reviewer))) return undefined
  if (verified.some(item => addedKeys.includes(item.binding.nodeKey) || item.binding.scouts.some(scout => addedKeys.includes(scout.nodeKey)))) return undefined
  return { candidate, sourceAnalystKeys, witness: makeWitness(graphRevision, snapshot, stableStatusDigest, candidate, verified.map(item => item.binding), sourceAnalystKeys, lifecycle, addedKeys) }
}

export async function readScheduledDraftCandidateBinding(client: Queryable, scope: GraphIdentityScope): Promise<LoadedScheduledDraftCandidateBinding> {
  if (!validScope(scope)) throw new Error("scheduled_draft_candidate_binding_invalid")
  const graph = await client.query(`SELECT item."id", item."revision", item."content", item."sessionId", item."turnId", item."taskId",
      session."userId" AS "userId", turn."rootTaskId" AS "turnRootTaskId"
    FROM "agent_items" AS item JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4 AND item."type" = 'task_graph'
      AND session."userId" = $5 AND turn."userId" = $5`,
  [taskGraphItemId(scope.parentTaskId), scope.sessionId, scope.turnId, scope.parentTaskId, scope.userId])
  const item = graph.rows[0] as Row | undefined
  if (!item) { await assertNoOrphans(client, scope, true); return { status: "absent" } }
  if (graph.rows.length !== 1 || item.id !== taskGraphItemId(scope.parentTaskId) || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId
    || item.taskId !== scope.parentTaskId || item.userId !== scope.userId || item.turnRootTaskId !== scope.rootTaskId || !validRevision(item.revision)) throw new Error("scheduled_draft_candidate_binding_invalid")
  const snapshot = parseSnapshot(item.content)
  if (!snapshot) throw new Error("scheduled_draft_candidate_binding_invalid")
  const writers = snapshot.nodes.filter(isWriterNode), reviewers = snapshot.nodes.filter(isReviewerNode)
  if (!writers.length && !reviewers.length) { await assertNoOrphans(client, scope, false); return { status: "absent" } }
  if (writers.length !== 1 || reviewers.length !== 1 || reviewers[0]!.dependsOn.length !== 1 || reviewers[0]!.dependsOn[0] !== writers[0]!.key) throw new Error("scheduled_draft_candidate_binding_invalid")
  const [writer, reviewer] = [writers[0]!, reviewers[0]!]
  const byId = await readScopedGraphTasks(client, scope, snapshot)
  if (!byId) throw new Error("scheduled_draft_candidate_binding_invalid")
  const currentStatuses = new Map(snapshot.nodes.map(node => [node.key, String(byId.get(node.taskId)!.status)]))
  const completedKeys = snapshot.nodes.filter(node => node.templateId === "analyst" && node.verificationDisposition === "typed" && byId.get(node.taskId)!.status === "completed").map(node => node.key).sort(compareBytesText)
  const found: ScheduledDraftCandidateWitness[] = []
  for (const node of [writer, reviewer]) {
    const row = byId.get(node.taskId)
    if (!row) throw new Error("scheduled_draft_candidate_binding_invalid")
    if (row.sessionId !== scope.sessionId || row.turnId !== scope.turnId || row.rootTaskId !== scope.rootTaskId || row.parentTaskId !== scope.parentTaskId
      || row.userId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId) throw new Error("scheduled_draft_candidate_binding_invalid")
    const context = plainRecord(parseJson(row.context))
    if (!context || context.scheduledDraftCandidateMode !== true || !Object.hasOwn(context, "scheduledDraftCandidateWitness")) throw new Error("scheduled_draft_candidate_binding_invalid")
    const witness = parseScheduledDraftCandidateWitness(context.scheduledDraftCandidateWitness)
    const selected = plainRecord(context.selectedJobPreparation)
    if (!witness || !selected || Object.keys(selected).sort().join(",") !== "jobId" || selected.jobId !== witness.candidate.jobId
      || witness.graphRevision > Number(item.revision) || !validWitnessNewKeys(witness, snapshot) || witness.graphDigest !== structuralGraphDigest(snapshot, witness.newlyProposedNodeKeys) || witness.stableStatusDigest !== statusDigest(snapshot, currentStatuses, witness.newlyProposedNodeKeys)
      || !lifecycleStatusesValid(witness, snapshot, currentStatuses)
      || canonicalTaskGraphJson(witness.analysts.map(value => value.nodeKey)) !== canonicalTaskGraphJson(completedKeys)
      || isWriterNode(node) && !witness.sourceAnalystKeys.every(key => writer.dependsOn.includes(key))
      || !witnessReachableFromNode(witness, node, snapshot) || row.role !== (isWriterNode(node) ? "writer" : "reviewer")) throw new Error("scheduled_draft_candidate_binding_invalid")
    found.push(witness)
  }
  if (found.some(value => canonicalTaskGraphJson(value) !== canonicalTaskGraphJson(found[0]))) throw new Error("scheduled_draft_candidate_binding_invalid")
  const witness = found[0]!
  return { status: "bound", jobId: witness.candidate.jobId, graphRevision: Number(item.revision), witness, snapshot }
}

export async function validateScheduledDraftCandidateWitness(
  client: Queryable, scope: GraphIdentityScope, currentSnapshot: TaskGraphSnapshot, graphRevision: number,
  jobId: string, witnessValue: unknown,
): Promise<boolean> {
  const snapshot = parseSnapshot(currentSnapshot), witness = parseScheduledDraftCandidateWitness(witnessValue)
  if (!snapshot || !validScope(scope) || !validRevision(graphRevision) || !witness || witness.graphRevision > graphRevision
    || !validWitnessNewKeys(witness, snapshot) || witness.graphDigest !== structuralGraphDigest(snapshot, witness.newlyProposedNodeKeys)
    || !canonicalJobId(jobId) || witness.candidate.jobId !== jobId) return false
  const writers = snapshot.nodes.filter(isWriterNode), reviewers = snapshot.nodes.filter(isReviewerNode)
  if (writers.length !== 1 || reviewers.length !== 1 || reviewers[0]!.dependsOn.length !== 1 || reviewers[0]!.dependsOn[0] !== writers[0]!.key
    || !witness.sourceAnalystKeys.every(key => writers[0]!.dependsOn.includes(key))) return false
  const rows = await readScopedGraphTasks(client, scope, snapshot)
  if (!rows) return false
  const currentStatuses = new Map(snapshot.nodes.map(node => [node.key, String(rows.get(node.taskId)!.status)]))
  const currentStatusDigest = statusDigest(snapshot, currentStatuses, witness.newlyProposedNodeKeys)
  if (!lifecycleStatusesValid(witness, snapshot, currentStatuses)) return false
  const currentPool = snapshot.nodes.filter(node => node.templateId === "analyst" && node.verificationDisposition === "typed" && rows.get(node.taskId)!.status === "completed").map(node => node.key).sort(compareBytesText)
  if (currentStatusDigest !== witness.stableStatusDigest || canonicalTaskGraphJson(currentPool) !== canonicalTaskGraphJson(witness.analysts.map(item => item.nodeKey))) return false
  const keys = witness.analysts.map(item => item.nodeKey), verified = [] as Array<{ result: AnalystResult; binding: ScheduledDraftCandidateWitness["analysts"][number] }>
  for (const key of keys) {
    const node = snapshot.nodes.find(item => item.key === key), current = node && await readScheduledDraftAnalystProof(client, scope, snapshot, node)
    if (!current) return false
    verified.push(current)
  }
  const sourceKeys = verified.filter(item => item.result.findings.some(finding => finding.jobId === jobId && finding.score === witness.candidate.score))
    .map(item => item.binding.nodeKey).sort(compareBytesText)
  if (canonicalTaskGraphJson(sourceKeys) !== canonicalTaskGraphJson(witness.sourceAnalystKeys)) return false
  const fresh = makeWitness(witness.graphRevision, snapshot, currentStatusDigest, witness.candidate, verified.map(item => item.binding), sourceKeys, witness.lifecycleStatuses, witness.newlyProposedNodeKeys)
  if (canonicalTaskGraphJson(fresh) !== canonicalTaskGraphJson(witness)) return false
  const winner = selectTopScheduledDraftCandidate(verified.flatMap(item => item.result.findings.map(({ jobId, score }) => ({ jobId, score }))))
  return winner?.jobId === jobId && winner.score === witness.candidate.score
}

export function parseScheduledDraftCandidateWitness(value: unknown): ScheduledDraftCandidateWitness | undefined {
  const row = exactRecord(value, "analysts,bindingVersion,candidate,graphDigest,graphRevision,lifecycleStatuses,newlyProposedNodeKeys,sourceAnalystKeys,stableStatusDigest")
    ?? exactRecord(value, "analysts,bindingVersion,candidate,graphDigest,graphRevision,newlyProposedNodeKeys,sourceAnalystKeys,stableStatusDigest"), candidate = row && parseCandidate(row.candidate), proposedKeys = row?.newlyProposedNodeKeys
  if (!row || !candidate || row.bindingVersion !== BINDING_VERSION || !validRevision(row.graphRevision) || !isDigest(row.graphDigest) || !isDigest(row.stableStatusDigest)
    || !dense(row.analysts, MAX_ANALYSTS) || !row.analysts.length || !dense(row.sourceAnalystKeys, MAX_ANALYSTS) || !row.sourceAnalystKeys.length
    || !dense(proposedKeys, 8) || proposedKeys.some((key, index) => !canonicalBoundId(key) || index > 0 && compareBytesText(proposedKeys[index - 1] as string, key) >= 0)) return undefined
  const analysts = [] as ScheduledDraftCandidateWitness["analysts"][number][]
  let previous: string | undefined
  for (const entry of row.analysts) {
    const item = exactRecord(entry, "attemptCount,evidenceDigest,nodeKey,reportDigest,resultDigest,scouts,taskId")
    if (!item || !canonicalBoundId(item.nodeKey) || !canonicalBoundId(item.taskId) || !validAttempt(item.attemptCount)
      || !isDigest(item.resultDigest) || !isDigest(item.evidenceDigest) || !isDigest(item.reportDigest)
      || !dense(item.scouts, MAX_ANALYSTS) || !item.scouts.length || previous !== undefined && compareBytesText(previous, item.nodeKey) >= 0) return undefined
    const scouts = item.scouts.map(parseTaskBinding)
    if (scouts.some(binding => !binding) || !sortedUniqueBindings(scouts as TaskGraphVerificationDependencyBinding[])) return undefined
    previous = item.nodeKey
    analysts.push({ nodeKey: item.nodeKey, taskId: item.taskId, attemptCount: item.attemptCount, resultDigest: item.resultDigest,
      evidenceDigest: item.evidenceDigest, reportDigest: item.reportDigest, scouts: scouts as TaskGraphVerificationDependencyBinding[] })
  }
  const sourceAnalystKeys = row.sourceAnalystKeys
  if (!sourceAnalystKeys.every(canonicalBoundId) || sourceAnalystKeys.some((key, index) => index > 0 && compareBytesText(sourceAnalystKeys[index - 1] as string, key as string) >= 0)
    || sourceAnalystKeys.some(key => !analysts.some(item => item.nodeKey === key))) return undefined
  const lifecycle = row.lifecycleStatuses === undefined ? undefined : parseLifecycleStatuses(row.lifecycleStatuses)
  if (row.lifecycleStatuses !== undefined && !lifecycle) return undefined
  const newlyProposedNodeKeys = proposedKeys as string[]
  if (analysts.some(item => newlyProposedNodeKeys.includes(item.nodeKey) || item.scouts.some(scout => newlyProposedNodeKeys.includes(scout.nodeKey)))) return undefined
  return { bindingVersion: BINDING_VERSION, graphRevision: row.graphRevision, graphDigest: row.graphDigest, stableStatusDigest: row.stableStatusDigest, ...(lifecycle ? { lifecycleStatuses: lifecycle } : {}), newlyProposedNodeKeys, candidate, sourceAnalystKeys: sourceAnalystKeys as string[], analysts }
}

function makeWitness(graphRevision: number, snapshot: TaskGraphSnapshot, stableStatusDigest: string, candidate: ScheduledDraftCandidate, analysts: ScheduledDraftCandidateWitness["analysts"], sourceAnalystKeys: readonly string[], lifecycle?: ScheduledDraftCandidateWitness["lifecycleStatuses"], newlyProposedNodeKeys: readonly string[] = []): ScheduledDraftCandidateWitness { const added = [...newlyProposedNodeKeys].sort(compareBytesText); return { bindingVersion: BINDING_VERSION, graphRevision, graphDigest: structuralGraphDigest(snapshot, added), stableStatusDigest, ...(lifecycle ? { lifecycleStatuses: lifecycle } : {}), newlyProposedNodeKeys: added, candidate, sourceAnalystKeys: [...sourceAnalystKeys], analysts: [...analysts].sort((a, b) => compareBytesText(a.nodeKey, b.nodeKey)).map(item => ({ ...item, scouts: [...item.scouts].sort((a, b) => compareBytesText(a.nodeKey, b.nodeKey)) })) } }
function parseCandidate(value: unknown): ScheduledDraftCandidate | undefined { const row = exactRecord(value, "jobId,score"); return row && canonicalJobId(row.jobId) && typeof row.score === "number" && Number.isFinite(row.score) && row.score >= 0 && row.score <= 10 ? { jobId: row.jobId, score: row.score } : undefined }
function parseTaskBinding(value: unknown): TaskGraphVerificationDependencyBinding | undefined {
  const row = exactRecord(value, "attemptCount,evidenceDigest,nodeDigest,nodeKey,reportDigest,resultDigest,taskId")
  return row && canonicalBoundId(row.nodeKey) && canonicalBoundId(row.taskId) && validAttempt(row.attemptCount) && isDigest(row.nodeDigest) && isDigest(row.resultDigest) && isDigest(row.evidenceDigest) && isDigest(row.reportDigest)
    ? { nodeKey: row.nodeKey, taskId: row.taskId, attemptCount: row.attemptCount, nodeDigest: row.nodeDigest, resultDigest: row.resultDigest, evidenceDigest: row.evidenceDigest, reportDigest: row.reportDigest } : undefined
}
function sortedUniqueBindings(values: readonly TaskGraphVerificationDependencyBinding[]): boolean {
  return values.every((value, index) => index === 0 || compareBytesText(values[index - 1]!.nodeKey, value.nodeKey) < 0)
}
function validAnalystKeys(values: readonly string[]): string[] | undefined {
  return Array.isArray(values) && values.length > 0 && values.length <= MAX_ANALYSTS && values.every(canonicalBoundId) && new Set(values).size === values.length ? [...values] : undefined
}
function validNewNodeKeys(values: readonly string[], snapshot: TaskGraphSnapshot): string[] | undefined { if (!Array.isArray(values) || values.length > 8) return undefined; const keys = [...values].sort(compareBytesText); return keys.every((key, index) => canonicalBoundId(key) && snapshot.nodes.some(node => node.key === key) && (index === 0 || keys[index - 1] !== key) && !snapshot.nodes.some(node => node.key === key && (isWriterNode(node) || isReviewerNode(node)))) ? keys : undefined }
function validWitnessNewKeys(witness: ScheduledDraftCandidateWitness, snapshot: TaskGraphSnapshot): boolean { const keys = validNewNodeKeys(witness.newlyProposedNodeKeys, snapshot); return Boolean(keys && canonicalTaskGraphJson(keys) === canonicalTaskGraphJson(witness.newlyProposedNodeKeys)) }
function validScope(value: GraphIdentityScope): boolean { return [value.userId, value.sessionId, value.turnId, value.rootTaskId, value.parentTaskId].every(canonicalBoundId) && value.parentTaskId === value.rootTaskId }
function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function validAttempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function canonicalJobId(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && value.trim() === value && CANONICAL_JOB_ID.test(value) }
function canonicalBoundId(value: unknown): value is string { return canonicalJobId(value) }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function digest(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
function structuralGraphDigest(snapshot: TaskGraphSnapshot, addedKeys: readonly string[]): string { const added = new Set(addedKeys); return digest({ ...snapshot, newlyProposedNodeKeys: addedKeys, nodes: snapshot.nodes.map(node => { if (isWriterNode(node) || isReviewerNode(node)) { const { status: _lifecycle, taskId: _mintedId, ...fields } = node as StoredTaskGraphNode & { status?: unknown }; return fields } if (added.has(node.key)) { const { taskId: _mintedId, ...fields } = node; return fields } return node }) }) }
function statusDigest(snapshot: TaskGraphSnapshot | undefined, statuses: ReadonlyMap<string, string>, newlyProposedNodeKeys: readonly string[] = []): string | undefined { if (!snapshot || statuses.size !== snapshot.nodes.length) return undefined; const ignored = new Set(newlyProposedNodeKeys); const values = snapshot.nodes.filter(node => !isWriterNode(node) && !isReviewerNode(node) && !ignored.has(node.key)).map(node => { const status = statuses.get(node.key); return status && ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"].includes(status) ? [node.key, status] : undefined }); return values.some(value => !value) ? undefined : digest(values) }
function lifecycleStatuses(snapshot: TaskGraphSnapshot, statuses: ReadonlyMap<string, string>): ScheduledDraftCandidateWitness["lifecycleStatuses"] { const writer = snapshot.nodes.find(isWriterNode), reviewer = snapshot.nodes.find(isReviewerNode); return writer && reviewer ? { writer: statuses.get(writer.key) ?? "", reviewer: statuses.get(reviewer.key) ?? "" } : undefined }
function parseLifecycleStatuses(value: unknown): ScheduledDraftCandidateWitness["lifecycleStatuses"] | undefined { const row = exactRecord(value, "reviewer,writer"); return row && validStatus(row.writer) && validStatus(row.reviewer) ? { writer: row.writer, reviewer: row.reviewer } : undefined }
function lifecycleStatusesValid(witness: ScheduledDraftCandidateWitness, snapshot: TaskGraphSnapshot, statuses: ReadonlyMap<string, string>): boolean {
  const writer = snapshot.nodes.find(isWriterNode), reviewer = snapshot.nodes.find(isReviewerNode)
  if (!witness.lifecycleStatuses) return false
  const currentWriter = writer && statuses.get(writer.key), currentReviewer = reviewer && statuses.get(reviewer.key)
  return Boolean(currentWriter && currentReviewer && canReachStatus(witness.lifecycleStatuses.writer, currentWriter) && canReachStatus(witness.lifecycleStatuses.reviewer, currentReviewer))
}
function validStatus(value: unknown): value is string { return typeof value === "string" && ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"].includes(value) }
function canReachStatus(start: string, target: string): boolean {
  const edges: Record<string, readonly string[]> = { queued: ["running", "interrupted", "cancelled", "closed"], waiting: ["queued", "running", "interrupted", "cancelled", "closed"], retrying: ["running"], running: ["waiting", "waiting_for_user", "queued", "completed", "failed", "interrupted", "cancelled", "closed"], waiting_for_user: ["running", "interrupted", "cancelled", "closed"] }
  const seen = new Set([start]), pending = [start]
  while (pending.length) for (const next of edges[pending.pop()!] ?? []) { if (next === target) return true; if (!seen.has(next)) { seen.add(next); pending.push(next) } }
  return start === target
}
async function readScopedGraphTasks(client: Queryable, scope: GraphIdentityScope, snapshot: TaskGraphSnapshot): Promise<Map<string, Row> | undefined> {
  const ids = snapshot.nodes.map(node => node.taskId), result = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."status", task."role", task."context", session."userId" AS "userId", turn."rootTaskId" AS "turnRootTaskId" FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`, [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  const rows = new Map(result.rows.map(raw => { const row = raw as Row; return [String(row.id), row] as const }))
  if (rows.size !== ids.length || result.rows.length !== ids.length || snapshot.nodes.some(node => { const row = rows.get(node.taskId); return !row || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId || row.rootTaskId !== scope.rootTaskId || row.parentTaskId !== scope.parentTaskId || row.userId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId })) return undefined
  return rows
}
async function assertNoOrphans(client: Queryable, scope: GraphIdentityScope, includeReceipts: boolean): Promise<void> {
  const result = await client.query(`SELECT EXISTS(SELECT 1 FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" WHERE task."sessionId" = $1 AND task."turnId" = $2 AND task."rootTaskId" = $3 AND task."parentTaskId" = $4 AND task."role" IN ('writer','reviewer') AND session."userId" = $5 AND turn."userId" = $5) AS "drafts", EXISTS(SELECT 1 FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId" WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $6 AND event."type" IN ('item.started','item.delta') AND event."payload"->>'kind' IN ('proposal','native_command') AND session."userId" = $5 AND turn."userId" = $5) AS "receipts"`, [scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId, taskGraphItemId(scope.parentTaskId)])
  const row = result.rows[0] as Row | undefined
  if (!row || row.drafts === true || includeReceipts && row.receipts === true) throw new Error("scheduled_draft_candidate_binding_invalid")
}
function compareBytesText(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")) }
function dense(value: unknown, max: number): value is readonly unknown[] { return Array.isArray(value) && value.length <= max && Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean) }
function exactRecord(value: unknown, keys: string): Row | undefined { const row = plainRecord(value), own = row && Reflect.ownKeys(row); return row && own!.every(key => typeof key === "string") && own!.sort().join(",") === keys ? row : undefined }
function plainRecord(value: unknown): Row | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined } }
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return undefined } }
function parseSnapshot(value: unknown): TaskGraphSnapshot | undefined { try { return parseTaskGraphSnapshot(value) } catch { return undefined } }
function isWriterNode(node: StoredTaskGraphNode): boolean { return node.templateId === "cover_letter_writer" }
function isReviewerNode(node: StoredTaskGraphNode): boolean { return node.templateId === "cover_letter_reviewer" }
function witnessReachableFromNode(witness: ScheduledDraftCandidateWitness, target: StoredTaskGraphNode, snapshot: TaskGraphSnapshot): boolean { const byKey = new Map(snapshot.nodes.map(node => [node.key, node] as const)), visited = new Set<string>(), pending = [...target.dependsOn]; while (pending.length) { const key = pending.pop()!; if (visited.has(key)) continue; visited.add(key); pending.push(...(byKey.get(key)?.dependsOn ?? [])) } return witness.sourceAnalystKeys.every(key => visited.has(key)) }
