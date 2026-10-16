CREATE TABLE "AiPlatformEmbeddingModelPolicy" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AiPlatformEmbeddingModelPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiPlatformEmbeddingModelPolicy_providerId_idx" ON "AiPlatformEmbeddingModelPolicy"("providerId");
CREATE INDEX "AiPlatformEmbeddingModelPolicy_updatedBy_idx" ON "AiPlatformEmbeddingModelPolicy"("updatedBy");

ALTER TABLE "AiPlatformEmbeddingModelPolicy" ADD CONSTRAINT "AiPlatformEmbeddingModelPolicy_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiPlatformEmbeddingModelPolicy" ADD CONSTRAINT "AiPlatformEmbeddingModelPolicy_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
