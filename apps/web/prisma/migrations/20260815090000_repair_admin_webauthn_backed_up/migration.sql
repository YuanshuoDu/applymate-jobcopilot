ALTER TABLE "admin_webauthn_credentials"
ADD COLUMN IF NOT EXISTS "backed_up" BOOLEAN NOT NULL DEFAULT false;
