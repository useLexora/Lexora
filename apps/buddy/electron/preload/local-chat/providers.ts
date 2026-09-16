import type { LocalProviderAuthChallenge } from '../../../shared/providers/providerApi'
import type { ProviderRequestHeader } from '../../../shared/providers/providerHeaders'
import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { subscribe } from '../subscribe'

export function createProvidersApi(): Pick<LocalChatApi, 'providers'> {
  return {
    providers: Object.freeze({
      acknowledgeModelSourceUpdate: (providerId, modelId) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersAcknowledgeModelSource,
        { modelId, providerId },
      ),
      add: providerId => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersAdd, { providerId }),
      clearCredential: providerId => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersClearCredential,
        { providerId },
      ),
      getDefaultModel: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersGetDefaultModel),
      getModelSnapshot: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersGetModelSnapshot),
      openModelSnapshotDirectory: () => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersOpenModelSnapshotDirectory,
      ),
      list: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersList),
      listBuiltinPresets: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersListBuiltinPresets),
      rename: (providerId, displayName, requestHeaders) => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersRename, { providerId, displayName, requestHeaders: copyHeaders(requestHeaders) }),
      listModels: providerId =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersListModels, { providerId }),
      login: (providerId, authType) =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersLogin, { authType, providerId }),
      respondToAuth: (challengeId, value) =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersRespondToAuth, { challengeId, value }),
      cancelAuth: challengeId =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersCancelAuth, { challengeId }),
      logout: providerId =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersLogout, { providerId }),
      remove: providerId =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersRemove, { providerId }),
      removeModel: (providerId, modelId) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersRemoveModel,
        { modelId, providerId },
      ),
      setDefaultModel: model => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersSetDefaultModel,
        { model },
      ),
      setEnabled: (providerId, enabled) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersSetEnabled,
        { enabled, providerId },
      ),
      setModelEnabled: (providerId, modelId, enabled) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersSetModelEnabled,
        { enabled, modelId, providerId },
      ),
      setModelCatalogSource: (providerId, modelId, source) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersSetModelCatalogSource,
        { modelId, providerId, source },
      ),
      setModelCapabilities: (providerId, modelId, capabilities) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersSetModelCapabilities,
        { modelId, providerId, capabilities },
      ),
      setModelParameters: (providerId, modelId, parameters) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersSetModelParameters,
        { modelId, parameters, providerId },
      ),
      restoreModelSourceParameters: (providerId, modelId) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersRestoreModelSource,
        { modelId, providerId },
      ),
      refreshModelSnapshot: () => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersRefreshModelSnapshot,
      ),
      syncModels: providerId => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersSyncModels,
        { providerId },
      ),
      upsertManualModel: (providerId, model) => ipcRenderer.invoke(
        LOCAL_CHAT_IPC_CHANNELS.providersUpsertManualModel,
        { model, providerId },
      ),
      upsertCustom: provider =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersUpsertCustom, { provider: { ...provider, requestHeaders: copyHeaders(provider.requestHeaders) } }),
      createCustom: provider =>
        ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.providersCreateCustom, { provider: { ...provider, requestHeaders: copyHeaders(provider.requestHeaders) } }),
      onAuthChallenge: (listener: (challenge: LocalProviderAuthChallenge) => void) =>
        subscribe(LOCAL_CHAT_IPC_CHANNELS.providerAuthChallenge, listener),
    }),
  }
}

function copyHeaders(headers?: readonly ProviderRequestHeader[]): ProviderRequestHeader[] | undefined {
  return headers?.map(({ name, value }) => ({ name, value }))
}
