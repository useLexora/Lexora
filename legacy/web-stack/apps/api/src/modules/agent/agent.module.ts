import { Module } from '@nestjs/common'
import { RedisModule } from '../../infrastructure/redis/redis.module'
import { AiModule } from '../ai/ai.module'
import { AgentCommandPublisherService } from './agent-command-publisher.service'
import { AgentGenerationEventsService } from './agent-events.service'
import { AgentMemoryDocumentsController } from './agent-memory-documents.controller'
import { AgentMemoryDocumentsService } from './agent-memory-documents.service'
import { AgentMemoryIndexingService } from './agent-memory-indexing.service'
import { AgentMemoryInternalController } from './agent-memory-internal.controller'
import { AgentMemoryOperationsService } from './agent-memory-operations.service'
import { AgentMemoryService } from './agent-memory.service'
import { AgentProfilesController } from './agent-profiles.controller'
import { AgentProfilesService } from './agent-profiles.service'
import { AgentRuntimeCleanupTasksService } from './agent-runtime-cleanup-tasks.service'
import { AgentSkillsInternalController } from './agent-skills-internal.controller'
import { AgentSkillsController } from './agent-skills.controller'
import { AgentSkillsService } from './agent-skills.service'

@Module({
  imports: [RedisModule, AiModule],
  controllers: [AgentMemoryDocumentsController, AgentMemoryInternalController, AgentProfilesController, AgentSkillsController, AgentSkillsInternalController],
  providers: [
    AgentCommandPublisherService,
    AgentGenerationEventsService,
    AgentMemoryDocumentsService,
    AgentMemoryIndexingService,
    AgentMemoryOperationsService,
    AgentMemoryService,
    AgentProfilesService,
    AgentRuntimeCleanupTasksService,
    AgentSkillsService,
  ],
  exports: [
    AgentCommandPublisherService,
    AgentGenerationEventsService,
    AgentMemoryDocumentsService,
    AgentMemoryIndexingService,
    AgentMemoryOperationsService,
    AgentMemoryService,
    AgentProfilesService,
    AgentRuntimeCleanupTasksService,
    AgentSkillsService,
  ],
})
export class AgentModule {}
