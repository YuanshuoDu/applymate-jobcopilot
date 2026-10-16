import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { insertApplyResultWithClient, persistLegacyApplicationTaskOutcome } from "./legacy-application-task-outcome.js";

function testClient(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => {
    const row = rows.shift();
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  return { client: { query } as unknown as PoolClient, query };
}

const scope = { applicationTaskId: "task-1", userId: "user-1", jobId: "job-1" };

describe("legacy application task outcome fencing", () => {
  it("writes only after locking the scoped unbound task, with session and turn locks first", async () => {
    const { client, query } = testClient([
      { sessionId: "session-1" },
      { id: "session-1" },
      { id: "turn-1" },
      { id: "task-1", fillTurnId: null, sessionId: "session-1", status: "filling", checkpoint: "browser_active" },
    ]);
    const write = vi.fn(async () => "written");

    await expect(persistLegacyApplicationTaskOutcome(client, scope, write, { lockLatestTurn: true }))
      .resolves.toEqual({ status: "persisted", value: "written" });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toContain('WHERE "id" = $1 AND "userId" = $2 AND "jobId" = $3');
    expect(statements[1]).toContain('FROM agent_sessions');
    expect(statements[2]).toContain('FROM agent_turns');
    expect(statements[3]).toContain('FROM application_tasks');
    expect(statements[3]).toContain('"sessionId" IS NOT DISTINCT FROM $4');
    expect(statements[3]).toContain("FOR UPDATE");
    expect(write).toHaveBeenCalledWith(client);
    expect(statements.slice(4).some((sql) => /agent_sessions|agent_turns/.test(sql))).toBe(false);
  });

  it("suppresses every callback when the exact task is already bound to a TaskGraph Turn", async () => {
    const { client, query } = testClient([
      { sessionId: "session-1" },
      { id: "session-1" },
      { id: "task-1", fillTurnId: "turn-1", sessionId: "session-1", status: "filling", checkpoint: "taskgraph_fill_queued" },
    ]);
    const write = vi.fn();

    await expect(persistLegacyApplicationTaskOutcome(client, scope, write))
      .resolves.toEqual({ status: "taskgraph_bound" });

    expect(query).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["filling", "form_fill_queued"],
    ["filling", "browser_active"],
  ])("allows a live legacy Worker state (%s/%s)", async (status, checkpoint) => {
    const { client } = testClient([
      { sessionId: "session-1" },
      { id: "session-1" },
      { id: "task-1", fillTurnId: null, sessionId: "session-1", status, checkpoint },
    ]);
    const write = vi.fn(async () => "written");

    await expect(persistLegacyApplicationTaskOutcome(client, scope, write))
      .resolves.toEqual({ status: "persisted", value: "written" });
    expect(write).toHaveBeenCalledOnce();
  });

  it.each([
    ["cancelled", "cancelled_by_user"],
    ["failed", "account_suspended"],
    ["waiting_for_user", "materials_ready"],
    ["filling", "submission_uncertain"],
    ["filling", "taskgraph_fill_queued"],
  ])("suppresses late outcomes unless the legacy task remains completable (%s/%s)", async (status, checkpoint) => {
    const { client, query } = testClient([
      { sessionId: "session-1" },
      { id: "session-1" },
      { id: "task-1", fillTurnId: null, sessionId: "session-1", status, checkpoint },
    ]);
    const write = vi.fn();

    await expect(persistLegacyApplicationTaskOutcome(client, scope, write))
      .resolves.toEqual({ status: "task_inactive" });
    expect(query.mock.calls.at(-1)?.[0]).toContain("FOR UPDATE");
    expect(write).not.toHaveBeenCalled();
  });

  it("does not write when the exact task no longer exists", async () => {
    const { client, query } = testClient([]);
    const write = vi.fn();

    await expect(persistLegacyApplicationTaskOutcome(client, scope, write))
      .resolves.toEqual({ status: "missing" });

    expect(query).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it("inserts ApplyResult using the caller-owned transaction client", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ id: 41 }], rowCount: 1 }));
    const client = { query } as unknown as PoolClient;

    await expect(insertApplyResultWithClient(client, {
      userId: "user-1", jobId: "job-1", status: "manual", error: "Review required", durationMs: 17,
    })).resolves.toBe(41);

    expect(query.mock.calls[0]?.[1]).toEqual([
      "user-1", "job-1", "unattended", null, null, "manual", "Review required", 17,
    ]);
  });
});
