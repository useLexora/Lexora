import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { SpaceFileMutation, SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { ExplorerNode } from '@/shared/ui/explorer/treeCollection'
import { parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { useDialog, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { useFileOperations } from '../fileOperationsContext'
import { explorerLabels } from './explorerLabels'

export interface ExplorerNameRequest {
  kind: 'rename' | 'newFile' | 'newFolder'
  title: string
  name: string
  parent: string
}

export interface ExplorerNameError {
  message: string
  status: 'warning' | 'error'
}

export function useExplorerCommands(options: {
  target: () => SpaceFileTarget
  language: () => string
  api: Pick<LocalChatApi['spaces'], 'revealFile' | 'copyFilePath' | 'cancelFileOperation'>
  refresh: () => Promise<void>
}) {
  const operations = useFileOperations()
  const dialog = useDialog()
  const message = useMessage()
  const labels = computed(() => explorerLabels(options.language()))
  const nameRequest = shallowRef<ExplorerNameRequest | null>(null)
  const busy = shallowRef<SpaceFileMutation | null>(null)
  const nameError = shallowRef<ExplorerNameError | null>(null)
  let nameAction: ((name: string) => SpaceFileMutation) | null = null
  let stopped = false
  function closeName() {
    nameRequest.value = null
    nameAction = null
    nameError.value = null
  }
  onScopeDispose(() => {
    stopped = true
    closeName()
  })
  async function finishName(name: string | null) {
    if (busy.value || !nameRequest.value || !nameAction || stopped)
      return
    if (name === null) {
      closeName()
      return
    }
    nameError.value = null
    const result = await run(nameAction(name), 'name')
    if (!stopped && result?.status === 'applied')
      closeName()
  }
  function confirmTrash(name: string) {
    return new Promise<boolean>((resolve) => {
      dialog.warning({ title: `${labels.value.trash} · ${name}`, content: labels.value.trashDetail, positiveText: labels.value.trash, negativeText: labels.value.cancel, onPositiveClick: () => resolve(true), onNegativeClick: () => resolve(false), onClose: () => resolve(false), onMaskClick: () => resolve(false), onEsc: () => resolve(false) })
    })
  }
  function failureMessage(code: string) {
    switch (code) {
      case 'FILE_VIEW_CONFLICT': return labels.value.viewConflict
      case 'FILE_UNSAVED_CONFLICT': return labels.value.unsaved
      case 'FILE_CONFLICT': return labels.value.conflict
      case 'FILE_OPERATION_CANCELLED': return labels.value.cancelled
      case 'FILE_UNSUPPORTED': return labels.value.unsupported
      case 'FILE_PERMISSION_REVOKED': case 'DIRECTORY_NOT_AUTHORIZED': return labels.value.permission
      case 'FILE_RECOVERY_REQUIRED': return labels.value.pendingRecovery
      case 'FILE_ENGINE_INTERRUPTED': return labels.value.unknown
      default: return labels.value.failure
    }
  }
  async function run(input: SpaceFileMutation, feedback: 'name' | 'message' = 'message') {
    if (busy.value || stopped)
      return
    busy.value = input
    const fail = (code: string) => {
      if (stopped)
        return
      if (feedback === 'name') {
        nameError.value = { message: code === 'FILE_CONFLICT' ? labels.value.nameConflict : failureMessage(code), status: code === 'FILE_CONFLICT' ? 'warning' : 'error' }
      }
      else {
        message.error(failureMessage(code))
      }
    }
    try {
      const result = await operations.execute(input)
      if (result && result.status !== 'applied')
        fail(result.status === 'needs-recovery' ? 'FILE_ENGINE_INTERRUPTED' : result.error ?? '')
      if (!stopped)
        await options.refresh()
      return result
    }
    catch (cause) {
      fail(cause instanceof Error ? parseLocalChatPublicError(cause.message)?.code ?? cause.message : '')
    }
    finally { busy.value = null }
  }
  async function command(command: string, node: ExplorerNode | null) {
    if (busy.value || node?.disabled || stopped)
      return
    const target = { ...options.target() }
    const parent = node?.kind === 'directory' ? node.key : node?.key.split('/').slice(0, -1).join('/') ?? ''
    const path = node?.key ?? ''
    if (command === 'copy' || command === 'cut') {
      if (node)
        operations.clipboard.value = { target: { ...target, path }, move: command === 'cut' }
      return
    }
    if (command === 'copyPath') {
      if (!node)
        return
      try {
        await options.api.copyFilePath({ ...target, path })
      }
      catch {
        if (!stopped)
          message.error(labels.value.copyPathFailure)
      }
      return
    }
    if (command === 'reveal') {
      await options.api.revealFile({ ...target, path }).catch(() => {
        if (!stopped)
          message.error(labels.value.failure)
      })
      return
    }
    if (command === 'refresh') {
      await options.refresh()
      return
    }
    if (command === 'paste') {
      const clipboard = operations.clipboard.value
      if (!clipboard)
        return
      const name = clipboard.target.path.split('/').at(-1)!
      const result = await run({ ...clipboard.target, operationId: crypto.randomUUID(), action: { kind: clipboard.move ? 'move' : 'copy', destination: { ...target, path: parent ? `${parent}/${name}` : name } } })
      if (result?.status === 'applied' && clipboard.move && operations.clipboard.value === clipboard)
        operations.clipboard.value = null
      return
    }
    if (command === 'trash') {
      if (node && await confirmTrash(node.label))
        await run({ ...target, path, operationId: crypto.randomUUID(), action: { kind: 'trash' } })
      return
    }
    if (command === 'rename' && !node)
      return
    if (command !== 'rename' && command !== 'newFile' && command !== 'newFolder')
      return
    const folder = command === 'rename' ? path.split('/').slice(0, -1).join('/') : parent
    nameError.value = null
    nameRequest.value = { kind: command, title: labels.value[command], name: command === 'rename' ? node!.label : command === 'newFile' ? labels.value.defaultFileName : '', parent: folder }
    nameAction = (name) => {
      const destination = folder ? `${folder}/${name}` : name
      return { ...target, path: command === 'rename' ? path : destination, operationId: crypto.randomUUID(), action: command === 'rename' ? { kind: 'rename', destination } : { kind: command === 'newFile' ? 'createFile' : 'createDirectory' } }
    }
  }
  return { clipboard: operations.clipboard, labels, nameRequest, nameError, finishName, clearNameError: () => nameError.value = null, busy, command, run, cancel: () => busy.value && options.api.cancelFileOperation(busy.value).catch(() => {}) }
}
