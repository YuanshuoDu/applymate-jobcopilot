CREATE TABLE "AiProviderConfig" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "apiBase" TEXT NOT NULL,
  "secretRef" TEXT,
  "credentialConfigured" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiProviderConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiProviderConfig_key_key" ON "AiProviderConfig"("key");

CREATE TABLE "AiModelConfig" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT,
  "tier" TEXT NOT NULL,
  "priceIn" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "priceOut" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "contextK" INTEGER NOT NULL DEFAULT 128,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "AiModelConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiModelConfig_providerId_model_key" ON "AiModelConfig"("providerId", "model");

CREATE TABLE "AiRouteConfig" (
  "id" TEXT NOT NULL,
  "featureKey" TEXT NOT NULL,
  "defaultProvider" TEXT NOT NULL,
  "defaultModel" TEXT NOT NULL,
  "fallbackProvider" TEXT,
  "fallbackModel" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiRouteConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiRouteConfig_featureKey_key" ON "AiRouteConfig"("featureKey");

ALTER TABLE "AiModelConfig" ADD CONSTRAINT "AiModelConfig_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "AiProviderConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
