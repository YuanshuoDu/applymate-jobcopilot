import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { buildScheduledTaskGraphPrepareCheckpoint, scheduledTaskGraphContinuationKey, type ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint";
import type { PipelineCheckpointState } from "./types";

const CLAIM_SCHEMA = "agent-harness.v2.scheduled-pipeline-claim.v1";
const CONTINUATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-continuation.v1";
const WAIT_SCHEMA = "agent-harness.v2.scheduled-pipeline-wait.v1";
const PIPELINE_STAGES = new Set(["prepare", "gate", "execute", "audit"]);
const WAIT_STAGES = new Set(["scout", "analyst", "writer", "reviewer", "executor", "auditor", "post-run"]);

export interface ScheduledTaskGraphWaitMarker {
  schemaVersion: typeof WAIT_SCHEMA;
  key: string;
  claimToken: string;
  owner: ScheduledTaskGraphPipelineOwner;
  waitId: string;
  stage: string;
}
export interface ScheduledTaskGraphRebindResult { state: Record<string, unknown>; waitId: string; stage: string }
export interface ScheduledTaskGraphWaitQuestion { answered: boolean }
export interface PriorScheduledTaskGraphContinuation { owner: ScheduledTaskGraphPipelineOwner; key: string }

function objectRow(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function scheduledTaskGraphOwnerMatches(value: unknown, owner: ScheduledTaskGraphPipelineOwner): boolean {
  const row = objectRow(value);
  return Boolean(row && Object.keys(row).length === 9
    && row.userId === owner.userId && row.sessionId === owner.sessionId && row.turnId === owner.turnId
    && row.rootTaskId === owner.rootTaskId && row.rootAttemptCount === owner.rootAttemptCount
    && row.turnLeaseOwnerId === owner.turnLeaseOwnerId && row.turnLeaseVersion === owner.turnLeaseVersion
    && row.executionId === owner.executionId && row.executionAttemptCount === owner.executionAttemptCount);
}

export function scheduledTaskGraphClaimMatches(state: unknown, key: string, owner: ScheduledTaskGraphPipelineOwner, claimToken?: string): boolean {
  const claim = objectRow(objectRow(state)?.scheduledTaskGraphClaim);
  return claim?.schemaVersion === CLAIM_SCHEMA && claim.key === key && scheduledTaskGraphOwnerMatches(claim.owner, owner)
    && (claimToken === undefined || claim.claimToken === claimToken);
}

export function priorScheduledTaskGraphContinuation(input: { state: unknown; owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; attestation: unknown }): PriorScheduledTaskGraphContinuation | null {
  const state = objectRow(input.state), marker = objectRow(state?.scheduledTaskGraphContinuation), owner = parseOwner(marker?.owner);
  if (!state || !marker || !owner || !sameStableOwner(owner, input.owner) || owner.turnLeaseVersion >= input.owner.turnLeaseVersion) return null;
  try {
    const attestation = attestationForOwner(input.attestation, owner);
    const key = scheduledTaskGraphContinuationKey(owner, attestation);
    const checkpoint = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot: input.snapshot, attestation, existingCheckpoint: state });
    return marker.key === key && checkpoint.alreadyPersisted ? { owner, key } : null;
  } catch { return null; }
}

export function rebindScheduledTaskGraphClaimForLease(input: {
  state: unknown; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string;
  snapshot: unknown; attestation: unknown; claimedAt: string; leaseExpiresAt: string;
}): Record<string, unknown> | null {
  const state = objectRow(input.state), claim = objectRow(state?.scheduledTaskGraphClaim), priorOwner = parseOwner(claim?.owner);
  if (!state || !claim || !priorOwner || !sameStableOwner(priorOwner, input.owner) || priorOwner.turnLeaseVersion >= input.owner.turnLeaseVersion
    || !validPersistedClaim(claim) || !validId(input.key) || !validId(input.claimToken) || input.claimToken === claim.claimToken
    || !validTimestamp(input.claimedAt) || !validTimestamp(input.leaseExpiresAt) || state.scheduledTaskGraphWait !== undefined) return null;
  let priorKey: string;
  try { priorKey = scheduledTaskGraphContinuationKey(priorOwner, attestationForOwner(input.attestation, priorOwner)); }
  catch { return null; }
  if (claim.key !== priorKey) return null;
  const marker = objectRow(state.scheduledTaskGraphContinuation);
  if (state.scheduledTaskGraphContinuation !== undefined) {
    const prior = priorScheduledTaskGraphContinuation(input);
    if (!marker || !prior || prior.key !== priorKey || !scheduledTaskGraphOwnerMatches(claim.owner, prior.owner)
      || !PIPELINE_STAGES.has(String(state.nextStage)) || state.nextStage === "scout"
      || !Array.isArray(state.scoutedJobs) || !Array.isArray(state.scoredJobs)
      || !Number.isSafeInteger(state.analysisFailed) || Number(state.analysisFailed) < 0) return null;
  } else if (state.nextStage !== "scout") return null;
  return { ...state, scheduledTaskGraphClaim: { ...claim, key: input.key, claimToken: input.claimToken,
    owner: { ...input.owner }, claimedAt: input.claimedAt, leaseExpiresAt: input.leaseExpiresAt },
    ...(marker ? { scheduledTaskGraphContinuation: { ...marker, key: input.key, owner: { ...input.owner } } } : {}) };
}

