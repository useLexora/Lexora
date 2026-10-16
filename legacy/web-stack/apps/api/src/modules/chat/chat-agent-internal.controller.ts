import type { AgentChatAttachmentContent, ChatGenerationBootstrap } from '@haohaoxue/lexora-contracts'
import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common'
import { Public } from '../../decorators/public.decorator'
import { ChatAssetsService } from './chat-assets.service'
import { ChatSessionsService } from './chat-sessions.service'

@Controller('internal/chat')
export class ChatAgentInternalController {
  constructor(
    private readonly chatSessionsService: ChatSessionsService,
    private readonly chatAssetsService: ChatAssetsService,
  ) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('generations/:generationId/bootstrap')
  async getChatGenerationBootstrap(
    @Param('generationId') generationId: string,
  ): Promise<ChatGenerationBootstrap> {
    return this.chatSessionsService.getAgentGenerationBootstrap({
      generationId,
    })
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('generations/:generationId/assets/:assetId/content')
  async getChatGenerationAssetContent(
    @Param('generationId') generationId: string,
    @Param('assetId') assetId: string,
  ): Promise<AgentChatAttachmentContent> {
    return this.chatAssetsService.getGenerationAssetContent({
      generationId,
      assetId,
    })
  }
}
