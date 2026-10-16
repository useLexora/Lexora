import type { BrowserWindow, IpcMainEvent } from 'electron'
import type { ThemeService } from '../../../platform/themes/ThemeService'
import { ipcMain, nativeTheme, session } from 'electron'
import { THEME_ASSET_PROTOCOL, THEME_IPC, themeRequestSchema } from '../../../shared/theme/themeApi'
import { assertTrustedSender } from '../ipc'

export const themeSchemePrivileges: Electron.CustomScheme = {
  scheme: THEME_ASSET_PROTOCOL,
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
}

export function registerThemeIpc(service: ThemeService, getWindow: () => BrowserWindow | null, applyBackground: (color: string, dark: boolean, system: boolean) => void): () => void {
  session.defaultSession.protocol.handle(THEME_ASSET_PROTOCOL, async (request) => {
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 405 })
    try {
      return await service.assetResponse(request)
    }
    catch { return new Response(null, { status: 404 }) }
  })
  const owner = 'desktop'
  const initial = (event: IpcMainEvent) => {
    assertTrustedSender(event, getWindow())
    event.returnValue = service.snapshot
  }
  ipcMain.on(THEME_IPC.initial, initial)
  ipcMain.handle(THEME_IPC.request, (event, raw: unknown) => {
    assertTrustedSender(event, getWindow())
    const frame = event.senderFrame
    return service.request(owner, themeRequestSchema.parse(raw), () => {
      assertTrustedSender(event, getWindow())
      if (!frame || frame.detached || frame !== event.sender.mainFrame)
        throw new Error('EXTENSION_THEME_OWNER_EXPIRED')
    })
  })
  const subscription = service.onDidChange((snapshot) => {
    applyBackground(snapshot.active.colors.canvas, snapshot.active.descriptor.appearance === 'dark', !snapshot.preview && snapshot.preference.id === 'system')
    const window = getWindow()
    if (window && !window.isDestroyed())
      window.webContents.send(THEME_IPC.changed, snapshot)
  })
  const systemChanged = () => {
    if (nativeTheme.themeSource === 'system')
      service.setSystemDark(nativeTheme.shouldUseDarkColors)
  }
  nativeTheme.on('updated', systemChanged)
  const initialTheme = service.snapshot
  applyBackground(initialTheme.active.colors.canvas, initialTheme.active.descriptor.appearance === 'dark', initialTheme.preference.id === 'system')
  return () => {
    subscription.dispose()
    session.defaultSession.protocol.unhandle(THEME_ASSET_PROTOCOL)
    nativeTheme.off('updated', systemChanged)
    ipcMain.removeHandler(THEME_IPC.request)
    ipcMain.off(THEME_IPC.initial, initial)
    service.releaseOwner(owner)
  }
}
