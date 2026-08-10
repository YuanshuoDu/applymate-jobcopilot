ALTER TABLE "AdminAuditLog" DISABLE TRIGGER "admin_audit_log_append_only";

DO $$
DECLARE
  audit_row RECORD;
  previous TEXT := NULL;
  current_hash TEXT;
BEGIN
  FOR audit_row IN
    SELECT "id", "requestId", "actorUserId", "actorRoleKey", "action", "targetType", "targetId",
      "tenantUserId", "reason", "outcome", "errorCode", "before", "after"
    FROM "AdminAuditLog"
    ORDER BY "createdAt" ASC, "id" ASC
  LOOP
    current_hash := encode(digest(
      coalesce(previous, '') || '|' || audit_row."id" || '|' || audit_row."requestId" || '|' ||
      coalesce(audit_row."actorUserId", '') || '|' || coalesce(audit_row."actorRoleKey", '') || '|' ||
      audit_row."action" || '|' || coalesce(audit_row."targetType"::text, '') || '|' ||
      coalesce(audit_row."targetId", '') || '|' || coalesce(audit_row."tenantUserId", '') || '|' ||
      coalesce(audit_row."reason", '') || '|' || audit_row."outcome"::text || '|' ||
      coalesce(audit_row."errorCode", '') || '|' || coalesce(audit_row."before"::text, '') || '|' ||
      coalesce(audit_row."after"::text, ''),
      'sha256'
    ), 'hex');

    UPDATE "AdminAuditLog"
    SET "previous_hash" = previous, "record_hash" = current_hash
    WHERE "id" = audit_row."id";

    previous := current_hash;
  END LOOP;
END;
$$;

ALTER TABLE "AdminAuditLog" ENABLE TRIGGER "admin_audit_log_append_only";
ALTER TABLE "AdminAuditLog" ALTER COLUMN "record_hash" SET NOT NULL;
