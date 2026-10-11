import type { ThemeApi, ThemeSnapshot } from '../../shared/theme/themeApi'
import { ipcRenderer } from 'electron'
import { THEME_IPC } from '../../shared/theme/themeApi'
import { subscribe } from './subscribe'

export function createThemeApi(): ThemeApi {
  const initial: ThemeSnapshot = ipcRenderer.sendSync(THEME_IPC.initial)
  return Object.freeze<ThemeApi>({
    initial,
    request: input => ipcRenderer.invoke(THEME_IPC.request, input),
    onDidChange: listener => subscribe(THEME_IPC.changed, listener),
  })
}
