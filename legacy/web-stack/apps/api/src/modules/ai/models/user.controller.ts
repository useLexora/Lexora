import type {
  AiAvailableModelOption,
  AiAvailableProviderOption,
  AiDefaultModelPolicyItem,
  AiProvider,
  AiProviderCredential,
  AiProviderModelItem,
  AiProviderModels,
} from '@haohaoxue/lexora-contracts'
import type { AuthUserContext } from '../../auth/auth.interface'
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common'
import { CurrentUser } from '../../../decorators/current-user.decorator'
import {
  CreateAiProviderDto,
  UpdateAiProviderDto,
  UpdateDefaultModelDto,
  UpsertAiProviderModelDto,
  UpsertAiProviderModelsDto,
} from '../ai.dto'
import { AiDefaultModelsService } from './defaults.service'
import { AiProviderModelsService } from './provider-models.service'
import { AiProvidersService } from './providers.service'

@Controller('users/me/ai')
export class AiUserController {
  constructor(
    private readonly providersService: AiProvidersService,
    private readonly providerModelsService: AiProviderModelsService,
    private readonly defaultModelsService: AiDefaultModelsService,
  ) {}

  @Get('providers')
  getProviders(@CurrentUser() authUser: AuthUserContext): Promise<AiProvider[]> {
    return this.providersService.getUserProviders(authUser.id)
  }

  @Post('providers')
  createProvider(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: CreateAiProviderDto,
  ): Promise<AiProvider> {
    return this.providersService.createUserProvider(authUser.id, payload)
  }

  @Patch('providers/:providerId')
  updateProvider(
    @CurrentUser() authUser: AuthUserContext,
    @Param('providerId') providerId: string,
    @Body() payload: UpdateAiProviderDto,
  ): Promise<AiProvider> {
    return this.providersService.updateUserProvider(authUser.id, providerId, payload)
  }

  @Get('providers/:providerId/credential')
  getProviderCredential(
    @CurrentUser() authUser: AuthUserContext,
    @Param('providerId') providerId: string,
  ): Promise<AiProviderCredential> {
    return this.providersService.getUserProviderCredential(authUser.id, providerId)
  }

  @Delete('providers/:providerId')
  async deleteProvider(
    @CurrentUser() authUser: AuthUserContext,
    @Param('providerId') providerId: string,
  ): Promise<void> {
    await this.providersService.deleteUserProvider(authUser.id, providerId)
  }

  @Get('providers/:providerId/models')
  getModels(
    @CurrentUser() authUser: AuthUserContext,
    @Param('providerId') providerId: string,
  ): Promise<AiProviderModels> {
    return this.providerModelsService.getUserModels(authUser.id, providerId)
  }

  @Post('providers/:providerId/models/discover')
  discoverModels(
    @CurrentUser() authUser: AuthUserContext,
    @Param('providerId') providerId: string,
  ): Promise<AiProviderModels> {
    return this.providerModelsService.discoverUserProviderModels(authUser.id, providerId)
  }

  @Post('providers/:providerId/models')
  upsertModel(
    @CurrentUser() authUser: AuthUserContext,
    @Param('providerId') providerId: string,
    @Body() payload: UpsertAiProviderModelDto,
  ): Promise<AiProviderModelItem> {
    return this.providerModelsService.upsertUserModel(authUser.id, providerId, payload)
  }

  @Put('providers/:providerId/models')
  upsertModels(
    @CurrentUser() authUser: AuthUserContext,
    @Param('providerId') providerId: string,
    @Body() payload: UpsertAiProviderModelsDto,
  ): Promise<AiProviderModels> {
    return this.providerModelsService.upsertUserModels(authUser.id, providerId, payload)
  }

  @Get('models/available')
  getAvailableModels(
    @CurrentUser() authUser: AuthUserContext,
    @Query('intentKey') intentKey: string,
  ): Promise<AiAvailableModelOption[]> {
    return this.defaultModelsService.getAvailableModels(authUser.id, intentKey as never)
  }

  @Get('models/available/providers')
  getAvailableProviders(
    @CurrentUser() authUser: AuthUserContext,
    @Query('intentKey') intentKey: string,
    @Query('scope') scope: string,
  ): Promise<AiAvailableProviderOption[]> {
    return this.defaultModelsService.getAvailableProviders(authUser.id, intentKey as never, scope as never)
  }

  @Get('models/available/providers/:providerId/models')
  getAvailableProviderModels(
    @CurrentUser() authUser: AuthUserContext,
    @Param('providerId') providerId: string,
    @Query('intentKey') intentKey: string,
  ): Promise<AiAvailableModelOption[]> {
    return this.defaultModelsService.getAvailableProviderModels(authUser.id, intentKey as never, providerId)
  }

  @Get('default-models')
  getDefaultModels(@CurrentUser() authUser: AuthUserContext): Promise<AiDefaultModelPolicyItem[]> {
    return this.defaultModelsService.getDefaultModels(authUser.id)
  }

  @Put('default-models/:intentKey')
  updateDefaultModel(
    @CurrentUser() authUser: AuthUserContext,
    @Param('intentKey') intentKey: string,
    @Body() payload: UpdateDefaultModelDto,
  ): Promise<AiDefaultModelPolicyItem> {
    return this.defaultModelsService.updateDefaultModel(authUser.id, intentKey as never, payload)
  }
}
