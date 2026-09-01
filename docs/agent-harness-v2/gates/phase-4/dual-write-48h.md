# Phase 4 Gate — 48-hour dual-write integrity report

**Current status:** `PENDING_STAGING_SHADOW` / `blocked — staging access is available, but the required 48-hour observation is not complete`

This artifact records the evidence state for the Phase 4 Exit Gate. It does
not claim that a 48-hour staging observation was run. No counts, mismatch
samples, database snapshots, or production-shaped measurements are invented
here.

## Authoritative gate state

The status, run metadata, and required-metrics tables in this document are one
authoritative completion record. The staging baseline below is evidence of
access and setup only; it is not a 48-hour result. An authorized staging
operator must replace the remaining placeholder values in those tables in one
reviewed commit after the full observation window. Do not append a second
PASS/FAIL record below the current record; a stale table and an appended
completion block would make the Gate ambiguous.

| Field | Current value |
|---|---|
| Report status | `PENDING_STAGING_SHADOW` |
| Gate decision | **NOT PASSED** |
| Evidence authority | Authorized staging operator with Vercel and Prisma access |
| Phase sequencing | Phase 5 remains locked until the Gate is passed with real evidence |

## Run metadata

| Field | Value |
|---|---|
| Logical scope | AH2-008 dual-write and transcript projection |
| Required observation window | Trailing 48 hours, set at the time of the staging run |
| Operator | Codex (user-authorized staging verification) |
| Staging access provider | Isolated Neon `applymate-staging` / `main` plus authenticated Vercel Preview |
| Vercel Preview URL | https://web-12asu6jof-stevens-projects-894c8977.vercel.app |
| Vercel deployment | `dpl_GFoQyyXsFdumQvLppbrMmLf1PUcY`, commit `126b708f18790993e1537323b752a86b313b3142` |
| Preview environment | `PLATFORM_ENV=staging` (Preview-only) |
| Preview access probe | Authenticated browser session reached the deployed application and SSE route |
| Staging operator credentials | Used transiently; no credential or secret retained in this artifact |
| Artifact recorded at | 2026-09-01T13:28:57Z |
| Observation window | `NOT STARTED` — must run for 48 hours after dual-write is enabled with eligible traffic |
| Database snapshot | Baseline counts only; no 48-hour snapshot captured |
| Gate decision | **NOT PASSED** |

## Staging baseline (not the 48-hour report)

The authorized staging session established access and captured a read-only
baseline at `2026-09-01T13:28:57Z`. Both Harness 2.0 flags were retired when
this baseline was recorded:

| Baseline check | Observed value | Interpretation |
|---|---:|---|
| `AGENT_PROTOCOL_V2_DUAL_WRITE` | `enabled=false`, `status=retired` | No eligible dual-write window is active |
| `AGENT_EVENT_SSE_V2` | `enabled=false`, `status=retired` | Temporary SSE drill flag was reverted after the drill |
| All staging `agent_events` rows | `12` | Includes synthetic control-plane/SSE fixture rows; not a dual-write count |
| All staging `agent_transcript_events` rows | `10` | Includes synthetic fixture rows; not a 48-hour projection result |
| Eligible AH2-008 dual-write events | `0` | Baseline only; no 48-hour observation exists |
| MiniMax-backed real staging chat | Not available | Preview request returned HTTP `401`; no real dual-write chat run was counted |

The approval and SSE fixtures were synthetic internal control-plane tests with
`externalAction=false`. They are excluded from the AH2-008 golden comparison
and cannot substitute for a real 48-hour dual-write observation. The Gate
therefore remains `NOT PASSED`.

## Required metrics

| Metric | Result | Evidence status |
|---|---:|---|
| AH2-008 dual-write event count | `0 (baseline only; 48-hour result not available)` | No eligible dual-write flag window was active; native V2 control-plane events are excluded |
| Exact event/projection pair count | `BLOCKED` | Requires `(eventId, sessionId)` pairing over the real 48-hour window |
| Projection mismatch count | `BLOCKED` | Must compare every paired row, not a sample |
| Projection mismatch sample (maximum five) | `BLOCKED` | A sample is display-only after the complete mismatch count is calculated |
| Missing projection count | `BLOCKED` | Counts only a dual-write event with no marker anywhere |
| Existing projection outside selected window | `BLOCKED` | Must be reported separately from nonexistent-event markers |
| Invalid projection marker count | `BLOCKED` | Marker rows without a string event ID must not be silently omitted |
| Opaque projection candidate count | `BLOCKED` | Prefix events whose `payload.legacy` fails the projector shape are classified separately and excluded from golden comparison |
| Cross-session event count / marker-row count | `BLOCKED` | Requires session-aware validation; record both event groups and wrong-session rows |
| Duplicate projection event groups / extra rows | `BLOCKED` | Requires all paired projection rows, not a capped query |
| Duplicate session count | `INCOMPLETE/BLOCKED` | Automation is queryable; chat/manual requires an approved run manifest because no canonical cross-session run key is persisted |
| Automation orphan / unusable run-key observations | `BLOCKED` | Missing automation rows and malformed `automationId` values must remain visible in the aggregate |
| NULL-idempotency marker references | `BLOCKED` | NULL is not allowed to disappear through SQL three-valued logic |
| Chat/manual manifest validation errors | `INCOMPLETE/BLOCKED` | A manifest must have one canonical session per `(runClass, runKey)` and one row per observed session |
| Sequence / ordering errors | `BLOCKED` | Requires window-bounded transitions and an explicit left-edge predecessor check |

