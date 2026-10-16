import type {
  AuthProviderName,
  DeleteCurrentUserResponse,
  RequestBindEmailCodeResponse,
  SessionUser,
  StartOauthBindingResponse,
  UpdateCurrentUserAvatarResponse,
  UserPermissionList,
  UserSettings,
  UserSettingsPreferences,
} from '@haohaoxue/lexora-contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthUserContext } from '../auth/auth.interface'
import { PERMISSIONS } from '@haohaoxue/lexora-contracts'
import { normalizeAuthProviderName } from '@haohaoxue/lexora-shared'
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common'
import { CurrentUser } from '../../decorators/current-user.decorator'
import { Public } from '../../decorators/public.decorator'
import { RequirePermissions } from '../../decorators/require-permissions.decorator'
import { readAcceptLanguageHeader } from '../../utils/language'
import { getRequestFile } from '../../utils/request-file'
import { AuthSessionsService } from '../auth/auth-sessions.service'
import { AuthService } from '../auth/auth.service'
import { UserAvatarsService } from './user-avatars.service'
import { UserEmailBindingsService } from './user-email-bindings.service'
import {
  ConfirmBindEmailDto,
  DeleteCurrentUserDto,
  RequestBindEmailCodeDto,
  StartOauthBindingDto,
  UpdateCurrentUserProfileDto,
  UpdateUserPreferencesDto,
} from './users.dto'
import { UsersService } from './users.service'

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly authSessionsService: AuthSessionsService,
    private readonly userAvatarsService: UserAvatarsService,
    private readonly userEmailBindingsService: UserEmailBindingsService,
  ) {}

  @RequirePermissions(PERMISSIONS.USER_READ_SELF)
  @Get('me')
  async getCurrentUser(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<SessionUser> {
    return this.usersService.getCurrentUser(authUser.id)
  }

  @RequirePermissions(PERMISSIONS.USER_READ_SELF)
  @Get('me/settings')
  async getCurrentUserSettings(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<UserSettings> {
    return this.usersService.getCurrentUserSettings(authUser.id)
  }

  @RequirePermissions(PERMISSIONS.USER_READ_SELF)
  @Get('me/permissions')
  async getCurrentUserPermissions(
    @CurrentUser() authUser: AuthUserContext,
  ): Promise<UserPermissionList> {
    return {
      permissions: await this.usersService.getCurrentUserPermissions(authUser.id),
    }
  }

  @RequirePermissions(PERMISSIONS.USER_UPDATE_SELF)
  @Patch('me/profile')
  async updateCurrentUserProfile(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: UpdateCurrentUserProfileDto,
  ): Promise<SessionUser> {
    return this.usersService.updateCurrentUserProfile(authUser, payload.displayName)
  }

  @RequirePermissions(PERMISSIONS.USER_UPDATE_SELF)
  @Put('me/avatar')
  async updateCurrentUserAvatar(
    @CurrentUser() authUser: AuthUserContext,
    @Req() request: FastifyRequest,
  ): Promise<UpdateCurrentUserAvatarResponse> {
    const file = await getRequestFile(request)

    if (!file) {
      throw new BadRequestException('请选择头像文件')
    }

    return this.userAvatarsService.updateCurrentUserAvatar(authUser, {
      fileName: file.filename,
      mimeType: file.mimetype,
      buffer: await file.toBuffer(),
    })
  }

  @RequirePermissions(PERMISSIONS.USER_UPDATE_SELF)
  @Post('me/email/request-bind-code')
  async requestBindEmailCode(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: RequestBindEmailCodeDto,
    @Req() request: FastifyRequest,
  ): Promise<RequestBindEmailCodeResponse> {
    return this.userEmailBindingsService.requestBindEmailCode(
      authUser.id,
      payload.email,
      readAcceptLanguageHeader(request.headers['accept-language']),
    )
  }

  @RequirePermissions(PERMISSIONS.USER_UPDATE_SELF)
  @Post('me/email/confirm-bind')
  async confirmBindEmail(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: ConfirmBindEmailDto,
  ): Promise<SessionUser> {
    await this.userEmailBindingsService.confirmBindEmail(authUser.id, payload)
    return this.usersService.getCurrentUser(authUser.id)
  }

  @RequirePermissions(PERMISSIONS.USER_UPDATE_SELF)
  @Post('me/oauth/:provider/start-bind')
  async startOauthBinding(
    @CurrentUser() authUser: AuthUserContext,
    @Param('provider') provider: string,
    @Body() payload: StartOauthBindingDto,
    @Req() request: FastifyRequest,
  ): Promise<StartOauthBindingResponse> {
    return {
      authorizeUrl: await this.authService.buildOAuthBindingAuthorizationUrl(
        authUser.id,
        this.parseProvider(provider),
        request,
        payload.redirectPath,
      ),
    }
  }

  @RequirePermissions(PERMISSIONS.USER_UPDATE_SELF)
  @Delete('me/oauth/:provider')
  async disconnectOauthBinding(
    @CurrentUser() authUser: AuthUserContext,
    @Param('provider') provider: string,
  ): Promise<SessionUser> {
    await this.authService.disconnectOauthBinding(authUser.id, this.parseProvider(provider))
    return this.usersService.getCurrentUser(authUser.id)
  }

  @RequirePermissions(PERMISSIONS.USER_DELETE_SELF)
  @Post('me/delete')
  async deleteCurrentUser(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: DeleteCurrentUserDto,
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<DeleteCurrentUserResponse> {
    await this.usersService.deleteCurrentUser(authUser, payload)
    response.header('set-cookie', this.authSessionsService.buildLogoutCookieHeader())
    return { deleted: true }
  }

  @RequirePermissions(PERMISSIONS.USER_UPDATE_SELF)
  @Patch('me/preferences')
  async updatePreferences(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: UpdateUserPreferencesDto,
  ): Promise<UserSettingsPreferences> {
    return this.usersService.updatePreferences(authUser.id, payload)
  }

  @Public()
  @Get('avatar/:id')
  async getUserAvatar(
    @Param('id') userId: string,
    @Res() response: FastifyReply,
  ): Promise<FastifyReply> {
    const avatar = await this.userAvatarsService.getUserAvatar(userId)

    response.header('cache-control', 'public, max-age=300')
    response.header('content-type', avatar.contentType)

    if (avatar.contentLength !== null) {
      response.header('content-length', String(avatar.contentLength))
    }

    return response.send(avatar.body)
  }

  private parseProvider(provider: string): AuthProviderName {
    const normalizedProvider = normalizeAuthProviderName(provider)

    if (normalizedProvider) {
      return normalizedProvider
    }

    throw new BadRequestException(`Unsupported provider: ${provider}`)
  }
}
