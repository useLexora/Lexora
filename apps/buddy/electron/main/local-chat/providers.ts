import type { LocalChatIpcContext } from './registrar'
import { providersRequestSchemas, providersRpc } from '../../../shared/providers/providerApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerProvidersIpc(context: LocalChatIpcContext): void {
  const { handle, options, request } = context
  const PROVIDER_LOGIN_TIMEOUT_MS = 10 * 60_000
  handle(LOCAL_CHAT_IPC_CHANNELS.providersList, () => request(providersRpc.list, {}))
  handle(LOCAL_CHAT_IPC_CHANNELS.providersListBuiltinPresets, () => request(providersRpc.listBuiltinPresets, {}))
  handle(LOCAL_CHAT_IPC_CHANNELS.providersRename, (_event, input) => request(providersRpc.rename, providersRequestSchemas.providerRename.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersAdd, (_event, input) => request(providersRpc.add, providersRequestSchemas.providerId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersListModels, (_event, input) => request(providersRpc.listModels, providersRequestSchemas.listModels.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersGetDefaultModel, () => request(providersRpc.getDefaultModel, {}))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersGetModelSnapshot, () => request(providersRpc.getModelSnapshot, {}))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersOpenModelSnapshotDirectory, () => options.openModelSnapshotDirectory())

  handle(LOCAL_CHAT_IPC_CHANNELS.providersLogin, (_event, input) => request(providersRpc.login, providersRequestSchemas.providerLogin.parse(input), PROVIDER_LOGIN_TIMEOUT_MS))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersRespondToAuth, (_event, input) => request(providersRpc.respondToAuth, providersRequestSchemas.providerAuthResponse.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersCancelAuth, (_event, input) => request(providersRpc.cancelAuth, providersRequestSchemas.providerAuthCancel.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersLogout, (_event, input) => request(providersRpc.logout, providersRequestSchemas.providerId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersClearCredential, (_event, input) => request(providersRpc.clearCredential, providersRequestSchemas.providerId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersRemove, (_event, input) => request(providersRpc.remove, providersRequestSchemas.providerId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersRemoveModel, (_event, input) => request(providersRpc.removeModel, providersRequestSchemas.providerModel.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersSetEnabled, (_event, input) => request(providersRpc.setEnabled, providersRequestSchemas.providerEnabled.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersSetModelEnabled, (_event, input) => request(providersRpc.setModelEnabled, providersRequestSchemas.providerModelEnabled.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersSetModelParameters, (_event, input) => request(providersRpc.setModelParameters, providersRequestSchemas.providerModelParameters.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersSetModelCatalogSource, (_event, input) => request(providersRpc.setModelCatalogSource, providersRequestSchemas.providerModelCatalogSource.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.providersSetModelCapabilities, (_event, input) => request(providersRpc.setModelCapabilities, providersRequestSchemas.providerModelCapabilities.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersAcknowledgeModelSource, (_event, input) => request(providersRpc.acknowledgeModelSourceUpdate, providersRequestSchemas.providerModel.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersRestoreModelSource, (_event, input) => request(providersRpc.restoreModelSourceParameters, providersRequestSchemas.providerModel.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersRefreshModelSnapshot, () => request(providersRpc.refreshModelSnapshot, {}, 2 * 60_000))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersSetDefaultModel, (_event, input) => request(providersRpc.setDefaultModel, providersRequestSchemas.defaultModel.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersSyncModels, (_event, input) => request(providersRpc.syncModels, providersRequestSchemas.providerId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersUpsertManualModel, (_event, input) => request(providersRpc.upsertManualModel, providersRequestSchemas.providerManualModel.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.providersUpsertCustom, (_event, input) => {
    const { provider } = providersRequestSchemas.providerUpsert.parse(input)
    return request(providersRpc.upsertCustom, provider)
  })
  handle(LOCAL_CHAT_IPC_CHANNELS.providersCreateCustom, (_event, input) => {
    const { provider } = providersRequestSchemas.providerUpsert.parse(input)
    return request(providersRpc.createCustom, provider)
  })
}
