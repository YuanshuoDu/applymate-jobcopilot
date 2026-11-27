import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestFence = vi.hoisted(() => vi.fn());
const readTurnState = vi.hoisted(() => vi.fn());
const appendFencedSubmitAudit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../queue/application-submit-fence.js", () => ({
  appendFencedSubmitAudit,
}));
vi.mock("../../db/reviewed-application-submit-request-fence.js", () => ({
  withReviewedApplicationSubmitRequestFence: requestFence,
  readSubmissionTurnState: readTurnState,
}));

import { acquireApplicationSubmissionStartFence, isApplicationSubmissionStopped, startApplicationSubmissionStopProbe } from "./application-submission-probe.js";

const scope = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", fillTurnId: "turn_1",
  applicationTaskId: "task_1", jobId: "job_1", approvalId: "approval_1", constraintHash: "b".repeat(64),
  workerTaskId: "worker_1", executionId: "execution_1",
};
const objectiveSource = {
  schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1",
  approvalId: `objective-review:objective-review-${"e".repeat(40)}:2`,
  reviewTurnId: "review-turn-1", materialProofHash: "f".repeat(64),
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fakePool(turnStatus = "in_progress", interrupted = false, markerRowCount = 1, markerCommitFails = false) {
  readTurnState.mockResolvedValue({ sessionStatus: "running", turnStatus, interrupted });
  const clients: Array<{ role: "marker" | "boundary"; query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
  const connect = vi.fn(async () => {
    const role: "marker" | "boundary" = clients.length % 2 === 0 ? "marker" : "boundary";
    const query = vi.fn(async (sql: string) => {
      if (sql === "COMMIT" && role === "marker" && markerCommitFails) throw new Error("connection lost during marker commit");
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE application_tasks")) return { rows: markerRowCount === 1 ? [{ id: "task_1" }] : [], rowCount: markerRowCount };
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ status: "running" }], rowCount: 1 };
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ status: turnStatus }], rowCount: 1 };
      if (sql.includes('FROM "agent_events"')) return { rows: [{ stopped: interrupted }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const client = { role, query, release };
    clients.push(client);
    return client;
  });
  return {
    pool: { connect } as unknown as Pool,
    clients,
    connect,
  };
}

