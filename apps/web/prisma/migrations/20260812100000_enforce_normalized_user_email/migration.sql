-- Account identity is case-insensitive everywhere in the application. Keep
-- that invariant at the database boundary too, so concurrent registrations
-- cannot create two identities for the same normalized email.
DO $$
BEGIN
  IF EXISTS (
    SELECT lower("email")
    FROM "User"
    GROUP BY lower("email")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce normalized User.email uniqueness while duplicate normalized emails exist; reconcile those accounts first';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "User_email_lower_key"
  ON "User" (lower("email"));
