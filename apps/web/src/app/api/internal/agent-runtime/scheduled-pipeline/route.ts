import { randomUUID } from "node:crypto";
import { Prisma, type Job } from "@prisma/client";
import { APPLYMATE_BACKING, loadUserAiConfig, resolveConfig } from "@/lib/model-router";
import { db } from "@/lib/db";
import { runAgentPipeline, type ScheduledTaskGraphWaitResult } from "@/lib/agent/run-service";
import { parseScheduledAutomationSnapshot } from "@/lib/agent/scheduled-automation-snapshot";
import { scheduledAutomationSnapshotDigest, scheduledTaskGraphContinuationKey, type ScheduledTaskGraphPipelineOwner } from "@/lib/agent/scheduled-taskgraph-pipeline-checkpoint";
import { loadDurableScheduledTaskGraphWait, loadScheduledTaskGraphWaitQuestion, priorScheduledTaskGraphContinuation, readScheduledTaskGraphWaitMarker, rebindScheduledTaskGraphClaimForLease, rebindScheduledTaskGraphWaitState, scheduledTaskGraphClaimMatches, scheduledTaskGraphOwnerMatches } from "@/lib/agent/scheduled-taskgraph-pipeline-fence";
import { hasEffectiveEntitlement, isFeatureAllowed, resolveAiAccess } from "@/lib/entitlements";

export const maxDuration = 300;
const CLAIM_SCHEMA = "agent-harness.v2.scheduled-pipeline-claim.v1";
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion"];

