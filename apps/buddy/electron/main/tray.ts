import type { LexoraConfig } from '../shared/desktopApi'
import { Menu, nativeImage, Tray } from 'electron'
import { translateDesktopNative } from './desktopNativeI18n'

export interface CreateDesktopTrayOptions {
  appName: string
  iconPath: string
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
  const tray = new Tray(nativeImage.createFromPath(options.iconPath))
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
