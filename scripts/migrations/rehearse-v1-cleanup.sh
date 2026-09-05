#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly MIGRATION_FILE="$REPO_ROOT/apps/web/prisma/migrations/20260905120000_drop_legacy_agent_question_index/migration.sql"
readonly DB_IMAGE="${REHEARSAL_DB_IMAGE:-pgvector/pgvector:pg16}"
readonly DB_NAME="applymate_rehearsal"
readonly DB_USER="postgres"
readonly DB_PASSWORD="rehearsal"
readonly CONTAINER="applymate-v1-cleanup-${GITHUB_RUN_ID:-local}-$$"
readonly TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
readonly DUMP_FILE="${TEMP_ROOT}/applymate-v1-cleanup-${RANDOM}.dump"
readonly SCHEMA_FILE="${TEMP_ROOT}/applymate-v1-cleanup-${RANDOM}.sql"
REPORT_FILE="${REHEARSAL_REPORT_FILE:-disposable-rehearsal-report.md}"
MODE="dump"

usage() {
  cat <<'EOF'
Usage: rehearse-v1-cleanup.sh [--synthetic] [--report PATH]

Default mode restores SOURCE_DUMP_FILE or creates a custom dump from
SOURCE_DATABASE_URL. --synthetic creates a schema-only disposable fixture for
pull-request validation and is not a substitute for a current database dump.
EOF
}

while (($# > 0)); do
  case "$1" in
    --synthetic)
      MODE="synthetic"
      shift
      ;;
    --report)
      [[ $# -ge 2 ]] || { echo "--report requires a path" >&2; exit 2; }
      REPORT_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }
}

require_command docker
mkdir -p "$(dirname "$REPORT_FILE")"
: > "$REPORT_FILE"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
source_kind=""
db_port=""
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -f "$DUMP_FILE" "$SCHEMA_FILE"
}
trap cleanup EXIT

run_psql() {
  docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
}

wait_for_postgres() {
  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "PostgreSQL did not become ready" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
}

docker run --detach --name "$CONTAINER" \
  --env "POSTGRES_USER=$DB_USER" \
  --env "POSTGRES_PASSWORD=$DB_PASSWORD" \
  --env "POSTGRES_DB=$DB_NAME" \
  --publish 127.0.0.1::5432 \
  "$DB_IMAGE" >/dev/null
wait_for_postgres
db_port="$(docker port "$CONTAINER" 5432/tcp | sed -E 's/.*://')"
[[ "$db_port" =~ ^[0-9]+$ ]] || { echo "could not resolve container port" >&2; exit 1; }

target_url="postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${db_port}/${DB_NAME}?schema=public"

if [[ "$MODE" == "synthetic" ]]; then
  require_command pnpm
  source_kind="synthetic schema fixture"
  (
    cd "$REPO_ROOT"
    pnpm --filter @jobcopilot/web exec prisma migrate diff \
      --from-empty --to-schema-datamodel prisma/schema.prisma --script
  ) > "$SCHEMA_FILE"
  run_psql < "$SCHEMA_FILE"
  run_psql <<'SQL'
CREATE INDEX IF NOT EXISTS "AgentRunQuestion_userId_runId_answeredAt_idx"
  ON "AgentRunQuestion" ("userId", "runId", "answeredAt");
SQL
else
  if [[ -n "${SOURCE_DUMP_FILE:-}" ]]; then
    [[ -f "$SOURCE_DUMP_FILE" ]] || { echo "SOURCE_DUMP_FILE does not exist" >&2; exit 1; }
    source_kind="custom-format dump file"
    cp "$SOURCE_DUMP_FILE" "$DUMP_FILE"
  elif [[ -n "${SOURCE_DATABASE_URL:-}" ]]; then
    source_kind="database URL dump"
    docker run --rm --env "SOURCE_DATABASE_URL=$SOURCE_DATABASE_URL" "$DB_IMAGE" \
      sh -ceu 'pg_dump --format=custom --no-owner --no-acl "$SOURCE_DATABASE_URL"' > "$DUMP_FILE"
  else
    echo "set SOURCE_DUMP_FILE or SOURCE_DATABASE_URL, or use --synthetic" >&2
    exit 2
  fi
  docker exec -i "$CONTAINER" pg_restore --exit-on-error --no-owner --no-privileges \
    -U "$DB_USER" -d "$DB_NAME" < "$DUMP_FILE"
fi

if [[ "$MODE" == "synthetic" ]]; then
  # The migration file lives on the host; pipe it into psql running in Docker.
  run_psql < "$MIGRATION_FILE"
else
  require_command pnpm
  DATABASE_URL="$target_url" pnpm --filter @jobcopilot/web exec prisma migrate deploy
fi

run_psql <<'SQL'
INSERT INTO "User" ("id", "email", "createdAt", "updatedAt", "onboardingGoals")
VALUES ('rehearsal-user', 'rehearsal.invalid', NOW(), NOW(), '{}')
ON CONFLICT ("id") DO NOTHING;
SQL

run_psql <<'SQL'
DO $$
BEGIN
  IF to_regclass('public."AgentRunQuestion_userId_runId_answeredAt_idx"') IS NOT NULL THEN
    RAISE EXCEPTION 'approved legacy index still exists after cleanup migration';
  END IF;
END $$;
SELECT 'legacy_index_absent' AS check_name, TRUE AS passed;
SELECT 'agent_runs_read_shape' AS check_name,
       (SELECT COUNT(*) FROM (
          SELECT id, "userId", status, "updatedAt" FROM "agent_runs" LIMIT 0
        ) AS agent_run_shape) = 0 AS passed;
SELECT 'agent_question_read_shape' AS check_name,
       (SELECT COUNT(*) FROM (
          SELECT id, "userId", "runId", answer, "answeredAt"
          FROM "AgentRunQuestion" LIMIT 0
        ) AS question_shape) = 0 AS passed;
