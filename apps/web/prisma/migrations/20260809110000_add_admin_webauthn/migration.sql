CREATE TYPE "AdminWebAuthnChallengePurpose" AS ENUM ('registration', 'reauthentication');

CREATE TABLE "admin_webauthn_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[] NOT NULL,
    "device_type" TEXT,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "device_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "admin_webauthn_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_webauthn_credentials_credential_id_key" ON "admin_webauthn_credentials"("credential_id");
CREATE INDEX "admin_webauthn_credentials_user_id_revoked_at_idx" ON "admin_webauthn_credentials"("user_id", "revoked_at");
ALTER TABLE "admin_webauthn_credentials" ADD CONSTRAINT "admin_webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "admin_webauthn_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" "AdminWebAuthnChallengePurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_webauthn_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_webauthn_challenges_challenge_key" ON "admin_webauthn_challenges"("challenge");
CREATE INDEX "admin_webauthn_challenges_user_id_purpose_expires_at_idx" ON "admin_webauthn_challenges"("user_id", "purpose", "expires_at");
ALTER TABLE "admin_webauthn_challenges" ADD CONSTRAINT "admin_webauthn_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "admin_reauth_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_reauth_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_reauth_grants_token_hash_key" ON "admin_reauth_grants"("token_hash");
CREATE INDEX "admin_reauth_grants_user_id_expires_at_idx" ON "admin_reauth_grants"("user_id", "expires_at");
ALTER TABLE "admin_reauth_grants" ADD CONSTRAINT "admin_reauth_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
