import type {
  AuthProviderName,
  LogoutResponse,
  RegistrationInviteGrantResponse,
  RequestEmailVerificationResponse,
  StartOAuthLoginResponse,
  TokenExchangeResponse,
} from '@haohaoxue/lexora-contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthUserContext, TokenExchangeResult } from './auth.interface'
import { OAUTH_REDIRECT_ERROR_CODE } from '@haohaoxue/lexora-contracts'
import { normalizeAuthProviderName } from '@haohaoxue/lexora-shared'
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { Public } from '../../decorators/public.decorator'
import { resolveRequestLanguage } from '../../utils/language'
import { AuthRegistrationsService } from './auth-registrations.service'
import { AuthSessionsService } from './auth-sessions.service'
import {
  ChangePasswordDto,
  CreateRegistrationInviteGrantDto,
  ExchangeCodeDto,
  PasswordLoginDto,
  PasswordRegisterDto,
  RequestEmailVerificationDto,
  StartOAuthLoginDto,
} from './auth.dto'
import { AuthService } from './auth.service'
import {
  RegistrationInviteGrantsService,
  RegistrationInviteRequiredException,
} from './registration-invite-grants.service'

@Controller('auth')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly authSessionsService: AuthSessionsService,
    private readonly authRegistrationsService: AuthRegistrationsService,
    private readonly registrationInviteGrantsService: RegistrationInviteGrantsService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('registration-invite/grants')
  async createRegistrationInviteGrant(
    @Body() payload: CreateRegistrationInviteGrantDto,
  ): Promise<RegistrationInviteGrantResponse> {
    const result = await this.registrationInviteGrantsService.createGrant(payload)

    return {
      grantToken: result.grantToken,
      expiresAt: result.expiresAt.toISOString(),
    }
  }

  @Public()
  @Post('oauth/:provider/start')
  async startOAuthLogin(
    @Param('provider') provider: string,
    @Body() payload: StartOAuthLoginDto,
    @Req() request: FastifyRequest,
  ): Promise<StartOAuthLoginResponse> {
    const normalizedProvider = this.parseProvider(provider)

    return {
      authorizeUrl: await this.authService.buildOAuthAuthorizationUrl(normalizedProvider, request, {
        registrationInviteGrantToken: payload.registrationInviteGrantToken,
      }),
    }
  }

  @Public()
  @Get('oauth/:provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply,
  ): Promise<FastifyReply> {
    const normalizedProvider = this.parseProvider(provider)
    let redirectUrl: string

    try {
      redirectUrl = await this.authService.handleOAuthCallback(normalizedProvider, request)
    }
    catch (error) {
      redirectUrl = this.authService.buildOAuthFailureRedirect(
        normalizedProvider,
        request,
        this.resolveOAuthRedirectErrorCode(error),
      )
    }

    return response.redirect(redirectUrl, 302)
  }

  @Public()
  @Post('exchange-code')
  async exchangeCode(
    @Body() payload: ExchangeCodeDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<TokenExchangeResponse> {
    const result = await this.authSessionsService.exchangeCodeForTokens(payload.code, request)
    return this.applyTokenExchange(response, result)
  }

  @Public()
  @Post('login/password')
  async loginWithPassword(
    @Body() payload: PasswordLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<TokenExchangeResponse> {
    const result = await this.authService.loginWithPassword(payload.email, payload.password, request)
    return this.applyTokenExchange(response, result)
  }

  @Public()
  @Post('verify-email/request')
  async requestEmailVerification(
    @Body() payload: RequestEmailVerificationDto,
    @Req() request: FastifyRequest,
  ): Promise<RequestEmailVerificationResponse> {
    await this.authRegistrationsService.requestEmailVerification(
      payload.email,
      payload.registrationInviteGrantToken,
      resolveRequestLanguage(request),
    )

    return {
      requested: true,
    }
  }

  @Public()
  @Post('register/password')
  async registerWithPassword(
    @Body() payload: PasswordRegisterDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<TokenExchangeResponse> {
    const result = await this.authRegistrationsService.registerWithPassword(
      payload.email,
      payload.code,
      payload.displayName,
      payload.password,
      request,
      payload.registrationInviteGrantToken,
    )
    return this.applyTokenExchange(response, result)
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<TokenExchangeResponse> {
    try {
      const result = await this.authSessionsService.refreshTokens(request)
      return this.applyTokenExchange(response, result)
    }
    catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.UNAUTHORIZED) {
        response.header('set-cookie', this.authSessionsService.buildLogoutCookieHeader())
      }
      throw error
    }
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<LogoutResponse> {
    const result = await this.authSessionsService.logout(request)

    response.header('set-cookie', result.clearCookie)

    return { loggedOut: true }
  }

  @Post('password/change')
  async changePassword(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: ChangePasswordDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<TokenExchangeResponse> {
    const result = await this.authService.changePassword(
      authUser.id,
      payload.currentPassword,
      payload.newPassword,
      request,
    )
    return this.applyTokenExchange(response, result)
  }

  private applyTokenExchange(
    response: FastifyReply,
    result: TokenExchangeResult,
  ): TokenExchangeResponse {
    response.header('set-cookie', result.refreshTokenCookie)
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    }
  }

  private parseProvider(provider: string): AuthProviderName {
    const normalizedProvider = normalizeAuthProviderName(provider)

    if (normalizedProvider) {
      return normalizedProvider
    }

    throw new BadRequestException(`Unsupported provider: ${provider}`)
  }

  private resolveOAuthRedirectErrorCode(
    error: unknown,
  ): (typeof OAUTH_REDIRECT_ERROR_CODE)[keyof typeof OAUTH_REDIRECT_ERROR_CODE] {
    if (error instanceof RegistrationInviteRequiredException) {
      return error.oauthRedirectErrorCode
    }

    return OAUTH_REDIRECT_ERROR_CODE.CALLBACK_FAILED
  }
}