beforeEach(() => {
  requestFence.mockReset().mockImplementation(async (
    _client: unknown, _identity: unknown, _phase: unknown, expectedSourceTurnId: string | null | undefined,
    work: () => Promise<unknown>,
  ) => ({ kind: "current", value: await work(), sourceTurnId: expectedSourceTurnId ?? null }));
  readTurnState.mockResolvedValue({ sessionStatus: "running", turnStatus: "in_progress", interrupted: false });
  appendFencedSubmitAudit.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("application submission Stop probe", () => {
  it("commits the marker under the exact fence, then holds a fresh fence through the request boundary", async () => {
    const { pool, clients, connect } = fakePool();
    const fence = await acquireApplicationSubmissionStartFence(pool, scope);
    const marker = clients[0];
    const boundary = clients[1];

    expect(fence.state).toBe("ready");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(marker?.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", "SELECT set_config($1, $2, true)", expect.stringContaining("submission_request_started"), "COMMIT",
    ]);
    expect(boundary?.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", "SELECT set_config($1, $2, true)",
    ]);
    expect(marker?.release).toHaveBeenCalledOnce();
    expect(boundary?.release).not.toHaveBeenCalled();

    await fence.release(true);

    expect(boundary?.query).toHaveBeenLastCalledWith("COMMIT");
    expect(boundary?.release).toHaveBeenCalledOnce();
  });

  it("serializes probes while one request boundary owns the in-process permit", async () => {
    const { pool, clients, connect } = fakePool();
    const first = await acquireApplicationSubmissionStartFence(pool, scope);
    const secondAttempt = acquireApplicationSubmissionStartFence(pool, scope);

    expect(connect).toHaveBeenCalledTimes(2);
    await first.release(true);
    const second = await secondAttempt;
    expect(connect).toHaveBeenCalledTimes(4);
    expect(clients[1]?.query).toHaveBeenLastCalledWith("COMMIT");

    await second.release(false);
    expect(clients[3]?.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("retains the ready lease across acquisition abort and timeout until the route owner releases it", async () => {
    vi.useFakeTimers()
    const { pool, clients, connect } = fakePool()
    const controller = new AbortController()
    const ready = await acquireApplicationSubmissionStartFence(pool, scope, { signal: controller.signal, timeoutMs: 1_000 })
    expect(ready.state).toBe("ready")

    controller.abort()
    await vi.advanceTimersByTimeAsync(1_001)
    expect(clients[1]?.release).not.toHaveBeenCalled()
    const nextAttempt = acquireApplicationSubmissionStartFence(pool, scope)
    await Promise.resolve()
    expect(connect).toHaveBeenCalledTimes(2)
    await ready.release(true)
    const next = await nextAttempt
    expect(clients[1]?.query).toHaveBeenLastCalledWith("COMMIT")
    expect(clients[1]?.release).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledTimes(4)
    await next.release(false)
  })

  it("destroys a ready lease once when its route owner forcibly aborts release", async () => {
    const { pool, clients, connect } = fakePool()
    const ready = await acquireApplicationSubmissionStartFence(pool, scope)
    expect(ready.state).toBe("ready")
    ready.abort?.()
    ready.abort?.()
    expect(clients[1]?.release).toHaveBeenCalledOnce()
    expect(clients[1]?.release).toHaveBeenCalledWith(expect.any(Error))
    await expect(ready.release(true)).rejects.toThrow("Submission fence was forcibly released.")
    const next = await acquireApplicationSubmissionStartFence(pool, scope)
    expect(connect).toHaveBeenCalledTimes(4)
    await next.release(false)
  })

  it("releases its permit after a checkout error or a stopped turn", async () => {
    const fallback = fakePool("interrupted");
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("injected pool checkout failure"))
      .mockImplementation(fallback.connect);
    const pool = { connect } as unknown as Pool;

    await expect(acquireApplicationSubmissionStartFence(pool, scope)).rejects.toThrow("injected pool checkout failure");
    await expect(acquireApplicationSubmissionStartFence(pool, scope)).resolves.toMatchObject({ state: "stopped" });
    expect(fallback.clients[0]?.release).toHaveBeenCalledOnce();
  });

  it("does not open a request when the exact application task is inactive", async () => {
    const { pool, clients, connect } = fakePool("in_progress", false, 0);

    await expect(acquireApplicationSubmissionStartFence(pool, scope)).resolves.toMatchObject({ state: "inactive" });

    expect(connect).toHaveBeenCalledOnce();
    expect(clients[0]?.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(clients[0]?.release).toHaveBeenCalledOnce();
  });

  it("records superseded start callbacks without writing a marker or retaining a request fence", async () => {
    const { pool, clients, connect } = fakePool();
    requestFence.mockResolvedValueOnce({ kind: "superseded" });

    await expect(acquireApplicationSubmissionStartFence(pool, scope)).resolves.toMatchObject({ state: "inactive" });

    expect(connect).toHaveBeenCalledOnce();
    expect(clients[0]?.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE application_tasks"), expect.anything());
    expect(appendFencedSubmitAudit).toHaveBeenCalledWith(expect.anything(), scope, "submission_start_marker");
    expect(clients[0]?.release).toHaveBeenCalledOnce();
  });

  it("returns an uncertain outcome when marker COMMIT is ambiguous and never reserves the request boundary", async () => {
    const { pool, clients, connect } = fakePool("in_progress", false, 1, true);

    const fence = await acquireApplicationSubmissionStartFence(pool, scope);

    expect(fence.state).toBe("uncertain");
    expect(connect).toHaveBeenCalledOnce();
    expect(clients[0]?.query).toHaveBeenCalledWith("COMMIT");
    expect(clients[0]?.query).toHaveBeenCalledWith("ROLLBACK");
    expect(clients[0]?.release).toHaveBeenCalledOnce();
    await fence.release(false);
  });

  it("keeps an in-flight marker COMMIT uncertain when cancellation wins and never opens the boundary", async () => {
    const commitStarted = deferred<void>()
    const lateCommit = deferred<{ rows: unknown[]; rowCount: number }>()
    const query = vi.fn(async (sql: string) => {
      if (sql === "COMMIT") { commitStarted.resolve(); return lateCommit.promise }
      if (["BEGIN", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes("UPDATE application_tasks")) return { rows: [{ id: "task_1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ status: "in_progress" }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"')) return { rows: [{ stopped: false }], rowCount: 1 }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const release = vi.fn()
    const connect = vi.fn().mockResolvedValue({ query, release })
    const controller = new AbortController()
    const pending = acquireApplicationSubmissionStartFence({ connect } as unknown as Pool, scope, {
      signal: controller.signal, timeoutMs: 1_000,
    })

    await commitStarted.promise
    controller.abort()
    await expect(pending).resolves.toMatchObject({ state: "uncertain" })
    expect(connect).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(expect.any(Error))

    lateCommit.resolve({ rows: [], rowCount: 1 })
  })

  it("declines an invalid reviewed receipt before writing the durable request marker", async () => {
    const { pool, clients, connect } = fakePool();
    requestFence.mockResolvedValueOnce({ kind: "invalid" });

    await expect(acquireApplicationSubmissionStartFence(pool, scope)).resolves.toMatchObject({ state: "inactive" });

    expect(connect).toHaveBeenCalledOnce();
    expect(clients[0]?.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(clients[0]?.query).not.toHaveBeenCalledWith(expect.stringContaining("submission_request_started"), expect.anything());
  });

  it("keeps a post-marker proof rejection uncertain and never releases the request", async () => {
    const { pool, clients } = fakePool();
    requestFence.mockImplementationOnce(async (_client, _scope, _phase, _expected, work) => ({
      kind: "current", value: await work(), sourceTurnId: "source-turn-1",
    })).mockResolvedValueOnce({ kind: "invalid" });

    const fence = await acquireApplicationSubmissionStartFence(pool, scope);

    expect(fence.state).toBe("uncertain");
    expect(clients[0]?.query).toHaveBeenCalledWith("COMMIT");
    expect(clients[1]?.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(clients.every(client => client.release.mock.calls.length === 1)).toBe(true);
    await fence.release(false);
  });

  it("carries the full Objective selector from the committed marker to the paused boundary", async () => {
    const { pool, clients } = fakePool();
    requestFence.mockImplementationOnce(async (_client, _scope, _phase, _expected, work) => ({
      kind: "current", value: await work(), sourceTurnId: null, objectiveSource,
    })).mockImplementationOnce(async (_client, _scope, _phase, expected) => {
      expect(expected).toEqual({ kind: "objective", source: objectiveSource })
      return { kind: "invalid" }
    })

    await expect(acquireApplicationSubmissionStartFence(pool, scope)).resolves.toMatchObject({ state: "uncertain" })
    await expect(requestFence.mock.results[0]?.value).resolves.toMatchObject({ objectiveSource })

    expect(requestFence).toHaveBeenNthCalledWith(1, expect.anything(), scope, "marker", undefined, expect.any(Function))
    expect(requestFence).toHaveBeenNthCalledWith(2, expect.anything(), scope, "boundary",
      { kind: "objective", source: objectiveSource }, expect.any(Function))
    expect(clients[0]?.query).toHaveBeenCalledWith("COMMIT")
    expect(clients[1]?.query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(clients[1]?.release).toHaveBeenCalledOnce()
  })

  it("keeps a boundary verification error uncertain after the durable marker", async () => {
    const { pool, clients } = fakePool();
    requestFence.mockImplementationOnce(async (_client, _scope, _phase, _expected, work) => ({
      kind: "current", value: await work(), sourceTurnId: "source-turn-1",
    })).mockRejectedValueOnce(new Error("proof lookup failed"));

    await expect(acquireApplicationSubmissionStartFence(pool, scope)).resolves.toMatchObject({ state: "uncertain" });

    expect(clients[0]?.query).toHaveBeenCalledWith("COMMIT");
    expect(clients[1]?.query).toHaveBeenCalledWith("ROLLBACK");
    expect(clients[1]?.release).toHaveBeenCalledOnce();
  });

  it("keeps an Objective boundary Stop uncertain after the marker", async () => {
    const { pool, clients } = fakePool();
    readTurnState
      .mockResolvedValueOnce({ sessionStatus: "running", turnStatus: "in_progress", interrupted: false })
      .mockResolvedValueOnce({ sessionStatus: "running", turnStatus: "interrupted", interrupted: true });
    requestFence
      .mockImplementationOnce(async (_client, _scope, _phase, _expected, work) => ({
        kind: "current", value: await work(), sourceTurnId: null, objectiveSource,
      }))
      .mockImplementationOnce(async (_client, _scope, _phase, expected, work) => ({
        kind: "current", value: await work(), sourceTurnId: null, objectiveSource: expected && typeof expected === "object" ? expected.source : undefined,
      }));

    const fence = await acquireApplicationSubmissionStartFence(pool, scope);

    expect(fence).toMatchObject({ state: "uncertain", markerCommitted: true });
    expect(clients[0]?.query).toHaveBeenCalledWith("COMMIT");
    expect(clients[1]?.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(clients.every(client => client.release.mock.calls.length === 1)).toBe(true);
  });

  it("keeps an Objective boundary superseded after marker commit uncertain", async () => {
    const { pool, clients } = fakePool();
    requestFence
      .mockImplementationOnce(async (_client, _scope, _phase, _expected, work) => ({
        kind: "current", value: await work(), sourceTurnId: null, objectiveSource,
      }))
      .mockResolvedValueOnce({ kind: "superseded" });

    const fence = await acquireApplicationSubmissionStartFence(pool, scope);

    expect(fence.state).toBe("uncertain");
    expect(clients[0]?.query).toHaveBeenCalledWith("COMMIT");
    expect(clients[1]?.query).toHaveBeenCalledWith("COMMIT");
    expect(clients.every(client => client.release.mock.calls.length === 1)).toBe(true);
  });

  it("keeps a reviewed boundary Stop uncertain after the marker", async () => {
    const { pool } = fakePool();
    readTurnState
      .mockResolvedValueOnce({ sessionStatus: "running", turnStatus: "in_progress", interrupted: false })
      .mockResolvedValueOnce({ sessionStatus: "running", turnStatus: "interrupted", interrupted: true });
    requestFence
      .mockImplementationOnce(async (_client, _scope, _phase, _expected, work) => ({
        kind: "current", value: await work(), sourceTurnId: "selected-source-turn",
      }))
      .mockImplementationOnce(async (_client, _scope, _phase, _expected, work) => ({
        kind: "current", value: await work(), sourceTurnId: "selected-source-turn",
      }));

    const fence = await acquireApplicationSubmissionStartFence(pool, scope);

    expect(fence).toMatchObject({ state: "uncertain", markerCommitted: true });
  });

  it("checks scoped session, Turn, and interruption state", async () => {
    const { pool, clients } = fakePool();

    await expect(isApplicationSubmissionStopped(pool, scope)).resolves.toBe(false);

    expect(readTurnState).toHaveBeenCalledWith(clients[0], scope);
    expect(clients[0]?.release).toHaveBeenCalledOnce();
  });

  it.each([["interrupted", false], ["in_progress", true]] as const)("detects stopped state from Turn status or event", async (turnStatus, interrupted) => {
    const { pool } = fakePool(turnStatus, interrupted);
    await expect(isApplicationSubmissionStopped(pool, scope)).resolves.toBe(true);
  });

  it("aborts the active browser best effort after observing Stop", async () => {
    vi.useFakeTimers();
    const { pool } = fakePool("interrupted");
    const closePage = vi.fn().mockResolvedValue(undefined);
    const onStopped = vi.fn();
    const controller = new AbortController();
    const probe = startApplicationSubmissionStopProbe({
      pool, scope, closePage, controller, hasSubmissionStarted: () => false,
      onStopped, onUnavailable: vi.fn(), intervalMs: 100_000,
    });

    await probe.pollNow();
    probe.stop();

    expect(onStopped).toHaveBeenCalledOnce();
    expect(closePage).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports state-store failures without treating them as Stop", async () => {
    const onUnavailable = vi.fn();
    const controller = new AbortController();
    const closePage = vi.fn().mockResolvedValue(undefined);
    const probe = startApplicationSubmissionStopProbe({
      pool: { connect: vi.fn().mockRejectedValue(new Error("database unavailable")) } as unknown as Pool,
      scope, closePage, controller, hasSubmissionStarted: () => false,
      onStopped: vi.fn(), onUnavailable, intervalMs: 100_000,
    });

    await probe.pollNow();
    probe.stop();

    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({ message: "database unavailable" }));
    expect(controller.signal.aborted).toBe(true);
    expect(closePage).toHaveBeenCalledOnce();
  });

  it("does not treat a post-checkpoint probe error as a Stop", async () => {
    const controller = new AbortController();
    const closePage = vi.fn().mockResolvedValue(undefined);
    const probe = startApplicationSubmissionStopProbe({
      pool: { connect: vi.fn().mockRejectedValue(new Error("database unavailable")) } as unknown as Pool,
      scope, closePage, controller, hasSubmissionStarted: () => true,
      onStopped: vi.fn(), onUnavailable: vi.fn(), intervalMs: 100_000,
    });

    await probe.pollNow();
    probe.stop();

    expect(controller.signal.aborted).toBe(false);
    expect(closePage).not.toHaveBeenCalled();
  });
});
