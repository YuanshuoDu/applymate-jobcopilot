CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "AdminAuditLog"
  ADD COLUMN "previous_hash" TEXT,
  ADD COLUMN "record_hash" TEXT;
CREATE UNIQUE INDEX "AdminAuditLog_record_hash_key" ON "AdminAuditLog"("record_hash");

CREATE OR REPLACE FUNCTION set_admin_audit_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('applymate-admin-audit-chain'));
  SELECT "record_hash" INTO previous
  FROM "AdminAuditLog"
  ORDER BY "createdAt" DESC, "id" DESC
  LIMIT 1;
  NEW."previous_hash" := previous;
  NEW."record_hash" := encode(digest(
    coalesce(previous, '') || '|' || NEW."id" || '|' || NEW."requestId" || '|' ||
    coalesce(NEW."actorUserId", '') || '|' || coalesce(NEW."actorRoleKey", '') || '|' ||
    NEW."action" || '|' || coalesce(NEW."targetType"::text, '') || '|' || coalesce(NEW."targetId", '') || '|' ||
    coalesce(NEW."tenantUserId", '') || '|' || coalesce(NEW."reason", '') || '|' || NEW."outcome"::text || '|' ||
    coalesce(NEW."errorCode", '') || '|' || coalesce(NEW."before"::text, '') || '|' || coalesce(NEW."after"::text, ''),
    'sha256'
  ), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER admin_audit_hash_chain
BEFORE INSERT ON "AdminAuditLog"
FOR EACH ROW
EXECUTE FUNCTION set_admin_audit_hash();

CREATE TABLE "admin_audit_checkpoints" (
  "id" TEXT NOT NULL,
  "checkpoint_date" TIMESTAMP(3) NOT NULL,
  "first_record_hash" TEXT,
  "last_record_hash" TEXT,
  "record_count" INTEGER NOT NULL,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_checkpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_audit_checkpoints_checkpoint_date_key" UNIQUE ("checkpoint_date")
);
