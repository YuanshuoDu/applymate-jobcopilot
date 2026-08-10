CREATE TABLE "admin_invitations" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "invited_by_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "admin_invitations_token_hash_key" ON "admin_invitations"("token_hash");
CREATE INDEX "admin_invitations_email_status_idx" ON "admin_invitations"("email", "status");
CREATE INDEX "admin_invitations_status_expires_at_idx" ON "admin_invitations"("status", "expires_at");
