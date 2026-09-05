# V1 Agent-state backup, restore, and rollback runbook

Status: **required before any production schema change**

Named owner: **YuanshuoDu**, engineering/product owner. The platform
on-call executes commands; the security reviewer confirms retention and
external-action safety; the owner approves any production change.

## Safety rules

- Never put `DATABASE_URL`, passwords, tokens, prompts, resumes, candidate
  answers, email contents, or dump contents in GitHub comments or reports.
- Never run the cleanup migration against production from a laptop.
- The current PR removes one unused index only. It does not approve removal
  of AgentRun, execution, transcript, application, or V2 tables.
- Production DROP remains blocked until the AH2 GA checklist, durable
  seven-day zero-traffic report, rollback rehearsal, and owner approval are
  attached to the owning issue.

## Create a restricted custom-format dump

Run from an approved operator environment with a direct database connection.
Do not paste the command with its expanded URL into a ticket or shell log.

```bash
umask 077
export DUMP_FILE="${RUNNER_TEMP:-/tmp}/applymate-v1-legacy-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-acl --file="$DUMP_FILE" "$SOURCE_DATABASE_URL"
sha256sum "$DUMP_FILE"
```

Store the dump in the approved encrypted backup location; `pg_dump` custom
format alone is not encryption. The rehearsal
report records only the SHA-256 digest, image digest, migration name, and
query results—not the database URL or dump path.

Retention: keep the encrypted pre-change dump for the longer of the
applicable GDPR/product retention window and the approved rollback window;
the named owner records the expiry and destroys it through the normal secure
deletion process. Do not keep an extra local copy after upload.

## Restore into a fresh disposable database

Use `pgvector/pgvector:pg16` (or an approved immutable digest) because the
historical schema may require the `vector` extension. The repository script
starts the container, restores the custom dump, runs `prisma migrate deploy`,
and writes a metadata-only report:

```bash
SOURCE_DUMP_FILE="$DUMP_FILE" \
  bash scripts/migrations/rehearse-v1-cleanup.sh --report disposable-rehearsal-report.md
```

The script removes the container on success or failure. Review the report,
then attach it as a CI artifact. A clean empty-schema run is useful for
syntax checking but does not replace a current-dump restore.

## Staging rehearsal

1. Confirm the staging deployment and database target in the platform
   dashboard.
2. Take the approved pre-change staging dump and record its SHA-256.
3. Run the script in the protected `staging-migration-rehearsal` environment.
4. Capture `migration_logs.txt`, the generated report, and
   `staging-smoke-results.md` as protected artifacts.
5. Verify the archive route remains read-only and ownership-scoped, V2 read
   paths have the same shape, V2 transactional writes roll back cleanly, the
   cleanup index is absent, and no failed Prisma migration is recorded.
6. Observe staging request/error telemetry for the required window. A local
   counter or a green CI run is not a 24-hour/production observation.

## Rollback

The migration is reversible without data restore because it removes an index
only. If query latency or an unexpected dependency appears, stop rollout and
recreate the approved index in a separately reviewed forward migration:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "AgentRunQuestion_userId_runId_answeredAt_idx"
  ON "AgentRunQuestion" ("userId", "runId", "answeredAt");
```

Do not edit an already-applied migration. If any table/column/data change is
ever proposed, restore the encrypted pre-change dump into a disposable copy,
open a new reviewed migration issue, and obtain owner/security approval
before considering production recovery.

## Required evidence bundle

```text
disposable-rehearsal-report.md
migration_logs.txt
staging-smoke-results.md
schema-diff.txt
backup-sha256.txt
```

The evidence must identify the deployment/environment, timestamps, migration
name, image digest, result counts, and rollback target while excluding secret
values and candidate data.
