# Phase 4 Gate — 48-hour dual-write integrity report

**Current status:** `PENDING_STAGING_SHADOW` / `blocked — staging access not available`

This artifact records the evidence state for the Phase 4 Exit Gate. It does
not claim that a 48-hour staging observation was run. No counts, mismatch
samples, database snapshots, or production-shaped measurements are invented
here.

## Authoritative gate state

The status, run metadata, and required-metrics tables in this document are one
authoritative completion record. An authorized staging operator must replace
the current placeholder values in those tables in one reviewed commit. Do not
append a second PASS/FAIL record below the current record; a stale table and an
appended completion block would make the Gate ambiguous.

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
| Operator | Codex (repository-only verification) |
| Staging access provider | None available to Codex |
| Vercel Preview URL | https://web-git-codex-ah2-388-phase-4-705c21-stevens-projects-894c8977.vercel.app |
| Preview access probe | HTTP HEAD returned 302 to Vercel SSO at 2026-09-01T01:20:35Z |
| Staging operator credentials | Not available |
| Artifact recorded at | 2026-09-01T01:01:15Z |
| Database snapshot | Not captured |
| Gate decision | **NOT PASSED** |

## Required metrics

| Metric | Result | Evidence status |
|---|---:|---|
| AH2-008 dual-write event count | `BLOCKED` | Requires the scoped staging query below; native V2 control-plane events are excluded |
| Exact event/projection pair count | `BLOCKED` | Requires `(eventId, sessionId)` pairing over the real 48-hour window |
| Projection mismatch count | `BLOCKED` | Must compare every paired row, not a sample |
| Projection mismatch sample (maximum five) | `BLOCKED` | A sample is display-only after the complete mismatch count is calculated |
| Missing projection count | `BLOCKED` | Counts only a dual-write event with no marker anywhere |
| Existing projection outside selected window | `BLOCKED` | Must be reported separately from nonexistent-event markers |
| Cross-session event count / marker-row count | `BLOCKED` | Requires session-aware validation; record both event groups and wrong-session rows |
| Duplicate projection event groups / extra rows | `BLOCKED` | Requires all paired projection rows, not a capped query |
| Duplicate session count | `INCOMPLETE/BLOCKED` | Automation is queryable; chat/manual requires an approved run manifest because no canonical cross-session run key is persisted |
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
), projected AS (
  SELECT
    "id" AS "projectionId",
    "sessionId",
    "data" -> '__agentHarnessV2' ->> 'eventId' AS "eventId"
  FROM "agent_transcript_events"
  WHERE "data" IS NOT NULL
    AND "data" ? '__agentHarnessV2'
), projected_by_event AS (
  SELECT "eventId", COUNT(*)::int AS "allProjectionCount"
  FROM projected
  WHERE "eventId" IS NOT NULL
  GROUP BY "eventId"
), projected_by_pair AS (
  SELECT "eventId", "sessionId", COUNT(*)::int AS "exactPairProjectionCount"
  FROM projected
  WHERE "eventId" IS NOT NULL
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
SELECT
  COUNT(*)::int AS "ah2008PrefixEventCount",
  COUNT(*) FILTER (
    WHERE "payload" IS NULL
       OR NOT ("payload" ? 'legacy')
  )::int AS "dualWriteMarkerShapeAnomalyCount"
FROM "agent_events"
WHERE "createdAt" >= :window_start
  AND "createdAt" < :window_end
  AND "idempotencyKey" LIKE 'legacy-transcript:%';
```

### 2. Existing markers outside the selected event window

This query treats marker rows as the unit of measurement and distinguishes an
event ID that does not exist anywhere from an event that exists but was created
outside the selected 48-hour window. The latter must not be counted as a
missing projection for the selected window.

```sql
WITH markers AS (
  SELECT
    t."id" AS "projectionId",
    t."sessionId" AS "projectedSessionId",
    t."data" -> '__agentHarnessV2' ->> 'eventId' AS "eventId"
  FROM "agent_transcript_events" t
  WHERE t."data" IS NOT NULL
    AND t."data" ? '__agentHarnessV2'
), linked AS (
  SELECT
    m.*,
    e."id" AS "existingEventId",
    e."sessionId" AS "eventSessionId",
    e."createdAt" AS "eventCreatedAt",
    e."idempotencyKey" AS "eventIdempotencyKey"
  FROM markers m
  LEFT JOIN "agent_events" e ON e."id" = m."eventId"
  WHERE m."eventId" IS NOT NULL
)
SELECT
  COUNT(*) FILTER (
    WHERE "existingEventId" IS NULL
  )::int AS "nonexistentEventMarkerCount",
  COUNT(*) FILTER (
    WHERE "existingEventId" IS NOT NULL
      AND NOT ("eventCreatedAt" >= :window_start AND "eventCreatedAt" < :window_end)
  )::int AS "existingEventOutsideSelectedWindowCount",
  COUNT(*) FILTER (
    WHERE "existingEventId" IS NOT NULL
      AND "eventCreatedAt" >= :window_start
      AND "eventCreatedAt" < :window_end
  )::int AS "existingEventInsideSelectedWindowCount",
  COUNT(*) FILTER (
    WHERE "existingEventId" IS NOT NULL
      AND "eventIdempotencyKey" NOT LIKE 'legacy-transcript:%'
  )::int AS "markerPointsToNonDualWriteEventCount",
  COUNT(*) FILTER (
    WHERE "existingEventId" IS NOT NULL
      AND "eventSessionId" <> "projectedSessionId"
  )::int AS "crossSessionMarkerRowCount"
FROM linked;
```

### 3. Semantic projection mismatches

First extract **every** paired projection row in the selected window. Do not
use `LIMIT 5` in the extraction or comparison query; a maximum of five is only
permitted when displaying redacted mismatch references after the complete
count has been calculated.

```sql
SELECT
  e."id" AS "v2EventId",
  e."sessionId",
  e."payload" -> 'legacy' AS "legacyPayload",
  t."id" AS "projectionId",
  t."type",
  t."speaker",
  t."title",
  t."body",
  t."data",
  t."durationMs"
FROM "agent_events" e
JOIN "agent_transcript_events" t
  ON t."data" -> '__agentHarnessV2' ->> 'eventId' = e."id"
 AND t."sessionId" = e."sessionId"
WHERE e."createdAt" >= :window_start
  AND e."createdAt" < :window_end
  AND e."idempotencyKey" LIKE 'legacy-transcript:%'
  AND t."data" IS NOT NULL
  AND t."data" ? '__agentHarnessV2'
ORDER BY e."sessionId", e."sequence", t."id";
```

In a controlled comparison script, map `legacyPayload` to the comparable
fields (`type`, `speaker`, `title`, `body`, `durationMs`, and `data`) and call
`compareTranscriptGolden` from the projector module for **every** returned
paired row, including duplicate projection rows. Record the exact number of
rows whose `matches` value is false as `projection_mismatch_count`. The report
may retain at most five redacted `(v2EventId, projectionId, differences)`
references for review; the sample must never replace the complete count.
Structural anomalies (`missing`, `cross-session`, and `duplicate`) remain
separate metrics even when semantic comparison is possible.

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

For automation runs, run:

```sql
WITH automation_sessions AS (
  SELECT
    t."data" ->> 'automationId' AS "automationId",
    t."sessionId" AS "observedSessionId"
  FROM "agent_transcript_events" t
  WHERE t."type" = 'automation_started'
    AND t."createdAt" >= :window_start
    AND t."createdAt" < :window_end
    AND t."data" IS NOT NULL
    AND t."data" ->> 'automationId' IS NOT NULL
), automation_groups AS (
  SELECT
    a."id" AS "automationId",
    a."sessionId" AS "canonicalSessionId",
    COUNT(DISTINCT s."observedSessionId")::int AS "observedSessionCount",
    COUNT(*) FILTER (
      WHERE s."observedSessionId" IS DISTINCT FROM a."sessionId"
    )::int AS "nonCanonicalObservationCount"
  FROM "agent_automations" a
  JOIN automation_sessions s
    ON s."automationId" = a."id"
  GROUP BY a."id", a."sessionId"
)
SELECT
  COUNT(*) FILTER (
    WHERE "canonicalSessionId" IS NOT NULL
      AND "observedSessionCount" > 1
  )::int
    AS "duplicateAutomationSessionGroups",
  COUNT(*) FILTER (WHERE "canonicalSessionId" IS NULL)::int
    AS "automationWithoutCanonicalSessionCount",
  COALESCE(SUM("nonCanonicalObservationCount"), 0)::int
    AS "nonCanonicalAutomationObservationCount"
FROM automation_groups;
```

For chat/manual runs, the authorized operator must create an access-controlled
temporary manifest from the staging exercise, with one row per observed
session:

```sql
CREATE TEMP TABLE phase4_run_manifest (
  "runClass" text NOT NULL CHECK ("runClass" IN ('chat', 'manual')),
  "runKey" text NOT NULL,
  "canonicalSessionId" text NOT NULL,
  "observedSessionId" text NOT NULL
);
-- Insert the operator-approved exercise mapping here. Do not infer it from
-- goals, timestamps, user IDs, or similar text.

SELECT
  COUNT(*) FILTER (WHERE "observedSessionCount" > 1)::int
    AS "duplicateChatManualSessionGroups",
  COALESCE(SUM("nonCanonicalObservationCount"), 0)::int
    AS "nonCanonicalChatManualObservationCount"
FROM (
  SELECT
    "runClass",
    "runKey",
    "canonicalSessionId",
    COUNT(DISTINCT "observedSessionId")::int AS "observedSessionCount",
    COUNT(*) FILTER (
      WHERE "observedSessionId" IS DISTINCT FROM "canonicalSessionId"
    )::int AS "nonCanonicalObservationCount"
  FROM phase4_run_manifest
  GROUP BY "runClass", "runKey", "canonicalSessionId"
) grouped_runs;
```

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
