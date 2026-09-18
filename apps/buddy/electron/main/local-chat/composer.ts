import type { LocalChatIpcContext } from './registrar'
import { composerDraftsRpc, composerRequestSchemas, composerResourcesRpc } from '../../../shared/conversation/composerApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { translateDesktopNative } from '../desktopNativeI18n'
import { selectPaths } from './nativeSelection'

export function registerComposerIpc(context: LocalChatIpcContext): void {
  const { handle, request, options } = context

  handle(LOCAL_CHAT_IPC_CHANNELS.composerResourcesAccept, (_event, input) => request(composerResourcesRpc.accept, composerRequestSchemas.composerResourceAccept.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerDraftsFind, (_event, input) => request(composerDraftsRpc.find, composerRequestSchemas.composerDraftTarget.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerDraftsList, () => request(composerDraftsRpc.list, {}))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerDraftsDiscard, (_event, input) => request(composerDraftsRpc.discard, composerDraftsRpc.discard.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerDraftsOpen, (_event, input) => request(composerDraftsRpc.open, composerRequestSchemas.composerDraftOpen.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerDraftsGet, (_event, input) => request(composerDraftsRpc.get, composerRequestSchemas.composerDraftTarget.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerDraftsSave, (_event, input) => request(composerDraftsRpc.save, composerRequestSchemas.composerDraftSave.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.composerResourcesComplete, (_event, input) => request(composerResourcesRpc.complete, composerRequestSchemas.composerResourceComplete.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerResourcesFail, (_event, input) => request(composerResourcesRpc.fail, composerRequestSchemas.composerResourceTarget.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerResourcesRetry, (_event, input) => request(composerResourcesRpc.retry, composerRequestSchemas.composerResourceTarget.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerResourcesList, (_event, input) => request(composerResourcesRpc.list, composerRequestSchemas.composerResourceDraft.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerResourcesListSources, (_event, input) => request(composerResourcesRpc.listSources, composerResourcesRpc.listSources.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerResourcesSelectSpaceFile, (_event, input) => request(composerResourcesRpc.selectSpaceFile, composerRequestSchemas.composerSpaceFileSelect.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerResourcesSelectSource, (_event, input) => request(composerResourcesRpc.selectSource, composerRequestSchemas.composerSourceSelect.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.composerResourcesSelectFiles, async (_event, input) => {
    const { draftId, referencedResourceIds } = composerRequestSchemas.composerResourceFileSelect.parse(input)
    const paths = await selectPaths(options.getWindow(), {
      properties: ['openFile', 'multiSelections'],
      title: translateDesktopNative(options.getLanguage(), 'selectAttachments'),
    })
    return paths.length === 0
      ? []
      : request(composerResourcesRpc.registerFiles, { draftId, paths, referencedResourceIds })
  })
}
