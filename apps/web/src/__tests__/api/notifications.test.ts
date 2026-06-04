import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (val: unknown) => val instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.executeRaw,
  },
}));

function getRequest() {
  return new Request("http://localhost/api/notifications");
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/notifications/mark-read", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

describe("notifications API", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireAuth.mockReset();
    mocks.queryRaw.mockReset();
    mocks.executeRaw.mockReset();
    mocks.requireAuth.mockResolvedValue({ userId: "user-1" });
  });

  it("returns recent notifications with unread count", async () => {
    const rows = [
      {
        id: "notif-1",
        type: "apply_manual",
        title: "Action needed",
        body: "Engineer",
        read: false,
        jobId: "job-1",
        createdAt: new Date("2026-06-04T10:00:00Z"),
      },
      {
        id: "notif-2",
        type: "apply_submitted",
        title: "Submitted",
        body: "Designer",
        read: true,
        jobId: "job-2",
        createdAt: new Date("2026-06-04T09:00:00Z"),
      },
    ];
    mocks.queryRaw.mockResolvedValueOnce(rows);
    const { GET } = await import("@/app/api/notifications/route");

    const res = await GET(getRequest() as never);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      notifications: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
      unreadCount: 1,
    });
  });

  it("marks a specific notification as read", async () => {
    mocks.executeRaw.mockResolvedValueOnce(1);
    const { PATCH } = await import("@/app/api/notifications/mark-read/route");

    const res = await PATCH(patchRequest({ id: "notif-1" }) as never);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mocks.executeRaw).toHaveBeenCalledOnce();
  });

  it("marks all notifications as read when no id is provided", async () => {
    mocks.executeRaw.mockResolvedValueOnce(3);
    const { PATCH } = await import("@/app/api/notifications/mark-read/route");

    const res = await PATCH(patchRequest({}) as never);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mocks.executeRaw).toHaveBeenCalledOnce();
  });

  it("returns auth errors without querying", async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }));
    const { GET } = await import("@/app/api/notifications/route");

    const res = await GET(getRequest() as never);

    expect(res.status).toBe(401);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
