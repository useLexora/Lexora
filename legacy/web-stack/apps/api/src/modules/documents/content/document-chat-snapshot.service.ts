import type { TiptapJsonContent } from '@haohaoxue/lexora-contracts'
import { Injectable } from '@nestjs/common'
import { DocumentAccessService } from '../core/access.service'
import { DocumentContentService } from './content.service'
import { createDocumentMarkdownSnapshot } from './document-markdown-snapshot'

export interface DocumentChatMarkdownSnapshot {
  content: string
  size: number
}

@Injectable()
export class DocumentChatSnapshotService {
  constructor(
    private readonly documentAccessService: DocumentAccessService,
    private readonly documentContentService: DocumentContentService,
  ) {}

  async assertReadableDocument(input: {
    userId: string
    documentId: string
  }): Promise<void> {
    await this.documentAccessService.assertCanReadDocument(input.userId, input.documentId)
  }

  async createFullDocumentMarkdownSnapshot(input: {
    userId: string
    documentId: string
  }): Promise<DocumentChatMarkdownSnapshot> {
    const current = await this.documentContentService.getDocumentCurrent(input.userId, input.documentId)
    return createDocumentMarkdownSnapshot(current.currentProjection.body as TiptapJsonContent)
  }
}
