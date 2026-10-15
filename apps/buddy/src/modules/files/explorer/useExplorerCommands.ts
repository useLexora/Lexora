import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { SpaceFileMutation, SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { ExplorerNode } from '@/shared/ui/explorer/treeCollection'
import { parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { useDialog } from 'naive-ui'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { useFileOperations } from '../fileOperationsContext'
import { explorerLabels } from './explorerLabels'

export function useExplorerCommands(options: {
  target: () => SpaceFileTarget
  language: () => string
  api: Pick<LocalChatApi['spaces'], 'revealFile' | 'cancelFileOperation'>
  refresh: () => Promise<void>
}) {
  const operations = useFileOperations()
  const dialog = useDialog()
  const labels = computed(() => explorerLabels(options.language()))
  const nameRequest = shallowRef<{ title: string, name: string, parent: string } | null>(null)
  const busy = shallowRef<SpaceFileMutation | null>(null)
  const error = shallowRef('')
  let finishName: (name: string | null) => void = () => {}
  let stopped = false
  onScopeDispose(() => {
    stopped = true
    finishName(null)
  })
  function requestName(title: string, name: string, parent: string) {
    return new Promise<string | null>((resolve) => {
      finishName(null)
      nameRequest.value = { title, name, parent }
      finishName = (value) => {
        nameRequest.value = null
        resolve(value)
      }
    })
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
  async function run(input: SpaceFileMutation) {
    if (busy.value || stopped)
      return
    busy.value = input
    error.value = ''
    try {
      const result = await operations.execute(input)
      if (result && result.status !== 'applied')
        error.value = result.status === 'needs-recovery' ? labels.value.unknown : failureMessage(result.error ?? '')
      if (!stopped)
        await options.refresh()
      return result
    }
    catch (cause) {
      if (!stopped)
        error.value = failureMessage(cause instanceof Error ? parseLocalChatPublicError(cause.message)?.code ?? cause.message : '')
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
    if (command === 'reveal') {
      await options.api.revealFile({ ...target, path }).catch(() => error.value = labels.value.failure)
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
    if (!['rename', 'newFile', 'newFolder'].includes(command))
      return
    const folder = command === 'rename' ? path.split('/').slice(0, -1).join('/') : parent
    const name = await requestName(command === 'rename' ? labels.value.rename : command === 'newFile' ? labels.value.newFile : labels.value.newFolder, command === 'rename' ? node!.label : '', folder)
    if (name === null || stopped)
      return
    const destination = folder ? `${folder}/${name}` : name
    await run({ ...target, path: command === 'rename' ? path : destination, operationId: crypto.randomUUID(), action: command === 'rename' ? { kind: 'rename', destination } : { kind: command === 'newFile' ? 'createFile' : 'createDirectory' } })
  }
  return { clipboard: operations.clipboard, labels, nameRequest, finishName: (name: string | null) => finishName(name), busy, error, command, run, cancel: () => busy.value && options.api.cancelFileOperation(busy.value).catch(() => {}) }
}
