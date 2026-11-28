import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { blocked, matchingTurnSnapshot } from "./scheduled-taskgraph-pipeline-request";
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint";
import { scheduledAnalyzeSourceChangedErrorForUntrustedState, scheduledAnalyzeSourceProofIsUntrusted, scheduledSourceChangeTaskClaims, terminalizeScheduledAnalyzeSourceChangedTasks } from "./scheduled-taskgraph-source-change-task-cleanup";

const TERMINAL_ERROR = "scheduled_pipeline_source_changed";
const TERMINAL_SCHEMA = "agent-harness.v2.scheduled-pipeline-source-change-terminal.v1";
const CLAIM_SCHEMA = "agent-harness.v2.scheduled-pipeline-claim.v1";
const CONTINUATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-continuation.v1";
const JOURNAL_SCHEMA = "agent-harness.v2.scheduled-taskgraph-analysis-journal.v2";
const LEGACY_JOURNAL_SCHEMA = "agent-harness.v2.scheduled-taskgraph-analysis-journal.v1";
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId",
  "turnLeaseVersion", "executionId", "executionAttemptCount"] as const;
const STABLE_OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId",
  "executionAttemptCount"] as const;

type TerminalizeResult = "terminalized" | "owner_changed" | "snapshot_changed" | "state_changed" | "not_confirmed";

interface TerminalizeInput { owner: ScheduledTaskGraphPipelineOwner; key: string; attestationSnapshotDigest: string; expectedStatus: "running" | "waiting_for_user"; expectedState: unknown; claimToken: string; sourceChangeError: unknown; allowPriorLease?: boolean }
interface TurnLockRow { id: string; input: unknown }
interface RootLockRow { id: string }

function objectRow(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}
function stableOwner(owner: ScheduledTaskGraphPipelineOwner): Record<string, unknown> {
  return Object.fromEntries(STABLE_OWNER_KEYS.map(key => [key, owner[key]]));
}
function ownerShape(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  const row = objectRow(value);
  if (!row || Object.keys(row).sort().join(",") !== [...OWNER_KEYS].sort().join(",")
    || ![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId].every(validId)
    || !Number.isSafeInteger(row.rootAttemptCount) || Number(row.rootAttemptCount) <= 0
    || !Number.isSafeInteger(row.turnLeaseVersion) || Number(row.turnLeaseVersion) <= 0
    || !Number.isSafeInteger(row.executionAttemptCount) || Number(row.executionAttemptCount) < 0) return null;
  return row as unknown as ScheduledTaskGraphPipelineOwner;
}
function sameStableOwner(previous: ScheduledTaskGraphPipelineOwner, current: ScheduledTaskGraphPipelineOwner): boolean {
  return STABLE_OWNER_KEYS.every(key => previous[key] === current[key]);
}
function validDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function parseClaim(value: unknown): { key: string; claimToken: string; owner: ScheduledTaskGraphPipelineOwner } | null {
  const row = objectRow(value), owner = ownerShape(row?.owner);
  const keys = ["schemaVersion", "key", "claimToken", "owner", "claimedAt", "leaseExpiresAt"];
  if (!row || Object.keys(row).sort().join(",") !== keys.sort().join(",") || row.schemaVersion !== CLAIM_SCHEMA
    || !validId(row.key) || !validId(row.claimToken) || !owner
    || typeof row.claimedAt !== "string" || !Number.isFinite(Date.parse(row.claimedAt))
    || typeof row.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(row.leaseExpiresAt))) return null;
  return { key: row.key, claimToken: row.claimToken, owner };
}
function validContinuation(value: unknown, claim: NonNullable<ReturnType<typeof parseClaim>>, digest: string): boolean {
  const row = objectRow(value), owner = ownerShape(row?.owner);
  const keys = ["schemaVersion", "key", "owner", "snapshotDigest", "graphRevision", "evidenceDigest"];
  return Boolean(row && Object.keys(row).sort().join(",") === keys.sort().join(",")
    && row.schemaVersion === CONTINUATION_SCHEMA && row.key === claim.key && owner
    && OWNER_KEYS.every(key => owner[key] === claim.owner[key]) && validDigest(row.snapshotDigest)
    && row.snapshotDigest === digest
    && Number.isSafeInteger(row.graphRevision) && Number(row.graphRevision) > 0
    && typeof row.evidenceDigest === "string" && /^[a-f0-9]{64}$/.test(row.evidenceDigest));
}
function validJournal(value: unknown, claim: NonNullable<ReturnType<typeof parseClaim>>): boolean {
  const row = objectRow(value), owner = objectRow(row?.owner), v2 = row?.schemaVersion === JOURNAL_SCHEMA;
  const keys = v2 ? ["attemptsByJob", "failedJobIds", "key", "owner", "schemaVersion", "sourceFingerprintsByJob"]
    : ["attemptsByJob", "failedJobIds", "key", "owner", "schemaVersion"];
  return Boolean(row && (v2 || row.schemaVersion === LEGACY_JOURNAL_SCHEMA)
    && Object.keys(row).sort().join(",") === keys.sort().join(",") && row.key === claim.key && owner
    && OWNER_KEYS.every(key => (owner as Record<string, unknown>)[key] === claim.owner[key])
    && objectRow(row.attemptsByJob) && Array.isArray(row.failedJobIds)
    && (!v2 || objectRow(row.sourceFingerprintsByJob)));
}
function terminalMarkerMatches(value: unknown, owner: ScheduledTaskGraphPipelineOwner): boolean {
  const row = objectRow(value), markerOwner = objectRow(row?.owner);
  return Boolean(row && Object.keys(row).sort().join(",") === ["schemaVersion", "owner"].sort().join(",")
    && row.schemaVersion === TERMINAL_SCHEMA && markerOwner
    && Object.keys(markerOwner).sort().join(",") === [...STABLE_OWNER_KEYS].sort().join(",")
    && STABLE_OWNER_KEYS.every(key => markerOwner[key] === owner[key]));
}

