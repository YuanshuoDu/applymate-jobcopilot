-- Hash-chain order is defined by previous_hash, not by transaction timestamps.
-- A waiting concurrent transaction can receive an earlier createdAt value while
-- its trigger runs after a later transaction has already appended a row.
CREATE INDEX "AdminAuditLog_previous_hash_idx"
  ON "AdminAuditLog"("previous_hash")
  WHERE "previous_hash" IS NOT NULL;

CREATE OR REPLACE FUNCTION set_admin_audit_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('applymate-admin-audit-chain'));

  IF EXISTS (SELECT 1 FROM "AdminAuditLog") THEN
    SELECT leaf."record_hash"
    INTO STRICT previous
    FROM "AdminAuditLog" AS leaf
    WHERE NOT EXISTS (
      SELECT 1
      FROM "AdminAuditLog" AS child
      WHERE child."previous_hash" = leaf."record_hash"
    )
    FOR UPDATE;
  END IF;

  NEW."previous_hash" := previous;
  NEW."record_hash" := encode(digest(
    coalesce(previous, '') || '|' || NEW."id" || '|' || NEW."requestId" || '|' ||
    coalesce(NEW."actorUserId", '') || '|' || coalesce(NEW."actorRoleKey", '') || '|' ||
    NEW."action" || '|' || coalesce(NEW."targetType"::text, '') || '|' ||
    coalesce(NEW."targetId", '') || '|' || coalesce(NEW."tenantUserId", '') || '|' ||
    coalesce(NEW."reason", '') || '|' || NEW."outcome"::text || '|' ||
    coalesce(NEW."errorCode", '') || '|' || coalesce(NEW."before"::text, '') || '|' ||
    coalesce(NEW."after"::text, ''),
    'sha256'
  ), 'hex');
  RETURN NEW;
END;
$$;
