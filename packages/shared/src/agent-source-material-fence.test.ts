import { describe, expect, it } from "vitest";

import {
  buildAgentSourceMaterialFenceKey,
  normalizeAgentSourceMaterialFenceError,
  sortUniqueAgentSourceMaterialFenceUserIds,
} from "./agent-source-material-fence.js";

const FENCE_ERROR_MESSAGE = "source material fence transaction verification failed";
type NormalizedFenceError = Error & { code?: unknown; meta?: unknown; retryable?: unknown };

describe("agent source material fence key contract", () => {
  it("uses the versioned prefix and preserves the exact persisted user ID", () => {
    expect(buildAgentSourceMaterialFenceKey(" user:α "))
      .toBe("applymate:gate-source-fence:v1: user:α ");
    expect(buildAgentSourceMaterialFenceKey(" \t "))
      .toBe("applymate:gate-source-fence:v1: \t ");
  });

  it("fails closed for empty or non-string user IDs without echoing the input", () => {
    expect(() => buildAgentSourceMaterialFenceKey("")).toThrow(TypeError);
    for (const invalidUserId of [undefined, null, 7, {}]) {
      expect(() => buildAgentSourceMaterialFenceKey(invalidUserId as string)).toThrow(TypeError);
    }
  });

  it("sorts and deduplicates exact IDs deterministically without mutating the input", () => {
    const userIds = ["z-user", "a-user", "z-user", "A-user"];

    expect(sortUniqueAgentSourceMaterialFenceUserIds(userIds)).toEqual(["A-user", "a-user", "z-user"]);
    expect(userIds).toEqual(["z-user", "a-user", "z-user", "A-user"]);
  });

  it("rejects empty or non-string entries before sorting", () => {
    expect(() => sortUniqueAgentSourceMaterialFenceUserIds([""])).toThrow(TypeError);
    expect(() => sortUniqueAgentSourceMaterialFenceUserIds(["valid-user", 9 as unknown as string])).toThrow(TypeError);
  });

  it("keeps distinct IDs in distinct, unambiguous prefixed keys", () => {
    const firstKey = buildAgentSourceMaterialFenceKey("user-1");
    const secondKey = buildAgentSourceMaterialFenceKey("user-2");

    expect(firstKey).toBe("applymate:gate-source-fence:v1:user-1");
    expect(secondKey).toBe("applymate:gate-source-fence:v1:user-2");
    expect(firstKey).not.toBe(secondKey);
  });

  it.each(["40P01", "40001", "55P03", "57014", "P2034"])(
    "preserves allowlisted classification code %s without retaining other database details",
    code => {
      const source = Object.assign(new Error("private query, user ID, and XID"), {
        code,
        meta: { code: "secret-meta", query: "SELECT secret", parameters: "private-user-id" },
        clientVersion: "private-version",
        retryable: true,
        cause: new Error("private cause"),
      });

      const normalized = normalizeAgentSourceMaterialFenceError(source) as NormalizedFenceError;

      expect(normalized.message).toBe(FENCE_ERROR_MESSAGE);
      expect(normalized.code).toBe(code);
      expect(normalized.meta).toBeUndefined();
      expect(normalized).not.toHaveProperty("cause");
      expect(normalized).not.toHaveProperty("clientVersion");
      expect(normalized).not.toHaveProperty("retryable");
      expect(Object.keys(normalized)).toEqual(["code"]);
    },
  );

  it("retains only an allowlisted PostgreSQL code from Prisma P2010 metadata", () => {
    const source = Object.assign(new Error("private SQL and parameters"), {
      code: "P2010",
      meta: {
        code: "40P01",
        message: "private database detail",
        query: "SELECT private-user-id",
        parameters: "transaction 8675309",
      },
      cause: new Error("private cause"),
    });

    const normalized = normalizeAgentSourceMaterialFenceError(source) as NormalizedFenceError;

    expect(normalized.message).toBe(FENCE_ERROR_MESSAGE);
    expect(normalized.code).toBe("P2010");
    expect(normalized.meta).toEqual({ code: "40P01" });
    expect(Object.keys(normalized).sort()).toEqual(["code", "meta"]);
    expect(normalized).not.toHaveProperty("cause");
    expect(JSON.stringify(normalized)).not.toMatch(/private|8675309|SELECT/i);
  });

  it.each([undefined, "22023", "P2034", 40])(
    "does not preserve P2010 metadata code %s unless it is an allowlisted PostgreSQL code",
    metaCode => {
      const source = Object.assign(new Error("private query"), {
        code: "P2010",
        meta: { code: metaCode, query: "SELECT private-user-id" },
      });

      const normalized = normalizeAgentSourceMaterialFenceError(source) as NormalizedFenceError;

      expect(normalized.message).toBe(FENCE_ERROR_MESSAGE);
      expect(normalized.code).toBeUndefined();
      expect(normalized.meta).toBeUndefined();
      expect(Object.keys(normalized)).toEqual([]);
    },
  );

  it("returns a fixed uncoded error for transaction mismatches and unknown errors", () => {
    for (const source of [undefined, new Error("private user ID and XID"), Object.assign(new Error(), { code: "23505" })]) {
      const normalized = normalizeAgentSourceMaterialFenceError(source) as NormalizedFenceError;

      expect(normalized).toBeInstanceOf(Error);
      expect(normalized.message).toBe(FENCE_ERROR_MESSAGE);
      expect(normalized.code).toBeUndefined();
      expect(normalized.meta).toBeUndefined();
      expect(normalized).not.toHaveProperty("cause");
      expect(Object.keys(normalized)).toEqual([]);
    }
  });
});
