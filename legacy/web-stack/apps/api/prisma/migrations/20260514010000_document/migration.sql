-- CreateEnum
CREATE TYPE "DocumentPageWidthMode" AS ENUM ('NARROW', 'DEFAULT', 'FULL');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "pageWidthMode" "DocumentPageWidthMode" NOT NULL DEFAULT 'DEFAULT';
