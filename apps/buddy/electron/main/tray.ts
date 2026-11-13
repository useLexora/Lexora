import type { BuddyRuntimeProfile } from '../../shared/runtime/profile'
import type { LexoraConfig } from '../shared/desktopApi'
import { Menu, Tray } from 'electron'
import { translateDesktopNative } from './desktopNativeI18n'
import { createDesktopTrayImage } from './trayIcon'

export interface CreateDesktopTrayOptions {
  appName: string
  iconPath: string
  profile: BuddyRuntimeProfile
  language: LexoraConfig['desktop']['language']
  onOpenDesktop: () => void
  onQuit: () => void
  onRestart: () => void
}

export interface DesktopTrayController {
  destroy: () => void
  setLanguage: (language: LexoraConfig['desktop']['language']) => void
}

export function createDesktopTray(options: CreateDesktopTrayOptions): DesktopTrayController {
  const tray = new Tray(createDesktopTrayImage(options.iconPath, options.profile))
  let language = options.language

  const rebuildMenu = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: translateDesktopNative(language, 'open'),
        click: options.onOpenDesktop,
      },
      { type: 'separator' },
      {
        label: translateDesktopNative(language, 'restart'),
        click: options.onRestart,
      },
      { type: 'separator' },
      {
        label: translateDesktopNative(language, 'quit'),
        click: options.onQuit,
      },
    ]))
  }

  tray.setToolTip(options.appName)
  tray.on('click', options.onOpenDesktop)
  rebuildMenu()

  return {
    destroy() {
      tray.destroy()
    },
    setLanguage(nextLanguage) {
      language = nextLanguage
      rebuildMenu()
    },
  }
}
