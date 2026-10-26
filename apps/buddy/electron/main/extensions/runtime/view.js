import { waitsForExtensionIo } from '../../../../shared/extensions/extensionRequestLifecycle'
import { createExtensionNetworkClient, createExtensionResourceClient, writeExtensionResource } from '../../../../shared/extensions/extensionResourceClient'
import { createExtensionWorkers } from '../../../../shared/extensions/extensionWorkers'
import { createThemeClient } from '../../../../shared/theme/themeClient'
import { ExtensionCloseGuard } from './ExtensionCloseGuard'
import { ExtensionReferenceReveal } from './ExtensionReferenceReveal'
import { ExtensionViewState } from './ExtensionViewState'

const token = location.hostname
const controller = new AbortController()
const workers = createExtensionWorkers(new URL('/__package/', location.href), controller.signal, Worker)
const pending = new Map()
const closeGuard = new ExtensionCloseGuard((id, allowed) => parent.postMessage({ channel: 'lexora-extension', token, closeResult: { id, allowed } }, '*'))
const references = new ExtensionReferenceReveal((id, located) => parent.postMessage({ channel: 'lexora-extension', token, referenceResult: { id, located } }, '*'))
const state = new ExtensionViewState(() => request('events.snapshot'))
const events = state.events
let overlay = false
let interactionId = null
function applyEnvironment(next) {
  document.documentElement.lang = next.language
  document.documentElement.style.colorScheme = next.colorScheme
  for (const [name, value] of Object.entries(next.colors))
    document.documentElement.style.setProperty(`--lexora-${name}`, value)
}
events.on('view:environment:changed', event => applyEnvironment(event.data.environment))
function request(method, params = null) {
  return new Promise((resolve, reject) => {
    if (pending.size >= 64)
      return reject(new Error('EXTENSION_REQUEST_LIMIT'))
    const id = crypto.randomUUID()
    const longRunning = waitsForExtensionIo(method) || ['commands.execute', 'references.add', 'references.commit'].includes(method)
    const timer = longRunning
      ? undefined
      : setTimeout(() => {
          pending.delete(id)
          reject(new Error('EXTENSION_REQUEST_TIMEOUT'))
        }, ['resources.pickFiles', 'resources.pickDirectory', 'resources.beginSave'].includes(method) ? 125000 : 15000)
    pending.set(id, { resolve, reject, timer })
    parent.postMessage({ channel: 'lexora-extension', token, id, method, params }, '*')
  })
}
addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.channel !== 'lexora-extension' || event.data.token !== token)
    return
  const data = event.data
  if (typeof data.ping === 'string') {
    parent.postMessage({ channel: 'lexora-extension', token, pong: data.ping }, '*')
    return
  }
  if (data.closeRequest && typeof data.closeRequest.id === 'string') {
    void closeGuard.request(data.closeRequest.id)
    return
  }
  if (typeof data.closeCancel === 'string') {
    closeGuard.cancel(data.closeCancel)
    return
  }
  if (data.referenceRequest) {
    void references.reveal(data.referenceRequest.id, data.referenceRequest.input)
    return
  }
  if (typeof data.referenceCancel === 'string') {
    references.cancel(data.referenceCancel)
    return
  }
  if (data.event) {
    state.acceptUpdate(data)
    return
  }
  const item = pending.get(data.id)
  if (!item)
    return
  pending.delete(data.id)
  clearTimeout(item.timer)
  if (data.ok)
    item.resolve(data.value)
  else item.reject(new Error(data.value))
})
addEventListener('keydown', (event) => {
  if (interactionId && event.isTrusted && event.key === 'Escape') {
    event.preventDefault()
    parent.postMessage({ channel: 'lexora-extension', token, endInteraction: true }, '*')
  }
  if (state.snapshot.control && event.isTrusted && event.key === 'Escape')
    parent.postMessage({ channel: 'lexora-extension', token, dismiss: true }, '*')
})
addEventListener('pagehide', () => {
  controller.abort()
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(new Error('EXTENSION_VIEW_CLOSED'))
  }
  pending.clear()
  state.dispose()
  references.dispose()
  closeGuard.dispose()
})
async function initialize() {
  try {
    const initial = await request('bootstrap')
    interactionId = initial.interactionId
    overlay = initial.presentation === 'decoration'
    state.initialize({ workbench: initial.workbench, visible: initial.visible, environment: initial.environment, anchor: initial.anchor ?? null, mount: initial.mount ?? null, control: initial.control }, overlay, initial.eventCursor, !!interactionId)
    if (overlay) {
      document.documentElement.style.overflow = 'hidden'
      document.body.style.overflow = 'hidden'
    }
    applyEnvironment(state.snapshot.environment)
    await Promise.all((initial.styles ?? []).map(href => new Promise((resolve, reject) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = `/__package/${href}`
      link.onload = resolve
      link.onerror = () => reject(new Error('EXTENSION_VIEW_STYLES_FAILED'))
      document.head.append(link)
    })))
    const entry = await import(`/__package/${initial.entry}`)
    const api = Object.freeze({
      workers,
      clipboard: Object.freeze({ read: () => request('clipboard.read'), write: data => request('clipboard.write', data) }),
      setDocumentInfo: info => request('view.setDocumentInfo', info),
      apiVersion: initial.apiVersion,
      onBeforeClose: handler => closeGuard.register(handler),
      events,
      themes: createThemeClient(input => request('themes.request', input), listener => events.on('view:environment:changed', listener)),
      instanceId: initial.instanceId,
      interaction: interactionId ? Object.freeze({ id: interactionId, setRegions: regions => request('interaction.setRegions', regions), onActivate: listener => events.on('interaction:activated', ({ data }) => listener({ id: data.regionId, x: data.x, y: data.y })) }) : null,
      onMessage: listener => events.on('view:message:received', event => listener(event.data.message)),
      get workbench() { return state.snapshot.workbench },
      onWorkbenchChange: listener => events.on('workbench:context:changed', event => listener(event.data.context)),
      get visible() { return state.snapshot.visible },
      onVisibilityChange: listener => events.on('view:visibility:changed', event => listener(event.data.visible)),
      get environment() { return state.snapshot.environment },
      onEnvironmentChange: listener => events.on('view:environment:changed', event => listener(event.data.environment)),
      get mount() { return state.snapshot.mount },
      onMountChange: listener => events.on('view:mount:changed', event => listener(event.data.mount)),
      get anchor() { return state.snapshot.anchor },
      onAnchorChange: (listener) => {
        if (!overlay)
          throw new Error('EXTENSION_METHOD_DENIED')
        return events.on('view:anchor:changed', event => listener(event.data.anchor))
      },
      control: initial.presentation === 'control'
        ? Object.freeze({
            get snapshot() { return state.snapshot.control },
            onChange: listener => events.on('control:changed', event => listener(event.data.control)),
            propose: (value, revision = state.snapshot.control?.revision) => request('control.propose', { value, revision }),
          })
        : null,
      resource: initial.resource,
      state: initial.state,
      stateVersion: initial.stateVersion,
      expectedStateVersion: initial.expectedStateVersion,
      signal: controller.signal,
      onActivity: (listener) => {
        if (!overlay)
          throw new Error('EXTENSION_METHOD_DENIED')
        return events.on('composer:input:received', event => listener({ type: 'composer-input', ...event.data }))
      },
      setState: state => request('view.setState', state),
      setActive: active => request('view.setActive', { active }),
      setPresentation: presentation => request('view.setPresentation', presentation),
      references: Object.freeze({
        add: input => request('references.add', input.kind === 'resource' ? { ...input, resource: { id: input.resource.id } } : input),
        capture: input => request('references.capture', input.kind === 'resource' ? { ...input, resource: { id: input.resource.id } } : input),
        commit: (id, choice) => request('references.commit', { id, choice }),
        release: id => request('references.release', { id }),
        onReveal: handler => references.onReveal(handler),
      }),
      resources: {
        ...createExtensionResourceClient(request),
        pickFiles: (options = {}) => request('resources.pickFiles', options),
        revokeFile: resource => request('resources.revokeFile', { id: resource.id }),
        pickDirectory: () => request('resources.pickDirectory'),
        listDirectories: () => request('resources.listDirectories'),
        scanDirectory: (directory, options = {}) => request('resources.scanDirectory', { id: directory.id, ...options }),
        revokeDirectory: directory => request('resources.revokeDirectory', { id: directory.id }),
        saveFile: options => writeExtensionResource(request, 'resources.beginSave', options),
      },
      openExternal: url => request('links.openExternal', { url }),
      network: createExtensionNetworkClient(request),
      commands: { execute: (command, args = null) => request('commands.execute', { command, arguments: args }) },
    })
    if (typeof entry.render !== 'function')
      throw new Error('EXTENSION_VIEW_ENTRY_INVALID')
    await entry.render(api, document.querySelector('main'))
    await request('view.ready')
  }
  catch (error) {
    controller.abort()
    document.querySelector('main').textContent = overlay ? '' : 'This plugin view could not be loaded.'
    void request('view.failed', { code: /^EXTENSION_[A-Z_]+$/.test(error?.message) ? error.message : 'EXTENSION_VIEW_FAILED' }).catch(() => {})
  }
}
void initialize()
