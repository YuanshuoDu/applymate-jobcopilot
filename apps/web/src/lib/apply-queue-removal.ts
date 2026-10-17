import { createHash } from "node:crypto";

export interface SubmissionRemovalIdentity {
  applicationTaskId: string;
  userId: string;
  jobId: string;
  sessionId: string;
  fillTurnId: string;
  workerTaskId: string;
  receiptId: string;
  constraintHash: string;
}

export interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface SubmissionRemovalOptions {
  mode?: "remove-or-replay" | "receipt-only";
}

const OPERATION_NAME = "apply-submit-cancel";
const OPERATION_VERSION = 1;

function identityTuple(identity: SubmissionRemovalIdentity): string[] {
  return [identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId,
    identity.fillTurnId, identity.workerTaskId, identity.receiptId, identity.constraintHash];
}

function hasValidIdentity(identity: SubmissionRemovalIdentity): boolean {
  return identityTuple(identity).every(value => typeof value === "string" && value.trim().length > 0);
}

export function createCancelOperationId(identity: SubmissionRemovalIdentity): string {
  if (!hasValidIdentity(identity)) throw new Error("Submission removal identity is incomplete");
  const canonical = JSON.stringify([OPERATION_NAME, OPERATION_VERSION, ...identityTuple(identity)]);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${OPERATION_NAME}:v${OPERATION_VERSION}:${digest}`;
}

const REMOVE_PENDING_SUBMIT_LUA = `
local function kind(key, allowed)
  local actual = redis.call("TYPE", key).ok
  return actual == "none" or actual == allowed
end
local function listCount(key, value)
  local found = redis.call("LPOS", key, value, "COUNT", 2)
  return found and #found or 0
end
local types = {
  [1]="hash", [2]="string", [3]="list", [4]="list", [5]="zset", [6]="list",
  [7]="zset", [8]="zset", [9]="zset", [10]="zset", [11]="set", [12]="stream",
  [13]="hash", [14]="zset", [15]="list", [16]="set", [17]="hash", [18]="hash",
  [19]="zset", [20]="string"
}
for i, expected in ipairs(types) do
  if not kind(KEYS[i], expected) then return 0 end
end
local jobId = ARGV[1]
local receiptKey = KEYS[20]
local function stateMembershipCount()
  local count = listCount(KEYS[3], jobId) + listCount(KEYS[4], jobId)
  if redis.call("ZSCORE", KEYS[5], jobId) then count = count + 1 end
  count = count + listCount(KEYS[6], jobId)
  for i = 7, 10 do if redis.call("ZSCORE", KEYS[i], jobId) then count = count + 1 end end
  if redis.call("SISMEMBER", KEYS[11], jobId) == 1 then count = count + 1 end
  return count
end
if jobId ~= ARGV[10] or ARGV[2] ~= "apply-submit-cancel" or ARGV[3] ~= "1" or ARGV[4] == ""
    or (ARGV[14] ~= "remove-or-replay" and ARGV[14] ~= "receipt-only") then return 0 end
if redis.call("EXISTS", receiptKey) == 1 then
  if redis.call("GET", receiptKey) ~= ARGV[13] or redis.call("EXISTS", KEYS[1]) ~= 0
      or redis.call("EXISTS", KEYS[2]) ~= 0 or stateMembershipCount() ~= 0 then return 0 end
  for i = 15, 19 do if redis.call("EXISTS", KEYS[i]) ~= 0 then return 0 end end
  return 2
end
if ARGV[14] == "receipt-only" then return 0 end
if redis.call("EXISTS", KEYS[1]) ~= 1 or redis.call("EXISTS", KEYS[2]) ~= 0 then return 0 end
local jobName, payloadRaw, parentKey, parent, dedupId, repeatKey, legacyRepeatKey =
  unpack(redis.call("HMGET", KEYS[1], "name", "data", "parentKey", "parent", "deid", "rjk", "repeatJobKey"))
if jobName ~= "apply" or not payloadRaw or parentKey or parent or dedupId or repeatKey or legacyRepeatKey then return 0 end
for i = 16, 19 do if redis.call("EXISTS", KEYS[i]) ~= 0 then return 0 end end
local decoded, payload = pcall(cjson.decode, payloadRaw)
if not decoded or type(payload) ~= "table" or payload.operation ~= "submit"
    or payload.applicationTaskId ~= ARGV[5] or payload.userId ~= ARGV[6] or payload.jobId ~= ARGV[7]
    or payload.sessionId ~= ARGV[8] or payload.fillTurnId ~= ARGV[9]
    or payload.receiptId ~= ARGV[11] or payload.constraintHash ~= ARGV[12] then return 0 end
local waitCount, pausedCount, delayedCount = listCount(KEYS[3], jobId), listCount(KEYS[4], jobId), redis.call("ZSCORE", KEYS[5], jobId) and 1 or 0
local pendingCount = waitCount + pausedCount + delayedCount
if pendingCount ~= 1 then return 0 end
for i = 6, 11 do
  if i == 6 and listCount(KEYS[i], jobId) > 0 then return 0 end
  if i == 11 and redis.call("SISMEMBER", KEYS[i], jobId) == 1 then return 0 end
  if i > 6 and i < 11 and redis.call("ZSCORE", KEYS[i], jobId) then return 0 end
end
local previous = waitCount == 1 and "wait" or (pausedCount == 1 and "paused" or "delayed")
local maxEventsRaw = redis.call("HGET", KEYS[13], "opts.maxLenEvents")
local maxEvents = tonumber(maxEventsRaw or "10000")
if not maxEvents or maxEvents < 1 or maxEvents > 2147483647 or maxEvents % 1 ~= 0 then return 0 end
local receiptSet = redis.call("SET", receiptKey, ARGV[13], "NX")
if not receiptSet or receiptSet.ok ~= "OK" then return 0 end
local removed = previous == "wait" and redis.call("LREM", KEYS[3], 1, jobId)
  or (previous == "paused" and redis.call("LREM", KEYS[4], 1, jobId)
  or redis.call("ZREM", KEYS[5], jobId))
if removed ~= 1 then redis.call("DEL", receiptKey); return 0 end
redis.call("XADD", KEYS[12], "MAXLEN", "~", maxEvents, "*", "event", "removed", "jobId", jobId, "prev", previous)
redis.call("DEL", KEYS[1], KEYS[15])
return 1
`;

function receiptFor(identity: SubmissionRemovalIdentity, cancelOperationId: string): string {
  return JSON.stringify({
    operationName: OPERATION_NAME,
    version: OPERATION_VERSION,
    cancelOperationId,
    applicationTaskId: identity.applicationTaskId,
    userId: identity.userId,
    jobId: identity.jobId,
    sessionId: identity.sessionId,
    fillTurnId: identity.fillTurnId,
    workerTaskId: identity.workerTaskId,
    receiptId: identity.receiptId,
    constraintHash: identity.constraintHash,
  });
}

/** Atomically removes the exact pending submit job or verifies its prior removal receipt. */
export async function removePendingSubmitJobWithReceipt(
  redis: RedisEvalClient,
  toKey: (type: string) => string,
  identity: SubmissionRemovalIdentity,
  options: SubmissionRemovalOptions = {},
): Promise<boolean> {
  if (!hasValidIdentity(identity)) return false;
  const mode = options.mode ?? "remove-or-replay";
  if (mode !== "remove-or-replay" && mode !== "receipt-only") return false;
  const cancelOperationId = createCancelOperationId(identity);
  const jobKey = toKey(identity.workerTaskId);
  const keys = [
    jobKey, `${jobKey}:lock`, toKey("wait"), toKey("paused"), toKey("delayed"), toKey("active"),
    toKey("prioritized"), toKey("waiting-children"), toKey("completed"), toKey("failed"),
    toKey("stalled"), toKey("events"), toKey("meta"), toKey("repeat"), `${jobKey}:logs`,
    `${jobKey}:dependencies`, `${jobKey}:processed`, `${jobKey}:failed`, `${jobKey}:unsuccessful`,
    toKey(`cancel-receipt:${cancelOperationId}`),
  ];
  const args = [identity.workerTaskId, OPERATION_NAME, String(OPERATION_VERSION), cancelOperationId,
    identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId, identity.fillTurnId,
    identity.workerTaskId, identity.receiptId, identity.constraintHash, receiptFor(identity, cancelOperationId), mode];
  const result = await redis.eval(REMOVE_PENDING_SUBMIT_LUA, keys.length, ...keys, ...args);
  return result === 1 || result === 2 || result === "1" || result === "2";
}