export function isScheduledTaskGraphSourceChangeTerminal(input: {
  owner: ScheduledTaskGraphPipelineOwner; status: string; error: unknown; state: unknown;
}): boolean {
  const state = objectRow(input.state);
  return input.status === "failed" && input.error === TERMINAL_ERROR
    && Boolean(state && terminalMarkerMatches(state.scheduledTaskGraphSourceChangeTerminal, input.owner)
      && state.scoutedJobs === undefined && state.scoredJobs === undefined
      && state.scheduledTaskGraphAnalyzeJournal === undefined && state.scheduledTaskGraphContinuation === undefined
      && state.scheduledTaskGraphAnalyzeSourceFingerprints === undefined
      && state.scheduledTaskGraphClaim === undefined);
}

function cleanTerminalState(value: unknown, owner: ScheduledTaskGraphPipelineOwner, digest: string): Record<string, unknown> | null {
  const state = objectRow(value);
  if (!state || state.scheduledTaskGraphSourceChangeTerminal !== undefined) return null;
  const claim = parseClaim(state.scheduledTaskGraphClaim);
  if (!claim || !sameStableOwner(claim.owner, owner) || claim.owner.turnLeaseVersion > owner.turnLeaseVersion
    || claim.owner.turnLeaseVersion === owner.turnLeaseVersion && claim.owner.turnLeaseOwnerId !== owner.turnLeaseOwnerId
    || state.scheduledTaskGraphContinuation !== undefined
      && !validContinuation(state.scheduledTaskGraphContinuation, claim, digest)
    || state.scheduledTaskGraphAnalyzeJournal !== undefined && !validJournal(state.scheduledTaskGraphAnalyzeJournal, claim)) return null;
  return {
    ...state,
    scheduledTaskGraphSourceChangeTerminal: { schemaVersion: TERMINAL_SCHEMA, owner: stableOwner(owner) },
  };
}

function terminalStateFor(value: unknown, owner: ScheduledTaskGraphPipelineOwner, digest: string): Record<string, unknown> | null {
  const state = cleanTerminalState(value, owner, digest);
  if (!state) return null;
  delete state.scoutedJobs;
  delete state.scoredJobs;
  delete state.scheduledTaskGraphAnalyzeJournal;
  delete state.scheduledTaskGraphContinuation;
  delete state.scheduledTaskGraphClaim; delete state.scheduledTaskGraphAnalyzeSourceFingerprints;
  return state;
}

