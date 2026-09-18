import type { LexoraDesktopApi } from '../shared/desktopApi'
import { contextBridge } from 'electron'
import { createBrowserApi } from './browser'
import { createDesktopApi } from './desktop'
import { createExtensionApi } from './extensions'
import { createLocalChatApi } from './localChatApi'

const desktopApi: LexoraDesktopApi = Object.freeze({
  ...createDesktopApi(),
  ...createBrowserApi(),
  extensions: createExtensionApi(),
  localChat: createLocalChatApi(),
})

contextBridge.exposeInMainWorld('lexoraDesktop', desktopApi)
