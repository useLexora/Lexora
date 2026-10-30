import type { LexoraDesktopApi } from '../shared/desktopApi'
import { contextBridge } from 'electron'
import { createBrowserApi } from './browser'
import { createDesktopApi } from './desktop'
import { createExtensionApi } from './extensions'
import { createFileIconApi } from './fileIcons'
import { createImageApi } from './images'
import { createLocalChatApi } from './localChatApi'
import { createSpeechApi } from './speech'
import { createThemeApi } from './themes'

const desktopApi: LexoraDesktopApi = Object.freeze({
  ...createDesktopApi(),
  ...createBrowserApi(),
  images: createImageApi(),
  speech: createSpeechApi(),
  fileIcons: createFileIconApi(),
  themes: createThemeApi(),
  extensions: createExtensionApi(),
  localChat: createLocalChatApi(),
})

contextBridge.exposeInMainWorld('lexoraDesktop', desktopApi)
