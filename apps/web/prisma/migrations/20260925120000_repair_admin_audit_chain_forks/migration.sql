-- The append-order repair migration prevents new forks, but it cannot repair
-- forks that already existed. Multiple leaves make its INTO STRICT lookup fail
-- with P0003 on every subsequent audit insert.
--
-- Rebuild only the hash metadata into one deterministic chain. The audit
-- payload and row identities remain unchanged, and the append-only trigger is
-- restored before this migration commits.
DO $$
DECLARE
  audit_row RECORD;
  previous TEXT := NULL;
  current_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('applymate-admin-audit-chain'));
  ALTER TABLE "AdminAuditLog" DISABLE TRIGGER "admin_audit_log_append_only";

  BEGIN
    FOR audit_row IN
      SELECT "id", "requestId", "actorUserId", "actorRoleKey", "action", "targetType",
        "targetId", "tenantUserId", "reason", "outcome", "errorCode", "before", "after"
      FROM "AdminAuditLog"
      ORDER BY "createdAt" ASC, "id" ASC
    LOOP
      current_hash := admin_audit_record_hash(
        previous,
        audit_row."id",
        audit_row."requestId",
        audit_row."actorUserId",
        audit_row."actorRoleKey",
        audit_row."action",
        audit_row."targetType"::text,
        audit_row."targetId",
        audit_row."tenantUserId",
        audit_row."reason",
        audit_row."outcome"::text,
        audit_row."errorCode",
        audit_row."before",
        audit_row."after"
      );

      UPDATE "AdminAuditLog"
      SET "previous_hash" = previous, "record_hash" = current_hash
      WHERE "id" = audit_row."id";

      previous := current_hash;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE "AdminAuditLog" ENABLE TRIGGER "admin_audit_log_append_only";
    RAISE;
  END;

  ALTER TABLE "AdminAuditLog" ENABLE TRIGGER "admin_audit_log_append_only";
END;
$$;