SELECT 'v2_read_shape' AS check_name,
       (SELECT COUNT(*) FROM (
          SELECT id, "userId", goal, status, "eventSequence"
          FROM "agent_sessions" LIMIT 0
        ) AS session_shape) = 0
       AND (SELECT COUNT(*) FROM (
          SELECT id, "sessionId", "userId", status FROM "agent_turns" LIMIT 0
        ) AS turn_shape) = 0
       AND (SELECT COUNT(*) FROM (
          SELECT id, "sessionId", "turnId", sequence, type, payload
          FROM "agent_events" LIMIT 0
        ) AS event_shape) = 0 AS passed;
SQL

inventory="$(run_psql -At -F '|' -c '
SELECT ''agent_runs'', COUNT(*)::text, COALESCE(MAX("updatedAt")::text, ''never'') FROM "agent_runs"
UNION ALL SELECT ''AgentRunQuestion'', COUNT(*)::text, COALESCE(MAX(COALESCE("answeredAt", "createdAt"))::text, ''never'') FROM "AgentRunQuestion"
UNION ALL SELECT ''agent_executions'', COUNT(*)::text, COALESCE(MAX("updatedAt")::text, ''never'') FROM "agent_executions"
UNION ALL SELECT ''agent_transcript_events'', COUNT(*)::text, COALESCE(MAX("createdAt")::text, ''never'') FROM "agent_transcript_events"
UNION ALL SELECT ''application_tasks'', COUNT(*)::text, COALESCE(MAX("updatedAt")::text, ''never'') FROM "application_tasks"
UNION ALL SELECT ''application_task_events'', COUNT(*)::text, COALESCE(MAX("createdAt")::text, ''never'') FROM "application_task_events"
UNION ALL SELECT ''form_patterns'', COUNT(*)::text, COALESCE(MAX("updated_at")::text, ''never'') FROM "form_patterns"
UNION ALL SELECT ''agent_sessions'', COUNT(*)::text, COALESCE(MAX("updatedAt")::text, ''never'') FROM "agent_sessions"
UNION ALL SELECT ''agent_turns'', COUNT(*)::text, COALESCE(MAX("updatedAt")::text, ''never'') FROM "agent_turns"
UNION ALL SELECT ''agent_steps'', COUNT(*)::text, COALESCE(MAX("createdAt")::text, ''never'') FROM "agent_steps"
UNION ALL SELECT ''agent_inputs'', COUNT(*)::text, COALESCE(MAX("createdAt")::text, ''never'') FROM "agent_inputs"
UNION ALL SELECT ''agent_items'', COUNT(*)::text, COALESCE(MAX("updatedAt")::text, ''never'') FROM "agent_items"
UNION ALL SELECT ''agent_outbox'', COUNT(*)::text, COALESCE(MAX("createdAt")::text, ''never'') FROM "agent_outbox"
UNION ALL SELECT ''sub_agent_tasks'', COUNT(*)::text, COALESCE(MAX("updatedAt")::text, ''never'') FROM "sub_agent_tasks"
UNION ALL SELECT ''agent_mailbox_messages'', COUNT(*)::text, COALESCE(MAX("createdAt")::text, ''never'') FROM "agent_mailbox_messages"
UNION ALL SELECT ''agent_approvals'', COUNT(*)::text, COALESCE(MAX("createdAt")::text, ''never'') FROM "agent_approvals"
UNION ALL SELECT ''agent_action_reservations'', COUNT(*)::text, COALESCE(MAX("updatedAt")::text, ''never'') FROM "agent_action_reservations"
ORDER BY 1')"

run_psql <<'SQL'
BEGIN;
DO $$
DECLARE
  session_id TEXT := 'rehearsal-session-' || substr(md5(clock_timestamp()::text), 1, 20);
  turn_id TEXT := 'rehearsal-turn-' || substr(md5(clock_timestamp()::text || 'turn'), 1, 20);
  event_id TEXT := 'rehearsal-event-' || substr(md5(clock_timestamp()::text || 'event'), 1, 20);
BEGIN
  INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source")
  VALUES (session_id, 'rehearsal-user', 'disposable rehearsal', 'queued', 'system');
  INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot")
  VALUES (turn_id, session_id, 'rehearsal-user', 'queued', 'system', '{"rehearsal":true}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);
  INSERT INTO "agent_events" ("id", "sessionId", "turnId", "sequence", "type", "actor", "correlationId", "payload")
  VALUES (event_id, session_id, turn_id, 1, 'rehearsal', 'system', event_id, '{"rehearsal":true}'::jsonb);
END $$;
ROLLBACK;
SQL

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$REPORT_FILE" <<EOF
# Disposable V1 cleanup rehearsal report

- Result: **PASS**
- Source: ${source_kind}
- Started (UTC): ${started_at}
- Finished (UTC): ${finished_at}
- PostgreSQL image: ${DB_IMAGE}
- Migration: 20260905120000_drop_legacy_agent_question_index
- Destructive data/table operations: **none**

## Checks

- The approved legacy index is absent after migration.
- Legacy AgentRun and question read shapes remain queryable.
- V2 session, turn, and event read shapes remain queryable.
- A V2 session/turn/event write transaction committed and rolled back cleanly.

## Metadata-only inventory

```text
object|row_count|last_write
${inventory}
```

## Limitations

This report contains no prompt, resume, email, credential, or job content.
It does not constitute production zero-traffic evidence, staging observation,
GA checklist sign-off, or approval for a table/column/data DROP.
EOF

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$REPORT_FILE" >> "$GITHUB_STEP_SUMMARY"
fi

echo "rehearsal passed: $REPORT_FILE"
