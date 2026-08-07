-- Preference changes are an exception-only operation. Existing super-admin
-- role rows need the new permission because their stored arrays are explicit.
UPDATE "AdminRole"
SET "permissions" = array_append("permissions", 'users.update_preferences')
WHERE "key" = 'super_admin'
  AND NOT ('users.update_preferences' = ANY("permissions"));
