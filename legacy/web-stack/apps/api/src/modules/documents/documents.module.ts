import { Module } from '@nestjs/common'
import { RedisModule } from '../../infrastructure/redis/redis.module'
import { StorageModule } from '../../infrastructure/storage/storage.module'

// asset
import { DocumentAssetController } from './asset/asset.controller'
import { DocumentAssetsService } from './asset/asset.service'
// content
import { DocumentContentController } from './content/content.controller'
import { DocumentContentService } from './content/content.service'

import { DocumentChatSnapshotService } from './content/document-chat-snapshot.service'

// core (cross-subdomain)
import { DocumentAccessService } from './core/access.service'

// operations
import { DocumentOperationQueueService } from './operations/operation-queue.service'
import { DocumentOperationProcessor } from './operations/operation.processor'
import { DocumentOperationsController } from './operations/operations.controller'
import { DocumentOperationsService } from './operations/operations.service'

// publication
import { DocumentPublicationAccessService } from './publication/publication-access.service'
import { DocumentPublicationsController } from './publication/publications.controller'
import { DocumentPublicationsService } from './publication/publications.service'

// trash
import { DocumentTrashController } from './trash/trash.controller'
import { DocumentTrashService } from './trash/trash.service'

// tree
import { DocumentTreeController } from './tree/tree.controller'
import { DocumentsService } from './tree/tree.service'

@Module({
  imports: [StorageModule, RedisModule],
  controllers: [
    // 入站：自有文档
    DocumentTreeController,
    DocumentContentController,
    DocumentTrashController,
    DocumentAssetController,
    DocumentPublicationsController,
    DocumentOperationsController,
  ],
  providers: [
    DocumentAccessService,
    DocumentsService,
    DocumentContentService,
    DocumentChatSnapshotService,
    DocumentAssetsService,
    DocumentPublicationAccessService,
    DocumentPublicationsService,
    DocumentTrashService,
    DocumentOperationQueueService,
    DocumentOperationsService,
    DocumentOperationProcessor,
  ],
  exports: [
    DocumentAccessService,
    DocumentChatSnapshotService,
    DocumentContentService,
    DocumentsService,
    DocumentPublicationAccessService,
    DocumentPublicationsService,
  ],
})
export class DocumentsModule {}
