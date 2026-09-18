import type { LocalChatIpcContext } from './registrar'
import { shell } from 'electron'
import { validationRequestSchemas } from '../../../shared/runtime/apiValidation'
import { spacesRequestSchemas, spacesRpc } from '../../../shared/spaces/spaceApi'
import { spaceDirectoryRequestSchema, spaceFilesRpc, spaceFileTargetSchema, spaceSaveDocumentSchema } from '../../../shared/spaces/spaceFileApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { translateDesktopNative } from '../desktopNativeI18n'
import { SpaceDirectorySelectionLedger } from '../spaceDirectorySelections'
import { selectPaths } from './nativeSelection'

export function registerSpacesIpc(context: LocalChatIpcContext): void {
  const { handle, request, options } = context
  const spaceDirectorySelections = new SpaceDirectorySelectionLedger()
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceDocumentRead, (_event, input) => request(spaceFilesRpc.readDocument, spaceFileTargetSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceDocumentSave, (_event, input) => request(spaceFilesRpc.saveDocument, spaceSaveDocumentSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesList, (_event, input) => request(spaceFilesRpc.list, spaceDirectoryRequestSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesRead, (_event, input) => request(spaceFilesRpc.read, spaceFileTargetSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesReveal, async (_event, input) => {
    const target = await request(spaceFilesRpc.locate, spaceFileTargetSchema.parse(input))
    if (target.kind === 'file') {
      shell.showItemInFolder(target.path)
      return
    }
    const error = await shell.openPath(target.path)
    if (error)
      throw new Error(error)
  })
  handle(LOCAL_CHAT_IPC_CHANNELS.spacesCreate, (_event, input) => {
    const parsed = spacesRequestSchemas.spaceCreate.parse(input)
    return request(spacesRpc.create, withSpaceDirectorySelection(parsed, spaceDirectorySelections))
  })

  handle(LOCAL_CHAT_IPC_CHANNELS.spacesDelete, (_event, input) => request(spacesRpc.delete, spacesRequestSchemas.spaceId.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.spacesList, (_event, input) => request(spacesRpc.list, validationRequestSchemas.limit.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.spacesSearchFiles, (_event, input) => request(spacesRpc.searchFiles, spacesRequestSchemas.spaceFileSearch.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.spacesSelectDirectory, async () => {
    const paths = await selectPaths(options.getWindow(), {
      properties: ['openDirectory'],
      title: translateDesktopNative(options.getLanguage(), 'selectSpaceDirectory'),
    })
    const selected = paths[0] ?? null
    if (selected)
      spaceDirectorySelections.issue(selected)
    return selected
  })

  handle(LOCAL_CHAT_IPC_CHANNELS.spacesUpdate, (_event, input) => {
    const parsed = spacesRequestSchemas.spaceUpdate.parse(input)
    return request(spacesRpc.update, withSpaceDirectorySelection(parsed, spaceDirectorySelections))
  })
}

function withSpaceDirectorySelection<SpaceInput extends {
  primaryDirectory: { root: string } | null
}>(
  input: SpaceInput,
  selections: SpaceDirectorySelectionLedger,
): SpaceInput & { primaryDirectorySelectionVerified: boolean } {
  return {
    ...input,
    primaryDirectorySelectionVerified: input.primaryDirectory
      ? selections.consume(input.primaryDirectory.root)
      : false,
  }
}