type RequestOwner = Pick<ScheduledTaskGraphPipelineOwner, "userId" | "sessionId" | "turnId" | "rootTaskId" | "rootAttemptCount" | "turnLeaseOwnerId" | "turnLeaseVersion">;
type ParsedBody = { owner: RequestOwner; attestation: unknown };
type StoredExecution = { id: string; status: string; attemptCount: number; state: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value; }
function safeCount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function parseOwner(value: unknown): RequestOwner | null {
  const row = record(value);
  if (!row || Object.keys(row).sort().join(",") !== [...OWNER_KEYS].sort().join(",")
    || ![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId].every(validId)
    || !Number.isSafeInteger(row.rootAttemptCount) || Number(row.rootAttemptCount) < 1
    || !Number.isSafeInteger(row.turnLeaseVersion) || Number(row.turnLeaseVersion) < 1) return null;
  return { userId: row.userId as string, sessionId: row.sessionId as string, turnId: row.turnId as string,
    rootTaskId: row.rootTaskId as string, rootAttemptCount: Number(row.rootAttemptCount),
    turnLeaseOwnerId: row.turnLeaseOwnerId as string, turnLeaseVersion: Number(row.turnLeaseVersion) };
}
function parseBody(value: unknown): ParsedBody | null {
  const row = record(value);
  if (!row || Object.keys(row).sort().join(",") !== "attestation,owner" || !Object.hasOwn(row, "attestation")) return null;
  const owner = parseOwner(row.owner);
  return owner ? { owner, attestation: row.attestation } : null;
}
function json(status: number, value: unknown): Response { return Response.json(value, { status }); }
function blocked(status: number, errorCode: string): Response { return json(status, { status: "blocked", errorCode }); }
function candidates(value: unknown): string[] | null {
  const scout = record(record(value)?.scout), ids = scout?.candidateJobIds;
  return Array.isArray(ids) && ids.every(validId) && new Set(ids).size === ids.length ? [...ids] : null;
}
function isJsonObject(value: unknown): value is Record<string, unknown> { return Boolean(record(value)); }
function sameClaim(state: unknown, key: string, owner: ScheduledTaskGraphPipelineOwner): boolean {
  return scheduledTaskGraphClaimMatches(state, key, owner);
}
function finalReport(execution: StoredExecution, key: string, owner: ScheduledTaskGraphPipelineOwner) {
  const state = record(execution.state), marker = record(state?.scheduledTaskGraphContinuation), report = record(state?.report);
  if (!marker || marker.key !== key || !scheduledTaskGraphOwnerMatches(marker.owner, owner) || execution.status !== "completed"
    || !report || ![report.processed, report.applied, report.queued, report.pending, report.skipped, report.failed, report.durationMs].every(safeCount)) return null;
  return report;
}
function matchingTurnSnapshot(value: unknown) {
  const input = record(value);
  if (input?.automationRunMode !== "scheduled") return null;
  try { return parseScheduledAutomationSnapshot(input.scheduledAutomationSnapshot); }
  catch { return null; }
}
function leaseIsCurrent(turn: Record<string, unknown>, owner: RequestOwner): boolean {
  const expires = turn.leaseExpiresAt instanceof Date ? turn.leaseExpiresAt.getTime()
    : typeof turn.leaseExpiresAt === "string" ? Date.parse(turn.leaseExpiresAt) : Number.NaN;
  return turn.status === "in_progress" && turn.leaseOwnerId === owner.turnLeaseOwnerId
    && turn.leaseVersion === owner.turnLeaseVersion && Number.isFinite(expires) && expires > Date.now();
}
function reportLeaseIsCurrent(turn: Record<string, unknown>, owner: RequestOwner): boolean {
  if (turn.leaseVersion !== owner.turnLeaseVersion) return false;
  if (["in_progress", "waiting_for_user"].includes(String(turn.status)) && turn.leaseOwnerId === owner.turnLeaseOwnerId) {
    const expires = turn.leaseExpiresAt instanceof Date ? turn.leaseExpiresAt.getTime()
      : typeof turn.leaseExpiresAt === "string" ? Date.parse(turn.leaseExpiresAt) : Number.NaN;
    return Number.isFinite(expires) && expires > Date.now();
  }
  return ["waiting_for_user", "completed"].includes(String(turn.status))
    && turn.leaseOwnerId === null && turn.leaseExpiresAt === null;
}
async function readTurnLease(owner: RequestOwner): Promise<Record<string, unknown> | null> {
  return db.agentTurn.findFirst({ where: { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId },
    select: { status: true, leaseOwnerId: true, leaseVersion: true, leaseExpiresAt: true } });
}
async function completedReportLeaseIsCurrent(owner: RequestOwner): Promise<boolean> {
  const turn = await readTurnLease(owner);
  return Boolean(turn && reportLeaseIsCurrent(turn, owner));
}
function rootIsCurrent(root: Record<string, unknown>, owner: RequestOwner): boolean {
  return rootIdentityMatches(root, owner) && root.status === "running"
    && root.interruptRequestedAt === null && root.closedAt === null;
}
function rootIdentityMatches(root: Record<string, unknown>, owner: RequestOwner): boolean {
  return root.id === owner.rootTaskId && root.sessionId === owner.sessionId
    && root.turnId === owner.turnId && root.rootTaskId === owner.rootTaskId && root.parentTaskId === null
    && root.attemptCount === owner.rootAttemptCount;
}
function claimLeaseIsActive(state: Record<string, unknown>): boolean {
  const claim = record(state.scheduledTaskGraphClaim), expires = claim?.leaseExpiresAt;
  const timestamp = typeof expires === "string" ? Date.parse(expires) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp > Date.now();
}
function claimLeaseIsValidAndExpired(claim: Record<string, unknown>, key: string,
  owner: ScheduledTaskGraphPipelineOwner, now = Date.now()): boolean {
  const fields = ["schemaVersion", "key", "claimToken", "owner", "claimedAt", "leaseExpiresAt"];
  if (Object.keys(claim).length !== fields.length || !fields.every(field => Object.hasOwn(claim, field))
    || claim.schemaVersion !== CLAIM_SCHEMA || claim.key !== key || !validId(claim.claimToken)
    || !scheduledTaskGraphOwnerMatches(claim.owner, owner)) return false;
  const claimedAt = typeof claim.claimedAt === "string" ? Date.parse(claim.claimedAt) : Number.NaN;
  const expiresAt = typeof claim.leaseExpiresAt === "string" ? Date.parse(claim.leaseExpiresAt) : Number.NaN;
  return Number.isFinite(claimedAt) && Number.isFinite(expiresAt) && expiresAt <= now;
}
function hasPrepareCheckpoint(state: Record<string, unknown>, key: string, owner: ScheduledTaskGraphPipelineOwner): boolean {
  const marker = record(state.scheduledTaskGraphContinuation);
  return marker?.key === key && scheduledTaskGraphOwnerMatches(marker.owner, owner) && typeof state.nextStage === "string" && state.nextStage !== "scout";
}
function hasMarkerlessScoutState(state: Record<string, unknown>): boolean {
  return state.nextStage === "scout" && state.scheduledTaskGraphContinuation === undefined
    && state.scheduledTaskGraphWait === undefined;
}
function mapCheckpointError(error: unknown): string {
  const reason = record(error)?.reason;
  if (reason === "snapshot_mismatch" || reason === "invalid_snapshot") return "scheduled_pipeline_snapshot_mismatch";
  if (reason === "discovery_incomplete") return "scheduled_pipeline_discovery_incomplete";
  if (reason === "owner_mismatch" || reason === "invalid_owner") return "scheduled_pipeline_owner_mismatch";
  return "scheduled_pipeline_attestation_invalid";
}

