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
import { PERMISSIONS } from '@haohaoxue/lexora-contracts'
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common'
import { CurrentUser } from '../../../decorators/current-user.decorator'
import { RequirePermissions } from '../../../decorators/require-permissions.decorator'
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

@Controller('system-admin/ai')
export class AiSystemAdminController {
  constructor(
    private readonly providersService: AiProvidersService,
    private readonly providerModelsService: AiProviderModelsService,
    private readonly defaultModelsService: AiDefaultModelsService,
  ) {}

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_READ)
  @Get('providers')
  getProviders(): Promise<AiProvider[]> {
    return this.providersService.getPlatformProviders()
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_READ)
  @Get('platform-embedding-model')
  getPlatformEmbeddingModel(): Promise<AiDefaultModelPolicyItem> {
    return this.defaultModelsService.getPlatformEmbeddingModel()
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_READ)
  @Get('platform-embedding-model/available/providers')
  getPlatformEmbeddingAvailableProviders(): Promise<AiAvailableProviderOption[]> {
    return this.defaultModelsService.getPlatformEmbeddingAvailableProviders()
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_READ)
  @Get('platform-embedding-model/available/providers/:providerId/models')
  getPlatformEmbeddingAvailableProviderModels(
    @Param('providerId') providerId: string,
  ): Promise<AiAvailableModelOption[]> {
    return this.defaultModelsService.getPlatformEmbeddingAvailableProviderModels(providerId)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE)
  @Put('platform-embedding-model')
  updatePlatformEmbeddingModel(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: UpdateDefaultModelDto,
  ): Promise<AiDefaultModelPolicyItem> {
    return this.defaultModelsService.updatePlatformEmbeddingModel(authUser.id, payload)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE)
  @Post('providers')
  createProvider(
    @CurrentUser() authUser: AuthUserContext,
    @Body() payload: CreateAiProviderDto,
  ): Promise<AiProvider> {
    return this.providersService.createPlatformProvider(authUser.id, payload)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE)
  @Patch('providers/:providerId')
  updateProvider(
    @CurrentUser() authUser: AuthUserContext,
    @Param('providerId') providerId: string,
    @Body() payload: UpdateAiProviderDto,
  ): Promise<AiProvider> {
    return this.providersService.updatePlatformProvider(authUser.id, providerId, payload)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE)
  @Get('providers/:providerId/credential')
  getProviderCredential(@Param('providerId') providerId: string): Promise<AiProviderCredential> {
    return this.providersService.getPlatformProviderCredential(providerId)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE)
  @Delete('providers/:providerId')
  async deleteProvider(@Param('providerId') providerId: string): Promise<void> {
    await this.providersService.deletePlatformProvider(providerId)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_READ)
  @Get('providers/:providerId/models')
  getModels(@Param('providerId') providerId: string): Promise<AiProviderModels> {
    return this.providerModelsService.getPlatformModels(providerId)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE)
  @Post('providers/:providerId/models/discover')
  discoverModels(
    @Param('providerId') providerId: string,
  ): Promise<AiProviderModels> {
    return this.providerModelsService.discoverPlatformProviderModels(providerId)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE)
  @Post('providers/:providerId/models')
  upsertModel(
    @Param('providerId') providerId: string,
    @Body() payload: UpsertAiProviderModelDto,
  ): Promise<AiProviderModelItem> {
    return this.providerModelsService.upsertPlatformModel(providerId, payload)
  }

  @RequirePermissions(PERMISSIONS.SYSTEM_ADMIN_AI_CONFIG_UPDATE)
  @Put('providers/:providerId/models')
  upsertModels(
    @Param('providerId') providerId: string,
    @Body() payload: UpsertAiProviderModelsDto,
  ): Promise<AiProviderModels> {
    return this.providerModelsService.upsertPlatformModels(providerId, payload)
  }
}
