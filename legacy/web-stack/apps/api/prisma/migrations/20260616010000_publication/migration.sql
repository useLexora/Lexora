ALTER TYPE "DocumentPublicationNavItemType" ADD VALUE IF NOT EXISTS 'GROUP';

ALTER TABLE "DocumentPublicationNavItem"
  ADD COLUMN "parentId" TEXT,
  ADD COLUMN "icon" TEXT,
  ALTER COLUMN "label" DROP NOT NULL;

ALTER TABLE "DocumentPublicationNavItem"
  ADD CONSTRAINT "DocumentPublicationNavItem_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "DocumentPublicationNavItem"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "DocumentPublicationNavItem_siteId_parentId_status_order_idx"
  ON "DocumentPublicationNavItem"("siteId", "parentId", "status", "order");