async function loadExecution(owner: RequestOwner): Promise<StoredExecution | null> {
  return db.agentExecution.findFirst({
    where: { userId: owner.userId, sessionId: owner.sessionId },
    select: { id: true, status: true, attemptCount: true, state: true },
  }) as Promise<StoredExecution | null>;
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.AGENT_WORKER_SECRET;
  if (!secret || request.headers.get("x-agent-worker-secret") !== secret) return blocked(401, "scheduled_pipeline_unauthorized");
  const body = parseBody(await request.json().catch(() => null));
  if (!body) return blocked(400, "scheduled_pipeline_request_invalid");
  const { owner, attestation } = body;
  const [turn, root, session, user] = await Promise.all([
    db.agentTurn.findFirst({ where: { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId },
      select: { id: true, userId: true, sessionId: true, status: true, source: true, executionMode: true, input: true,
        rootTaskId: true, leaseOwnerId: true, leaseVersion: true, leaseExpiresAt: true } }),
    db.subAgentTask.findFirst({ where: { id: owner.rootTaskId, sessionId: owner.sessionId, turnId: owner.turnId,
      parentTaskId: null, session: { userId: owner.userId } },
      select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, status: true,
        attemptCount: true, interruptRequestedAt: true, closedAt: true } }),
    db.agentSession.findFirst({ where: { id: owner.sessionId, userId: owner.userId }, select: { id: true } }),
    db.user.findUnique({ where: { id: owner.userId }, select: { accountStatus: true } }),
  ]);
  if (!turn || !session || turn.userId !== owner.userId || turn.sessionId !== owner.sessionId || turn.rootTaskId !== owner.rootTaskId) {
    return blocked(409, "scheduled_pipeline_owner_mismatch");
  }
  const snapshot = matchingTurnSnapshot(turn.input);
  if (turn.source !== "automation" || turn.executionMode !== "canonical_task_graph" || !snapshot) {
    return blocked(409, "scheduled_pipeline_mode_mismatch");
  }
  if (!root || !rootIdentityMatches(root, owner)) return blocked(409, "scheduled_pipeline_owner_mismatch");

  const execution = await loadExecution(owner);
  if (!execution || !safeCount(execution.attemptCount)) return blocked(409, "scheduled_pipeline_execution_mismatch");
  const executionOwner: ScheduledTaskGraphPipelineOwner = { ...owner, executionId: execution.id, executionAttemptCount: execution.attemptCount };
  let key: string;
  try {
    key = scheduledTaskGraphContinuationKey(executionOwner, attestation);
    if (scheduledAutomationSnapshotDigest(snapshot) !== record(attestation)?.snapshotDigest) return blocked(409, "scheduled_pipeline_snapshot_mismatch");
  } catch (error) { return blocked(409, mapCheckpointError(error)); }
  const ids = candidates(attestation);
  if (!ids) return blocked(409, "scheduled_pipeline_attestation_invalid");
  const jobs = await db.job.findMany({ where: { userId: owner.userId, id: { in: ids } } }) as Job[];
  if (jobs.length !== ids.length || new Set(jobs.map(job => job.id)).size !== ids.length) return blocked(409, "scheduled_pipeline_jobs_mismatch");

  const report = finalReport(execution, key, executionOwner);
  if (report) return await completedReportLeaseIsCurrent(owner)
    ? json(200, { status: "completed", report }) : blocked(409, "scheduled_pipeline_turn_stale");
  if (execution.status === "completed") {
    const prior = priorScheduledTaskGraphContinuation({ state: execution.state, owner: executionOwner, snapshot, attestation });
    const replay = prior && finalReport(execution, prior.key, prior.owner);
    const currentTurn = replay ? await readTurnLease(owner) : null;
    if (replay && currentTurn && leaseIsCurrent(currentTurn, owner)) return json(200, { status: "completed", report: replay });
    return blocked(409, "scheduled_pipeline_execution_mismatch");
  }
  const priorWait = readScheduledTaskGraphWaitMarker(execution.state);
  if (priorWait && priorWait.key === key && scheduledTaskGraphOwnerMatches(priorWait.owner, executionOwner)
    && execution.status === "waiting_for_user" && turn.status === "waiting_for_user") {
    return json(202, { status: "waiting_for_user", waitId: priorWait.waitId, stage: priorWait.stage });
  }
  if (!rootIsCurrent(root, owner) || !leaseIsCurrent(turn, owner)) return blocked(409, "scheduled_pipeline_turn_stale");
  if (user?.accountStatus !== "active") return blocked(403, "scheduled_pipeline_account_unavailable");
  if (!await isFeatureAllowed(owner.userId, "auto_apply")) return blocked(403, "scheduled_pipeline_entitlement_required");
  const aiAccess = await resolveAiAccess(owner.userId);
  if (aiAccess === "disabled") return blocked(403, "scheduled_pipeline_ai_unavailable");
  if (aiAccess === "exhausted") return blocked(429, "scheduled_pipeline_ai_budget_exhausted");
  if (snapshot.autoApply && !await hasEffectiveEntitlement(owner.userId, "auto_apply")) return blocked(403, "scheduled_pipeline_entitlement_required");
  const configured = await loadUserAiConfig(owner.userId, "autoApply");
  const aiConfig = configured.resolvedKey
    ? { ...configured, usageUserId: owner.userId, usageFeatureKey: "autoApply", usageRuntime: "worker" as const }
    : { ...resolveConfig(APPLYMATE_BACKING), usageUserId: owner.userId, usageFeatureKey: "autoApply", usageRuntime: "worker" as const };

  const state = record(execution.state);
  const wait = readScheduledTaskGraphWaitMarker(state);
  if (state?.scheduledTaskGraphWait !== undefined && !wait) return blocked(409, "scheduled_pipeline_claim_conflict");
  if (wait && execution.status !== "waiting_for_user") {
    const question = await loadScheduledTaskGraphWaitQuestion(executionOwner, wait.waitId, wait.stage);
    if (!question) return json(202, { status: "waiting_for_user", waitId: wait.waitId, stage: wait.stage });
    const resumable = question.answered && execution.status === "running"
      && turn.status === "in_progress" && leaseIsCurrent(turn, owner);
    if (!resumable) return json(202, { status: "waiting_for_user", waitId: wait.waitId, stage: wait.stage });
  }
  if (!state || (execution.status !== "running" && !(execution.status === "waiting_for_user" && wait))) {
    return sameClaim(execution.state, key, executionOwner)
      ? blocked(500, "scheduled_pipeline_execution_failed") : blocked(409, "scheduled_pipeline_execution_mismatch");
  }
  const existingClaim = record(state.scheduledTaskGraphClaim);
  let claimedState: Record<string, unknown>;
  let resumeQuestionId: string | undefined;
  const claimToken = randomUUID();
  if (wait) {
    const question = await loadScheduledTaskGraphWaitQuestion(executionOwner, wait.waitId, wait.stage);
    if (!question || !question.answered) return blocked(409, "scheduled_pipeline_analysis_interrupted");
    const rebind = rebindScheduledTaskGraphWaitState({ state, owner: executionOwner, key, claimToken,
      snapshotDigest: String(record(attestation)?.snapshotDigest),
      graphRevision: Number(record(attestation)?.graphRevision), evidenceDigest: String(record(attestation)?.evidenceDigest) });
    if (!rebind) return blocked(409, "scheduled_pipeline_claim_conflict");
    resumeQuestionId = rebind.waitId;
    const reboundClaim = record(rebind.state.scheduledTaskGraphClaim);
    claimedState = { ...rebind.state, scheduledTaskGraphClaim: { ...reboundClaim,
      claimToken, claimedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() } };
  } else if (existingClaim && sameClaim(state, key, executionOwner)) {
    if (claimLeaseIsActive(state)) return json(202, { status: "accepted", duplicate: true });
    if (!claimLeaseIsValidAndExpired(existingClaim, key, executionOwner)) {
      return blocked(409, "scheduled_pipeline_claim_conflict");
    }
    const markerlessScout = hasMarkerlessScoutState(state);
    if (!hasPrepareCheckpoint(state, key, executionOwner) && !markerlessScout) {
      return blocked(409, "scheduled_pipeline_analysis_interrupted");
    }
    claimedState = { ...state, scheduledTaskGraphClaim: { ...existingClaim, claimToken, claimedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() } };
  } else if (existingClaim) {
    const claimedAt = new Date().toISOString(), leaseExpiresAt = new Date(Date.now() + 600_000).toISOString();
    const rebound = rebindScheduledTaskGraphClaimForLease({ state, owner: executionOwner, key, claimToken, snapshot, attestation, claimedAt, leaseExpiresAt });
    if (!rebound) return blocked(409, "scheduled_pipeline_claim_conflict");
    claimedState = rebound;
  } else {
    if (existingClaim || state.scheduledTaskGraphContinuation !== undefined || state.nextStage !== "scout") {
      return blocked(409, "scheduled_pipeline_claim_conflict");
    }
    claimedState = { ...state, scheduledTaskGraphClaim: { schemaVersion: CLAIM_SCHEMA, key, claimToken, owner: executionOwner,
      claimedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() } };
  }
  const claimed = await db.agentExecution.updateMany({
    where: { id: execution.id, userId: owner.userId, sessionId: owner.sessionId, status: execution.status,
      attemptCount: execution.attemptCount, state: { equals: state as Prisma.InputJsonValue } },
    data: { status: "running", state: claimedState as Prisma.InputJsonValue },
  });
  if (claimed.count !== 1) {
    const latest = await loadExecution(owner);
    const exactReport = latest && finalReport(latest, key, executionOwner);
    if (exactReport && await completedReportLeaseIsCurrent(owner)) return json(200, { status: "completed", report: exactReport });
    const prior = latest && priorScheduledTaskGraphContinuation({ state: latest.state, owner: executionOwner, snapshot, attestation });
    const priorReport = latest && prior && finalReport(latest, prior.key, prior.owner);
    if (priorReport) {
      const currentTurn = await readTurnLease(owner).catch(() => null);
      if (currentTurn && leaseIsCurrent(currentTurn, owner)) return json(200, { status: "completed", report: priorReport });
    }
    if (latest && sameClaim(latest.state, key, executionOwner)) return json(202, { status: "accepted", duplicate: true });
    return blocked(409, "scheduled_pipeline_claim_conflict");
  }

  try {
    const result = await runAgentPipeline({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      executionId: execution.id, source: "automation", aiConfig, autonomous: snapshot.autoApply,
      ...(resumeQuestionId ? { questionId: resumeQuestionId } : {}),
      scheduledTaskGraph: { owner: executionOwner, snapshot, attestation, continuationKey: key, claimToken, ownedJobs: jobs }, signal: request.signal });
    if (!result) {
      const wakeWait = await loadDurableScheduledTaskGraphWait({ owner: executionOwner, key, claimToken, answeredOnly: true });
      return wakeWait ? json(202, { status: "waiting_for_user", ...wakeWait })
        : blocked(500, "scheduled_pipeline_execution_failed");
    }
    if (isWaitResult(result)) {
      const durableWait = await loadDurableScheduledTaskGraphWait({ owner: executionOwner, key, claimToken });
      return durableWait?.waitId === result.waitId && durableWait.stage === result.stage
        ? json(202, { status: "waiting_for_user", ...durableWait }) : blocked(500, "scheduled_pipeline_execution_failed");
    }
    return json(200, { status: "completed", report: result });
  } catch { return blocked(500, "scheduled_pipeline_execution_failed"); }
}

function isWaitResult(value: unknown): value is ScheduledTaskGraphWaitResult {
  const row = record(value);
  return row?.status === "waiting_for_user" && typeof row.waitId === "string" && typeof row.stage === "string";
}
