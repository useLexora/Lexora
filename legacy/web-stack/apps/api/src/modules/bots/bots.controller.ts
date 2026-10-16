import type {
  SubmitWeixinBotVerifyCodeRequest,
  WeixinBotBindingStatus,
  WeixinBotLoginStartResponse,
  WeixinBotLoginStatusResponse,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../auth/auth.interface'
import {
  SubmitWeixinBotVerifyCodeRequestSchema,
} from '@haohaoxue/lexora-contracts'
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { ZodValidationPipe } from '../../pipes/zod-validation.pipe'
import { BotsService } from './bots.service'

@Controller('bot-accounts')
export class BotsController {
  constructor(private readonly botsService: BotsService) {}

  @Get('weixin')
  async getWeixinStatus(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<WeixinBotBindingStatus> {
    return this.botsService.getWeixinStatus(authUser.id)
  }

  @Post('weixin/login')
  async startWeixinLogin(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<WeixinBotLoginStartResponse> {
    return this.botsService.startWeixinLogin(authUser.id)
  }

  @Get('weixin/login/:loginId')
  async getWeixinLoginStatus(
    @CurrentUser() authUser: AuthUserContext,
    @Param('loginId') loginId: string,
  ): Promise<WeixinBotLoginStatusResponse> {
    return this.botsService.getWeixinLoginStatus(authUser.id, loginId)
  }

  @Post('weixin/login/:loginId/verify-code')
  async submitWeixinVerifyCode(
    @CurrentUser() authUser: AuthUserContext,
    @Param('loginId') loginId: string,
    @Body(new ZodValidationPipe(SubmitWeixinBotVerifyCodeRequestSchema)) payload: SubmitWeixinBotVerifyCodeRequest,
  ): Promise<WeixinBotLoginStatusResponse> {
    return this.botsService.submitWeixinVerifyCode(authUser.id, loginId, payload.verifyCode)
  }

  @Post('weixin/start')
  async startWeixinBot(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<WeixinBotBindingStatus> {
    return this.botsService.startWeixinBot(authUser.id)
  }

  @Post('weixin/stop')
  async stopWeixinBot(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<WeixinBotBindingStatus> {
    return this.botsService.stopWeixinBot(authUser.id)
  }

  @Delete('weixin')
  async disconnectWeixin(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<null> {
    return this.botsService.disconnectWeixin(authUser.id)
  }
}
