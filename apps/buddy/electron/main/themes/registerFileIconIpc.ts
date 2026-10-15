import type { BrowserWindow, IpcMainEvent } from 'electron'
import type { FileIconThemeService } from '../../../platform/icons/FileIconThemeService'
import { ipcMain, session } from 'electron'
import { FILE_ICON_PROTOCOL } from '../../../shared/icons/fileIconTheme'
import { FILE_ICON_IPC, fileIconThemeRequestSchema } from '../../../shared/icons/fileIconThemeApi'
import { assertTrustedSender } from '../ipc'

export const fileIconSchemePrivileges: Electron.CustomScheme = {
  scheme: FILE_ICON_PROTOCOL,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}

export function registerFileIconIpc(service: FileIconThemeService, getWindow: () => BrowserWindow | null): () => void {
  const initial = (event: IpcMainEvent) => {
    assertTrustedSender(event, getWindow())
    event.returnValue = service.snapshot
  }
  ipcMain.on(FILE_ICON_IPC.initial, initial)
  ipcMain.handle(FILE_ICON_IPC.request, (event, raw: unknown) => {
    const frame = event.senderFrame
    const guard = () => {
      assertTrustedSender(event, getWindow())
      if (!frame || frame.detached || frame !== event.sender.mainFrame)
        throw new Error('EXTENSION_ICON_THEME_OWNER_EXPIRED')
    }
    return service.request(fileIconThemeRequestSchema.parse(raw), guard)
  })
  session.defaultSession.protocol.handle(FILE_ICON_PROTOCOL, async (request) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method))
        return new Response(null, { status: 405 })
      const asset = await service.asset(request.url)
      if (!asset)
        return new Response(null, { status: 404 })
      return new Response(request.method === 'HEAD' ? null : asset.bytes as Uint8Array<ArrayBuffer>, { headers: {
        'content-type': asset.type,
        'content-length': String(asset.bytes.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'default-src \'none\'; sandbox',
      } })
    }
    catch { return new Response(null, { status: 403 }) }
  })
  const subscription = service.onDidChange((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed())
      window.webContents.send(FILE_ICON_IPC.changed, snapshot)
  })
  return () => {
    subscription.dispose()
    ipcMain.off(FILE_ICON_IPC.initial, initial)
    ipcMain.removeHandler(FILE_ICON_IPC.request)
    session.defaultSession.protocol.unhandle(FILE_ICON_PROTOCOL)
  }
}
