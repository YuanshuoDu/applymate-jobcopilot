import { describe, expect, it, vi } from "vitest";
import {
  createCancelOperationId,
  removePendingSubmitJobWithReceipt,
  type RedisEvalClient,
  type SubmissionRemovalIdentity,
} from "./apply-queue-removal";

const identity: SubmissionRemovalIdentity = {
  applicationTaskId: "task-1",
  userId: "user-1",
  jobId: "job-1",
  sessionId: "session-1",
  fillTurnId: "turn-1",
  workerTaskId: "submit-queue-job-1",
  receiptId: "approval-1",
  constraintHash: "hash-1",
};

const toKey = (type: string) => `bull:apply-tasks:${type}`;

describe("apply queue removal operation identity", () => {
  it("is stable across retries with a different per-click request ID", () => {
    const first = { ...identity, requestId: "click-1" };
    const retry = { ...identity, requestId: "click-2" };

    expect(createCancelOperationId(first)).toBe(createCancelOperationId(retry));
    expect(createCancelOperationId(identity)).toMatch(/^apply-submit-cancel:v1:[a-f0-9]{64}$/);
  });

  it.each([
    "applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "workerTaskId", "receiptId", "constraintHash",
  ] as const)("changes the cancellation identity when %s changes", field => {
    expect(createCancelOperationId({ ...identity, [field]: `${identity[field]}-changed` })).not.toBe(createCancelOperationId(identity));
  });

  it("rejects incomplete identity before any Redis operation", async () => {
    const evalScript = vi.fn().mockResolvedValue(0);
    const redis: RedisEvalClient = { eval: evalScript };

    await expect(removePendingSubmitJobWithReceipt(redis, toKey, { ...identity, fillTurnId: " " }))
      .resolves.toBe(false);
    expect(evalScript).not.toHaveBeenCalled();
    expect(() => createCancelOperationId({ ...identity, workerTaskId: "" })).toThrow("identity is incomplete");
  });
});

describe("atomic pending submit removal receipt", () => {
  it("uses one eval with the exact job identity, durable receipt and BullMQ event operation", async () => {
    const evalScript = vi.fn().mockResolvedValue(1);
    const redis: RedisEvalClient = { eval: evalScript };

    await expect(removePendingSubmitJobWithReceipt(redis, toKey, identity)).resolves.toBe(true);

    expect(evalScript).toHaveBeenCalledTimes(1);
    const [script, keyCount, ...args] = evalScript.mock.calls[0] as [string, number, ...string[]];
    expect(keyCount).toBe(20);
    expect(args.slice(0, keyCount)).toEqual(expect.arrayContaining([
      toKey(identity.workerTaskId), `${toKey(identity.workerTaskId)}:lock`, toKey("wait"), toKey("paused"),
      toKey("delayed"), toKey("active"), toKey("events"), toKey("meta"),
    ]));
    expect(script).toContain('"event", "removed", "jobId", jobId, "prev", previous');
    expect(script).toContain('"MAXLEN", "~", maxEvents');
    expect(script).toContain('"SET", receiptKey, ARGV[13], "NX"');
    expect(script).toContain('"EXISTS", KEYS[2])');
    expect(script).toContain('if ARGV[14] == "receipt-only" then return 0 end');

    const receiptText = args.at(-2);
    expect(args.at(-1)).toBe("remove-or-replay");
    expect(receiptText).toBeDefined();
    const parsed: unknown = JSON.parse(receiptText ?? "null");
    expect(parsed).toEqual({
      operationName: "apply-submit-cancel",
      version: 1,
      cancelOperationId: createCancelOperationId(identity),
      ...identity,
    });
  });

  it("uses receipt-only mode without enabling a fresh removal", async () => {
    const evalScript = vi.fn().mockResolvedValue(2);
    const redis: RedisEvalClient = { eval: evalScript };

    await expect(removePendingSubmitJobWithReceipt(redis, toKey, identity, { mode: "receipt-only" })).resolves.toBe(true);

    const call = evalScript.mock.calls[0];
    expect(call?.at(-1)).toBe("receipt-only");
    const script = call?.[0];
    expect(script).toContain('if ARGV[14] == "receipt-only" then return 0 end');
  });

  it.each([1, 2, "1", "2"])("accepts Redis success code %s for removal or exact receipt replay", async result => {
    const redis: RedisEvalClient = { eval: vi.fn().mockResolvedValue(result) };
    await expect(removePendingSubmitJobWithReceipt(redis, toKey, identity)).resolves.toBe(true);
  });

  it.each([0, -1, "0", "malformed", null])("fails closed on Redis rejection code %s without issuing a second command", async result => {
    const evalScript = vi.fn().mockResolvedValue(result);
    const redis: RedisEvalClient = { eval: evalScript };

    await expect(removePendingSubmitJobWithReceipt(redis, toKey, identity)).resolves.toBe(false);
    expect(evalScript).toHaveBeenCalledTimes(1);
  });

  it("propagates Redis errors so the caller can abort its fenced transaction", async () => {
    const redis: RedisEvalClient = { eval: vi.fn().mockRejectedValue(new Error("redis unavailable")) };
    await expect(removePendingSubmitJobWithReceipt(redis, toKey, identity)).rejects.toThrow("redis unavailable");
  });
});
