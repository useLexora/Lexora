CREATE TYPE "NotificationSourceKind" AS ENUM ('PLATFORM', 'DOCUMENT_COLLABORATION_USER_INVITE');
CREATE TYPE "PlatformNotificationStatus" AS ENUM ('DRAFT', 'PUBLISHED');

CREATE TABLE "PlatformNotification" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "status" "PlatformNotificationStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "PlatformNotification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationReadReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceKind" "NotificationSourceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationReadReceipt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformNotification_status_publishedAt_idx" ON "PlatformNotification"("status", "publishedAt");
CREATE INDEX "PlatformNotification_updatedAt_idx" ON "PlatformNotification"("updatedAt");
CREATE INDEX "PlatformNotification_createdBy_idx" ON "PlatformNotification"("createdBy");
CREATE INDEX "PlatformNotification_updatedBy_idx" ON "PlatformNotification"("updatedBy");
CREATE INDEX "PlatformNotification_deletedBy_idx" ON "PlatformNotification"("deletedBy");
CREATE UNIQUE INDEX "NotificationReadReceipt_userId_sourceKind_sourceId_key" ON "NotificationReadReceipt"("userId", "sourceKind", "sourceId");
CREATE INDEX "NotificationReadReceipt_userId_sourceKind_readAt_idx" ON "NotificationReadReceipt"("userId", "sourceKind", "readAt");

ALTER TABLE "PlatformNotification" ADD CONSTRAINT "PlatformNotification_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlatformNotification" ADD CONSTRAINT "PlatformNotification_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlatformNotification" ADD CONSTRAINT "PlatformNotification_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationReadReceipt" ADD CONSTRAINT "NotificationReadReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
