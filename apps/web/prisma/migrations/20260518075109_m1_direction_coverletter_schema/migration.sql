-- AlterTable
ALTER TABLE "public"."Job" ADD COLUMN     "finalCoverLetterId" TEXT,
ADD COLUMN     "finalResumeId" TEXT;

-- AlterTable
ALTER TABLE "public"."Resume" ADD COLUMN     "basicsDetached" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "directionId" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'base',
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "parentResumeId" TEXT,
ADD COLUMN     "targetJobId" TEXT;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "aiAutoPilot" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "defaultAccentColor" TEXT,
ADD COLUMN     "defaultFontFamily" TEXT,
ADD COLUMN     "defaultTemplateId" TEXT,
ADD COLUMN     "onboardedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingGoals" TEXT[];

-- CreateTable
CREATE TABLE "public"."Direction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Direction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CoverLetter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "resumeId" TEXT,
    "content" TEXT NOT NULL,
    "tone" TEXT NOT NULL DEFAULT 'professional',
    "templateId" TEXT,
    "templateOptions" JSONB,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoverLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Direction_userId_idx" ON "public"."Direction"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Direction_userId_name_key" ON "public"."Direction"("userId", "name");

-- CreateIndex
CREATE INDEX "CoverLetter_userId_jobId_idx" ON "public"."CoverLetter"("userId", "jobId");

-- CreateIndex
CREATE INDEX "CoverLetter_jobId_isFinal_idx" ON "public"."CoverLetter"("jobId", "isFinal");

-- CreateIndex
CREATE INDEX "Resume_userId_directionId_idx" ON "public"."Resume"("userId", "directionId");

-- CreateIndex
CREATE INDEX "Resume_targetJobId_idx" ON "public"."Resume"("targetJobId");

-- AddForeignKey
ALTER TABLE "public"."Job" ADD CONSTRAINT "Job_finalResumeId_fkey" FOREIGN KEY ("finalResumeId") REFERENCES "public"."Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Job" ADD CONSTRAINT "Job_finalCoverLetterId_fkey" FOREIGN KEY ("finalCoverLetterId") REFERENCES "public"."CoverLetter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Resume" ADD CONSTRAINT "Resume_directionId_fkey" FOREIGN KEY ("directionId") REFERENCES "public"."Direction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Resume" ADD CONSTRAINT "Resume_parentResumeId_fkey" FOREIGN KEY ("parentResumeId") REFERENCES "public"."Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Resume" ADD CONSTRAINT "Resume_targetJobId_fkey" FOREIGN KEY ("targetJobId") REFERENCES "public"."Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Direction" ADD CONSTRAINT "Direction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CoverLetter" ADD CONSTRAINT "CoverLetter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CoverLetter" ADD CONSTRAINT "CoverLetter_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "public"."Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CoverLetter" ADD CONSTRAINT "CoverLetter_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "public"."Resume"("id") ON DELETE SET NULL ON UPDATE CASCADE;