export async function terminalizeScheduledTaskGraphSourceChange(input: TerminalizeInput): Promise<TerminalizeResult> {
  const expectedState = objectRow(input.expectedState);
  if (!expectedState || !validId(input.key) || !validDigest(input.attestationSnapshotDigest)
    || input.owner.executionAttemptCount < 0) return "not_confirmed";
  const claim = parseClaim(expectedState.scheduledTaskGraphClaim);
  if (!claim || claim.key !== input.key) return "not_confirmed";
  const exactOwner = OWNER_KEYS.every(key => claim.owner[key] === input.owner[key]);
  const priorLease = input.allowPriorLease === true
    && scheduledAnalyzeSourceProofIsUntrusted(input.expectedState) && sameStableOwner(claim.owner, input.owner)
    && claim.owner.turnLeaseVersion < input.owner.turnLeaseVersion;
  if (claim.claimToken !== input.claimToken || !exactOwner && !priorLease) return "not_confirmed";
  const taskClaims = scheduledSourceChangeTaskClaims(input.sourceChangeError, expectedState);
  if (!taskClaims) return "not_confirmed";
  const continuation = objectRow(expectedState.scheduledTaskGraphContinuation);
  if (continuation && continuation.snapshotDigest !== input.attestationSnapshotDigest) return "not_confirmed";
  const nextState = terminalStateFor(input.expectedState, input.owner, input.attestationSnapshotDigest);
  if (!nextState) return "not_confirmed";

  return db.$transaction(async tx => {
    const turns = await tx.$queryRaw<TurnLockRow[]>(Prisma.sql`
      SELECT "id", "input" FROM "agent_turns"
      WHERE "id" = ${input.owner.turnId} AND "userId" = ${input.owner.userId} AND "sessionId" = ${input.owner.sessionId}
        AND "rootTaskId" = ${input.owner.rootTaskId} AND "source" = 'automation'
        AND "executionMode" = 'canonical_task_graph' AND "leaseVersion" = ${input.owner.turnLeaseVersion}
        AND (
          ("status" IN ('in_progress', 'waiting_for_user') AND "leaseOwnerId" = ${input.owner.turnLeaseOwnerId}
            AND "leaseExpiresAt" > clock_timestamp())
          OR ("status" = 'waiting_for_user' AND "leaseOwnerId" IS NULL AND "leaseExpiresAt" IS NULL)
        )
      FOR UPDATE
    `);
    const turn = turns[0];
    if (turns.length !== 1 || turn?.id !== input.owner.turnId) return "owner_changed";
    let snapshot: ReturnType<typeof matchingTurnSnapshot>;
    try { snapshot = matchingTurnSnapshot(turn.input); } catch { return "snapshot_changed"; }
    if (!snapshot) return "snapshot_changed";
    let liveSnapshotDigest: string;
    try { liveSnapshotDigest = scheduledAutomationSnapshotDigest(snapshot); } catch { return "snapshot_changed"; }
    if (liveSnapshotDigest !== input.attestationSnapshotDigest || continuation && continuation.snapshotDigest !== liveSnapshotDigest) return "snapshot_changed";
    const roots = await tx.$queryRaw<RootLockRow[]>(Prisma.sql`
      SELECT "id" FROM "sub_agent_tasks"
      WHERE "id" = ${input.owner.rootTaskId} AND "sessionId" = ${input.owner.sessionId}
        AND "turnId" = ${input.owner.turnId} AND "rootTaskId" = ${input.owner.rootTaskId}
        AND "parentTaskId" IS NULL AND "role" = 'orchestrator' AND "taskType" = 'root'
        AND "status" = 'running' AND "attemptCount" = ${input.owner.rootAttemptCount}
        AND "interruptRequestedAt" IS NULL AND "closedAt" IS NULL
      FOR UPDATE
    `);
    if (roots.length !== 1 || roots[0]?.id !== input.owner.rootTaskId) return "owner_changed";
    const saved = await tx.agentExecution.updateMany({
      where: { id: input.owner.executionId, userId: input.owner.userId, sessionId: input.owner.sessionId,
        status: input.expectedStatus, attemptCount: input.owner.executionAttemptCount,
        state: { equals: input.expectedState as Prisma.InputJsonValue } },
      data: { status: "failed", error: TERMINAL_ERROR, completedAt: new Date(), state: nextState as Prisma.InputJsonValue },
    });
    if (saved.count !== 1) return "state_changed";
    if (taskClaims?.length) await terminalizeScheduledAnalyzeSourceChangedTasks(tx, { userId: input.owner.userId, sessionId: input.owner.sessionId, claims: taskClaims });
    return "terminalized";
  });
}

