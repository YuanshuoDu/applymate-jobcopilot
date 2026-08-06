CREATE FUNCTION prevent_admin_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AdminAuditLog is append-only';
END;
$$;

CREATE TRIGGER admin_audit_log_append_only
BEFORE UPDATE OR DELETE ON "AdminAuditLog"
FOR EACH ROW
EXECUTE FUNCTION prevent_admin_audit_log_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON "AdminAuditLog" FROM PUBLIC;