function attestationForOwner(value: unknown, owner: ScheduledTaskGraphPipelineOwner): unknown {
  const attestation = objectRow(value);
  if (!attestation) return value;
  const { userId, sessionId, turnId, rootTaskId, rootAttemptCount, turnLeaseOwnerId, turnLeaseVersion } = owner;
  return { ...attestation, owner: { userId, sessionId, turnId, rootTaskId, rootAttemptCount, turnLeaseOwnerId, turnLeaseVersion } };
}
function validPersistedClaim(claim: Record<string, unknown>): boolean {
  return Object.keys(claim).length === 6 && ["schemaVersion", "key", "claimToken", "owner", "claimedAt", "leaseExpiresAt"].every(key => Object.hasOwn(claim, key))
    && claim.schemaVersion === CLAIM_SCHEMA && validId(claim.key) && validId(claim.claimToken)
    && validTimestamp(claim.claimedAt) && validTimestamp(claim.leaseExpiresAt);
}
function validTimestamp(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
export function createScheduledTaskGraphWaitState(
  stateValue: unknown,
  owner: ScheduledTaskGraphPipelineOwner,
  key: string,
  claimToken: string,
  waitId: string,
  stage: string,
): Record<string, unknown> | null {
  const state = objectRow(stateValue), continuation = objectRow(state?.scheduledTaskGraphContinuation);
  if (!state || !validId(waitId) || !WAIT_STAGES.has(stage) || !PIPELINE_STAGES.has(String(state.nextStage))
    || continuation?.schemaVersion !== CONTINUATION_SCHEMA || continuation.key !== key
    || !scheduledTaskGraphOwnerMatches(continuation.owner, owner)
    || !validId(claimToken) || !scheduledTaskGraphClaimMatches(state, key, owner, claimToken)) return null;
  return { ...state, scheduledTaskGraphWait: { schemaVersion: WAIT_SCHEMA, key, claimToken, owner: { ...owner }, waitId, stage } };
}

export async function persistScheduledTaskGraphWaitMarker(input: {
  state: unknown; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string; waitId: string; stage: string;
}): Promise<Record<string, unknown> | null> {
  const nextState = createScheduledTaskGraphWaitState(input.state, input.owner, input.key, input.claimToken, input.waitId, input.stage);
  if (!nextState) return null;
  const saved = await db.agentExecution.updateMany({
    where: { id: input.owner.executionId, userId: input.owner.userId, sessionId: input.owner.sessionId,
      status: "running", attemptCount: input.owner.executionAttemptCount,
      state: { equals: input.state as Prisma.InputJsonValue } },
    data: { state: nextState as Prisma.InputJsonValue },
  });
  return saved.count === 1 ? nextState : null;
}

export async function saveScheduledTaskGraphCheckpoint(input: {
  expectedState: unknown; state: PipelineCheckpointState; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string;
}): Promise<boolean> {
  if (!scheduledTaskGraphClaimMatches(input.expectedState, input.key, input.owner, input.claimToken)
    || !scheduledTaskGraphClaimMatches(input.state, input.key, input.owner, input.claimToken)) return false;
  const saved = await db.agentExecution.updateMany({
    where: { id: input.owner.executionId, userId: input.owner.userId, sessionId: input.owner.sessionId,
      status: "running", attemptCount: input.owner.executionAttemptCount,
      state: { equals: input.expectedState as Prisma.InputJsonValue } },
    data: { checkpoint: input.state.nextStage, state: input.state as unknown as Prisma.InputJsonValue },
  });
  return saved.count === 1;
}

export async function finishScheduledTaskGraphExecution(input: {
  state: unknown; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string;
  status: "completed" | "failed"; error?: string | null;
}): Promise<boolean> {
  if (!scheduledTaskGraphClaimMatches(input.state, input.key, input.owner, input.claimToken)) return false;
  const saved = await db.agentExecution.updateMany({
    where: { id: input.owner.executionId, userId: input.owner.userId, sessionId: input.owner.sessionId,
      status: "running", attemptCount: input.owner.executionAttemptCount,
      state: { equals: input.state as Prisma.InputJsonValue } },
    data: { status: input.status, error: input.status === "failed" ? input.error ?? null : null, completedAt: new Date() },
  });
  return saved.count === 1;
}

export function scheduledTaskGraphWaitMarker(
  stateValue: unknown,
  key: string,
  owner: ScheduledTaskGraphPipelineOwner,
): ScheduledTaskGraphWaitMarker | null {
  const wait = readScheduledTaskGraphWaitMarker(stateValue);
  return wait?.key === key && scheduledTaskGraphOwnerMatches(wait.owner, owner) ? wait : null;
}

export function readScheduledTaskGraphWaitMarker(stateValue: unknown): ScheduledTaskGraphWaitMarker | null {
  const state = objectRow(stateValue), wait = objectRow(state?.scheduledTaskGraphWait);
  const continuation = objectRow(state?.scheduledTaskGraphContinuation);
  const owner = parseOwner(wait?.owner);
  if (!state || !wait || !owner || Object.keys(wait).length !== 6 || wait.schemaVersion !== WAIT_SCHEMA
    || !validId(wait.key) || !validId(wait.claimToken) || !validId(wait.waitId) || typeof wait.stage !== "string" || !WAIT_STAGES.has(wait.stage)
    || !scheduledTaskGraphClaimMatches(state, wait.key, owner, wait.claimToken)
    || continuation?.schemaVersion !== CONTINUATION_SCHEMA || continuation.key !== wait.key
    || !scheduledTaskGraphOwnerMatches(continuation.owner, owner)) return null;
  return { schemaVersion: WAIT_SCHEMA, key: wait.key, claimToken: wait.claimToken, owner, waitId: wait.waitId, stage: wait.stage };
}

export async function loadScheduledTaskGraphWaitQuestion(
  owner: ScheduledTaskGraphPipelineOwner, waitId: string, stage: string,
): Promise<ScheduledTaskGraphWaitQuestion | null> {
  if (!waitId.startsWith(`agent-question:${owner.turnId}:canonical:`)) return null;
  const itemId = `agent-wait:question:${waitId}`;
  const item = await db.agentItem.findFirst({ where: { id: itemId, sessionId: owner.sessionId, turnId: owner.turnId, type: "question" },
    select: { id: true, sessionId: true, turnId: true, type: true, status: true, startedAt: true, completedAt: true, content: true } });
  const content = objectRow(item?.content);
  if (!item || item.id !== itemId || item.sessionId !== owner.sessionId || item.turnId !== owner.turnId || item.type !== "question"
    || content?.waitKind !== "question" || content.questionId !== waitId || content.stage !== stage
    || !(item.startedAt instanceof Date)) return null;
  if (item.status === "started" && item.completedAt === null && content.answerAvailable === false && content.answer === null) return { answered: false };
  return item.status === "completed" && item.completedAt instanceof Date && content.answerAvailable === true
    && typeof content.answer === "string" && content.answer.length > 0 ? { answered: true } : null;
}

export async function loadDurableScheduledTaskGraphWait(input: {
  owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string; answeredOnly?: boolean;
}): Promise<{ waitId: string; stage: string } | null> {
  const [execution, turn] = await Promise.all([
    db.agentExecution.findFirst({ where: { id: input.owner.executionId, userId: input.owner.userId, sessionId: input.owner.sessionId,
      attemptCount: input.owner.executionAttemptCount }, select: { status: true, state: true } }),
    db.agentTurn.findFirst({ where: { id: input.owner.turnId, userId: input.owner.userId, sessionId: input.owner.sessionId },
      select: { status: true, leaseOwnerId: true, leaseVersion: true, leaseExpiresAt: true } }),
  ]);
  const marker = readScheduledTaskGraphWaitMarker(execution?.state);
  if (!execution || !turn || !marker || marker.key !== input.key || marker.claimToken !== input.claimToken
    || !scheduledTaskGraphOwnerMatches(marker.owner, input.owner)) return null;
  const question = await loadScheduledTaskGraphWaitQuestion(input.owner, marker.waitId, marker.stage);
  if (!question) return null;
  const leaseExpiresAt = turn.leaseExpiresAt instanceof Date ? turn.leaseExpiresAt.getTime() : Number.NaN;
  const currentLease = turn.status === "in_progress" && turn.leaseOwnerId === input.owner.turnLeaseOwnerId
    && turn.leaseVersion === input.owner.turnLeaseVersion && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now();
  const durablePause = execution.status === "waiting_for_user" && (turn.status === "waiting_for_user" || currentLease);
  const resumedAnswer = question.answered && ["running", "waiting_for_user"].includes(execution.status)
    && ["in_progress", "waiting_for_user"].includes(turn.status);
  if (input.answeredOnly ? !resumedAnswer : question.answered ? !resumedAnswer : !durablePause) return null;
  return { waitId: marker.waitId, stage: marker.stage };
}

function parseOwner(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  const owner = objectRow(value);
  const keys = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion", "executionId", "executionAttemptCount"];
  if (!owner || Object.keys(owner).sort().join(",") !== [...keys].sort().join(",")
    || ![owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId].every(validId)
    || !positiveInteger(owner.rootAttemptCount) || !positiveInteger(owner.turnLeaseVersion)
    || !Number.isSafeInteger(owner.executionAttemptCount) || Number(owner.executionAttemptCount) < 0) return null;
  return owner as unknown as ScheduledTaskGraphPipelineOwner;
}

export function rebindScheduledTaskGraphWaitState(input: {
  state: unknown; owner: ScheduledTaskGraphPipelineOwner; key: string; claimToken: string;
  snapshotDigest: string; graphRevision: number; evidenceDigest: string;
}): ScheduledTaskGraphRebindResult | null {
  const state = objectRow(input.state), marker = objectRow(state?.scheduledTaskGraphContinuation);
  const claim = objectRow(state?.scheduledTaskGraphClaim);
  const priorOwner = objectRow(marker?.owner) as ScheduledTaskGraphPipelineOwner | null;
  if (!state || !marker || !claim || !priorOwner || !sameStableOwner(priorOwner, input.owner)
    || !PIPELINE_STAGES.has(String(state.nextStage)) || !Array.isArray(state.scoutedJobs) || !Array.isArray(state.scoredJobs)
    || !Number.isSafeInteger(state.analysisFailed) || Number(state.analysisFailed) < 0
    || marker.schemaVersion !== CONTINUATION_SCHEMA || !validId(marker.key)
    || !scheduledTaskGraphOwnerMatches(claim.owner, priorOwner) || claim.key !== marker.key || claim.schemaVersion !== CLAIM_SCHEMA
    || !isSnapshotDigest(marker.snapshotDigest) || !isDigest(marker.evidenceDigest) || !positiveInteger(marker.graphRevision)
    || marker.snapshotDigest !== input.snapshotDigest || marker.evidenceDigest !== input.evidenceDigest
    || marker.graphRevision !== input.graphRevision) return null;
  const priorWait = scheduledTaskGraphWaitMarker(state, marker.key, priorOwner);
  if (!priorWait) return null;
  const rebound: Record<string, unknown> = { ...state,
    scheduledTaskGraphClaim: { ...claim, key: input.key, claimToken: input.claimToken, owner: { ...input.owner } },
    scheduledTaskGraphContinuation: { ...marker, key: input.key, owner: { ...input.owner } },
  };
  delete rebound.scheduledTaskGraphWait;
  return { state: rebound, waitId: priorWait.waitId, stage: priorWait.stage };
}

function sameStableOwner(previous: ScheduledTaskGraphPipelineOwner, current: ScheduledTaskGraphPipelineOwner): boolean {
  return scheduledTaskGraphOwnerMatches({ ...previous, turnLeaseOwnerId: current.turnLeaseOwnerId,
    turnLeaseVersion: current.turnLeaseVersion }, current);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function isDigest(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isSnapshotDigest(value: unknown): boolean { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }

export async function isScheduledTaskGraphOwnerCurrent(
  owner: ScheduledTaskGraphPipelineOwner,
  key: string,
  claimToken: string,
): Promise<boolean> {
  try {
    const [turn, root, execution] = await Promise.all([
      db.agentTurn.findFirst({
        where: { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId },
        select: { status: true, leaseOwnerId: true, leaseVersion: true, leaseExpiresAt: true },
      }),
      db.subAgentTask.findFirst({
        where: { id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
          parentTaskId: null, session: { userId: owner.userId } },
        select: { status: true, attemptCount: true, interruptRequestedAt: true, closedAt: true },
      }),
      db.agentExecution.findFirst({
        where: { id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId, status: "running", attemptCount: owner.executionAttemptCount },
        select: { state: true },
      }),
    ]);
    return turn?.status === "in_progress" && turn.leaseOwnerId === owner.turnLeaseOwnerId
      && turn.leaseVersion === owner.turnLeaseVersion && turn.leaseExpiresAt instanceof Date
      && turn.leaseExpiresAt.getTime() > Date.now() && root?.status === "running"
      && root.attemptCount === owner.rootAttemptCount && !root.interruptRequestedAt && !root.closedAt
      && scheduledTaskGraphClaimMatches(execution?.state, key, owner, claimToken);
  } catch {
    return false;
  }
}
