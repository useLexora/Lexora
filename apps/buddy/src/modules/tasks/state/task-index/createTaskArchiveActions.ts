import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { TaskArchiveActions } from '../../contracts'

export function createTaskArchiveActions(options: {
  api: LocalChatApi['conversations']
  ready: TaskArchiveActions['ready']
  beforeClose?: (id: string) => Promise<boolean>
  onClosed?: (id: string) => void
  refresh: () => Promise<void>
}): TaskArchiveActions {
  async function mutate(kind: 'archive' | 'restoreArchive' | 'deleteArchived', id: string, revision?: number) {
    if (!options.ready.value || revision === undefined)
      return false
    if (kind !== 'restoreArchive' && options.beforeClose && !await options.beforeClose(id))
      return false
    if (!options.ready.value)
      return false
    const changed = await options.api[kind](id, revision)
    if (!changed)
      return false
    if (kind !== 'restoreArchive')
      options.onClosed?.(id)
    await options.refresh()
    return true
  }
  return {
    ready: options.ready,
    onChanged: listener => options.api.onChanged(listener),
    archive: (id, revision) => mutate('archive', id, revision),
    restore: (id, revision) => mutate('restoreArchive', id, revision),
    delete: (id, revision) => mutate('deleteArchived', id, revision),
    list: query => options.api.listArchived(query),
    get: id => options.api.get(id),
    getPolicy: () => options.api.getArchivePolicy(),
    setPolicy: days => options.api.setArchivePolicy(days),
  }
}
