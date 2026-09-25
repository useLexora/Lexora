import type { BrowserWindow, IpcMainEvent } from 'electron'
import type { ExtensionWorkbenchEvent } from '../../../shared/extensions/extensionApi'
import type { ExtensionInspection } from '../../../shared/extensions/extensionAuthoring'
import type { SpaceFileTarget } from '../../../shared/spaces/spaceFileApi'
import { join } from 'node:path'
import { dialog, ipcMain, Notification, powerMonitor, session } from 'electron'
import { z } from 'zod'
import { ExtensionPackageStore } from '../../../platform/extensions/ExtensionPackageStore'
import { ExtensionService } from '../../../platform/extensions/ExtensionService'
import { EXTENSION_IPC, extensionError, extensionManagementSchema } from '../../../shared/extensions/extensionApi'
import { assertTrustedSender } from '../ipc'
import { compileExtension } from './compileExtension'
import { ExtensionProtocol } from './ExtensionProtocol'
import { SandboxedExtensionHost } from './SandboxedExtensionHost'

export function registerExtensionIpc(options: {
  home: string
  version: string
  getWindow: () => BrowserWindow | null
  readText: (target: SpaceFileTarget, signal: AbortSignal) => Promise<string>
  get: (url: string, init: { signal: AbortSignal }) => Promise<Response>
  developmentDirectory?: string
  notificationsEnabled?: () => boolean
}): { dispose: () => Promise<void>, reviewPackage: (path: string) => Promise<void>, inspect: (id: string) => Promise<ExtensionInspection> } {
  const store = new ExtensionPackageStore(join(options.home, 'extensions'), options.version)
  const protocol = new ExtensionProtocol(store)
  const stopProtocol = protocol.install(session.defaultSession, 'view')
  const hosts = new Set<SandboxedExtensionHost>()
  const replies = new Map<string, (value: string | null) => void>()
  const bound = new Set<BrowserWindow>()
  let resourcePickerOpen = false
  const guardNavigation = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
    if (!event.isMainFrame && !protocol.validViewUrl(event.url))
      event.preventDefault()
  }
  const service = new ExtensionService(store, {
    createHost: (pkg, broker, failed) => {
      const host = new SandboxedExtensionHost(pkg, protocol, broker, failed)
      hosts.add(host)
      return { call: host.call.bind(host), devtools: host.devtools.bind(host), dispose: async () => {
        await host.dispose()
        hosts.delete(host)
      } }
    },
    createView: pkg => protocol.register(pkg, 'view'),
    readText: options.readText,
    get: options.get,
    compile: compileExtension,
    selectResources: async (name, selection, signal) => {
      const owner = window()
      if (!owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized() || resourcePickerOpen)
        throw new Error('EXTENSION_RESOURCE_PICKER_UNAVAILABLE')
      signal.throwIfAborted()
      resourcePickerOpen = true
      try {
        const result = await dialog.showOpenDialog(owner, {
          title: name,
          properties: selection.directory ? ['openDirectory'] : selection.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
          ...(selection.directory || !selection.filters.length ? {} : { filters: selection.filters }),
        })
        signal.throwIfAborted()
        return result.canceled ? [] : result.filePaths
      }
      finally { resourcePickerOpen = false }
    },
    selectSavePath: async (name, suggestedName, signal) => {
      const owner = window()
      if (!owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized() || resourcePickerOpen)
        throw new Error('EXTENSION_RESOURCE_PICKER_UNAVAILABLE')
      signal.throwIfAborted()
      resourcePickerOpen = true
      try {
        const result = await dialog.showSaveDialog(owner, { title: name, defaultPath: suggestedName, properties: ['showOverwriteConfirmation', 'createDirectory'] })
        signal.throwIfAborted()
        return result.canceled ? null : result.filePath ?? null
      }
      finally { resourcePickerOpen = false }
    },
    notify: (id, notification) => {
      if (!Notification.isSupported() || options.notificationsEnabled?.() === false)
        return false
      const record = store.installed[id]
      if (!record?.enabled)
        return false
      const native = new Notification({ title: `${record.current.manifest.name} · ${notification.title}`, body: notification.body })
      native.show()
      return true
    },
    changed: () => {
      const current = window()
      if (current && !current.isDestroyed())
        current.webContents.send(EXTENSION_IPC.changed)
    },
    workbench: (event: ExtensionWorkbenchEvent, signal: AbortSignal) => new Promise((resolve) => {
      const current = window()
      if (!current || current.isDestroyed() || signal.aborted || replies.size >= 64) {
        resolve(null)
        return
      }
      let settled = false
      const cancel = () => {
        if (!current.isDestroyed())
          current.webContents.send(EXTENSION_IPC.workbench, { kind: 'cancel', requestId: event.requestId } satisfies ExtensionWorkbenchEvent)
        finish(null)
      }
      const timer = setTimeout(cancel, 10000)
      function finish(value: string | null) {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        replies.delete(event.requestId)
        resolve(value)
      }
      replies.set(event.requestId, finish)
      signal.addEventListener('abort', cancel, { once: true })
      current.webContents.send(EXTENSION_IPC.workbench, event)
    }),
  })
  const resetHosts = () => {
    void service.resetHosts()
  }
  const resetOnNavigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame && !event.isSameDocument)
      resetHosts()
  }
  function window(): BrowserWindow | null {
    const current = options.getWindow()
    if (current && !current.isDestroyed() && !bound.has(current)) {
      bound.add(current)
      current.webContents.on('will-frame-navigate', guardNavigation)
      current.webContents.on('did-start-navigation', resetOnNavigation)
      current.webContents.on('render-process-gone', resetHosts)
      current.webContents.once('destroyed', () => {
        bound.delete(current)
        for (const reply of replies.values()) reply(null)
        resetHosts()
      })
    }
    return current
  }
  const prepared = options.developmentDirectory
    ? service.initialize().then(async () => {
        const review = await service.review(options.developmentDirectory!, true)
        await service.install(review.token)
        await service.restart(review.manifest.id)
      })
    : service.initialize()
  void prepared.catch(() => {})
  const suspend = () => service.scheduler.suspend()
  const resume = () => {
    void prepared.then(() => service.scheduler.resume()).catch(() => {})
  }
  powerMonitor.on('suspend', suspend)
  powerMonitor.on('resume', resume)
  ipcMain.handle(EXTENSION_IPC.request, async (event, raw: unknown) => {
    assertTrustedSender(event, window())
    try {
      const input = extensionManagementSchema.parse(raw)
      await prepared
      await service.initialize()
      switch (input.action) {
        case 'list': return await service.list()
        case 'installations': return service.installations.list()
        case 'catalog': return service.catalog.list(input.refresh)
        case 'reviewCatalog': return service.reviewCatalog(input.id, input.version)
        case 'cancelInstallation': return service.installations.cancel(input.id)
        case 'selectPackage': {
          const owner = window()
          if (!owner)
            throw new Error('EXTENSION_WINDOW_UNAVAILABLE')
          const result = await dialog.showOpenDialog(owner, { properties: input.development ? ['openDirectory'] : ['openFile'], ...(input.development ? {} : { filters: [{ name: 'Lexora Extension', extensions: ['lexora-extension', 'zip'] }] }) })
          return result.canceled || !result.filePaths[0] ? null : await service.review(result.filePaths[0], input.development)
        }
        case 'install': return await service.install(input.token)
        case 'cancelInstall': return service.cancelInstall(input.token)
        case 'enable': return await service.enable(input.id, input.enabled)
        case 'restart': return await service.restart(input.id)
        case 'uninstall': return await service.uninstall(input.id)
        case 'devtools': return await service.devtools(input.id)
        case 'revokeResources': return await service.revokeResources(input.id)
        case 'execute': return await service.execute(input.id, input.command, input.resource)
        case 'openView': return await service.openView(input.view)
        case 'closeView': return service.closeView(input.viewId, input.generation, input.token)
        case 'viewRequest': return await service.viewRequest(input.viewId, input.generation, input.token, input.method, input.params)
      }
    }
    catch (error) {
      throw new Error(extensionError(error))
    }
  })
  const onWorkbenchReply = (event: IpcMainEvent, raw: unknown) => {
    const current = window()
    if (!current || current.isDestroyed() || event.sender !== current.webContents || event.senderFrame !== current.webContents.mainFrame)
      return
    const input = z.object({ requestId: z.string().uuid(), viewId: z.string().uuid().nullable() }).strict().safeParse(raw)
    if (input.success)
      replies.get(input.data.requestId)?.(input.data.viewId)
  }
  ipcMain.on(EXTENSION_IPC.workbenchReply, onWorkbenchReply)
  ipcMain.handle(EXTENSION_IPC.hostRequest, async (event, method: unknown, params: unknown) => {
    const host = [...hosts].find(host => host.owns(event))
    try {
      if (!host)
        throw new Error('EXTENSION_HOST_STOPPED')
      return { ok: true, value: await host.request(method, params) }
    }
    catch (error) {
      return { ok: false, value: extensionError(error) }
    }
  })
  const onHostReply = (event: IpcMainEvent, raw: unknown) => [...hosts].find(host => host.owns(event))?.reply(raw)
  ipcMain.on(EXTENSION_IPC.hostReply, onHostReply)
  const dispose = async () => {
    powerMonitor.off('suspend', suspend)
    powerMonitor.off('resume', resume)
    await service.dispose()
    for (const reply of replies.values()) reply(null)
    for (const current of bound) {
      if (current.isDestroyed())
        continue
      current.webContents.off('will-frame-navigate', guardNavigation)
      current.webContents.off('did-start-navigation', resetOnNavigation)
      current.webContents.off('render-process-gone', resetHosts)
    }
    stopProtocol()
    ipcMain.removeHandler(EXTENSION_IPC.request)
    ipcMain.removeHandler(EXTENSION_IPC.hostRequest)
    ipcMain.off(EXTENSION_IPC.hostReply, onHostReply)
    ipcMain.off(EXTENSION_IPC.workbenchReply, onWorkbenchReply)
  }
  return {
    dispose,
    inspect: async (id) => {
      await prepared
      return service.inspect(id)
    },
    async reviewPackage(path: string) {
      await prepared
      const review = await service.review(path, false)
      const current = window()
      if (!current || current.isDestroyed()) {
        service.cancelInstall(review.token)
        return
      }
      current.webContents.send(EXTENSION_IPC.review, review)
    },
  }
}
