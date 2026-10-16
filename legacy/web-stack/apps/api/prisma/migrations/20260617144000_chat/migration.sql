-- AlterEnum
ALTER TYPE "ChatSessionRunStatus" ADD VALUE 'REQUIRES_ACTION';

-- AlterEnum
ALTER TYPE "ChatMessageGenerationStatus" ADD VALUE 'REQUIRES_ACTION';

-- AlterEnum
ALTER TYPE "ChatSessionEventType" ADD VALUE 'RUN_REQUIRES_ACTION';
