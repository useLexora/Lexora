ALTER TYPE "AiProviderScope" RENAME VALUE 'SYSTEM' TO 'PLATFORM';

UPDATE "AiProvider"
SET "ownerKey" = 'platform'
WHERE "ownerKey" = 'system';
