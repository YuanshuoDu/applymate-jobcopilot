CREATE TYPE "AdminIncidentSeverity" AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE "AdminIncidentStatus" AS ENUM ('open', 'monitoring', 'resolved');

CREATE TABLE "admin_incidents" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "service" TEXT NOT NULL,
  "severity" "AdminIncidentSeverity" NOT NULL DEFAULT 'medium',
  "status" "AdminIncidentStatus" NOT NULL DEFAULT 'open',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admin_incidents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_incidents_status_severity_startedAt_idx" ON "admin_incidents"("status", "severity", "startedAt" DESC);
