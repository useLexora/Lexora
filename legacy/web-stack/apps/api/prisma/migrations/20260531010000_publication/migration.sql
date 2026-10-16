DROP TABLE IF EXISTS "DocumentPublication";
DROP TYPE IF EXISTS "DocumentPublicationStatus";
DROP TYPE IF EXISTS "DocumentPublicationTheme";

CREATE TYPE "DocumentSinglePublicationState" AS ENUM ('INHERIT', 'ENABLED', 'DISABLED');
CREATE TYPE "DocumentPublicationSiteStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE "DocumentPublicationEntryStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'REMOVED');
CREATE TYPE "DocumentPublicationSiteTheme" AS ENUM ('DEFAULT');
CREATE TYPE "DocumentPublicationSiteHomeMode" AS ENUM ('LANDING', 'DOCUMENT');
CREATE TYPE "DocumentPublicationPageScope" AS ENUM ('PAGE', 'DESCENDANTS');
CREATE TYPE "DocumentPublicationNavItemType" AS ENUM ('INTERNAL', 'EXTERNAL');
CREATE TYPE "DocumentPublicationNavItemInternalTarget" AS ENUM ('HOME', 'SECTION', 'PAGE');
CREATE TYPE "DocumentPublicationNavItemExternalTarget" AS ENUM ('SELF', 'BLANK');

CREATE TABLE "DocumentSinglePublicationSetting" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "state" "DocumentSinglePublicationState" NOT NULL DEFAULT 'INHERIT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DocumentSinglePublicationSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentPublicationSite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "theme" "DocumentPublicationSiteTheme" NOT NULL DEFAULT 'DEFAULT',
    "homeMode" "DocumentPublicationSiteHomeMode" NOT NULL DEFAULT 'LANDING',
    "homeDocumentId" TEXT,
    "homeConfig" JSONB,
    "allowIndexing" BOOLEAN NOT NULL DEFAULT false,
    "status" "DocumentPublicationSiteStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DocumentPublicationSite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentPublicationSection" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "collapsed" BOOLEAN NOT NULL DEFAULT false,
    "status" "DocumentPublicationEntryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DocumentPublicationSection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentPublicationPage" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope" "DocumentPublicationPageScope" NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" "DocumentPublicationEntryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DocumentPublicationPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentPublicationNavItem" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "type" "DocumentPublicationNavItemType" NOT NULL,
    "label" TEXT NOT NULL,
    "target" "DocumentPublicationNavItemInternalTarget",
    "targetId" TEXT,
    "url" TEXT,
    "openTarget" "DocumentPublicationNavItemExternalTarget",
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" "DocumentPublicationEntryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DocumentPublicationNavItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentSinglePublicationSetting_documentId_key" ON "DocumentSinglePublicationSetting"("documentId");
CREATE INDEX "DocumentSinglePublicationSetting_state_updatedAt_idx" ON "DocumentSinglePublicationSetting"("state", "updatedAt");
CREATE UNIQUE INDEX "DocumentPublicationSite_workspaceId_key" ON "DocumentPublicationSite"("workspaceId");
CREATE INDEX "DocumentPublicationSite_homeDocumentId_idx" ON "DocumentPublicationSite"("homeDocumentId");
CREATE INDEX "DocumentPublicationSite_status_updatedAt_idx" ON "DocumentPublicationSite"("status", "updatedAt");
CREATE INDEX "DocumentPublicationSection_siteId_status_order_idx" ON "DocumentPublicationSection"("siteId", "status", "order");
CREATE UNIQUE INDEX "DocumentPublicationPage_siteId_documentId_key" ON "DocumentPublicationPage"("siteId", "documentId");
CREATE INDEX "DocumentPublicationPage_sectionId_status_order_idx" ON "DocumentPublicationPage"("sectionId", "status", "order");
CREATE INDEX "DocumentPublicationPage_documentId_status_idx" ON "DocumentPublicationPage"("documentId", "status");
CREATE INDEX "DocumentPublicationNavItem_siteId_status_order_idx" ON "DocumentPublicationNavItem"("siteId", "status", "order");
CREATE INDEX "DocumentPublicationNavItem_type_target_targetId_idx" ON "DocumentPublicationNavItem"("type", "target", "targetId");

ALTER TABLE "DocumentSinglePublicationSetting" ADD CONSTRAINT "DocumentSinglePublicationSetting_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentSinglePublicationSetting" ADD CONSTRAINT "DocumentSinglePublicationSetting_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentSinglePublicationSetting" ADD CONSTRAINT "DocumentSinglePublicationSetting_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationSite" ADD CONSTRAINT "DocumentPublicationSite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationSite" ADD CONSTRAINT "DocumentPublicationSite_homeDocumentId_fkey" FOREIGN KEY ("homeDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationSite" ADD CONSTRAINT "DocumentPublicationSite_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationSite" ADD CONSTRAINT "DocumentPublicationSite_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationSection" ADD CONSTRAINT "DocumentPublicationSection_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "DocumentPublicationSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationSection" ADD CONSTRAINT "DocumentPublicationSection_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationSection" ADD CONSTRAINT "DocumentPublicationSection_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationPage" ADD CONSTRAINT "DocumentPublicationPage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "DocumentPublicationSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationPage" ADD CONSTRAINT "DocumentPublicationPage_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "DocumentPublicationSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationPage" ADD CONSTRAINT "DocumentPublicationPage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationPage" ADD CONSTRAINT "DocumentPublicationPage_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationPage" ADD CONSTRAINT "DocumentPublicationPage_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationNavItem" ADD CONSTRAINT "DocumentPublicationNavItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "DocumentPublicationSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationNavItem" ADD CONSTRAINT "DocumentPublicationNavItem_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentPublicationNavItem" ADD CONSTRAINT "DocumentPublicationNavItem_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
