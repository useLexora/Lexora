import type { DatabaseSync } from 'node:sqlite'
import type { BuiltinProviderConfigRepository } from './builtinProviderConfigRepository'
import type { DefaultModelRepository } from './defaultModelRepository'
import type { ProviderConfigRepository } from './providerConfigRepository'
import type { ProviderModelStateRepository } from './providerModelStateRepository'
import type { ProviderStateRepository } from './providerStateRepository'
import { createBuiltinProviderConfigRepository } from './builtinProviderConfigRepository'
import { withTransaction } from './database'
import { createDefaultModelRepository } from './defaultModelRepository'
import { createProviderConfigRepository } from './providerConfigRepository'
import { createProviderModelStateRepository } from './providerModelStateRepository'
import { createProviderStateRepository } from './providerStateRepository'

export interface ProviderRepository {
  readonly builtins: BuiltinProviderConfigRepository
  readonly configs: ProviderConfigRepository
  readonly defaultModel: DefaultModelRepository
  readonly models: ProviderModelStateRepository
  readonly states: ProviderStateRepository
  transaction: <T>(operation: () => T) => T
}

export function createProviderRepository(database: DatabaseSync): ProviderRepository {
  return {
    builtins: createBuiltinProviderConfigRepository(database),
    configs: createProviderConfigRepository(database),
    defaultModel: createDefaultModelRepository(database),
    models: createProviderModelStateRepository(database),
    states: createProviderStateRepository(database),
    transaction(operation) {
      return withTransaction(database, operation)
    },
  }
}
