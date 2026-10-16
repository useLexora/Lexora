import { Module } from '@nestjs/common'
import { ChatModule } from '../chat/chat.module'
import { WorkspacesModule } from '../workspaces/workspaces.module'
import { BotCredentialsService } from './bot-credentials.service'
import { BotsController } from './bots.controller'
import { BotsService } from './bots.service'
import { WeixinBotRuntimeService } from './weixin-bot-runtime.service'
import { WeixinOpenClawApiService } from './weixin-openclaw-api.service'

@Module({
  imports: [ChatModule, WorkspacesModule],
  controllers: [BotsController],
  providers: [
    BotCredentialsService,
    BotsService,
    WeixinBotRuntimeService,
    WeixinOpenClawApiService,
  ],
})
export class BotsModule {}
