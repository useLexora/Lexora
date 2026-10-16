-- AlterTable
ALTER TABLE "ChatSession"
ADD COLUMN "workspaceId" TEXT,
ADD COLUMN "createdBy" TEXT;

-- Backfill personal workspaces for historical chat owners that somehow do not have one.
WITH chat_users AS (
  SELECT DISTINCT "userId"
  FROM "ChatSession"
),
missing_personal_workspace_users AS (
  SELECT "User"."id", "User"."userCode"
  FROM "User"
  INNER JOIN chat_users ON chat_users."userId" = "User"."id"
  WHERE NOT EXISTS (
    SELECT 1
    FROM "WorkspaceMember"
    INNER JOIN "Workspace" ON "Workspace"."id" = "WorkspaceMember"."workspaceId"
    WHERE "WorkspaceMember"."userId" = "User"."id"
      AND "WorkspaceMember"."status" = 'ACTIVE'
      AND "Workspace"."type" = 'PERSONAL'
  )
)
INSERT INTO "Workspace" ("id", "type", "name", "slug", "updatedAt")
SELECT
  CONCAT('personal-', "id"),
  'PERSONAL',
  CONCAT('Personal ', "userCode"),
  CONCAT('personal-', LOWER("userCode")),
  CURRENT_TIMESTAMP
FROM missing_personal_workspace_users;

WITH chat_users AS (
  SELECT DISTINCT "userId"
  FROM "ChatSession"
),
missing_personal_workspace_users AS (
  SELECT "User"."id"
  FROM "User"
  INNER JOIN chat_users ON chat_users."userId" = "User"."id"
  WHERE NOT EXISTS (
    SELECT 1
    FROM "WorkspaceMember"
    INNER JOIN "Workspace" ON "Workspace"."id" = "WorkspaceMember"."workspaceId"
    WHERE "WorkspaceMember"."userId" = "User"."id"
      AND "WorkspaceMember"."status" = 'ACTIVE'
      AND "Workspace"."type" = 'PERSONAL'
  )
)
INSERT INTO "WorkspaceMember" ("workspaceId", "userId", "role", "status", "joinedAt", "updatedAt")
SELECT
  CONCAT('personal-', "id"),
  "id",
  'OWNER',
  'ACTIVE',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM missing_personal_workspace_users;

WITH personal_memberships AS (
  SELECT
    "WorkspaceMember"."userId",
    "WorkspaceMember"."workspaceId",
    ROW_NUMBER() OVER (
      PARTITION BY "WorkspaceMember"."userId"
      ORDER BY "Workspace"."createdAt" ASC, "Workspace"."id" ASC
    ) AS "rank"
  FROM "WorkspaceMember"
  INNER JOIN "Workspace" ON "Workspace"."id" = "WorkspaceMember"."workspaceId"
  WHERE "WorkspaceMember"."status" = 'ACTIVE'
    AND "Workspace"."type" = 'PERSONAL'
)
UPDATE "ChatSession"
SET
  "workspaceId" = personal_memberships."workspaceId",
  "createdBy" = "ChatSession"."userId"
FROM personal_memberships
WHERE "ChatSession"."userId" = personal_memberships."userId"
  AND personal_memberships."rank" = 1;

ALTER TABLE "ChatSession"
ALTER COLUMN "workspaceId" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "ChatSession"
DROP CONSTRAINT "ChatSession_userId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "ChatSession_userId_updatedAt_idx";
DROP INDEX IF EXISTS "ChatSession_userId_origin_updatedAt_idx";

-- AlterTable
ALTER TABLE "ChatSession"
DROP COLUMN "userId";

-- CreateIndex
CREATE INDEX "ChatSession_workspaceId_updatedAt_idx" ON "ChatSession"("workspaceId", "updatedAt");
CREATE INDEX "ChatSession_workspaceId_origin_updatedAt_idx" ON "ChatSession"("workspaceId", "origin", "updatedAt");
CREATE INDEX "ChatSession_createdBy_updatedAt_idx" ON "ChatSession"("createdBy", "updatedAt");

-- AddForeignKey
ALTER TABLE "ChatSession"
ADD CONSTRAINT "ChatSession_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatSession"
ADD CONSTRAINT "ChatSession_createdBy_fkey"
FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
