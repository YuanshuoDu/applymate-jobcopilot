-- CreateTable
CREATE TABLE "apply_results" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "ats_type" TEXT,
    "flow_used" TEXT,
    "error" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "apply_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "apply_results_user_id_created_at_idx" ON "apply_results"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "apply_results" ADD CONSTRAINT "apply_results_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;