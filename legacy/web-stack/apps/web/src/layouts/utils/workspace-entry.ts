import { isAdminRoutePath } from '@/router/constants'
import { getSessionStorage, STORAGE_KEY } from '@/utils/storage'

const WORKSPACE_HOME_PATH = '/'

export function rememberWorkspaceEntryPath(path: string) {
  if (!path || isAdminRoutePath(path)) {
    return
  }

  getSessionStorage().setItem(STORAGE_KEY.workspaceEntry, path)
}

export function getWorkspaceEntryPath() {
  return getSessionStorage().getItem(STORAGE_KEY.workspaceEntry) || WORKSPACE_HOME_PATH
}
