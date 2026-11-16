const AGENT_SOURCE_MATERIAL_FENCE_PREFIX = "applymate:gate-source-fence:v1:";
const AGENT_SOURCE_MATERIAL_FENCE_ERROR_MESSAGE = "source material fence transaction verification failed";
const POSTGRES_SOURCE_MATERIAL_FENCE_ERROR_CODES = new Set(["40P01", "40001", "55P03", "57014"]);

type PostgresSourceMaterialFenceErrorCode = "40P01" | "40001" | "55P03" | "57014";

function readOwnDataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isPostgresSourceMaterialFenceErrorCode(value: unknown): value is PostgresSourceMaterialFenceErrorCode {
  return typeof value === "string" && POSTGRES_SOURCE_MATERIAL_FENCE_ERROR_CODES.has(value);
}

/** Replaces database details with a fixed message while retaining only allowlisted retry-classification codes. */
export function normalizeAgentSourceMaterialFenceError(error: unknown): Error {
  const normalizedError = new Error(AGENT_SOURCE_MATERIAL_FENCE_ERROR_MESSAGE);
  const code = readOwnDataProperty(error, "code");

  if (isPostgresSourceMaterialFenceErrorCode(code) || code === "P2034") {
    Object.assign(normalizedError, { code });
    return normalizedError;
  }

  if (code === "P2010") {
    const meta = readOwnDataProperty(error, "meta");
    const metaCode = readOwnDataProperty(meta, "code");
    if (isPostgresSourceMaterialFenceErrorCode(metaCode)) {
      Object.assign(normalizedError, { code, meta: { code: metaCode } });
    }
  }

  return normalizedError;
}

function assertNonEmptyUserId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("source material fence user ID must be a non-empty string");
  }
}

/** Builds the shared v1 fence key without trimming or otherwise changing the persisted user ID. */
export function buildAgentSourceMaterialFenceKey(userId: string): string {
  assertNonEmptyUserId(userId);
  return `${AGENT_SOURCE_MATERIAL_FENCE_PREFIX}${userId}`;
}

/** Returns exact, unique user IDs in locale-independent UTF-16 code-unit order. */
export function sortUniqueAgentSourceMaterialFenceUserIds(userIds: readonly string[]): string[] {
  if (!Array.isArray(userIds)) {
    throw new TypeError("source material fence user IDs must be an array");
  }

  for (const userId of userIds) assertNonEmptyUserId(userId);

  const sortedUserIds = [...userIds].sort();
  const uniqueUserIds: string[] = [];
  for (const userId of sortedUserIds) {
    if (uniqueUserIds.at(-1) !== userId) uniqueUserIds.push(userId);
  }
  return uniqueUserIds;
}
