import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('lexoraExtensionHost', Object.freeze({
  request: async (method: string, params: unknown) => {
    const result = await ipcRenderer.invoke('lexora:extensions:host-request', method, params)
    if (!result.ok)
      throw new Error(result.value)
    return result.value
  },
  reply: (id: string, ok: boolean, value: unknown) => ipcRenderer.send('lexora:extensions:host-reply', { id, ok, value }),
  subscribe: (listener: (message: unknown) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, message: unknown) => listener(message)
    ipcRenderer.on('lexora:extensions:host-message', receive)
    return () => ipcRenderer.removeListener('lexora:extensions:host-message', receive)
  },
}))
