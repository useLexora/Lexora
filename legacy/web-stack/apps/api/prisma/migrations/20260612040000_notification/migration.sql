CREATE TYPE "PlatformNotificationAssetStatus" AS ENUM ('READY', 'DELETED');

CREATE TABLE "PlatformNotificationAsset" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT,
    "status" "PlatformNotificationAssetStatus" NOT NULL DEFAULT 'READY',
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "PlatformNotificationAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformNotificationAsset_bucket_objectKey_key" ON "PlatformNotificationAsset"("bucket", "objectKey");
CREATE INDEX "PlatformNotificationAsset_notificationId_idx" ON "PlatformNotificationAsset"("notificationId");
CREATE INDEX "PlatformNotificationAsset_status_createdAt_idx" ON "PlatformNotificationAsset"("status", "createdAt");
CREATE INDEX "PlatformNotificationAsset_createdBy_idx" ON "PlatformNotificationAsset"("createdBy");
CREATE INDEX "PlatformNotificationAsset_deletedBy_idx" ON "PlatformNotificationAsset"("deletedBy");
CREATE INDEX "PlatformNotificationAsset_sha256_idx" ON "PlatformNotificationAsset"("sha256");

ALTER TABLE "PlatformNotificationAsset" ADD CONSTRAINT "PlatformNotificationAsset_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "PlatformNotification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlatformNotificationAsset" ADD CONSTRAINT "PlatformNotificationAsset_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlatformNotificationAsset" ADD CONSTRAINT "PlatformNotificationAsset_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
