import { Module } from '@nestjs/common'

// models
import { AiModelCapabilityDefaultsService } from './models/capability-defaults.service'
import { AiDefaultModelsService } from './models/defaults.service'
import { AiProviderModelsService } from './models/provider-models.service'
import { AiProvidersService } from './models/providers.service'
import { AiModelResolverService } from './models/resolver.service'
import { AiSystemAdminController } from './models/system-admin.controller'
import { AiUserController } from './models/user.controller'

// providers
import { AiProviderAdaptersService } from './providers/adapters.service'
import { AiProviderPresetsController } from './providers/presets.controller'
import { AiProviderPresetsService } from './providers/presets.service'

@Module({
  controllers: [
    AiProviderPresetsController,
    AiSystemAdminController,
    AiUserController,
  ],
  providers: [
    AiProviderPresetsService,
    AiProviderAdaptersService,
    AiModelCapabilityDefaultsService,
    AiProvidersService,
    AiProviderModelsService,
    AiDefaultModelsService,
    AiModelResolverService,
  ],
  exports: [
    AiDefaultModelsService,
    AiModelCapabilityDefaultsService,
    AiProviderAdaptersService,
    AiProvidersService,
    AiModelResolverService,
  ],
})
export class AiModule {}
