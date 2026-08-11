-- Keep authentication revocation separate from ordinary profile and preference updates.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "authVersion" INTEGER NOT NULL DEFAULT 1;
