import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionDataSource } from '@buddy-shared/extensions/extensionData'
import type { ExtensionDataBinding } from './ExtensionDataClient'

export type { ExtensionDataBinding } from './ExtensionDataClient'
export interface ExtensionDataPort {
  binding: (input: ExtensionViewInput, source: ExtensionDataSource) => ExtensionDataBinding | null
  observeChanges: (input: ExtensionViewInput, listener: () => void) => () => void
}
