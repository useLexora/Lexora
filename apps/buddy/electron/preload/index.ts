import type { LexoraDesktopApi } from '../shared/desktopApi'
import { contextBridge } from 'electron'
import { createBrowserApi } from './browser'
import { createDesktopApi } from './desktop'
import { createExtensionApi } from './extensions'
import { createLocalChatApi } from './localChatApi'
import { createThemeApi } from './themes'

const desktopApi: LexoraDesktopApi = Object.freeze({
  ...createDesktopApi(),
  ...createBrowserApi(),
  themes: createThemeApi(),
  extensions: createExtensionApi(),
  localChat: createLocalChatApi(),
})

contextBridge.exposeInMainWorld('lexoraDesktop', desktopApi)
