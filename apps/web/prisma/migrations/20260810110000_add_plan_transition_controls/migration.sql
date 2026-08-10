ALTER TABLE "plan_catalogue"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "plan_transitions" (
  "id" TEXT NOT NULL,
  "fromPlan" "Plan" NOT NULL,
  "toPlan" "Plan" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "plan_transitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_transitions_fromPlan_toPlan_key"
  ON "plan_transitions"("fromPlan", "toPlan");

ALTER TABLE "plan_transitions"
  ADD CONSTRAINT "plan_transitions_fromPlan_fkey"
  FOREIGN KEY ("fromPlan") REFERENCES "plan_catalogue"("plan")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "plan_transitions"
  ADD CONSTRAINT "plan_transitions_toPlan_fkey"
  FOREIGN KEY ("toPlan") REFERENCES "plan_catalogue"("plan")
  ON DELETE RESTRICT ON UPDATE CASCADE;
