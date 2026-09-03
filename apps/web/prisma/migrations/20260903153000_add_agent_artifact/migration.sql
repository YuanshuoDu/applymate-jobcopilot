-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AgentArtifactLifecycle" AS ENUM ('base', 'draft');

-- CreateTable
CREATE TABLE "agent_artifact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "artifactType" TEXT NOT NULL,
    "lifecycle" "AgentArtifactLifecycle" NOT NULL,
    "baseId" TEXT,
    "baseHash" TEXT,
    "content" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "constraintHash" TEXT NOT NULL,
    "provenanceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "previousHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_artifact_userId_jobId_lifecycle_idx" ON "agent_artifact"("userId", "jobId", "lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "agent_artifact_userId_jobId_lifecycle_artifactType_key" ON "agent_artifact"("userId", "jobId", "lifecycle", "artifactType");
