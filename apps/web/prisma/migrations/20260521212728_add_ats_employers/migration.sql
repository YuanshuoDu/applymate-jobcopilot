-- CreateTable
CREATE TABLE "ats_employers" (
    "id" SERIAL NOT NULL,
    "atsType" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ats_employers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ats_employers_atsType_slug_key" ON "ats_employers"("atsType", "slug");
