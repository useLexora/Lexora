import type { LocalChatIpcContext } from './registrar'
import process from 'node:process'
import { clipboard, shell } from 'electron'
import { z } from 'zod'
import { validationRequestSchemas } from '../../../shared/runtime/apiValidation'
import { spacesRequestSchemas, spacesRpc } from '../../../shared/spaces/spaceApi'
import { spaceDirectoryRequestSchema, spaceFilesRpc, spaceFileTargetSchema, spaceSaveDocumentSchema } from '../../../shared/spaces/spaceFileApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { translateDesktopNative } from '../desktopNativeI18n'
import { SpaceDirectorySelectionLedger } from '../spaceDirectorySelections'
import { selectPaths } from './nativeSelection'
import { readWslDistributions, wslStartDirectory } from './wslDirectory'

const selectDirectoryInputSchema = z.object({ source: z.object({ wsl: z.string().min(1).max(128) }).strict().optional() }).strict()

async function listWslDistributions(): Promise<string[]> {
  return process.platform === 'win32' ? (await readWslDistributions()).names : []
}

// Only a distribution that is actually installed can be opened; the name never becomes a path unchecked.
async function wslDirectory(distribution: string): Promise<string> {
  if (!(await listWslDistributions()).includes(distribution))
    throw new Error('WSL_NOT_AVAILABLE')
  return wslStartDirectory(distribution)
}

export function registerSpacesIpc(context: LocalChatIpcContext): void {
  const { handle, request, options } = context
  const spaceDirectorySelections = new SpaceDirectorySelectionLedger()
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesMutate, (_event, input) => request(spaceFilesRpc.mutate, spaceFilesRpc.mutate.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesHistory, (_event, input) => request(spaceFilesRpc.history, spaceFilesRpc.history.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesQuery, (_event, input) => request(spaceFilesRpc.query, spaceFilesRpc.query.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesAcknowledge, (_event, input) => request(spaceFilesRpc.acknowledge, spaceFilesRpc.acknowledge.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesCancel, (_event, input) => request(spaceFilesRpc.cancel, spaceFilesRpc.cancel.input.parse(input)))

  handle(LOCAL_CHAT_IPC_CHANNELS.spaceDocumentRead, (_event, input) => request(spaceFilesRpc.readDocument, spaceFileTargetSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceDocumentSave, (_event, input) => request(spaceFilesRpc.saveDocument, spaceSaveDocumentSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesList, (_event, input) => request(spaceFilesRpc.list, spaceDirectoryRequestSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesRead, (_event, input) => request(spaceFilesRpc.read, spaceFileTargetSchema.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.spaceFilesCopyPath, async (_event, input) => {
    const target = await request(spaceFilesRpc.locate, spaceFileTargetSchema.parse(input))
    clipboard.writeText(target.path)
  })
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

  handle(LOCAL_CHAT_IPC_CHANNELS.spacesSelectDirectory, async (_event, input) => {
    const { source } = selectDirectoryInputSchema.parse(input ?? {})
    // The system folder dialog does not list WSL, so open it inside the chosen distribution instead.
    const defaultPath = source ? await wslDirectory(source.wsl) : undefined
    const paths = await selectPaths(options.getWindow(), {
      properties: ['openDirectory'],
      title: translateDesktopNative(options.getLanguage(), 'selectSpaceDirectory'),
      ...(defaultPath ? { defaultPath } : {}),
    })
    const selected = paths[0] ?? null
    if (selected)
      spaceDirectorySelections.issue(selected)
    return selected
  })

  handle(LOCAL_CHAT_IPC_CHANNELS.spacesWslDistributions, () => listWslDistributions())

  handle(LOCAL_CHAT_IPC_CHANNELS.spacesUpdate, (_event, input) => {
    const parsed = spacesRequestSchemas.spaceUpdate.parse(input)
    return request(spacesRpc.update, withSpaceDirectorySelection(parsed, spaceDirectorySelections))
  })
}

function withSpaceDirectorySelection<SpaceInput extends {
  primaryDirectory: { root: string } | null
  additionalDirectoryChanges?: { add: string[], remove: string[] }
}>(
  input: SpaceInput,
  selections: SpaceDirectorySelectionLedger,
): SpaceInput & { primaryDirectorySelectionVerified: boolean, additionalDirectorySelectionsVerified: boolean } {
  return {
    ...input,
    additionalDirectorySelectionsVerified: selections.consumeAll(input.additionalDirectoryChanges?.add ?? []),
    primaryDirectorySelectionVerified: input.primaryDirectory
      ? selections.consume(input.primaryDirectory.root)
      : false,
  }
}
