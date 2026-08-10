CREATE TYPE "AdminMembershipStatus" AS ENUM ('active', 'suspended', 'revoked');
CREATE TYPE "AdminMfaLevel" AS ENUM ('none', 'totp', 'webauthn');
CREATE TYPE "AdminAuditOutcome" AS ENUM ('success', 'denied', 'failed');
CREATE TYPE "AdminTargetType" AS ENUM ('user', 'job', 'application', 'ats_source', 'feature_flag', 'ai_budget', 'queue', 'broadcast', 'support_case', 'admin_member');
CREATE TYPE "SupportCaseStatus" AS ENUM ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed');
CREATE TYPE "SupportCasePriority" AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE "SupportCaseMessageKind" AS ENUM ('customer_reply', 'staff_reply', 'internal_note', 'system_event');

CREATE TABLE "AdminRole" (
  "id" TEXT NOT NULL, "key" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT,
  "permissions" TEXT[], "system" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminRole_key_key" ON "AdminRole"("key");

CREATE TABLE "AdminMembership" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "roleId" TEXT NOT NULL,
  "status" "AdminMembershipStatus" NOT NULL DEFAULT 'active', "mfaLevel" "AdminMfaLevel" NOT NULL DEFAULT 'none',
  "sessionVersion" INTEGER NOT NULL DEFAULT 1, "grantedById" TEXT, "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revokedAt" TIMESTAMP(3),
  CONSTRAINT "AdminMembership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminMembership_userId_key" ON "AdminMembership"("userId");
CREATE INDEX "AdminMembership_status_roleId_idx" ON "AdminMembership"("status", "roleId");
ALTER TABLE "AdminMembership" ADD CONSTRAINT "AdminMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminMembership" ADD CONSTRAINT "AdminMembership_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AdminAuditLog" (
  "id" TEXT NOT NULL, "requestId" TEXT NOT NULL, "actorUserId" TEXT, "actorRoleKey" TEXT, "action" TEXT NOT NULL,
  "targetType" "AdminTargetType", "targetId" TEXT, "tenantUserId" TEXT, "reason" TEXT,
  "outcome" "AdminAuditOutcome" NOT NULL, "ipHash" TEXT, "userAgentHash" TEXT, "before" JSONB, "after" JSONB,
  "errorCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminAuditLog_actorUserId_createdAt_idx" ON "AdminAuditLog"("actorUserId", "createdAt" DESC);
CREATE INDEX "AdminAuditLog_tenantUserId_createdAt_idx" ON "AdminAuditLog"("tenantUserId", "createdAt" DESC);
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt" DESC);

CREATE TABLE "AdminBreakGlassGrant" (
  "id" TEXT NOT NULL, "requesterId" TEXT NOT NULL, "approverId" TEXT, "permission" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminBreakGlassGrant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminBreakGlassGrant_requesterId_expiresAt_idx" ON "AdminBreakGlassGrant"("requesterId", "expiresAt");

CREATE TABLE "support_cases" (
  "id" TEXT NOT NULL, "requester_user_id" TEXT NOT NULL, "subject" TEXT NOT NULL, "category" TEXT NOT NULL,
  "status" "SupportCaseStatus" NOT NULL DEFAULT 'open', "priority" "SupportCasePriority" NOT NULL DEFAULT 'normal',
  "assigned_admin_id" TEXT, "sla_due_at" TIMESTAMP(3), "first_responded_at" TIMESTAMP(3), "resolved_at" TIMESTAMP(3),
  "safe_context" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_cases_status_priority_sla_due_at_idx" ON "support_cases"("status", "priority", "sla_due_at");
CREATE INDEX "support_cases_requester_user_id_updatedAt_idx" ON "support_cases"("requester_user_id", "updatedAt" DESC);
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "support_case_messages" (
  "id" TEXT NOT NULL, "case_id" TEXT NOT NULL, "author_type" "SupportCaseMessageKind" NOT NULL,
  "author_user_id" TEXT, "idempotency_key" TEXT, "body" TEXT NOT NULL, "redacted" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "support_case_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_case_messages_case_id_createdAt_idx" ON "support_case_messages"("case_id", "createdAt");
CREATE UNIQUE INDEX "support_case_messages_idempotency_key_key" ON "support_case_messages"("idempotency_key");
ALTER TABLE "support_case_messages" ADD CONSTRAINT "support_case_messages_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "support_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
