import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const withExactAttemptFence = vi.hoisted(() => vi.fn());
const appendFencedSubmitAudit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../queue/application-submit-fence.js", () => ({
  withExactAttemptFence,
  appendFencedSubmitAudit,
}));

import { acquireApplicationSubmissionStartFence, isApplicationSubmissionStopped, startApplicationSubmissionStopProbe } from "./application-submission-probe.js";
import type { ApplicationSubmitIdentity } from "../../queue/application-submit-fence.js";

const scope = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", fillTurnId: "turn_1",
  applicationTaskId: "task_1", jobId: "job_1", approvalId: "approval_1", constraintHash: "b".repeat(64),
  workerTaskId: "worker_1", executionId: "execution_1",
};

function fakePool(turnStatus = "in_progress", interrupted = false, markerRowCount = 1, markerCommitFails = false) {
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
  withExactAttemptFence.mockImplementation(async (
    _client: unknown,
    _identity: ApplicationSubmitIdentity,
    work: () => Promise<unknown>,
  ) => ({ kind: "current", value: await work() }));
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
      "BEGIN",
      "SELECT set_config($1, $2, true)",
      expect.stringContaining('FROM "agent_sessions"'),
      expect.stringContaining('FROM "agent_turns"'),
      expect.stringContaining("turn.interrupted"),
      expect.stringContaining("submission_request_started"),
      "COMMIT",
    ]);
    expect(boundary?.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT set_config($1, $2, true)",
      expect.stringContaining('FROM "agent_sessions"'),
      expect.stringContaining('FROM "agent_turns"'),
      expect.stringContaining("turn.interrupted"),
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
    withExactAttemptFence.mockResolvedValueOnce({ kind: "superseded" });

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

  it("checks scoped session, Turn, and interruption state", async () => {
    const { pool, clients } = fakePool();

    await expect(isApplicationSubmissionStopped(pool, scope)).resolves.toBe(false);

    expect(clients[0]?.query).toHaveBeenCalledWith(
      expect.stringContaining('"id" = $1 AND "sessionId" = $2 AND "userId" = $3'), ["turn_1", "session_1", "user_1"],
    );
    expect(clients[0]?.query).toHaveBeenCalledWith(expect.stringContaining("turn.interrupted"), ["session_1", "turn_1"]);
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