## Authoritative data sources

The dual-write implementation and its projection marker are the sources of
truth for collection:

- [AH2-008 dual writer](https://github.com/YuanshuoDu/applymate-jobcopilot/blob/d34db398da9a542712ec7815f0507a76a006a951/apps/web/src/lib/agent/session/dual-write.ts)
- [AH2-008 transcript projector](https://github.com/YuanshuoDu/applymate-jobcopilot/blob/d34db398da9a542712ec7815f0507a76a006a951/apps/web/src/lib/agent/session/transcript-projector.ts)
- [AH2-008 projector and dual-write tests](https://github.com/YuanshuoDu/applymate-jobcopilot/tree/d34db398da9a542712ec7815f0507a76a006a951/apps/web/src/lib/agent/session)
- Prisma tables: `agent_events`, `agent_transcript_events`, `agent_sessions`, `agent_turns`, and `agent_automations`.

The projector stores an opaque marker at
`data.__agentHarnessV2.eventId`. The marker is the join key for comparing a
V2 event with its legacy projection; transcript timestamps must not be used as
the join key.

### AH2-008 dual-write event subset

`agent_events` also contains native Harness 2.0 control-plane, approval,
worker, and wake-up events. Those events do not necessarily have an AH2-008
legacy transcript row and must not be counted as missing projections. The
dual-write path creates its event with the idempotency key prefix
`legacy-transcript:`. Every parity query in this report therefore applies:

```sql
"idempotencyKey" LIKE 'legacy-transcript:%'
```

This is the AH2-008 source predicate. The operator must record any rows in the
selected window that have this prefix but do not have the expected `payload.legacy`
object as a marker-shape anomaly; they are not silently reclassified as native
events.

The Prisma `Json` columns used here are PostgreSQL `jsonb` columns. Every
`?`, `->`, and `->>` operation below is guarded by `jsonb_typeof` or a guarded
`CASE`, so malformed JSON values are measured as anomalies rather than causing
the evidence query itself to fail.

The runtime marker contract is also part of the query contract. A marker is
valid only when all of the following are true:

```sql
jsonb_typeof("marker") = 'object'
AND jsonb_typeof("marker" -> 'eventId') = 'string'
AND jsonb_typeof("marker" -> 'opaque') = 'boolean'
AND (
  NOT ("marker" ? 'wrapped')
  OR jsonb_typeof("marker" -> 'wrapped') = 'boolean'
)
```

This mirrors `transcriptProjectionMarker()`: `eventId` and `opaque` are
required, while `wrapped` is optional but must be boolean when present. No
`->>` extraction is allowed before these type checks. Invalid markers are
counted as invalid-marker anomalies and are never eligible for an exact pair.

## Reproducible staging collection

The operator must run the following against a read-only, access-controlled
staging connection after recording the exact `window_start`, `window_end`,
deployment URL, deployment commit, operator, and timezone. The current PR
Preview URL is recorded above, but it redirects unauthenticated requests to
Vercel SSO; it is not evidence that a staging operator session exists. The
report must retain aggregate results and a redacted sample only; do not paste
raw resume, contact, credential, answer, cookie, or provider-token data into
this file or the GitHub issue.

### 1. Event/projection parity, session identity, and duplicate projections

The query below scopes V2 events to AH2-008 dual-write events, groups marker
rows both by event and by `(eventId, sessionId)`, and calculates structural
counts across every row. A marker for the right event but the wrong session is
not an exact pair and is reported as cross-session rather than as a valid
projection.

```sql
WITH v2 AS (
  SELECT "id", "sessionId", "createdAt"
  FROM "agent_events"
  WHERE "createdAt" >= :window_start
    AND "createdAt" < :window_end
    AND "idempotencyKey" LIKE 'legacy-transcript:%'
), projected_marker_rows AS (
  SELECT
    "id" AS "projectionId",
    "sessionId",
    "data" -> '__agentHarnessV2' AS "marker"
  FROM "agent_transcript_events"
  WHERE jsonb_typeof("data") = 'object'
    AND "data" ? '__agentHarnessV2'
), projected AS (
  SELECT
    "projectionId",
    "sessionId",
    CASE
      WHEN jsonb_typeof("marker") = 'object'
       AND jsonb_typeof("marker" -> 'eventId') = 'string'
       AND jsonb_typeof("marker" -> 'opaque') = 'boolean'
       AND (
         NOT ("marker" ? 'wrapped')
         OR jsonb_typeof("marker" -> 'wrapped') = 'boolean'
       )
        THEN TRUE
      ELSE FALSE
    END AS "isValidMarker",
    CASE
      WHEN jsonb_typeof("marker") = 'object'
       AND jsonb_typeof("marker" -> 'eventId') = 'string'
       AND jsonb_typeof("marker" -> 'opaque') = 'boolean'
       AND (
         NOT ("marker" ? 'wrapped')
         OR jsonb_typeof("marker" -> 'wrapped') = 'boolean'
       )
        THEN "marker" ->> 'eventId'
      ELSE NULL
    END AS "eventId"
  FROM projected_marker_rows
), projected_by_event AS (
  SELECT "eventId", COUNT(*)::int AS "allProjectionCount"
  FROM projected
  WHERE "isValidMarker" = TRUE
  GROUP BY "eventId"
), projected_by_pair AS (
  SELECT "eventId", "sessionId", COUNT(*)::int AS "exactPairProjectionCount"
  FROM projected
  WHERE "isValidMarker" = TRUE
  GROUP BY "eventId", "sessionId"
), joined AS (
  SELECT
    v2."id",
    v2."sessionId",
    p."eventId" AS "anyProjectionEventId",
    p."allProjectionCount",
    pp."eventId" AS "exactPairEventId",
    pp."exactPairProjectionCount"
  FROM v2
  LEFT JOIN projected_by_event p ON p."eventId" = v2."id"
  LEFT JOIN projected_by_pair pp
    ON pp."eventId" = v2."id"
   AND pp."sessionId" = v2."sessionId"
)
SELECT
  COUNT(*)::int AS "dualWriteEventCount",
  COUNT(*) FILTER (
    WHERE "exactPairEventId" IS NOT NULL
      AND "exactPairProjectionCount" = 1
  )::int AS "exactlyOneProjectionPairCount",
  COUNT(*) FILTER (
    WHERE "anyProjectionEventId" IS NULL
  )::int AS "missingProjectionCount",
  COUNT(*) FILTER (
    WHERE "anyProjectionEventId" IS NOT NULL
      AND "exactPairEventId" IS NULL
  )::int AS "crossSessionEventCount",
  COALESCE(SUM(
    CASE
      WHEN "allProjectionCount" IS NULL THEN 0
      ELSE "allProjectionCount" - COALESCE("exactPairProjectionCount", 0)
    END
  ), 0)::int AS "crossSessionMarkerRowCount",
  COUNT(*) FILTER (
    WHERE "exactPairProjectionCount" > 1
  )::int AS "duplicateProjectionEventCount",
  COALESCE(SUM(
    CASE
      WHEN "exactPairProjectionCount" > 1
        THEN "exactPairProjectionCount" - 1
      ELSE 0
    END
  ), 0)::int AS "duplicateProjectionExtraRowCount"
FROM joined;
```

`missingProjectionCount` above means the event ID has no marker anywhere.
`crossSessionEventCount` means a marker exists for that event ID but no marker
exists for the expected `(eventId, sessionId)` pair. `crossSessionMarkerRowCount`
also counts wrong-session marker rows when an exact pair exists. The operator
must not collapse those two categories or discard the extra rows.

The operator must also audit the AH2-008 source predicate itself:

```sql
WITH dual_write_events AS (
  SELECT
    e.*,
    CASE
      WHEN jsonb_typeof(e."payload") = 'object'
        THEN e."payload" -> 'legacy'
      ELSE NULL
    END AS "legacyPayload"
  FROM "agent_events" e
  WHERE e."createdAt" >= :window_start
    AND e."createdAt" < :window_end
    AND e."idempotencyKey" LIKE 'legacy-transcript:%'
), classified AS (
  SELECT
    *,
    CASE
      WHEN jsonb_typeof("payload") = 'object'
       AND "payload" ? 'legacy'
       AND jsonb_typeof("legacyPayload") = 'object'
       AND jsonb_typeof("legacyPayload" -> 'type') = 'string'
       AND jsonb_typeof("legacyPayload" -> 'speaker') = 'string'
       AND jsonb_typeof("legacyPayload" -> 'body') = 'string'
        THEN TRUE
      ELSE FALSE
    END AS "hasValidLegacyPayload"
  FROM dual_write_events
)
SELECT
  COUNT(*)::int AS "ah2008PrefixEventCount",
  COUNT(*) FILTER (WHERE "hasValidLegacyPayload")::int
    AS "validLegacyPayloadCount",
  COUNT(*) FILTER (WHERE NOT "hasValidLegacyPayload")::int
    AS "opaqueProjectionCandidateCount"
FROM classified;
```

`legacyFromPayload` in the projector requires `legacy` to be an object with
string `type`, `speaker`, and `body`. A prefix event that fails that full shape
is classified as an `opaqueProjectionCandidate`, matching the projector's
`opaqueProjection` fallback. It is excluded from the golden comparison query
below and must be retained as a separate structural metric; an AH2-008
dual-write Gate PASS requires this candidate count to be zero.

### 2. Existing markers outside the selected event window

This query treats marker rows as the unit of measurement and distinguishes an
event ID that does not exist anywhere from an event that exists but was created
outside the selected 48-hour window. The latter must not be counted as a
missing projection for the selected window.

```sql
WITH marker_rows AS (
  SELECT
    t."id" AS "projectionId",
    t."sessionId" AS "projectedSessionId",
    t."data" -> '__agentHarnessV2' AS "marker"
  FROM "agent_transcript_events" t
  WHERE jsonb_typeof(t."data") = 'object'
    AND t."data" ? '__agentHarnessV2'
), markers AS (
  SELECT
    "projectionId",
    "projectedSessionId",
    CASE
      WHEN jsonb_typeof("marker") = 'object'
       AND jsonb_typeof("marker" -> 'eventId') = 'string'
       AND jsonb_typeof("marker" -> 'opaque') = 'boolean'
       AND (
         NOT ("marker" ? 'wrapped')
         OR jsonb_typeof("marker" -> 'wrapped') = 'boolean'
       )
        THEN TRUE
      ELSE FALSE
    END AS "isValidMarker",
    CASE
      WHEN jsonb_typeof("marker") = 'object'
       AND jsonb_typeof("marker" -> 'eventId') = 'string'
       AND jsonb_typeof("marker" -> 'opaque') = 'boolean'
       AND (
         NOT ("marker" ? 'wrapped')
         OR jsonb_typeof("marker" -> 'wrapped') = 'boolean'
       )
        THEN "marker" ->> 'eventId'
      ELSE NULL
    END AS "eventId"
  FROM marker_rows
), linked AS (
  SELECT
    m.*,
    e."id" AS "existingEventId",
    e."sessionId" AS "eventSessionId",
    e."createdAt" AS "eventCreatedAt",
    e."idempotencyKey" AS "eventIdempotencyKey"
  FROM markers m
  LEFT JOIN "agent_events" e ON e."id" = m."eventId"
)
SELECT
  COUNT(*) FILTER (
    WHERE "isValidMarker" = FALSE
  )::int AS "invalidProjectionMarkerCount",
  COUNT(*) FILTER (
    WHERE "isValidMarker" = TRUE
      AND "eventId" IS NOT NULL
      AND "existingEventId" IS NULL
  )::int AS "nonexistentEventMarkerCount",
  COUNT(*) FILTER (
    WHERE "isValidMarker" = TRUE
      AND "eventId" IS NOT NULL
      AND "existingEventId" IS NOT NULL
      AND NOT ("eventCreatedAt" >= :window_start AND "eventCreatedAt" < :window_end)
  )::int AS "existingEventOutsideSelectedWindowCount",
  COUNT(*) FILTER (
    WHERE "isValidMarker" = TRUE
      AND "eventId" IS NOT NULL
      AND "existingEventId" IS NOT NULL
      AND "eventCreatedAt" >= :window_start
      AND "eventCreatedAt" < :window_end
  )::int AS "existingEventInsideSelectedWindowCount",
  COUNT(*) FILTER (
    WHERE "isValidMarker" = TRUE
      AND "eventId" IS NOT NULL
      AND "existingEventId" IS NOT NULL
      AND (
        "eventIdempotencyKey" IS NULL
        OR "eventIdempotencyKey" NOT LIKE 'legacy-transcript:%'
      )
  )::int AS "markerPointsToNonDualWriteEventCount",
  COUNT(*) FILTER (
    WHERE "isValidMarker" = TRUE
      AND "eventId" IS NOT NULL
      AND "existingEventId" IS NOT NULL
      AND "eventIdempotencyKey" IS NULL
  )::int AS "markerPointsToNullIdempotencyKeyCount",
  COUNT(*) FILTER (
    WHERE "isValidMarker" = TRUE
      AND "eventId" IS NOT NULL
      AND "existingEventId" IS NOT NULL
      AND "eventSessionId" <> "projectedSessionId"
  )::int AS "crossSessionMarkerRowCount"
FROM linked;
```

### 3. Semantic projection mismatches

The comparison must use the named, executable `phase4-transcript-comparison-
runner.ts` below. The authorized operator must materialize it as the untracked
temporary file `apps/web/phase4-transcript-comparison-runner.ts` in an
access-controlled workspace (do not commit it), run it from the `apps/web`
package, and record the runner's source revision as the current evidence
commit. The runner uses Prisma's parameterized query API, keeps raw fields in
process memory only, disables row/query logging, and writes only
aggregate counts plus hashed opaque IDs and difference-field names. Do not run
the internal query in `psql`, CI with query logging, shell tracing, or an output
file. The runner must process **every** paired row and must not use `LIMIT 5`;
five is only a display cap for the redacted hash sample.

```ts
// phase4-transcript-comparison-runner.ts (operator-supplied, not committed)
import { createHash } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { compareTranscriptGolden } from "../src/lib/agent/session/transcript-projector"

type PairRow = {
  v2EventId: string
  projectionId: string
  legacyPayload: unknown
  projectedType: string
  projectedSpeaker: string
  projectedTitle: string | null
  projectedBody: string
  projectedData: unknown
  projectedDurationMs: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function opaqueId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const prisma = new PrismaClient({ log: [] })
const windowStart = new Date(requiredArgument("--window-start"))
const windowEnd = new Date(requiredArgument("--window-end"))

try {
  const rows = await prisma.$queryRaw<PairRow[]>(Prisma.sql`
    WITH valid_dual_write_events AS (
      SELECT
        e."id",
        e."sessionId",
        e."sequence",
        CASE
          WHEN jsonb_typeof(e."payload") = 'object'
            THEN e."payload" -> 'legacy'
          ELSE NULL
        END AS "legacyPayload"
      FROM "agent_events" e
      WHERE e."createdAt" >= ${windowStart}
        AND e."createdAt" < ${windowEnd}
        AND e."idempotencyKey" LIKE 'legacy-transcript:%'
        AND jsonb_typeof(e."payload") = 'object'
        AND e."payload" ? 'legacy'
        AND jsonb_typeof(e."payload" -> 'legacy') = 'object'
        AND jsonb_typeof(e."payload" -> 'legacy' -> 'type') = 'string'
        AND jsonb_typeof(e."payload" -> 'legacy' -> 'speaker') = 'string'
        AND jsonb_typeof(e."payload" -> 'legacy' -> 'body') = 'string'
    ), transcript_marker_rows AS (
      SELECT
        t."id",
        t."sessionId",
        t."type" AS "projectedType",
        t."speaker" AS "projectedSpeaker",
        t."title" AS "projectedTitle",
        t."body" AS "projectedBody",
        t."data" AS "projectedData",
        t."durationMs" AS "projectedDurationMs",
        t."data" -> '__agentHarnessV2' AS "marker"
      FROM "agent_transcript_events" t
      WHERE jsonb_typeof(t."data") = 'object'
        AND t."data" ? '__agentHarnessV2'
    ), valid_marker_rows AS (
      SELECT
        "id",
        "sessionId",
        "projectedType",
        "projectedSpeaker",
        "projectedTitle",
        "projectedBody",
        "projectedData",
        "projectedDurationMs",
        "marker" ->> 'eventId' AS "eventId"
      FROM transcript_marker_rows
      WHERE jsonb_typeof("marker") = 'object'
        AND jsonb_typeof("marker" -> 'eventId') = 'string'
        AND jsonb_typeof("marker" -> 'opaque') = 'boolean'
        AND (
          NOT ("marker" ? 'wrapped')
          OR jsonb_typeof("marker" -> 'wrapped') = 'boolean'
        )
    )
    SELECT
      e."id" AS "v2EventId",
      e."legacyPayload",
      t."id" AS "projectionId",
      t."projectedType",
      t."projectedSpeaker",
      t."projectedTitle",
      t."projectedBody",
      t."projectedData",
      t."projectedDurationMs"
    FROM valid_dual_write_events e
    JOIN valid_marker_rows t
      ON t."eventId" = e."id"
     AND t."sessionId" = e."sessionId"
    ORDER BY e."sessionId", e."sequence", t."id"
  `)

  let projectionMismatchCount = 0
  const mismatchSample: Array<{
    v2EventIdHash: string
    projectionIdHash: string
    differences: string[]
  }> = []

  for (const row of rows) {
    if (!isRecord(row.legacyPayload)) throw new Error("Unexpected legacy payload shape")
    const legacy = {
      type: row.legacyPayload.type as string,
      speaker: row.legacyPayload.speaker as string,
      title: typeof row.legacyPayload.title === "string" ? row.legacyPayload.title : null,
      body: row.legacyPayload.body as string,
      durationMs: typeof row.legacyPayload.durationMs === "number" ? row.legacyPayload.durationMs : null,
      data: row.legacyPayload.data ?? null,
    }
    const projected = {
      type: row.projectedType,
      speaker: row.projectedSpeaker,
      title: row.projectedTitle,
      body: row.projectedBody,
      durationMs: row.projectedDurationMs,
      data: row.projectedData,
    }
    const comparison = compareTranscriptGolden(legacy, projected)
    if (!comparison.matches) {
      projectionMismatchCount += 1
      if (mismatchSample.length < 5) {
        mismatchSample.push({
          v2EventIdHash: opaqueId(row.v2EventId),
          projectionIdHash: opaqueId(row.projectionId),
          differences: comparison.differences,
        })
      }
    }
  }

  process.stdout.write(JSON.stringify({
    comparedPairCount: rows.length,
    projection_mismatch_count: projectionMismatchCount,
    mismatchSample,
  }) + "\n")
} finally {
  await prisma.$disconnect()
}
```

Run it as follows, with the exact timestamps used by the other queries:

```powershell
pnpm --filter web exec tsx phase4-transcript-comparison-runner.ts `
  --window-start 2026-08-30T00:00:00.000Z `
  --window-end 2026-09-01T00:00:00.000Z
```

The timestamps above are placeholders and must be replaced before execution.
The runner maps `legacyPayload` exactly as `legacyFromPayload()` does: string
`type`, `speaker`, and `body` are required; non-string `title` becomes `null`;
non-number `durationMs` becomes `null`; and missing `data` becomes `null`.
`compareTranscriptGolden` then removes the valid marker before comparing
`data`. Duplicate projection rows are intentionally included. Record the
exact `projection_mismatch_count` from the runner; the hash sample must never
replace the complete count. Structural anomalies (`missing`, `cross-session`,
and `duplicate`) remain separate metrics even when semantic comparison is
possible. If the operator cannot run this exact in-memory runner, the
`Projection mismatch count` must remain `UNSUPPORTED/BLOCKED` and the Gate
cannot pass; it must not be estimated from a sample.

### 4. Duplicate canonical sessions for every required run class

The duplicate-session metric is complete only when every run class in the
staging exercise has an authoritative run key. The run key rules are:

| Run class | Authoritative run key | Canonical session source | Current status |
|---|---|---|---|
| Automation | `automationId` from `automation_started.data` | `agent_automations.sessionId` | Queryable |
| Chat | Operator-supplied approved chat run key in the run manifest | No canonical cross-session key is persisted in the current schema | Blocked unless manifest is supplied |
| Manual | Operator-supplied approved manual run key in the run manifest | No canonical cross-session key is persisted in the current schema | Blocked unless manifest is supplied |

`clientMessageId` is unique only within `(sessionId, clientMessageId)` and
therefore cannot prove that two chat/manual sessions are duplicates. Similar
goals, timestamps, users, or `source` values are not an authoritative run key.
If the staging exercise includes chat or manual runs without a supplied run
manifest, the full duplicate-session metric must remain
`INCOMPLETE/BLOCKED`; it must not be reported as zero.

For automation runs, run the observation-driven query below. It starts from
every `automation_started` observation and uses a `LEFT JOIN`, so deleted,
unknown, or malformed automation records cannot disappear before aggregation.
Rows without a usable string `automationId` are counted separately.

```sql
WITH automation_observations AS (
  SELECT
    CASE
      WHEN jsonb_typeof(t."data") = 'object'
       AND t."data" ? 'automationId'
       AND jsonb_typeof(t."data" -> 'automationId') = 'string'
       AND NULLIF(BTRIM(t."data" ->> 'automationId'), '') IS NOT NULL
        THEN t."data" ->> 'automationId'
      ELSE NULL
    END AS "automationId",
    t."sessionId" AS "observedSessionId"
  FROM "agent_transcript_events" t
  WHERE t."type" = 'automation_started'
    AND t."createdAt" >= :window_start
    AND t."createdAt" < :window_end
), automation_groups AS (
  SELECT
    o."automationId",
    a."id" AS "canonicalAutomationId",
    a."sessionId" AS "canonicalSessionId",
    COUNT(*)::int AS "observationCount",
    COUNT(DISTINCT o."observedSessionId")::int AS "observedSessionCount",
    COUNT(*) FILTER (
      WHERE o."observedSessionId" IS DISTINCT FROM a."sessionId"
    )::int AS "nonCanonicalObservationCount"
  FROM automation_observations o
  LEFT JOIN "agent_automations" a
    ON a."id" = o."automationId"
  WHERE o."automationId" IS NOT NULL
  GROUP BY o."automationId", a."id", a."sessionId"
)
SELECT
  COUNT(*) FILTER (
    WHERE "canonicalAutomationId" IS NOT NULL
      AND "canonicalSessionId" IS NOT NULL
      AND "observedSessionCount" > 1
  )::int
    AS "duplicateAutomationSessionGroups",
  COUNT(*) FILTER (WHERE "canonicalSessionId" IS NULL)::int
    AS "automationWithoutCanonicalSessionGroupCount",
  COUNT(*) FILTER (WHERE "canonicalAutomationId" IS NULL)::int
    AS "orphanAutomationGroupCount",
  COALESCE(SUM("observationCount") FILTER (
    WHERE "canonicalAutomationId" IS NULL
  ), 0)::int AS "orphanAutomationObservationCount",
  COALESCE(SUM("nonCanonicalObservationCount"), 0)::int
    AS "nonCanonicalAutomationObservationCount",
  (
    SELECT COUNT(*)::int
    FROM automation_observations
    WHERE "automationId" IS NULL
  ) AS "automationWithoutUsableRunKeyCount"
FROM automation_groups;
```

`orphanAutomationGroupCount` and `orphanAutomationObservationCount` cover
usable automation IDs with no current `agent_automations` row. The
`automationWithoutCanonicalSessionGroupCount` also covers existing automation
rows whose nullable `sessionId` is absent. Either orphan or malformed metric is
a Gate failure, not a reason to report a clean zero.

For chat/manual runs, the authorized operator must supply an access-controlled
manifest from the staging exercise, with one row per observed session. Use the
parameterized `VALUES` CTE below; do not create a temporary table on the
read-only connection:

```sql
WITH phase4_run_manifest("runClass", "runKey", "canonicalSessionId", "observedSessionId") AS (
  VALUES
    (CAST(:run_class_1 AS text), CAST(:run_key_1 AS text),
     CAST(:canonical_session_id_1 AS text), CAST(:observed_session_id_1 AS text))
    -- Add one parameterized row per operator-approved observed session.
), manifest_rows AS (
  SELECT
    *,
    CASE
      WHEN "runClass" IN ('chat', 'manual')
       AND NULLIF(BTRIM("runKey"), '') IS NOT NULL
       AND NULLIF(BTRIM("canonicalSessionId"), '') IS NOT NULL
       AND NULLIF(BTRIM("observedSessionId"), '') IS NOT NULL
        THEN TRUE
      ELSE FALSE
    END AS "isValidRow"
  FROM phase4_run_manifest
), manifest_groups AS (
  SELECT
    "runClass",
    "runKey",
    COUNT(*)::int AS "rowCount",
    COUNT(DISTINCT "canonicalSessionId")::int AS "canonicalSessionCount",
    COUNT(DISTINCT "observedSessionId")::int AS "observedSessionCount",
    (COUNT(*) - COUNT(DISTINCT "observedSessionId"))::int
      AS "duplicateManifestRowCount",
    COUNT(*) FILTER (
      WHERE "observedSessionId" IS DISTINCT FROM "canonicalSessionId"
    )::int AS "nonCanonicalObservationCount",
    COUNT(*) FILTER (WHERE NOT "isValidRow")::int AS "invalidManifestRowCount"
  FROM manifest_rows
  GROUP BY "runClass", "runKey"
), grouped_metrics AS (
  SELECT
    COUNT(*) FILTER (
      WHERE "observedSessionCount" > 1
        AND "canonicalSessionCount" = 1
        AND "duplicateManifestRowCount" = 0
        AND "invalidManifestRowCount" = 0
    )::int AS "duplicateChatManualSessionGroups",
    COALESCE(SUM("nonCanonicalObservationCount"), 0)::int
      AS "nonCanonicalChatManualObservationCount",
    COUNT(*) FILTER (
      WHERE "canonicalSessionCount" <> 1
        OR "duplicateManifestRowCount" > 0
        OR "invalidManifestRowCount" > 0
    )::int AS "invalidChatManualManifestGroupCount",
    COALESCE(SUM("duplicateManifestRowCount"), 0)::int
      AS "duplicateChatManualManifestRowCount"
  FROM manifest_groups
)
SELECT *
FROM grouped_metrics;
```

The operator must not infer manifest rows from goals, timestamps, user IDs, or
similar text. Grouping is intentionally by `(runClass, runKey)` only. Thus one
authoritative run key mapped to two canonical sessions is one invalid group,
not two singleton groups. The consistency checks require exactly one
canonical session per run key and one manifest row per observed session. Any
invalid group or duplicate manifest row keeps the duplicate-session metric
`INCOMPLETE/BLOCKED`.

The final duplicate-session metric is complete only after the automation
result and all manifest-backed chat/manual results have been reconciled. Until
then, update the authoritative metric table to `INCOMPLETE/BLOCKED` rather
than entering an integer.

### 5. Sequence and ordering errors within the measured window

This query counts transitions whose right-hand event is inside the measured
window. It checks adjacent events within the window and separately checks the
first selected event against the immediately preceding event before the
window, when such a predecessor exists. It does not scan or count unrelated
post-window history, and an absent left-edge predecessor is not itself an
error.

Unlike the parity query, this invariant is evaluated over all `agent_events`
rows because native V2 events also consume the session sequence. Only
transitions with a right-hand event inside the measured window contribute to
the reported error count.

```sql
WITH window_events AS (
  SELECT
    e."sessionId",
    e."sequence",
    e."createdAt",
    LAG(e."sequence") OVER (
      PARTITION BY e."sessionId"
      ORDER BY e."sequence"
    ) AS "previousWindowSequence"
  FROM "agent_events" e
  WHERE e."createdAt" >= :window_start
    AND e."createdAt" < :window_end
), first_window_event AS (
  SELECT DISTINCT ON ("sessionId")
    "sessionId",
    "sequence" AS "firstWindowSequence"
  FROM window_events
  ORDER BY "sessionId", "sequence"
), left_edge AS (
  SELECT
    f."sessionId",
    f."firstWindowSequence",
    previous."sequence" AS "previousBeforeWindowSequence"
  FROM first_window_event f
  LEFT JOIN LATERAL (
    SELECT e."sequence"
    FROM "agent_events" e
    WHERE e."sessionId" = f."sessionId"
      AND e."createdAt" < :window_start
      AND e."sequence" < f."firstWindowSequence"
    ORDER BY e."sequence" DESC
    LIMIT 1
  ) previous ON TRUE
), metrics AS (
  SELECT
    (
      SELECT COUNT(*)
      FROM window_events
      WHERE "previousWindowSequence" IS NOT NULL
        AND "sequence" <> "previousWindowSequence" + 1::bigint
    )::int AS "withinWindowTransitionErrorCount",
    (
      SELECT COUNT(*)
      FROM left_edge
      WHERE "previousBeforeWindowSequence" IS NOT NULL
        AND "firstWindowSequence" <> "previousBeforeWindowSequence" + 1::bigint
    )::int AS "leftEdgeTransitionErrorCount",
    (
      SELECT COUNT(*)
      FROM left_edge
      WHERE "previousBeforeWindowSequence" IS NULL
    )::int AS "leftEdgeWithoutPredecessorCount"
)
SELECT
  "withinWindowTransitionErrorCount",
  "leftEdgeTransitionErrorCount",
  "leftEdgeWithoutPredecessorCount",
  ("withinWindowTransitionErrorCount" + "leftEdgeTransitionErrorCount")::int
    AS "sequenceGapOrOrderingErrorCount"
FROM metrics;
```

The schema's `(sessionId, sequence)` unique constraint protects against exact
duplicates, while the continuity check detects committed sequence gaps. The
operator must still record retry or projection anomalies observed during the
window and explain any session whose first observed event has no predecessor.

## Executable Gate thresholds

The operator must apply these thresholds when replacing the single
authoritative metrics record. A real staging run is **NOT PASSED** if any
required metric is non-zero, if the comparison runner cannot produce a
complete count, or if a required run class is incomplete. The report must not
interpret "observed" as "passed".

| Metric or condition | Required value for Gate PASS |
|---|---:|
| `dualWriteEventCount` | Equals `validLegacyPayloadCount`; `opaqueProjectionCandidateCount = 0` |
| `exactlyOneProjectionPairCount` | Equals `dualWriteEventCount` |
| `projection_mismatch_count` | `0`, produced by the complete in-memory runner |
| `missingProjectionCount` | `0` |
| `existingEventOutsideSelectedWindowCount` | `0` |
| `invalidProjectionMarkerCount` | `0` |
| `nonexistentEventMarkerCount` | `0` |
| `markerPointsToNonDualWriteEventCount` | `0` |
| `markerPointsToNullIdempotencyKeyCount` | `0` |
| `crossSessionEventCount` and `crossSessionMarkerRowCount` | `0` |
| `duplicateProjectionEventCount` and `duplicateProjectionExtraRowCount` | `0` |
| `duplicateAutomationSessionGroups` | `0` |
| `automationWithoutCanonicalSessionGroupCount` | `0` |
| `orphanAutomationGroupCount`, `orphanAutomationObservationCount`, and `automationWithoutUsableRunKeyCount` | `0` |
| `nonCanonicalAutomationObservationCount` | `0` |
| `duplicateChatManualSessionGroups` and `nonCanonicalChatManualObservationCount` | `0` |
| `invalidChatManualManifestGroupCount` and `duplicateChatManualManifestRowCount` | `0` |
| Duplicate-session metric completeness | Not `INCOMPLETE/BLOCKED`; every included run class has an authoritative key |
| `sequenceGapOrOrderingErrorCount` | `0` |
| `leftEdgeWithoutPredecessorCount` | Informational only; explain affected sessions, but do not treat absence as an error |
| AC1 approval smoke and AC3 SSE drill | Real staging evidence for every required scenario |

Any threshold failure keeps the **Gate decision** `NOT PASSED`, records the
failed metric and redacted evidence reference, and prevents Phase 5 unlock.
Only an authorized operator may replace the blocked values after all required
thresholds and real staging scenarios pass.

## Authorized completion procedure

Only an operator with staging/Vercel/Prisma authorization may complete the
Gate:

1. Record the deployment URL, deployed commit, exact UTC window, operator ID,
   timezone, and read-only database target in the existing **Run metadata**
   table.
2. Run every query and the complete semantic comparison above. Calculate all
   mismatch and structural counts without display limits; retain no raw PII.
3. Reconcile automation sessions and provide the approved chat/manual run
   manifest. If any required run class lacks an authoritative key, keep the
   duplicate-session metric `INCOMPLETE/BLOCKED` and keep the Gate **NOT
   PASSED**.
4. Replace the values in the existing **Required metrics** table and the
   **Authoritative gate state** table in the same reviewed change. Do not
   append a second completion record.
5. Attach redacted query output, the comparison script revision, and database
   snapshot/retention metadata to the restricted staging evidence location;
   link only the approved aggregate evidence from this report or the issue.

Until an authorized operator completes that in-place update from staging,
AC2 remains blocked and the Phase 4 Exit Gate remains `NOT PASSED`; this report
does not unlock Phase 5.