async function exactSourceChangedTerminalRead(owner: ScheduledTaskGraphPipelineOwner): Promise<boolean> {
  const execution = await db.agentExecution.findFirst({
    where: { id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId,
      attemptCount: owner.executionAttemptCount },
    select: { id: true, status: true, attemptCount: true, state: true, error: true },
  }) as { id: string; status: string; attemptCount: number; state: unknown; error: string | null } | null;
  return Boolean(execution && execution.id === owner.executionId && execution.attemptCount === owner.executionAttemptCount
    && isScheduledTaskGraphSourceChangeTerminal({ owner, status: execution.status, error: execution.error, state: execution.state }));
}

function sourceChangeResponse(result: TerminalizeResult): Response {
  if (result === "terminalized") return blocked(409, TERMINAL_ERROR);
  if (result === "owner_changed") return blocked(409, "scheduled_pipeline_turn_stale");
  if (result === "snapshot_changed") return blocked(409, "scheduled_pipeline_snapshot_mismatch");
  return blocked(409, "scheduled_pipeline_claim_conflict");
}

export { isAnalyzeSourceChangedError } from "./stages/analyze-model-input";
export { scheduledAnalyzeSourceProofIsUntrusted as isScheduledTaskGraphAnalyzeProofUntrusted } from "./scheduled-taskgraph-source-change-task-cleanup";
export { renewExpiredScheduledAnalyzeClaim } from "./scheduled-taskgraph-source-change-task-cleanup";

export async function respondToScheduledTaskGraphAnalyzeSourceChange(input: {
  owner: ScheduledTaskGraphPipelineOwner; key?: string; claimToken?: string; attestationSnapshotDigest: string;
  sourceChangeError?: unknown; allowPriorLease?: boolean; currentTurn?: { leaseOwnerId: string | null; leaseVersion: number };
}): Promise<Response> {
  let execution: { id: string; status: string; attemptCount: number; state: unknown; error: string | null } | null;
  try { execution = await db.agentExecution.findFirst({ where: { id: input.owner.executionId, userId: input.owner.userId, sessionId: input.owner.sessionId },
    select: { id: true, status: true, attemptCount: true, state: true, error: true } }) as typeof execution; }
  catch { return blocked(500, "scheduled_pipeline_execution_failed"); }
  if (!execution || execution.id !== input.owner.executionId || execution.attemptCount !== input.owner.executionAttemptCount) return blocked(409, "scheduled_pipeline_execution_mismatch");
  let owner = input.owner, key = input.key, claimToken = input.claimToken, sourceChangeError = input.sourceChangeError;
  let snapshotDigest = input.attestationSnapshotDigest, allowPriorLease = false;
  if (input.allowPriorLease) {
    const state = objectRow(execution.state), claim = parseClaim(state?.scheduledTaskGraphClaim);
    if (!state || !scheduledAnalyzeSourceProofIsUntrusted(state) || !claim || !input.currentTurn) return blocked(409, "scheduled_pipeline_claim_conflict");
    sourceChangeError = scheduledAnalyzeSourceChangedErrorForUntrustedState(state);
    if (!sourceChangeError || !validId(claim.key) || !validId(claim.claimToken)) return blocked(409, "scheduled_pipeline_claim_conflict");
    owner = { ...owner, turnLeaseOwnerId: validId(input.currentTurn.leaseOwnerId) ? input.currentTurn.leaseOwnerId : claim.owner.turnLeaseOwnerId,
      turnLeaseVersion: input.currentTurn.leaseVersion };
    key = claim.key; claimToken = claim.claimToken; allowPriorLease = true;
  }
  if (!key || !claimToken || !sourceChangeError) return blocked(409, "scheduled_pipeline_claim_conflict");
  if (isScheduledTaskGraphSourceChangeTerminal({ owner, status: execution.status, error: execution.error, state: execution.state })) return blocked(409, TERMINAL_ERROR);
  if (execution.status !== "running" && execution.status !== "waiting_for_user") return blocked(409, "scheduled_pipeline_claim_conflict");
  let result: TerminalizeResult;
  try { result = await terminalizeScheduledTaskGraphSourceChange({ owner, key, claimToken: claimToken!, attestationSnapshotDigest: snapshotDigest,
    expectedStatus: execution.status, expectedState: execution.state, sourceChangeError, allowPriorLease }); }
  catch { return blocked(500, "scheduled_pipeline_execution_failed"); }
  if (result === "state_changed") try { if (await exactSourceChangedTerminalRead(owner)) return blocked(409, TERMINAL_ERROR); }
    catch { return blocked(500, "scheduled_pipeline_execution_failed"); }
  return sourceChangeResponse(result);
}
