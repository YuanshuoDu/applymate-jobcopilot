-- Keep the deployed append-order migration immutable. This additive migration
-- exposes the exact hash calculation to the integrity verifier so it can detect
-- field tampering, not only broken links.
CREATE OR REPLACE FUNCTION admin_audit_record_hash(
  previous TEXT,
  audit_id TEXT,
  request_id TEXT,
  actor_user_id TEXT,
  actor_role_key TEXT,
  action TEXT,
  target_type TEXT,
  target_id TEXT,
  tenant_user_id TEXT,
  reason TEXT,
  outcome TEXT,
  error_code TEXT,
  before_json JSONB,
  after_json JSONB
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT encode(digest(
    coalesce(previous, '') || '|' || audit_id || '|' || request_id || '|' ||
    coalesce(actor_user_id, '') || '|' || coalesce(actor_role_key, '') || '|' ||
    action || '|' || coalesce(target_type, '') || '|' ||
    coalesce(target_id, '') || '|' || coalesce(tenant_user_id, '') || '|' ||
    coalesce(reason, '') || '|' || outcome || '|' ||
    coalesce(error_code, '') || '|' || coalesce(before_json::text, '') || '|' ||
    coalesce(after_json::text, ''),
    'sha256'
  ), 'hex');
$$;

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
  NEW."record_hash" := admin_audit_record_hash(
    previous,
    NEW."id",
    NEW."requestId",
    NEW."actorUserId",
    NEW."actorRoleKey",
    NEW."action",
    NEW."targetType"::text,
    NEW."targetId",
    NEW."tenantUserId",
    NEW."reason",
    NEW."outcome"::text,
    NEW."errorCode",
    NEW."before",
    NEW."after"
  );
  RETURN NEW;
END;
$$;
