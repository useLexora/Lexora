import type { ExtensionApi, ExtensionManagementRequest } from '../../shared/extensions/extensionApi'
import { ipcRenderer } from 'electron'
import { EXTENSION_IPC } from '../../shared/extensions/extensionApi'
import { subscribe } from './subscribe'

export function createExtensionApi(): ExtensionApi {
  const request = (input: ExtensionManagementRequest) => ipcRenderer.invoke(EXTENSION_IPC.request, input)
  return Object.freeze({
    list: () => request({ action: 'list' }),
    installations: () => request({ action: 'installations' }),
    catalog: (refresh = false) => request({ action: 'catalog', refresh }),
    reviewCatalog: (id, version) => request({ action: 'reviewCatalog', id, version }),
    cancelInstallation: id => request({ action: 'cancelInstallation', id }),
    selectPackage: (development = false) => request({ action: 'selectPackage', development }),
    install: token => request({ action: 'install', token }),
    cancelInstall: token => request({ action: 'cancelInstall', token }),
    enable: (id, enabled) => request({ action: 'enable', id, enabled }),
    restart: id => request({ action: 'restart', id }),
    uninstall: id => request({ action: 'uninstall', id }),
    devtools: id => request({ action: 'devtools', id }),
    revokeResources: id => request({ action: 'revokeResources', id }),
    execute: (id, command, resource) => request({ action: 'execute', id, command, resource }),
    executeMenu: (id, menu, invocation) => request({ action: 'executeMenu', id, menu, invocation }),
    executeSlash: (id, command, argumentsText, instanceId) => request({ action: 'executeSlash', id, command, arguments: argumentsText, instanceId }),
    updatePanes: panes => request({ action: 'updatePanes', panes }),
    endInteraction: id => request({ action: 'endInteraction', id }),
    openView: view => request({ action: 'openView', view }),
    closeView: (viewId, generation, token) => request({ action: 'closeView', viewId, generation, token }),
    viewRequest: (viewId, generation, token, method, params) => request({ action: 'viewRequest', viewId, generation, token, method, params }),
    onChanged: listener => subscribe(EXTENSION_IPC.changed, listener),
    onReview: listener => subscribe(EXTENSION_IPC.review, listener),
    onWorkbench: listener => subscribe(EXTENSION_IPC.workbench, listener),
    replyWorkbench: (requestId, viewId) => ipcRenderer.send(EXTENSION_IPC.workbenchReply, { requestId, viewId }),
  } satisfies ExtensionApi)
}
