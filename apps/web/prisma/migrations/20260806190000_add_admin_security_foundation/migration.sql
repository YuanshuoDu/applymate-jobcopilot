CREATE TYPE "AdminMembershipStatus" AS ENUM ('active', 'suspended', 'revoked');
CREATE TYPE "AdminMfaLevel" AS ENUM ('none', 'totp', 'webauthn');
CREATE TYPE "AdminAuditOutcome" AS ENUM ('success', 'denied', 'failed');
CREATE TYPE "AdminTargetType" AS ENUM ('user', 'admin_member', 'admin_role', 'plan', 'plan_change', 'ai_provider', 'ai_model', 'ai_route', 'broadcast', 'support_case');

CREATE TABLE "AdminRole" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "permissions" TEXT[] NOT NULL,
  "system" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminRole_key_key" ON "AdminRole"("key");

CREATE TABLE "AdminMembership" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "status" "AdminMembershipStatus" NOT NULL DEFAULT 'active',
  "mfaLevel" "AdminMfaLevel" NOT NULL DEFAULT 'none',
  "sessionVersion" INTEGER NOT NULL DEFAULT 1,
  "grantedById" TEXT,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AdminMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminMembership_userId_key" ON "AdminMembership"("userId");
CREATE INDEX "AdminMembership_status_roleId_idx" ON "AdminMembership"("status", "roleId");

CREATE TABLE "AdminAuditLog" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorRoleKey" TEXT,
  "action" TEXT NOT NULL,
  "targetType" "AdminTargetType",
  "targetId" TEXT,
  "tenantUserId" TEXT,
  "reason" TEXT,
  "outcome" "AdminAuditOutcome" NOT NULL,
  "ipHash" TEXT,
  "userAgentHash" TEXT,
  "before" JSONB,
  "after" JSONB,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAuditLog_actorUserId_createdAt_idx" ON "AdminAuditLog"("actorUserId", "createdAt" DESC);
CREATE INDEX "AdminAuditLog_tenantUserId_createdAt_idx" ON "AdminAuditLog"("tenantUserId", "createdAt" DESC);
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt" DESC);

CREATE TABLE "AdminIdempotencyKey" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "responseStatus" INTEGER NOT NULL,
  "responseBody" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminIdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminIdempotencyKey_actorUserId_key_key" ON "AdminIdempotencyKey"("actorUserId", "key");
CREATE INDEX "AdminIdempotencyKey_createdAt_idx" ON "AdminIdempotencyKey"("createdAt");

ALTER TABLE "AdminMembership" ADD CONSTRAINT "AdminMembership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminMembership" ADD CONSTRAINT "AdminMembership_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
